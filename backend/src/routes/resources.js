import { Router } from "express";
import * as pve from "../services/proxmoxService.js";
import { logAudit } from "../services/auditService.js";
import { requireAuth } from "../middleware/auth.js";
import { getOwner, removeOwner, allOwners, setOwnerIp } from "../services/ownershipStore.js";
import { getExpiry, extendExpiry, removeExpiry } from "../services/expiryStore.js";
import { canSeeTags } from "../services/visibility.js";
import { parseTags } from "../services/tags.js";

const router = Router();
router.use(requireAuth);

// Visibility is tag-driven: admins see everything; everyone else sees a
// resource only if its Proxmox tags include their user tag or a group tag.
// Works on raw Proxmox items (tags = string) or normalized items (tags = array).
function filterByVisibility(items, user) {
  if (user.role === "admin") return items;
  return items.filter((i) => canSeeTags(i.tags, user));
}

// OS lookups hit the Proxmox config API (one request per resource), so we
// cache the resolved, human-friendly label by VMID. A VM's OS effectively
// never changes, so the cache lives for the process lifetime and is only
// cleared when a resource is deleted.
const osCache = new Map();

// Turn a raw Proxmox ostype into something readable. Containers report the
// template family already (ubuntu/debian/...); VMs report short codes.
function prettyOs(ostype, type) {
  if (!ostype) return null;
  if (type === "container") {
    return ostype.charAt(0).toUpperCase() + ostype.slice(1);
  }
  const vmMap = {
    l24: "Linux 2.4",
    l26: "Linux",
    other: "Other",
    solaris: "Solaris",
    wxp: "Windows XP",
    w2k: "Windows 2000",
    w2k3: "Windows 2003",
    w2k8: "Windows 2008",
    wvista: "Windows Vista",
    win7: "Windows 7",
    win8: "Windows 8",
    win10: "Windows 10",
    win11: "Windows 11",
  };
  return vmMap[ostype] || ostype;
}

// Attach an `os` label to each resource, fetching (and caching) the config
// ostype only for resources we haven't seen before.
async function enrichOs(items) {
  await Promise.all(
    items.map(async (r) => {
      if (osCache.has(r.vmid)) {
        r.os = osCache.get(r.vmid);
        return;
      }
      const ostype = await pve
        .getResourceOsType({ vmid: r.vmid, type: r.type })
        .catch(() => null);
      const os = prettyOs(ostype, r.type);
      osCache.set(r.vmid, os);
      r.os = os;
    })
  );
}

// The Connect button and terminal need a VM's IP. It's recorded at provision
// time, but VMs created outside the provisioner (or ones whose guest agent
// hadn't reported an address yet) have no stored IP. For running VMs missing an
// IP, do a live guest-agent lookup and persist it so the Resources list shows
// the Connect action and the terminal route resolves the host without a second
// lookup. Only VMs are probed — the guest-agent endpoint is qemu-specific.
async function enrichIps(items) {
  await Promise.all(
    items.map(async (r) => {
      if (r.ip || r.type !== "vm" || r.status !== "running") return;
      const ip = await pve.getGuestAgentIp({ vmid: r.vmid }).catch(() => null);
      if (ip) {
        r.ip = ip;
        setOwnerIp(r.vmid, ip);
      }
    })
  );
}

// Expiry metadata surfaced to the UI: when it expires, whether it's already
// expired, and how many whole days remain (negative once past due).
function expiryFields(vmid) {
  const rec = getExpiry(vmid);
  if (!rec) return { expiresAt: null, expired: false, daysLeft: null };
  const ms = new Date(rec.expiresAt).getTime() - Date.now();
  return {
    expiresAt: rec.expiresAt,
    expired: ms <= 0,
    daysLeft: Math.ceil(ms / 86400_000),
  };
}

// --- Dashboard metrics ---
router.get("/dashboard", async (req, res) => {
  try {
    const [allVms, allContainers] = await Promise.all([
      pve.listAllVms({}),
      pve.listAllContainers({}),
    ]);

    const vms = filterByVisibility(allVms, req.user);
    const containers = filterByVisibility(allContainers, req.user);

    const runningVms = vms.filter((v) => v.status === "running").length;
    const runningCts = containers.filter((c) => c.status === "running").length;

    // Node-level metrics require Sys.Audit on Proxmox and are only meaningful
    // for admins. If the API user lacks the permission, this resolves to null
    // and the dashboard simply omits the node health section.
    let node = null;
    if (req.user.role === "admin") {
      const nodeStatus = await pve.getNodeStatus({}).catch(() => null);
      if (nodeStatus) {
        node = {
          cpu: nodeStatus.cpu,
          memoryUsed: nodeStatus.memory?.used,
          memoryTotal: nodeStatus.memory?.total,
          uptime: nodeStatus.uptime,
          loadavg: nodeStatus.loadavg,
        };
      }
    }

    res.json({
      scope: req.user.role === "admin" ? "all" : "owned",
      counts: {
        vms: vms.length,
        containers: containers.length,
        running: runningVms + runningCts,
        stopped: (vms.length - runningVms) + (containers.length - runningCts),
      },
      node,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Inventory ---
router.get("/resources", async (req, res) => {
  try {
    const [allVms, allContainers] = await Promise.all([
      pve.listAllVms({}),
      pve.listAllContainers({}),
    ]);
    const norm = (item, type) => ({
      vmid: item.vmid,
      name: item.name,
      type,
      status: item.status,
      cpu: item.cpus || item.maxcpu,
      maxmem: item.maxmem,
      maxdisk: item.maxdisk,
      uptime: item.uptime,
      owner: getOwner(item.vmid)?.username || null,
      ip: getOwner(item.vmid)?.ip || null,
      tags: parseTags(item.tags),
      maxdiskGB: item.maxdisk ? Math.round(item.maxdisk / 1024 ** 3) : null,
      memGB: item.maxmem ? Math.round(item.maxmem / 1024 ** 3) : null,
      os: null,
      ...expiryFields(item.vmid),
    });
    const combined = [
      ...allVms.map((v) => norm(v, "vm")),
      ...allContainers.map((c) => norm(c, "container")),
    ];
    // Only resolve OS for resources the caller can actually see, so non-admins
    // don't trigger config reads across the whole node.
    const visible = filterByVisibility(combined, req.user);
    await Promise.all([enrichOs(visible), enrichIps(visible)]);
    res.json(visible);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Lifecycle actions ---
// type = 'vm' | 'container', action = start|stop|shutdown|reboot|reset|delete
// (reset = hard reset, VM-only — LXC has no equivalent Proxmox endpoint)
const ACTIONS = {
  vm: {
    start: pve.startVm,
    stop: pve.stopVm,
    shutdown: pve.shutdownVm,
    reboot: pve.rebootVm,
    reset: pve.resetVm,
    delete: pve.deleteVm,
  },
  container: {
    start: pve.startContainer,
    stop: pve.stopContainer,
    shutdown: pve.shutdownContainer,
    reboot: pve.rebootContainer,
    delete: pve.deleteContainer,
  },
};

router.post("/resources/:type/:vmid/:action", async (req, res) => {
  const { type, vmid, action } = req.params;
  const fn = ACTIONS[type]?.[action];
  if (!fn) {
    return res.status(400).json({ error: `Invalid type/action: ${type}/${action}` });
  }

  const numericVmid = Number(vmid);
  const isAdmin = req.user.role === "admin";

  // Non-admins may only act on resources visible to them by tag (their own
  // user tag or a group tag). Consistent with what they see in the list.
  if (!isAdmin) {
    const tags = await pve.getResourceTags({ vmid: numericVmid, type }).catch(() => "");
    if (!canSeeTags(tags, req.user)) {
      return res.status(403).json({ error: "You can only manage resources assigned to you or your group" });
    }
  }

  // Starting a resource is admin-only. Users can reboot/shutdown their own
  // running resources, but bringing a stopped one back up is an admin action
  // (this is what enforces the expiry policy — once a resource is shut down
  // for expiring, only an admin can start it again, typically after extending).
  if (action === "start" && !isAdmin) {
    return res.status(403).json({ error: "Only admins can start a stopped resource" });
  }

  // Deleting is admin-only.
  if (action === "delete" && !isAdmin) {
    return res.status(403).json({ error: "Only admins can delete resources" });
  }

  try {
    await fn({ vmid: numericVmid });
    if (action === "delete") {
      removeOwner(numericVmid);
      removeExpiry(numericVmid);
      osCache.delete(numericVmid);
    }
    logAudit({
      actor: req.user,
      action: `${type}.${action}`,
      target: `VMID ${vmid}`,
      status: "success",
    });
    res.json({ ok: true });
  } catch (err) {
    logAudit({
      actor: req.user,
      action: `${type}.${action}`,
      target: `VMID ${vmid}`,
      status: "failure",
      detail: { error: err.message },
    });
    res.status(502).json({ error: err.message });
  }
});

// --- Edit resource specs ---
// Owners and admins may resize CPU/RAM (and grow disk) on their resources.
// cores/memory hot-apply where the guest supports it; disk can only grow.
router.put("/resources/:type/:vmid/config", async (req, res) => {
  const { type, vmid } = req.params;
  if (type !== "vm" && type !== "container") {
    return res.status(400).json({ error: `Invalid type: ${type}` });
  }

  const numericVmid = Number(vmid);
  const isAdmin = req.user.role === "admin";
  if (!isAdmin) {
    const tags = await pve.getResourceTags({ vmid: numericVmid, type }).catch(() => "");
    if (!canSeeTags(tags, req.user)) {
      return res.status(403).json({ error: "You can only edit resources assigned to you or your group" });
    }
  }

  const cores = req.body?.cpu != null ? Number(req.body.cpu) : undefined;
  const memoryGB = req.body?.memoryGB != null ? Number(req.body.memoryGB) : undefined;
  const diskGB = req.body?.diskGB != null ? Number(req.body.diskGB) : undefined;

  if (cores === undefined && memoryGB === undefined && diskGB === undefined) {
    return res.status(400).json({ error: "Provide at least one of cpu, memoryGB, diskGB" });
  }
  if ([cores, memoryGB, diskGB].some((v) => v !== undefined && (!Number.isFinite(v) || v <= 0))) {
    return res.status(400).json({ error: "cpu, memoryGB and diskGB must be positive numbers" });
  }

  const edit = type === "vm" ? pve.editVm : pve.editContainer;
  try {
    await edit({
      vmid: numericVmid,
      cores,
      memory: memoryGB !== undefined ? memoryGB * 1024 : undefined,
      diskGB,
    });
    logAudit({
      actor: req.user,
      action: `${type}.edit`,
      target: `VMID ${vmid}`,
      status: "success",
      detail: { cpu: cores, memoryGB, diskGB },
    });
    res.json({ ok: true });
  } catch (err) {
    logAudit({
      actor: req.user,
      action: `${type}.edit`,
      target: `VMID ${vmid}`,
      status: "failure",
      detail: { error: err.message },
    });
    res.status(502).json({ error: err.message });
  }
});

// --- Extend expiry (admin only) ---
router.post("/resources/:type/:vmid/extend", (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Only admins can change a resource's expiry" });
  }
  const numericVmid = Number(req.params.vmid);
  const days = req.body?.days != null ? Number(req.body.days) : undefined;
  if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
    return res.status(400).json({ error: "days must be a positive number" });
  }

  const record = extendExpiry(numericVmid, { days, setBy: req.user.username });
  logAudit({
    actor: req.user,
    action: "resource.extend",
    target: `VMID ${req.params.vmid}`,
    status: "success",
    detail: { expiresAt: record.expiresAt, days: days ?? "default" },
  });
  res.json({ ok: true, expiresAt: record.expiresAt });
});

export default router;
