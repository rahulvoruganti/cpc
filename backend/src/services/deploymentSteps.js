import { etaFor, recordDuration } from "./stepTimingsStore.js";

// The Colruyt security baseline installed on every server, regardless of what
// the user requests. Surfaced (read-only) in the provisioning form too.
export const DEFAULT_AGENTS = [
  { id: "defender", name: "Microsoft Defender for Endpoint", pkg: "mdatp" },
  { id: "omi", name: "OMI Client", pkg: "omi" },
  { id: "guardicore", name: "Guardicore Agent", pkg: "guardicore-agent" },
];

// Canonical deployment steps with impactful, human statements. `active` shows
// while the step runs; `done` after it finishes. `eta` is the seed estimate
// (seconds) used until we've learned real timings for a template.
export const VM_STEP_DEFS = [
  { key: "submitted",          label: "Request submitted",     active: "Receiving your new-server request…",                                  done: "New server request submitted",                 eta: 2,  group: "request" },
  { key: "approval",           label: "Approvals",             active: "Checking approval requirements…",                                     done: "Standard request — auto-approved",             eta: 2,  group: "request" },
  { key: "approved",           label: "Approved",              active: "Locking in the approval…",                                            done: "Request approved — kicking off the build",     eta: 1,  group: "request" },
  { key: "provision_vm",       label: "Provisioning the VM",   active: "Carving out your virtual machine on the cluster…",                    done: "Virtual machine provisioned",                  eta: 45, group: "build" },
  { key: "deploy_os",          label: "Deploying the OS",      active: "Laying down the golden OS image…",                                    done: "Operating system deployed",                    eta: 40, group: "build" },
  { key: "allocate_resources", label: "Allocating resources",  active: "Dialing in your CPU, memory and storage…",                            done: "Requested resources allocated",                eta: 15, group: "build" },
  { key: "assign_ip",          label: "Assigning IP address",  active: "Wiring your machine into the network…",                               done: "Network attached (DHCP)",                      eta: 12, group: "build" },
  { key: "power_on",           label: "Powering on",           active: "Powering on your virtual machine…",                                   done: "Powered on",                                   eta: 10, group: "boot" },
  { key: "system_startup",     label: "System startup",        active: "Waiting for the system to come alive…",                               done: "System is online",                             eta: 90, group: "boot" },
  { key: "initial_setup",      label: "Initial setup",         active: "Running first-boot initialization and creating your account…",        done: "Initial setup complete",                       eta: 25, group: "config" },
  { key: "default_packages",   label: "Security baseline",     active: "Hardening with the Colruyt baseline — Defender, OMI Client, Guardicore…", done: "Security baseline installed",              eta: 45, group: "config" },
  { key: "requested_packages", label: "Requested software",    active: "Installing your requested software…",                                 done: "Requested software installed",                 eta: 35, group: "config" },
  { key: "validate",           label: "Validation",            active: "Running final health checks on your server…",                         done: "Server validated end-to-end",                  eta: 15, group: "config" },
  { key: "summarize",          label: "Summary",               active: "Wrapping up and preparing your summary…",                             done: "All done — your server is ready 🎉",           eta: 3,  group: "done" },
];

function nowIso() { return new Date().toISOString(); }

// Build the initial step list for a job, seeding each step's ETA from the
// learned-timings cache for this template (falling back to the seed default).
export function buildVmSteps(templateKey) {
  return VM_STEP_DEFS.map((d) => ({
    key: d.key,
    label: d.label,
    active: d.active,
    done: d.done,
    group: d.group,
    state: "pending",              // pending | active | done | skipped | failed
    etaSec: etaFor(templateKey, d.key, d.eta),
    startedAt: null,
    endedAt: null,
    tookSec: null,
  }));
}

// A tracker the provisioner drives (start/done/skip/fail). It keeps the steps
// array current, streams a snapshot to the job via `emit`, and records each
// completed step's real duration back into the timings cache for future ETAs.
export function createStepTracker({ templateKey, emit }) {
  const steps = buildVmSteps(templateKey);
  const at = (key) => steps.find((s) => s.key === key);
  const snapshot = () => steps.map((s) => ({ ...s }));
  const push = (extra = {}) => emit({ steps: snapshot(), ...extra });

  return {
    steps,
    snapshot,

    start(key, activeOverride) {
      const s = at(key); if (!s) return;
      s.state = "active";
      s.startedAt = nowIso();
      if (activeOverride) s.active = activeOverride;
      push({ status: "provisioning", message: s.active });
    },

    done(key, { done, detail } = {}) {
      const s = at(key); if (!s) return;
      if (!s.startedAt) s.startedAt = nowIso();
      s.endedAt = nowIso();
      s.tookSec = Math.max(0, Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 1000));
      s.state = "done";
      if (done) s.done = done;
      if (detail) s.detail = detail;
      recordDuration(templateKey, key, s.tookSec);
      push({ message: s.done });
    },

    // Instant start+done for the near-zero request/approval steps.
    quickDone(key, opts) { this.start(key); this.done(key, opts); },

    skip(key, { done } = {}) {
      const s = at(key); if (!s) return;
      s.state = "skipped";
      if (done) s.done = done;
      push();
    },

    // Soft stop (VM created but unreachable): mark the active step failed and
    // skip the rest, without failing the whole deployment.
    stall(message) {
      const active = steps.find((s) => s.state === "active");
      if (active) { active.state = "failed"; active.endedAt = nowIso(); }
      steps.forEach((s) => { if (s.state === "pending") s.state = "skipped"; });
      push(message ? { message } : {});
    },

    // Hard failure: mark the active step failed, skip the rest, fail the job.
    fail(message, error) {
      const active = steps.find((s) => s.state === "active");
      if (active) { active.state = "failed"; active.endedAt = nowIso(); }
      steps.forEach((s) => { if (s.state === "pending") s.state = "skipped"; });
      emit({ status: "failed", message: message || "Deployment failed", error, steps: snapshot() });
    },
  };
}
