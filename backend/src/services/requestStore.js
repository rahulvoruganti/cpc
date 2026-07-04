import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { createJob, getJob } from "./jobStore.js";
import { runVmJob, runContainerJob, runStackJob, runInternalJob } from "./provisioner.js";
import * as pve from "./proxmoxService.js";
import { notifyAdmins, notifyUser } from "./notificationStore.js";

// Short label for a request, used in notification titles.
function targetOf(request) {
  const p = request?.payload || {};
  return p.hostname || p.hostnamePrefix || p.templateId || p.stackId
    || (p.vmid ? `VMID ${p.vmid}` : null) || request?.id;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const REQUEST_FILE = path.join(DATA_DIR, "requests.json");

const requests = new Map();

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(REQUEST_FILE)) {
    fs.writeFileSync(REQUEST_FILE, JSON.stringify({ requests: [] }, null, 2));
  }
}

// Load persisted requests into the in-memory Map at startup.
function hydrate() {
  ensureStore();
  try {
    const { requests: saved = [] } = JSON.parse(fs.readFileSync(REQUEST_FILE, "utf-8"));
    for (const req of saved) requests.set(req.id, req);
  } catch (err) {
    console.error("[requestStore] failed to load requests.json:", err.message);
  }
}

// Persist the full Map back to disk. Called after every mutation.
function persist() {
  ensureStore();
  const payload = { requests: Array.from(requests.values()) };
  fs.writeFileSync(REQUEST_FILE, JSON.stringify(payload, null, 2));
}

hydrate();

const POLICY = {
  cpu: Number(process.env.APPROVAL_CPU_THRESHOLD || 2),
  memoryGB: Number(process.env.APPROVAL_MEMORY_GB_THRESHOLD || 4),
  diskGB: Number(process.env.APPROVAL_DISK_GB_THRESHOLD || 50),
};

// Approval gate. When "Auto-approve all deployments" is on (the boolNegated
// setting is anything but the string "false"), every request skips the gate.
// When it's off, a request that exceeds any threshold (CPU, RAM or disk) is
// paused for admin approval; within-limits requests auto-provision.
const AUTO_APPROVE = process.env.AUTO_APPROVE_DEPLOYMENTS !== "false";

function requiresApproval(payload = {}) {
  if (AUTO_APPROVE) return false;
  const cpu = Number(payload.cpu || 0);
  const memoryGB = Number(payload.memoryGB || 0);
  const diskGB = Number(payload.diskGB || 0);
  return cpu > POLICY.cpu || memoryGB > POLICY.memoryGB || diskGB > POLICY.diskGB;
}

// Public helper: does a resize to these target totals need admin approval?
// Reuses the same size policy as new-VM provisioning (evaluated on the target).
export function resizeNeedsApproval(target = {}) {
  return requiresApproval(target);
}

function buildRequest({ kind, payload, requestedBy, source = "portal" }) {
  const now = new Date().toISOString();
  const needsApproval = requiresApproval(payload);
  const id = nanoid(12);

  const request = {
    id,
    kind,
    payload,
    requestedBy,
    source,
    status: needsApproval ? "pending_approval" : "approved",
    requiresApproval: needsApproval,
    policy: { ...POLICY },
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    jobId: null,
    createdAt: now,
    updatedAt: now,
  };

  requests.set(id, request);
  persist();
  return request;
}

function runProvisioningForRequest(request) {
  const job = createJob(request.kind, {
    ...request.payload,
    requestedBy: request.requestedBy,
    requestId: request.id,
    autoApproved: !request.requiresApproval,
    approvedBy: request.approvedBy || null,
  });

  // Pass the job payload (which carries requestedBy) so the provisioner can tag
  // the VM with the owner's username and groups.
  if (request.kind === "internal") {
    runInternalJob(job.id, job.payload);
  } else if (request.kind === "vm") {
    runVmJob(job.id, job.payload);
  } else if (request.kind === "container") {
    runContainerJob(job.id, job.payload);
  } else {
    runStackJob(job.id, job.payload);
  }

  request.jobId = job.id;
  request.status = "provisioning";
  request.updatedAt = new Date().toISOString();
  persist();
  return job;
}

function syncRequestStatus(request) {
  if (!request || !request.jobId) return request;
  const job = getJob(request.jobId);
  if (!job) return request;

  let next;
  if (job.status === "ready") next = "completed";
  else if (job.status === "failed") next = "failed";
  else next = "provisioning";

  if (next !== request.status) {
    request.status = next;
    request.updatedAt = new Date().toISOString();
    persist();
  }
  return request;
}

export function submitProvisionRequest({ kind, payload, requestedBy, source = "portal" }) {
  const request = buildRequest({ kind, payload, requestedBy, source });
  let job = null;
  if (!request.requiresApproval) {
    job = runProvisioningForRequest(request);
  } else {
    // Over the size policy — tell the admins there's something to review.
    const verb = kind === "resize" ? "resize" : "provision";
    notifyAdmins({
      type: "approval",
      title: `Approval needed — ${targetOf(request)}`,
      message: `${requestedBy} requested to ${verb} ${targetOf(request)}. Review and approve or reject.`,
      link: `/requests?review=${request.id}`,
      meta: { requestId: request.id, kind },
    });
  }
  return { request: syncRequestStatus(request), job };
}

export function listProvisionRequests(user) {
  const all = Array.from(requests.values()).map((r) => syncRequestStatus(r));
  const visible = user?.role === "admin" ? all : all.filter((r) => r.requestedBy === user.username);
  return visible.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getProvisionRequest(id) {
  const req = requests.get(id);
  return syncRequestStatus(req);
}

export async function approveProvisionRequest({ id, approver }) {
  const request = requests.get(id);
  if (!request) return null;
  if (!request.requiresApproval || request.status !== "pending_approval") {
    return { request: syncRequestStatus(request), job: null };
  }

  request.status = "approved";
  request.approvedBy = approver;
  request.approvedAt = new Date().toISOString();
  request.updatedAt = new Date().toISOString();
  request.rejectedBy = null;
  request.rejectedAt = null;
  request.rejectionReason = null;
  persist();

  // Resize requests don't spawn a provisioning job — apply the new specs to the
  // live resource, then wait for the owner to trigger the reboot.
  if (request.kind === "resize") {
    await applyResizeRequest(request);
    return { request: syncRequestStatus(request), job: null };
  }

  const job = runProvisioningForRequest(request);
  notifyUser(request.requestedBy, {
    type: "approved",
    title: `Request approved — ${targetOf(request)}`,
    message: `Your ${request.kind} request was approved and is now provisioning.`,
    link: "/deployments",
    meta: { requestId: request.id, jobId: job?.id || null },
  });
  return { request: syncRequestStatus(request), job };
}

// Apply an approved resize to the live resource, then move it to
// "awaiting_reboot" and notify the owner to trigger the reboot.
async function applyResizeRequest(request) {
  const p = request.payload || {};
  try {
    const edit = p.type === "container" ? pve.editContainer : pve.editVm;
    const specs = { vmid: p.vmid };
    if (p.cpu != null) specs.cores = Number(p.cpu);
    if (p.memoryGB != null) specs.memory = Number(p.memoryGB) * 1024;
    // Disk can only grow — only pass it when the target exceeds the current size.
    if (p.diskGB != null && (!p.current?.diskGB || Number(p.diskGB) > Number(p.current.diskGB))) {
      specs.diskGB = Number(p.diskGB);
    }
    await edit(specs);

    request.status = "awaiting_reboot";
    request.updatedAt = new Date().toISOString();
    persist();

    notifyUser(request.requestedBy, {
      type: "resize_approved",
      title: `Resize approved — ${targetOf(request)}`,
      message: `Your resize was applied. Reboot ${targetOf(request)} now to bring the new resources online.`,
      link: `/resources?reboot=${p.vmid}&request=${request.id}`,
      meta: { requestId: request.id, vmid: p.vmid },
    });
  } catch (err) {
    request.status = "failed";
    request.error = err.message;
    request.updatedAt = new Date().toISOString();
    persist();
    notifyUser(request.requestedBy, {
      type: "resize_failed",
      title: `Resize failed — ${targetOf(request)}`,
      message: err.message,
      link: "/requests",
      meta: { requestId: request.id },
    });
    throw err;
  }
}

// Owner (or admin) confirms the reboot for an approved-and-applied resize.
export async function confirmResizeReboot({ id, actor }) {
  const request = requests.get(id);
  if (!request || request.kind !== "resize") return null;
  if (request.status !== "awaiting_reboot") return { request: syncRequestStatus(request) };

  const p = request.payload || {};
  const reboot = p.type === "container" ? pve.rebootContainer : pve.rebootVm;
  await reboot({ vmid: p.vmid });

  request.status = "completed";
  request.rebootedBy = actor;
  request.updatedAt = new Date().toISOString();
  persist();
  return { request: syncRequestStatus(request) };
}

export function rejectProvisionRequest({ id, reviewer, reason = "Rejected by admin" }) {
  const request = requests.get(id);
  if (!request) return null;
  if (request.status !== "pending_approval") return syncRequestStatus(request);

  request.status = "rejected";
  request.rejectedBy = reviewer;
  request.rejectedAt = new Date().toISOString();
  request.rejectionReason = reason;
  request.updatedAt = new Date().toISOString();
  persist();

  notifyUser(request.requestedBy, {
    type: "rejected",
    title: `Request rejected — ${targetOf(request)}`,
    message: reason,
    link: "/requests",
    meta: { requestId: request.id },
  });
  return syncRequestStatus(request);
}
