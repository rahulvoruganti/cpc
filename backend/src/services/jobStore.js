import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { setOwner } from "./ownershipStore.js";
import { setDefaultExpiry } from "./expiryStore.js";
import { createIncident } from "./servicenowService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

// Cap how many deployments we retain so the history file stays bounded.
const MAX_JOBS = Number(process.env.MAX_JOBS_HISTORY || 1000);

const jobs = new Map();

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(JOBS_FILE)) {
    fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [] }, null, 2));
  }
}

// Load deployment history into memory at startup. Any job that was still
// in-flight when the server stopped is marked failed — the process that was
// running it is gone, so it can never complete.
function hydrate() {
  ensureStore();
  let changed = false;
  try {
    const { jobs: saved = [] } = JSON.parse(fs.readFileSync(JOBS_FILE, "utf-8"));
    for (const j of saved) {
      if (j.status !== "ready" && j.status !== "failed") {
        const ts = new Date().toISOString();
        j.status = "failed";
        j.message = "Interrupted";
        j.error = "Interrupted by a server restart before completion";
        j.updatedAt = ts;
        if (!Array.isArray(j.logs)) j.logs = [];
        j.logs.push({ ts, status: "failed", message: j.error, error: j.error });
        changed = true;
      }
      jobs.set(j.id, j);
    }
  } catch (err) {
    console.error("[jobStore] failed to load jobs.json:", err.message);
  }
  if (changed) persist();
}

// Write the full history back to disk, trimming to the most recent MAX_JOBS.
function persist() {
  ensureStore();
  if (jobs.size > MAX_JOBS) {
    const ordered = Array.from(jobs.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const stale of ordered.slice(MAX_JOBS)) jobs.delete(stale.id);
  }
  fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: Array.from(jobs.values()) }, null, 2));
}

hydrate();

export function createJob(type, payload) {
  const id = nanoid(10);
  const now = new Date().toISOString();
  const job = {
    id,
    type, // 'vm' | 'container' | 'stack'
    payload,
    status: "pending", // pending -> provisioning -> configuring -> starting -> ready -> failed
    message: "Queued",
    resources: [], // list of { vmid, hostname, type }
    error: null,
    // Timestamped, append-only trail of every step the job goes through, so
    // the UI can render step-by-step logs rather than just the latest message.
    logs: [{ ts: now, status: "pending", message: "Queued" }],
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(id, job);
  persist();
  return job;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;

  const prevStatus = job.status;
  const prevMessage = job.message;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });

  // Append a step entry whenever the status or the human message changes (or an
  // error arrives). Repeated no-op updates (e.g. resource list refreshes) don't
  // add noise to the log.
  const statusChanged = patch.status !== undefined && patch.status !== prevStatus;
  const messageChanged = patch.message !== undefined && patch.message !== prevMessage;
  if (statusChanged || messageChanged || patch.error) {
    if (!Array.isArray(job.logs)) job.logs = [];
    job.logs.push({
      ts: new Date().toISOString(),
      status: job.status,
      message: patch.message || job.message,
      ...(patch.error ? { error: patch.error } : {}),
    });
  }

  // On the transition into "failed", raise a ServiceNow incident (mocked) once
  // and attach it to the job so the UI can notify the user with its number.
  // Returns null when ServiceNow incidents are disabled in Settings.
  if (patch.status === "failed" && prevStatus !== "failed" && !job.incident) {
    const host = job.payload?.hostname || job.payload?.hostnamePrefix || `job ${job.id}`;
    const incident = createIncident({
      shortDescription: `CPC provisioning failed: ${host}`,
      description: job.error || job.message || "Provisioning failed",
      callerId: job.payload?.requestedBy || "cpc-portal",
      jobId: job.id,
    });
    if (incident) {
      job.incident = incident;
      if (!Array.isArray(job.logs)) job.logs = [];
      job.logs.push({
        ts: new Date().toISOString(),
        status: "failed",
        message: `ServiceNow incident ${incident.number} raised for this failure.`,
      });
    }
  }

  // Record ownership for any newly-known resources so users can see what
  // they created. requestedBy is set on the job payload at creation time.
  const owner = job.payload?.requestedBy;
  if (owner && Array.isArray(job.resources)) {
    for (const r of job.resources) {
      if (r.vmid) {
        setOwner(r.vmid, { username: owner, hostname: r.hostname });
        // Honour the lifetime the requester chose on the provisioning form.
        // "Permanent" resources get no expiry record — they're never swept.
        if (!job.payload?.permanent) {
          setDefaultExpiry(r.vmid, { setBy: owner, ttlDays: job.payload?.ttlDays, type: r.type }); // no-op if already set
        }
      }
    }
  }

  persist();
  return job;
}

// A deployment that hasn't reached a terminal state within this window is
// considered stuck and is moved to "failed" (timed out).
const STUCK_TIMEOUT_MS = Number(process.env.JOB_STUCK_TIMEOUT_MS || 30 * 60 * 1000);

// A finished job is "accessible" only if every resource answered on SSH.
function isAccessible(job) {
  const res = job.resources || [];
  return res.length > 0 && res.every((r) => r.sshReady);
}

// Map a job's state to one of the deployment categories the monitor shows.
//   running     -> still provisioning (not yet categorized)
//   successful  -> up and accessible
//   pending     -> created but unaccessible (SSH never came up)
//   failed      -> create/power-on failed, or timed out
export function categoryOf(job) {
  if (job.status === "failed") return "failed";
  if (job.status === "ready") return isAccessible(job) ? "successful" : "pending";
  return "running";
}

// If an in-flight job has been stuck on the same step past the timeout, fail it.
function enforceTimeout(job) {
  if (job.status === "ready" || job.status === "failed") return;
  const stale = Date.now() - new Date(job.updatedAt).getTime();
  if (stale > STUCK_TIMEOUT_MS) {
    updateJob(job.id, {
      status: "failed",
      message: "Timed out",
      error: `Timed out — stuck at "${job.message}" for over ${Math.round(STUCK_TIMEOUT_MS / 60000)} minutes`,
    });
  }
}

// Return a read-only view of the job with its derived category attached.
function annotate(job) {
  return { ...job, category: categoryOf(job) };
}

export function getJob(id) {
  const job = jobs.get(id);
  if (!job) return undefined;
  enforceTimeout(job);
  return annotate(job);
}

export function listJobs() {
  const arr = Array.from(jobs.values());
  arr.forEach(enforceTimeout);
  return arr
    .map(annotate)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

