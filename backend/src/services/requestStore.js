import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { createJob, getJob } from "./jobStore.js";
import { runVmJob, runContainerJob, runStackJob, runInternalJob } from "./provisioner.js";

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

// Deployments are auto-approved by default — no admin gate. Set
// AUTO_APPROVE_DEPLOYMENTS=false to re-enable the size-based approval policy.
const AUTO_APPROVE = process.env.AUTO_APPROVE_DEPLOYMENTS !== "false";

function requiresApproval(payload = {}) {
  if (AUTO_APPROVE) return false;
  const cpu = Number(payload.cpu || 0);
  const memoryGB = Number(payload.memoryGB || 0);
  const diskGB = Number(payload.diskGB || 0);
  return cpu > POLICY.cpu || memoryGB > POLICY.memoryGB || diskGB > POLICY.diskGB;
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

export function approveProvisionRequest({ id, approver }) {
  const request = requests.get(id);
  if (!request) return null;
  if (!request.requiresApproval || request.status !== "pending_approval") return syncRequestStatus(request);

  request.status = "approved";
  request.approvedBy = approver;
  request.approvedAt = new Date().toISOString();
  request.updatedAt = new Date().toISOString();
  request.rejectedBy = null;
  request.rejectedAt = null;
  request.rejectionReason = null;
  persist();

  const job = runProvisioningForRequest(request);
  return { request: syncRequestStatus(request), job };
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
  return syncRequestStatus(request);
}
