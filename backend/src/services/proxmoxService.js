import axios from "axios";
import https from "https";

// Connection config is read from process.env at call time (not captured at
// module load) so changes saved in the admin Settings tab take effect without
// a restart. The settingsStore layers persisted overrides onto process.env.
function pveConfig() {
  return {
    host: process.env.PROXMOX_HOST,
    port: process.env.PROXMOX_PORT || "8006",
    node: process.env.PROXMOX_NODE,
    username: process.env.PROXMOX_USERNAME,
    password: process.env.PROXMOX_PASSWORD,
    verifySsl: process.env.PROXMOX_VERIFY_SSL === "true",
  };
}

let client = null;
let clientSig = null;
let ticket = null;
let csrfToken = null;
let ticketExpiry = 0;

// Build (or rebuild) the axios client whenever the connection target changes.
// A changed host/port/TLS setting also invalidates the cached auth ticket.
function ensureClient() {
  const cfg = pveConfig();
  const sig = `${cfg.host}:${cfg.port}:${cfg.verifySsl}`;
  if (!client || sig !== clientSig) {
    client = axios.create({
      baseURL: `https://${cfg.host}:${cfg.port}/api2/json`,
      httpsAgent: new https.Agent({ rejectUnauthorized: cfg.verifySsl }),
    });
    clientSig = sig;
    ticket = null;
    csrfToken = null;
    ticketExpiry = 0;
  }
  return client;
}

async function authenticate() {
  const cfg = pveConfig();
  const res = await ensureClient().post("/access/ticket", {
    username: cfg.username,
    password: cfg.password,
  });
  ticket = res.data.data.ticket;
  csrfToken = res.data.data.CSRFPreventionToken;
  // Proxmox tickets last 2 hours; refresh after 100 minutes to be safe
  ticketExpiry = Date.now() + 100 * 60 * 1000;
}

async function ensureAuth() {
  ensureClient();
  if (!ticket || Date.now() > ticketExpiry) {
    await authenticate();
  }
}

async function pveRequest(method, path, data = null, params = null) {
  await ensureAuth();
  const client = ensureClient();
  const headers = {
    Cookie: `PVEAuthCookie=${ticket}`,
  };
  if (["post", "put", "delete"].includes(method)) {
    headers["CSRFPreventionToken"] = csrfToken;
  }
  try {
    const res = await client.request({
      method,
      url: path,
      data,
      params,
      headers,
    });
    return res.data.data;
  } catch (err) {
    const detail = err.response?.data || err.message;
    throw new Error(
      `Proxmox API error [${method.toUpperCase()} ${path}]: ${JSON.stringify(detail)}`
    );
  }
}

export async function getNextVmid() {
  return pveRequest("get", "/cluster/nextid");
}

// Accepts either listTemplates(), listTemplates("node") or the object style
// listTemplates({ node }) used elsewhere in this module — callers pass {} so a
// positional node arg would otherwise become "[object Object]".
export async function listTemplates(arg) {
  const node = (arg && typeof arg === "object" ? arg.node : arg) || process.env.PROXMOX_NODE;
  const vms = await pveRequest("get", `/nodes/${node}/qemu`);
  // Proxmox reports the template flag as 1 (number) — tolerate true/"1" too.
  return vms.filter((vm) => vm.template === 1 || vm.template === true || vm.template === "1");
}

export async function cloneVm({
  node = process.env.PROXMOX_NODE,
  templateVmid,
  newVmid,
  hostname,
  storage = "local-lvm",
  fullClone = true,
}) {
  // Proxmox clone is async — returns a task UPID immediately while the
  // disk copy keeps the VM config file locked in the background.
  const upid = await pveRequest("post", `/nodes/${node}/qemu/${templateVmid}/clone`, {
    newid: newVmid,
    name: hostname,
    storage,
    full: fullClone ? 1 : 0,
  });
  return upid;
}

export async function waitForTask({ node = process.env.PROXMOX_NODE, upid, attempts = 60, delayMs = 2000 }) {
  for (let i = 0; i < attempts; i++) {
    const status = await getTaskStatus(node, upid);
    if (status.status === "stopped") {
      if (status.exitstatus !== "OK") {
        throw new Error(`Task ${upid} failed: ${status.exitstatus}`);
      }
      return status;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Timed out waiting for task ${upid} to finish`);
}

export async function getTaskStatus(node, upid) {
  return pveRequest("get", `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
}

export async function configureVm({ node = process.env.PROXMOX_NODE, vmid, cores, memory, diskResizeGB, storage = "local-lvm" }) {
  const payload = { agent: "1" }; // enable guest agent so we can read the DHCP IP
  if (cores) payload.cores = cores;
  if (memory) payload.memory = memory; // MB

  await pveRequest("put", `/nodes/${node}/qemu/${vmid}/config`, payload);

  // Attach a cloud-init drive if missing. Don't trust a config pre-check here —
  // Proxmox's config API can lag slightly behind the clone task's own disk
  // creation, so a "does ide2 exist yet" read can race and false-negative.
  // Instead just attempt it and treat "already exists" as success.
  try {
    await pveRequest("put", `/nodes/${node}/qemu/${vmid}/config`, {
      ide2: `${storage}:cloudinit`,
    });
  } catch (err) {
    const alreadyExists = /already exists/i.test(err.message);
    if (!alreadyExists) throw err;
    // else: cloud-init drive is already attached (created by the clone itself), fine.
  }

  if (diskResizeGB) {
    await pveRequest("put", `/nodes/${node}/qemu/${vmid}/resize`, {
      disk: "scsi0",
      size: `${diskResizeGB}G`,
    });
  }
}

export async function setCloudInit({ node = process.env.PROXMOX_NODE, vmid, hostname, staticIp, sshKeys }) {
  const payload = {
    ciuser: "ubuntu",
    searchdomain: "local",
  };

  // Set a default SSH password from env so the web terminal can connect.
  // Users should change this after first login.
  if (process.env.VM_SSH_PASSWORD) {
    payload.cipassword = process.env.VM_SSH_PASSWORD;
  }

  if (staticIp) {
    payload.ipconfig0 = `ip=${staticIp.full},gw=${staticIp.gateway}`;
    payload.nameserver = staticIp.dns;
  } else {
    payload.ipconfig0 = "ip=dhcp";
    payload.nameserver = "8.8.8.8";
  }

  if (sshKeys) payload.sshkeys = encodeURIComponent(sshKeys);
  await pveRequest("put", `/nodes/${node}/qemu/${vmid}/config`, payload);
}

// Edit an existing VM's specs. cores/memory are applied live where the guest
// supports hotplug; otherwise Proxmox stores them as pending and they take
// effect on the next reboot. Disk can only grow (Proxmox can't shrink).
export async function editVm({ node = process.env.PROXMOX_NODE, vmid, cores, memory, diskGB }) {
  const payload = {};
  if (cores) payload.cores = Number(cores);
  if (memory) payload.memory = Number(memory); // MB
  if (Object.keys(payload).length) {
    await pveRequest("put", `/nodes/${node}/qemu/${vmid}/config`, payload);
  }
  if (diskGB) {
    await pveRequest("put", `/nodes/${node}/qemu/${vmid}/resize`, {
      disk: "scsi0",
      size: `${Number(diskGB)}G`,
    });
  }
}

export async function editContainer({ node = process.env.PROXMOX_NODE, vmid, cores, memory, diskGB }) {
  const payload = {};
  if (cores) payload.cores = Number(cores);
  if (memory) payload.memory = Number(memory); // MB — LXC applies live via cgroups
  if (Object.keys(payload).length) {
    await pveRequest("put", `/nodes/${node}/lxc/${vmid}/config`, payload);
  }
  if (diskGB) {
    await pveRequest("put", `/nodes/${node}/lxc/${vmid}/resize`, {
      disk: "rootfs",
      size: `${Number(diskGB)}G`,
    });
  }
}

export async function startVm({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("post", `/nodes/${node}/qemu/${vmid}/status/start`);
}

export async function getVmStatus({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("get", `/nodes/${node}/qemu/${vmid}/status/current`);
}

export async function getVmConfig({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("get", `/nodes/${node}/qemu/${vmid}/config`);
}

// Poll the VM until Proxmox releases its config lock (e.g. the "clone" lock held
// while the disk copy runs). Resolves once no lock is present.
export async function waitForUnlock({ node = process.env.PROXMOX_NODE, vmid, attempts = 300, delayMs = 2000, onTick } = {}) {
  for (let i = 0; i < attempts; i++) {
    const status = await getVmStatus({ node, vmid }).catch(() => null);
    const lock = status?.lock;
    if (status && !lock) return true;
    if (onTick && lock) onTick(lock);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Timed out waiting for VMID ${vmid} to unlock`);
}

// Read a disk's current size in GB from the VM config (e.g. "scsi0").
export async function getDiskSizeGB({ node = process.env.PROXMOX_NODE, vmid, disk = "scsi0" }) {
  const cfg = await getVmConfig({ node, vmid });
  const m = /size=(\d+(?:\.\d+)?)([KMGT])/i.exec(cfg?.[disk] || "");
  if (!m) return null;
  let size = Number(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === "K") size = size / (1024 * 1024);
  if (unit === "M") size = size / 1024;
  if (unit === "T") size = size * 1024;
  return Math.ceil(size);
}

// Attach the VM's primary NIC to a bridge/VLAN and configure it for DHCP.
// A dotted iface (vmbr0.100) is split into bridge + VLAN tag. The guest agent
// is enabled so we can discover the DHCP-assigned address after boot.
export async function setVmNetwork({ node = process.env.PROXMOX_NODE, vmid, iface, model = "virtio" }) {
  let bridge = iface, tag = null;
  const dotted = /^(.+)\.(\d+)$/.exec(iface || "");
  if (dotted) { bridge = dotted[1]; tag = dotted[2]; }

  await pveRequest("put", `/nodes/${node}/qemu/${vmid}/config`, {
    net0: `${model},bridge=${bridge}${tag ? `,tag=${tag}` : ""}`,
    ipconfig0: "ip=dhcp",
    agent: "1", // enable qemu-guest-agent channel so we can read the leased IP
  });
}

// Read the VM's IPv4 address from the qemu-guest-agent (requires the agent to
// be installed and running in the guest). Returns the first non-loopback,
// non-link-local IPv4, or null if the agent hasn't reported one yet.
export async function getGuestAgentIp({ node = process.env.PROXMOX_NODE, vmid }) {
  const data = await pveRequest("get", `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`)
    .catch(() => null);
  const ifaces = data?.result || data || [];
  for (const nic of ifaces) {
    if ((nic.name || "").toLowerCase() === "lo") continue;
    for (const addr of nic["ip-addresses"] || []) {
      const ip = addr["ip-address"];
      if (addr["ip-address-type"] === "ipv4" && ip && !ip.startsWith("127.") && !ip.startsWith("169.254.")) {
        return ip;
      }
    }
  }
  return null;
}

// Set the VM's Proxmox tags (array joined with ';'). Used to record owner,
// groups and environment so the Resources view can filter by them.
export async function setVmTags({ node = process.env.PROXMOX_NODE, vmid, tags = [] }) {
  await pveRequest("put", `/nodes/${node}/qemu/${vmid}/config`, { tags: tags.join(";") });
}

// Read a resource's raw tag string (works for VM or container).
export async function getResourceTags({ node = process.env.PROXMOX_NODE, vmid, type = "vm" }) {
  const base = type === "container" ? "lxc" : "qemu";
  const cfg = await pveRequest("get", `/nodes/${node}/${base}/${vmid}/config`).catch(() => null);
  return cfg?.tags || "";
}

// Read a resource's OS type from its config (works for VM or container).
// VMs return Proxmox ostype codes (e.g. "l26", "win11"); containers return
// the template family (e.g. "ubuntu", "debian"). Returns null if unavailable.
export async function getResourceOsType({ node = process.env.PROXMOX_NODE, vmid, type = "vm" }) {
  const base = type === "container" ? "lxc" : "qemu";
  const cfg = await pveRequest("get", `/nodes/${node}/${base}/${vmid}/config`).catch(() => null);
  return cfg?.ostype || null;
}

// Link a Proxmox snippet as the cloud-init user-data file (cicustom).
export async function setCicustom({ node = process.env.PROXMOX_NODE, vmid, file, storage = process.env.SNIPPET_STORAGE || "local" }) {
  await pveRequest("put", `/nodes/${node}/qemu/${vmid}/config`, {
    cicustom: `user=${storage}:snippets/${file}`,
  });
}

// --- LXC Container support ---
export async function cloneContainer({
  node = process.env.PROXMOX_NODE,
  templateVmid,
  newVmid,
  hostname,
  storage = "local-lvm",
}) {
  const upid = await pveRequest("post", `/nodes/${node}/lxc/${templateVmid}/clone`, {
    newid: newVmid,
    hostname,
    storage,
    full: 1,
  });
  return upid;
}

export async function configureContainer({ node = process.env.PROXMOX_NODE, vmid, cores, memory, swap, staticIp }) {
  const payload = {};
  if (cores) payload.cores = cores;
  if (memory) payload.memory = memory;
  if (swap !== undefined) payload.swap = swap;
  if (staticIp) {
    payload.net0 = `name=eth0,bridge=vmbr0,ip=${staticIp.full},gw=${staticIp.gateway}`;
    payload.nameserver = staticIp.dns;
  }
  await pveRequest("put", `/nodes/${node}/lxc/${vmid}/config`, payload);
}

export async function startContainer({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("post", `/nodes/${node}/lxc/${vmid}/status/start`);
}

// Read a running container's IPv4 from its interfaces (LXC has no guest agent;
// Proxmox exposes leased addresses directly). Returns null if none yet.
export async function getContainerIp({ node = process.env.PROXMOX_NODE, vmid }) {
  const ifaces = await pveRequest("get", `/nodes/${node}/lxc/${vmid}/interfaces`).catch(() => null);
  for (const nic of ifaces || []) {
    if ((nic.name || "").toLowerCase() === "lo") continue;
    const ip = (nic.inet || "").split("/")[0];
    if (ip && !ip.startsWith("127.") && !ip.startsWith("169.254.")) return ip;
  }
  return null;
}

// --- Lifecycle controls (VM) ---
export async function stopVm({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("post", `/nodes/${node}/qemu/${vmid}/status/stop`);
}

export async function shutdownVm({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("post", `/nodes/${node}/qemu/${vmid}/status/shutdown`);
}

export async function rebootVm({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("post", `/nodes/${node}/qemu/${vmid}/status/reboot`);
}

// Hard reset — the equivalent of pressing the physical reset button. Unlike
// reboot (which asks the guest OS to restart cleanly), this resets the machine
// immediately without notifying the guest, so it can cause data loss.
export async function resetVm({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("post", `/nodes/${node}/qemu/${vmid}/status/reset`);
}

// Poll a VM/container until Proxmox reports it stopped (or we give up). Used to
// gate a destroy behind a clean stop, since Proxmox refuses to destroy a
// running guest.
async function waitForStopped({ node = process.env.PROXMOX_NODE, vmid, type = "vm", attempts = 30, delayMs = 1000 } = {}) {
  const getStatus = type === "container" ? getContainerStatus : getVmStatus;
  for (let i = 0; i < attempts; i++) {
    const s = await getStatus({ node, vmid }).catch(() => null);
    if (!s || s.status === "stopped") return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

export async function deleteVm({ node = process.env.PROXMOX_NODE, vmid }) {
  // A running VM can't be destroyed — force-stop it first and wait until the
  // hypervisor reports it stopped before removing it.
  const status = await getVmStatus({ node, vmid }).catch(() => null);
  if (status && status.status !== "stopped") {
    const stopUpid = await pveRequest("post", `/nodes/${node}/qemu/${vmid}/status/stop`);
    await waitForTask({ node, upid: stopUpid }).catch(() => {});
    await waitForStopped({ node, vmid, type: "vm" });
  }
  // purge=1 removes the VM from all configs; destroy-unreferenced-disks cleans LVs
  const delUpid = await pveRequest("delete", `/nodes/${node}/qemu/${vmid}?purge=1&destroy-unreferenced-disks=1`);
  await waitForTask({ node, upid: delUpid }).catch(() => {});
  return delUpid;
}

// --- Lifecycle controls (Container) ---
export async function stopContainer({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("post", `/nodes/${node}/lxc/${vmid}/status/stop`);
}

export async function shutdownContainer({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("post", `/nodes/${node}/lxc/${vmid}/status/shutdown`);
}

export async function rebootContainer({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("post", `/nodes/${node}/lxc/${vmid}/status/reboot`);
}

export async function deleteContainer({ node = process.env.PROXMOX_NODE, vmid }) {
  // Same as VMs: stop a running container before destroying it.
  const status = await getContainerStatus({ node, vmid }).catch(() => null);
  if (status && status.status !== "stopped") {
    const stopUpid = await pveRequest("post", `/nodes/${node}/lxc/${vmid}/status/stop`);
    await waitForTask({ node, upid: stopUpid }).catch(() => {});
    await waitForStopped({ node, vmid, type: "container" });
  }
  const delUpid = await pveRequest("delete", `/nodes/${node}/lxc/${vmid}?purge=1&destroy-unreferenced-disks=1`);
  await waitForTask({ node, upid: delUpid }).catch(() => {});
  return delUpid;
}

// --- Inventory & metrics ---
export async function listAllVms({ node = process.env.PROXMOX_NODE }) {
  const vms = await pveRequest("get", `/nodes/${node}/qemu`);
  return vms.filter((vm) => vm.template !== 1);
}

export async function listAllContainers({ node = process.env.PROXMOX_NODE }) {
  return pveRequest("get", `/nodes/${node}/lxc`);
}

export async function getNodeStatus({ node = process.env.PROXMOX_NODE }) {
  return pveRequest("get", `/nodes/${node}/status`);
}

export async function getClusterResources() {
  return pveRequest("get", "/cluster/resources");
}

// List network interfaces on the node (bridges, VLANs, bonds, etc.). Used by
// the admin Mappings page to auto-detect available VM networks.
export async function listNetworks({ node = process.env.PROXMOX_NODE } = {}) {
  return pveRequest("get", `/nodes/${node}/network`);
}

// List cloud-init snippet files available in a storage (defaults to `local`,
// which is backed by /var/lib/vz/snippets). Returns bare filenames.
export async function listSnippets({ node = process.env.PROXMOX_NODE, storage = process.env.SNIPPET_STORAGE || "local" } = {}) {
  const items = await pveRequest(
    "get",
    `/nodes/${node}/storage/${storage}/content`,
    null,
    { content: "snippets" }
  );
  return (items || [])
    .map((i) => (i.volid || "").split("/").pop())
    .filter(Boolean);
}

export async function getContainerStatus({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("get", `/nodes/${node}/lxc/${vmid}/status/current`);
}

// Read every VM and container config and extract any IPv4 addresses that fall
// in a static ipconfig/net definition. Used to reconcile the IP pool against
// resources that CPC didn't create (e.g. manually-built VMs on Proxmox).
export async function getUsedIpsFromConfigs({ node = process.env.PROXMOX_NODE }) {
  const ips = new Set();
  const ipRegex = /ip=(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g;

  const extract = (configObj) => {
    for (const [key, val] of Object.entries(configObj || {})) {
      if (typeof val !== "string") continue;
      // VM cloud-init uses ipconfig0..N; LXC uses net0..N
      if (key.startsWith("ipconfig") || key.startsWith("net")) {
        let m;
        while ((m = ipRegex.exec(val)) !== null) {
          ips.add(m[1]);
        }
      }
    }
  };

  const [vms, cts] = await Promise.all([
    pveRequest("get", `/nodes/${node}/qemu`).catch(() => []),
    pveRequest("get", `/nodes/${node}/lxc`).catch(() => []),
  ]);

  await Promise.all([
    ...vms.map((vm) =>
      pveRequest("get", `/nodes/${node}/qemu/${vm.vmid}/config`).then(extract).catch(() => {})
    ),
    ...cts.map((ct) =>
      pveRequest("get", `/nodes/${node}/lxc/${ct.vmid}/config`).then(extract).catch(() => {})
    ),
  ]);

  return ips;
}

// Live getter — reflects the current (possibly runtime-updated) node name.
export const getPveNode = () => process.env.PROXMOX_NODE;

// Lightweight connectivity check for the admin Settings tab. Forces a fresh
// auth against the current config and reads node status; returns node info or
// throws with the Proxmox error message.
export async function testConnection() {
  ticket = null;
  ticketExpiry = 0;
  const status = await getNodeStatus({});
  return {
    node: process.env.PROXMOX_NODE,
    host: process.env.PROXMOX_HOST,
    uptime: status?.uptime ?? null,
    pveversion: status?.pveversion ?? null,
  };
}
