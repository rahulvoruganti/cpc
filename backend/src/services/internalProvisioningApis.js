import axios from "axios";
import https from "https";
import crypto from "crypto";
import { logAudit } from "./auditService.js";

// --- Internal provisioning integrations ---
//
// Each function integrates with a real internal system over HTTP when that
// system's endpoint is configured in the admin Settings tab
// (INTERNAL_<SYSTEM>_URL / INTERNAL_<SYSTEM>_TOKEN). When it isn't configured,
// the call falls back to a realistic simulated response so the workflow still
// completes end to end — useful before the real integrations are wired up.
//
// Both paths return the same { system, reference, detail, fields } shape, so
// the provisioner and UI treat a simulated step exactly like a real one. The
// fields a later step depends on (ip, gateway, subnet, vlan, fqdn) are always
// populated. Endpoints are read from process.env at call time so a saved
// Settings change takes effect immediately.

const timeoutMs = () => Number(process.env.INTERNAL_HTTP_TIMEOUT_MS) || 30000;

// Reuse one HTTPS agent per TLS-verify setting rather than rebuilding per call.
// Verification is opt-in (env === "true"), consistent with the Proxmox/K3s
// settings, since internal endpoints often present private-CA certificates.
let agent = null;
let agentVerify = null;
function httpsAgent() {
  const verify = process.env.INTERNAL_VERIFY_TLS === "true";
  if (!agent || agentVerify !== verify) {
    agent = new https.Agent({ rejectUnauthorized: verify });
    agentVerify = verify;
  }
  return agent;
}

// Whether a system's endpoint has been configured in Settings. When false, the
// corresponding step is simulated rather than calling out.
export function isSystemConfigured(system) {
  const url = process.env[`INTERNAL_${String(system).toUpperCase()}_URL`];
  return !!(url && String(url).trim());
}

// First present (non-empty) value among candidate keys.
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

// --- Simulated-response helpers (used when a system isn't configured) ---
const rand = (min, max) => crypto.randomInt(min, max + 1);
const ref = (prefix, digits = 7) => `${prefix}${String(rand(0, 10 ** digits - 1)).padStart(digits, "0")}`;
let reqSeq = 4500000 + rand(1000, 8999);

// POST to a configured internal system endpoint. Wraps any HTTP error with the
// system + status so a real integration failure surfaces on the job.
async function callSystem(system, action, body) {
  const key = system.toUpperCase();
  const url = process.env[`INTERNAL_${key}_URL`];
  const token = process.env[`INTERNAL_${key}_TOKEN`];

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await axios.post(url, body, {
      headers,
      timeout: timeoutMs(),
      httpsAgent: String(url).startsWith("https") ? httpsAgent() : undefined,
    });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data
      ? JSON.stringify(err.response.data).slice(0, 300)
      : err.message;
    logAudit({
      actor: { username: "system", role: "system" },
      action: `internal.${system}.${action}`,
      target: url,
      status: "failure",
      detail: { httpStatus: status || null, error: detail },
    });
    throw new Error(`${system} call failed${status ? ` (HTTP ${status})` : ""}: ${detail}`);
  }

  const data = res.data ?? {};
  logAudit({
    actor: { username: "system", role: "system" },
    action: `internal.${system}.${action}`,
    target: String(pick(data, ["reference", "number", "id", "ip", "fqdn"]) || url),
    status: "success",
    detail: { httpStatus: res.status },
  });
  return data;
}

// Log a simulated call the same way a real one is audited (flagged simulated).
function recordSimulated(system, action, target) {
  logAudit({
    actor: { username: "system", role: "system" },
    action: `internal.${system}.${action}`,
    target,
    detail: { simulated: true },
  });
}

export async function openServiceRequest({ hostname, requestedBy, cpu, memoryGB, diskGB } = {}) {
  if (isSystemConfigured("ITSM")) {
    const data = await callSystem("itsm", "request.open", {
      shortDescription: `Provision internal Linux server: ${hostname || "workspace"}`,
      hostname, requestedBy, cpu, memoryGB, diskGB,
    });
    const reference = pick(data, ["number", "reference", "requestNumber", "sysId", "sys_id", "id"]);
    return {
      system: data.system || "ITSM",
      reference,
      detail: pick(data, ["detail", "message"]) || `Service request ${reference || ""} opened`.trim(),
      fields: data.fields || { requestNumber: reference },
    };
  }
  reqSeq += 1;
  const number = `REQ${String(reqSeq).padStart(7, "0")}`;
  recordSimulated("itsm", "request.open", number);
  return {
    system: "ServiceNow ITSM",
    reference: number,
    detail: `Service request ${number} opened for ${hostname || "workspace"}`,
    fields: { requestNumber: number },
  };
}

export async function allocateIpAddress({ hostname } = {}) {
  if (isSystemConfigured("IPAM")) {
    const data = await callSystem("ipam", "address.allocate", { hostname });
    const ip = pick(data, ["ip", "ipAddress", "address"]);
    const gateway = pick(data, ["gateway", "gw"]);
    const subnet = pick(data, ["subnet", "cidr", "network"]);
    const vlan = pick(data, ["vlan", "vlanId", "vlanName"]);
    if (!ip) throw new Error("IPAM did not return an IP address");
    return {
      system: data.system || "IPAM",
      reference: ip,
      detail: pick(data, ["detail", "message"])
        || `Allocated ${ip}${subnet ? ` (${subnet})` : ""}${gateway ? ` gw ${gateway}` : ""}`,
      fields: { ip, gateway, subnet, vlan },
    };
  }
  const vlan = rand(100, 199);
  const octet2 = vlan - 100 + 20;
  const octet3 = rand(10, 240);
  const ip = `10.${octet2}.${octet3}.${rand(20, 240)}`;
  const gateway = `10.${octet2}.${octet3}.1`;
  const subnet = `10.${octet2}.${octet3}.0/24`;
  recordSimulated("ipam", "address.allocate", ip);
  return {
    system: "Infoblox IPAM",
    reference: ip,
    detail: `Allocated ${ip}/24 on VLAN ${vlan} (gw ${gateway})`,
    fields: { ip, gateway, subnet, vlan: `VLAN${vlan}` },
  };
}

export async function reserveCompute({ cpu, memoryGB, hostname } = {}) {
  if (isSystemConfigured("COMPUTE")) {
    const data = await callSystem("compute", "capacity.reserve", { cpu, memoryGB, hostname });
    const reference = pick(data, ["reference", "node", "host", "id"]);
    return {
      system: data.system || "Compute",
      reference,
      detail: pick(data, ["detail", "message"])
        || `Reserved ${cpu ?? "?"} vCPU / ${memoryGB ?? "?"} GB on ${reference || "compute"}`,
      fields: data.fields || { node: reference, cluster: pick(data, ["cluster"]) },
    };
  }
  const cluster = `PROD-CL${rand(1, 4)}`;
  const node = `esx-${String(rand(1, 32)).padStart(2, "0")}.dc.internal`;
  recordSimulated("compute", "capacity.reserve", node);
  return {
    system: "Datacenter Capacity Broker",
    reference: node,
    detail: `Reserved ${cpu || "?"} vCPU / ${memoryGB || "?"} GB RAM on ${node} (${cluster})`,
    fields: { cluster, node },
  };
}

export async function reserveStorage({ diskGB, hostname } = {}) {
  if (isSystemConfigured("STORAGE")) {
    const data = await callSystem("storage", "volume.reserve", { diskGB, hostname });
    const reference = pick(data, ["reference", "volumeId", "volume", "id"]);
    return {
      system: data.system || "Storage",
      reference,
      detail: pick(data, ["detail", "message"]) || `Reserved ${diskGB ?? "?"} GB volume ${reference || ""}`.trim(),
      fields: data.fields || { volumeId: reference, datastore: pick(data, ["datastore"]) },
    };
  }
  const volumeId = ref("vol-", 8);
  const datastore = `ds-san-prod-${String(rand(1, 12)).padStart(2, "0")}`;
  const size = Number(diskGB) || 50;
  recordSimulated("storage", "volume.reserve", volumeId);
  return {
    system: "SAN Storage Orchestrator",
    reference: volumeId,
    detail: `Reserved ${size} GB volume ${volumeId} on ${datastore} (tier: gold)`,
    fields: { volumeId, datastore },
  };
}

export async function requestFirewallAccess({ hostname, ip } = {}) {
  if (isSystemConfigured("FIREWALL")) {
    const data = await callSystem("firewall", "access.request", { hostname, ip });
    const reference = pick(data, ["reference", "changeId", "change", "id"]);
    return {
      system: data.system || "Firewall",
      reference,
      detail: pick(data, ["detail", "message"]) || `Change ${reference || ""} raised for ${ip || hostname || "host"}`.trim(),
      fields: data.fields || { changeId: reference, rules: data.rules },
    };
  }
  const changeId = ref("CHG", 7);
  const rules = ["tcp/22 (SSH) from mgmt-zone", "tcp/443 (HTTPS) from app-zone", "tcp/8443 to monitoring"];
  recordSimulated("firewall", "access.request", changeId);
  return {
    system: "Firewall Change System",
    reference: changeId,
    detail: `${changeId} approved — ${rules.length} rules opened for ${ip || hostname || "host"}`,
    fields: { changeId, rules },
  };
}

export async function createDnsRecord({ hostname, ip } = {}) {
  if (isSystemConfigured("DNS")) {
    const data = await callSystem("dns", "record.create", { hostname, ip });
    const fqdn = pick(data, ["fqdn", "name", "record"]);
    return {
      system: data.system || "DNS",
      reference: fqdn,
      detail: pick(data, ["detail", "message"]) || `Created A record ${fqdn || hostname} -> ${ip || "pending"}`,
      fields: { fqdn },
    };
  }
  const fqdn = `${(hostname || "host").toLowerCase()}.cpc.internal`;
  recordSimulated("dns", "record.create", fqdn);
  return {
    system: "Internal DNS",
    reference: fqdn,
    detail: `Created A record ${fqdn} -> ${ip || "pending"}`,
    fields: { fqdn },
  };
}

export async function registerCmdbItem({ hostname, ip, requestedBy } = {}) {
  if (isSystemConfigured("CMDB")) {
    const data = await callSystem("cmdb", "ci.register", { hostname, ip, owner: requestedBy });
    const reference = pick(data, ["reference", "ciId", "sysId", "sys_id", "id"]);
    return {
      system: data.system || "CMDB",
      reference,
      detail: pick(data, ["detail", "message"]) || `Registered CI ${reference || ""} for ${hostname}`.trim(),
      fields: data.fields || { ciId: reference },
    };
  }
  const ciId = ref("CI", 8);
  recordSimulated("cmdb", "ci.register", ciId);
  return {
    system: "CMDB",
    reference: ciId,
    detail: `Registered CI ${ciId} (${hostname}) — owner ${requestedBy || "unknown"}`,
    fields: { ciId },
  };
}

export async function finalizeHandover({ hostname, requestNumber } = {}) {
  if (isSystemConfigured("ITSM")) {
    const data = await callSystem("itsm", "request.close", { hostname, requestNumber });
    const reference = pick(data, ["reference", "task", "number", "id"]);
    return {
      system: data.system || "ITSM",
      reference,
      detail: pick(data, ["detail", "message"]) || `Handover ${reference || ""} completed`.trim(),
      fields: data.fields || { task: reference },
    };
  }
  const ticket = ref("TASK", 7);
  recordSimulated("itsm", "request.close", ticket);
  return {
    system: "ServiceNow ITSM",
    reference: ticket,
    detail: `Handover task ${ticket} completed — workspace ready`,
    fields: { task: ticket },
  };
}

// Dispatch table used by the provisioner to invoke a step's API by name.
export const INTERNAL_APIS = {
  openServiceRequest,
  allocateIpAddress,
  reserveCompute,
  reserveStorage,
  requestFirewallAccess,
  createDnsRecord,
  registerCmdbItem,
  finalizeHandover,
};
