import axios from "axios";
import https from "https";
import { logAudit } from "./auditService.js";

// --- Internal provisioning integrations (production) ---
//
// Each function calls a real internal system over HTTP using an endpoint and
// (optional) bearer token configured per system in the admin Settings tab
// (INTERNAL_<SYSTEM>_URL / INTERNAL_<SYSTEM>_TOKEN). Nothing is fabricated: if a
// system's endpoint isn't configured the call fails loudly, so a provisioning
// job surfaces the misconfiguration instead of pretending to succeed.
//
// Response mapping is deliberately tolerant — real systems differ in their JSON
// shapes — so we read a reference/detail from a set of common field names and
// propagate the network fields later steps depend on (ip, gateway, subnet,
// vlan, fqdn). Endpoints are read from process.env at call time so a saved
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

// First present (non-empty) value among candidate keys.
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

// POST to a configured internal system endpoint. Throws a clear error if the
// system isn't configured, or wraps any HTTP error with the system + status.
async function callSystem(system, action, body) {
  const key = system.toUpperCase();
  const url = process.env[`INTERNAL_${key}_URL`];
  const token = process.env[`INTERNAL_${key}_TOKEN`];
  if (!url || !String(url).trim()) {
    throw new Error(`${system} endpoint is not configured — set INTERNAL_${key}_URL in Settings.`);
  }

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

export async function openServiceRequest({ hostname, requestedBy, cpu, memoryGB, diskGB } = {}) {
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

export async function allocateIpAddress({ hostname } = {}) {
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

export async function reserveCompute({ cpu, memoryGB, hostname } = {}) {
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

export async function reserveStorage({ diskGB, hostname } = {}) {
  const data = await callSystem("storage", "volume.reserve", { diskGB, hostname });
  const reference = pick(data, ["reference", "volumeId", "volume", "id"]);
  return {
    system: data.system || "Storage",
    reference,
    detail: pick(data, ["detail", "message"]) || `Reserved ${diskGB ?? "?"} GB volume ${reference || ""}`.trim(),
    fields: data.fields || { volumeId: reference, datastore: pick(data, ["datastore"]) },
  };
}

export async function requestFirewallAccess({ hostname, ip } = {}) {
  const data = await callSystem("firewall", "access.request", { hostname, ip });
  const reference = pick(data, ["reference", "changeId", "change", "id"]);
  const rules = data.rules || data.fields?.rules;
  return {
    system: data.system || "Firewall",
    reference,
    detail: pick(data, ["detail", "message"]) || `Change ${reference || ""} raised for ${ip || hostname || "host"}`.trim(),
    fields: data.fields || { changeId: reference, rules },
  };
}

export async function createDnsRecord({ hostname, ip } = {}) {
  const data = await callSystem("dns", "record.create", { hostname, ip });
  const fqdn = pick(data, ["fqdn", "name", "record"]);
  return {
    system: data.system || "DNS",
    reference: fqdn,
    detail: pick(data, ["detail", "message"]) || `Created A record ${fqdn || hostname} -> ${ip || "pending"}`,
    fields: { fqdn },
  };
}

export async function registerCmdbItem({ hostname, ip, requestedBy } = {}) {
  const data = await callSystem("cmdb", "ci.register", { hostname, ip, owner: requestedBy });
  const reference = pick(data, ["reference", "ciId", "sysId", "sys_id", "id"]);
  return {
    system: data.system || "CMDB",
    reference,
    detail: pick(data, ["detail", "message"]) || `Registered CI ${reference || ""} for ${hostname}`.trim(),
    fields: data.fields || { ciId: reference },
  };
}

export async function finalizeHandover({ hostname, requestNumber } = {}) {
  const data = await callSystem("itsm", "request.close", { hostname, requestNumber });
  const reference = pick(data, ["reference", "task", "number", "id"]);
  return {
    system: data.system || "ITSM",
    reference,
    detail: pick(data, ["detail", "message"]) || `Handover ${reference || ""} completed`.trim(),
    fields: data.fields || { task: reference },
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
