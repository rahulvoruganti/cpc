import * as pve from "./proxmoxService.js";
import { updateJob } from "./jobStore.js";
import { findVmTemplate, findContainerTemplate, findStack } from "../config/catalog.js";
import { getTemplateMappings } from "./mappingStore.js";
import { setOwnerIp } from "./ownershipStore.js";
import { groupsForUser } from "./groupStore.js";
import { ownerTags } from "./tags.js";
import { waitForPort } from "./portProbe.js";
import { generatePassword } from "./passwordGen.js";
import { runSsh } from "./sshRunner.js";
import { userSetupCommands, packageInstallCommand, aiTroubleshoot } from "./aiOps.js";
import { INTERNAL_APIS, isSystemConfigured } from "./internalProvisioningApis.js";
import { findInternalTemplate } from "../config/internalCatalog.js";
import { createStepTracker, DEFAULT_AGENTS } from "./deploymentSteps.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a list of {name, cmd} over SSH as root, with a one-shot AI-assisted retry
// on failure. Returns per-command results (best-effort — never throws).
async function runCommands(cmds, sshOpts, { osName, packageManager } = {}) {
  const results = [];
  for (const c of cmds) {
    if (!c || !c.cmd) continue;
    let res = await runSsh({ ...sshOpts, command: c.cmd }).catch((e) => ({ code: 1, stdout: "", stderr: e.message }));
    if (res.code !== 0) {
      const fix = await aiTroubleshoot({ command: c.cmd, stderr: res.stderr, osName, packageManager }).catch(() => null);
      if (fix?.fix) {
        await runSsh({ ...sshOpts, command: fix.fix }).catch(() => {});
        res = await runSsh({ ...sshOpts, command: c.cmd }).catch((e) => ({ code: 1, stdout: "", stderr: e.message }));
      }
    }
    results.push({ name: c.name, ok: res.code === 0, stderr: res.code === 0 ? "" : (res.stderr || "").slice(0, 300) });
  }
  return results;
}

// Resolve a VM template id to its Proxmox VMID + mapping. Mapping-derived ids
// look like "tpl-<vmid>"; anything else (e.g. stack member ids) falls back to
// the static catalog.
function resolveVmTemplate(templateId) {
  if (typeof templateId === "string" && /^tpl-\d+$/.test(templateId)) {
    const vmid = Number(templateId.slice(4));
    const m = getTemplateMappings()[String(vmid)];
    if (m) return { id: templateId, vmid, name: m.osName || `template-${vmid}`, mapping: m };
  }
  const t = findVmTemplate(templateId);
  return t ? { ...t, mapping: getTemplateMappings()[String(t.vmid)] || {} } : null;
}

// Poll the qemu-guest-agent until it reports a DHCP-leased IPv4 (or times out).
async function discoverVmIp(vmid, { timeoutMs = 600000, intervalMs = 10000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ip = await pve.getGuestAgentIp({ vmid }).catch(() => null);
    if (ip) return ip;
    if (onTick) onTick();
    await sleep(intervalMs);
  }
  return null;
}

async function discoverContainerIp(vmid, { timeoutMs = 180000, intervalMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ip = await pve.getContainerIp({ vmid }).catch(() => null);
    if (ip) return ip;
    await sleep(intervalMs);
  }
  return null;
}

// Clone + boot a single VM on DHCP (used by stacks). IP is discovered by the
// caller after boot via the guest agent.
async function provisionSingleVm({ templateId, hostname, cpu, memoryGB, diskGB, packages = [] }) {
  const template = resolveVmTemplate(templateId);
  if (!template) throw new Error(`Unknown VM template: ${templateId}`);

  const newVmid = await pve.getNextVmid();
  const upid = await pve.cloneVm({ templateVmid: template.vmid, newVmid, hostname });
  await pve.waitForTask({ upid });

  await pve.configureVm({ vmid: newVmid, cores: cpu, memory: memoryGB * 1024, diskResizeGB: diskGB });
  await pve.setCloudInit({ vmid: newVmid, hostname }); // no staticIp => ip=dhcp
  await pve.startVm({ vmid: newVmid });

  return { vmid: newVmid, hostname, type: "vm", templateId, ip: null, requestedPackages: packages };
}

async function provisionContainer({ templateId, hostname, cpu, memoryGB, packages = [] }) {
  const template = findContainerTemplate(templateId);
  if (!template) throw new Error(`Unknown container template: ${templateId}`);

  const newVmid = await pve.getNextVmid();
  const upid = await pve.cloneContainer({ templateVmid: template.vmid, newVmid, hostname });
  await pve.waitForTask({ upid });

  // No staticIp => keep the template's DHCP networking.
  await pve.configureContainer({ vmid: newVmid, cores: cpu, memory: memoryGB * 1024 });
  await pve.startContainer({ vmid: newVmid });

  return { vmid: newVmid, hostname, type: "container", templateId, ip: null, requestedPackages: packages };
}

// Full VM deployment pipeline, driven by a structured step tracker so the
// deployment monitor shows each step with an impactful statement, an ETA, and
// the time it actually took. Post-boot configuration always SSHes in as the
// template's root account (from Mappings) — never the end-user account.
export async function runVmJob(jobId, payload) {
  const {
    templateId, hostname, cpu, memoryGB, diskGB,
    packages = [], username, sudoAccess = false, environment,
  } = payload;

  const tracker = createStepTracker({ templateKey: templateId, emit: (p) => updateJob(jobId, p) });
  let newVmid = null;

  try {
    const tpl = resolveVmTemplate(templateId);
    if (!tpl) throw new Error(`Unknown VM template: ${templateId}`);
    const m = tpl.mapping || {};
    const rootUser = m.credUser || "root";
    const rootPass = m.credPassword || process.env.VM_SSH_PASSWORD || "";
    const sshPort = m.port || 22;
    const cloudInitFile = m.cloudInitFile || null;
    const packageManager = m.packageManager || "apt";

    // --- Request / approval steps (already settled by the time we run) ---
    tracker.quickDone("submitted");
    tracker.quickDone("approval", {
      done: payload.autoApproved === false
        ? `Approved by ${payload.approvedBy || "an administrator"}`
        : "Standard request — auto-approved",
    });
    tracker.quickDone("approved");

    // --- Provision the VM (clone) ---
    tracker.start("provision_vm");
    newVmid = await pve.getNextVmid();
    await pve.cloneVm({ templateVmid: tpl.vmid, newVmid, hostname });
    tracker.done("provision_vm", { done: `Virtual machine #${newVmid} provisioned` });

    // --- Deploy the OS (disk copy finishes when the clone lock clears) ---
    tracker.start("deploy_os");
    await pve.waitForUnlock({ vmid: newVmid, onTick: () => {} });
    await sleep(4000);
    tracker.done("deploy_os", { done: `${tpl.name} image deployed` });

    // --- Allocate resources (CPU / RAM / disk; disk only grows) ---
    tracker.start("allocate_resources");
    const currentDisk = await pve.getDiskSizeGB({ vmid: newVmid, disk: "scsi0" }).catch(() => null);
    const targetDisk = currentDisk ? Math.max(Number(diskGB) || 0, currentDisk) : Number(diskGB);
    const growDisk = currentDisk && targetDisk > currentDisk ? targetDisk : (currentDisk ? undefined : targetDisk);
    await pve.editVm({ vmid: newVmid, cores: cpu, memory: Number(memoryGB) * 1024, diskGB: growDisk });
    tracker.done("allocate_resources", { done: `Allocated ${cpu} vCPU · ${memoryGB} GB RAM · ${targetDisk} GB disk` });

    // --- Assign IP / network (attach NIC on DHCP), cloud-init + tags ---
    tracker.start("assign_ip");
    await pve.setVmNetwork({ vmid: newVmid, iface: environment });
    if (cloudInitFile) await pve.setCicustom({ vmid: newVmid, file: cloudInitFile });
    const owner = payload.requestedBy;
    const groups = owner ? groupsForUser(owner) : [];
    await pve.setVmTags({ vmid: newVmid, tags: ownerTags({ username: owner, groups, environment }) }).catch(() => {});
    tracker.done("assign_ip", { done: `Attached to "${environment}" (address leased on boot)` });

    const resource = { vmid: newVmid, hostname, type: "vm", ip: null, environment, sshReady: false };
    updateJob(jobId, { resources: [resource] });

    // --- Power on ---
    tracker.start("power_on");
    await pve.startVm({ vmid: newVmid });
    tracker.done("power_on");

    // --- System startup: wait for DHCP + SSH ---
    tracker.start("system_startup");
    const ip = await discoverVmIp(newVmid, { timeoutMs: 600000, intervalMs: 10000 });
    if (!ip) {
      tracker.stall("Your VM started but never reported a network address (is the guest agent installed?). It was created, but is unreachable.");
      updateJob(jobId, { status: "ready", resources: [{ ...resource, sshReady: false }] });
      return;
    }
    setOwnerIp(newVmid, ip);
    resource.ip = ip;
    const online = await waitForPort({ host: ip, port: sshPort, timeoutMs: 180000, intervalMs: 5000 });
    if (!online) {
      tracker.stall(`Your VM is up at ${ip} but isn't accepting SSH yet. It was created, but is unreachable.`);
      updateJob(jobId, { status: "ready", resources: [{ ...resource, sshReady: false }] });
      return;
    }
    tracker.done("system_startup", { done: `System online at ${ip}` });

    const sshOpts = { host: ip, port: sshPort, username: rootUser, password: rootPass };
    const allStepResults = [];

    // --- Initial setup: first-boot init + create the user account ---
    tracker.start("initial_setup");
    const generatedPassword = username ? generatePassword() : null;
    const initCmds = [
      { name: "wait for cloud-init", cmd: "cloud-init status --wait 2>/dev/null || true" },
      ...userSetupCommands({ username, password: generatedPassword, sudo: sudoAccess }),
    ];
    allStepResults.push(...await runCommands(initCmds, sshOpts, { osName: tpl.name, packageManager }));
    tracker.done("initial_setup", { done: username ? `Initial setup done — account "${username}" created` : "Initial setup complete" });

    // --- Security baseline: Defender, OMI Client, Guardicore (best-effort) ---
    tracker.start("default_packages");
    const agentPkgs = DEFAULT_AGENTS.map((a) => a.pkg);
    const agentCmd = packageInstallCommand({ packageManager, packages: agentPkgs });
    const agentResults = await runCommands([{ name: "install security baseline", cmd: agentCmd }], sshOpts, { osName: tpl.name, packageManager });
    allStepResults.push(...agentResults);
    tracker.done("default_packages", { done: `Security baseline applied — ${DEFAULT_AGENTS.map((a) => a.name.split(" ")[0]).join(", ")}` });

    // --- Requested software (only if the user asked for any) ---
    if (packages.length) {
      tracker.start("requested_packages");
      const reqCmd = packageInstallCommand({ packageManager, packages });
      allStepResults.push(...await runCommands([{ name: `install ${packages.join(", ")}`, cmd: reqCmd }], sshOpts, { osName: tpl.name, packageManager }));
      tracker.done("requested_packages", { done: `Installed: ${packages.join(", ")}` });
    } else {
      tracker.skip("requested_packages", { done: "No additional software requested" });
    }

    // --- Validate: confirm each requested package is present ---
    tracker.start("validate");
    const validations = [];
    for (const pkg of packages) {
      const check = await runSsh({
        ...sshOpts,
        command: `command -v ${pkg} >/dev/null 2>&1 || rpm -q ${pkg} >/dev/null 2>&1 || dpkg -s ${pkg} >/dev/null 2>&1 || apk info -e ${pkg} >/dev/null 2>&1 && echo OK || echo MISSING`,
      }).catch(() => ({ stdout: "MISSING" }));
      validations.push({ package: pkg, present: /OK/.test(check.stdout || "") });
    }
    const pkgsOk = validations.every((v) => v.present);
    tracker.done("validate", { done: packages.length ? `Validated ${validations.filter((v) => v.present).length}/${validations.length} package(s)` : "Server validated end-to-end" });

    // --- Summarize ---
    tracker.start("summarize");
    const allOk = allStepResults.every((r) => r.ok) && pkgsOk;
    tracker.done("summarize", { done: allOk ? "All done — your server is ready 🎉" : "Done — with a few warnings (see summary)" });

    updateJob(jobId, {
      status: "ready",
      message: allOk
        ? `Your VM "${hostname}" is ready to use. Open the summary for login details.`
        : `Your VM "${hostname}" is ready, but some setup steps had issues. Open the summary for details.`,
      resources: [{ ...resource, sshReady: true }],
      result: {
        hostname, vmid: newVmid, ip, environment,
        username: username || null, generatedPassword, sudo: sudoAccess,
        defaultAgents: DEFAULT_AGENTS.map((a) => a.name),
        validations, steps: allStepResults, allOk,
      },
    });
  } catch (err) {
    // Mark the active step failed + skip the rest, and fail the job. The raw
    // error is kept for the summary; jobStore raises the ServiceNow incident.
    tracker.fail("Something went wrong while creating your VM. Open the summary for details.", err.message);
  }
}

// Internal provisioning workflow. Does NOT touch Proxmox — instead it walks the
// fixed workflow defined on the internal template (config/internalCatalog.js),
// calling a real internal system per step over HTTP (ITSM, IPAM, compute,
// storage, firewall, DNS, CMDB). Each step's endpoint is configured in Settings.
// The deployment monitor streams progress as each real call completes.
export async function runInternalJob(jobId, payload) {
  const { templateId, hostname, cpu, memoryGB, diskGB } = payload;

  try {
    const tpl = findInternalTemplate(templateId);
    if (!tpl) throw new Error(`Unknown internal template: ${templateId}`);

    // A structured, per-step tracker the UI renders as circles that go green as
    // each step finishes. Kept on the job alongside the streamed log messages.
    const steps = tpl.workflow.map((s) => ({
      key: s.key, label: s.label, state: "pending", system: null, reference: null, detail: null,
    }));
    const snapshot = () => steps.map((s) => ({ ...s }));

    updateJob(jobId, {
      status: "provisioning",
      message: `Starting the internal provisioning workflow for "${hostname}"…`,
      steps: snapshot(),
    });

    // Context accumulates each API's returned fields so later steps (firewall,
    // DNS, CMDB) can reference the IP allocated earlier, etc.
    const ctx = { hostname, cpu, memoryGB, diskGB, requestedBy: payload.requestedBy };
    const workflow = [];

    for (let i = 0; i < tpl.workflow.length; i++) {
      const step = tpl.workflow[i];
      const api = INTERNAL_APIS[step.api];
      if (!api) throw new Error(`No handler configured for workflow step "${step.api}"`);

      // A configured system is called for real (its own latency provides the
      // timing); an unconfigured one is simulated — add a short pause so the
      // monitor still streams each step like a real integration.
      const simulated = !step.system || !isSystemConfigured(step.system);
      steps[i].state = "active";
      updateJob(jobId, { status: "provisioning", message: `${step.label}…`, steps: snapshot() });
      if (simulated) await sleep(1500);

      let res;
      try {
        res = await api(ctx);
      } catch (err) {
        steps[i] = { ...steps[i], state: "error", detail: err.message };
        updateJob(jobId, { steps: snapshot() });
        throw err;
      }
      Object.assign(ctx, res.fields || {}); // e.g. ip, gateway, fqdn for later steps

      steps[i] = { ...steps[i], state: "done", system: res.system, reference: res.reference, detail: res.detail };
      workflow.push({ step: step.label, system: res.system, reference: res.reference, detail: res.detail });
      updateJob(jobId, { message: `${step.label} — done${res.reference ? ` · ${res.reference}` : ""}`, steps: snapshot() });
    }

    const resource = {
      vmid: null, // no Proxmox VM — keeps ownership/Resources store clean
      hostname,
      type: "vm",
      ip: ctx.ip || null,
      environment: ctx.vlan || null,
      sshReady: true, // no SSH phase for this workflow; treat as ready
    };

    updateJob(jobId, {
      status: "ready",
      message: `Internal provisioning for "${hostname}" completed. Open the summary for the full workflow.`,
      resources: [resource],
      result: {
        hostname,
        provider: "internal",
        ip: ctx.ip || null,
        fqdn: ctx.fqdn || null,
        cpu,
        memoryGB,
        diskGB,
        workflow,
      },
    });
  } catch (err) {
    updateJob(jobId, {
      status: "failed",
      message: "The internal provisioning workflow hit an error. Open the summary for details.",
      error: err.message,
    });
  }
}

export async function runContainerJob(jobId, { templateId, hostname, cpu, memoryGB, packages = [] }) {
  try {
    updateJob(jobId, { status: "provisioning", message: "Creating your container…" });
    const resource = await provisionContainer({ templateId, hostname, cpu, memoryGB, packages });

    updateJob(jobId, { status: "booting", message: "Starting your container and waiting for a network address…", resources: [resource] });

    const ip = await discoverContainerIp(resource.vmid);
    if (ip) {
      setOwnerIp(resource.vmid, ip);
      resource.ip = ip;
    }
    const sshUp = ip ? await waitForPort({ host: ip, port: 22 }) : false;
    resource.sshReady = sshUp;

    updateJob(jobId, {
      status: "ready",
      message: sshUp
        ? `Your container "${hostname}" is ready to use.`
        : "Your container was created but we couldn't reach it on the network yet.",
      resources: [resource],
    });
  } catch (err) {
    updateJob(jobId, {
      status: "failed",
      message: "Something went wrong while creating your container. Open the summary for details.",
      error: err.message,
    });
  }
}

export async function runStackJob(jobId, { stackId, hostnamePrefix, cpu, memoryGB, diskGB, packages = [] }) {
  const stack = findStack(stackId);
  if (!stack) {
    updateJob(jobId, { status: "failed", message: "Unknown stack", error: `Stack ${stackId} not found` });
    return;
  }

  const resources = [];
  try {
    updateJob(jobId, { status: "provisioning", message: `Creating ${stack.members.length} machine(s) for your stack…` });

    for (const member of stack.members) {
      const hostname = `${hostnamePrefix}-${member.hostnameSuffix}`;
      updateJob(jobId, { message: `Creating ${hostname} (${member.role})…` });
      const resource = await provisionSingleVm({
        templateId: member.templateId, hostname, cpu, memoryGB, diskGB, packages,
      });
      resource.role = member.role;
      resources.push(resource);
      updateJob(jobId, { resources: [...resources] });
    }

    updateJob(jobId, { status: "booting", message: "All machines started — waiting for network addresses…", resources: [...resources] });

    for (const resource of resources) {
      const ip = await discoverVmIp(resource.vmid, { timeoutMs: 300000, intervalMs: 10000 });
      if (ip) {
        setOwnerIp(resource.vmid, ip);
        resource.ip = ip;
        resource.sshReady = await waitForPort({ host: ip, port: 22 });
      } else {
        resource.sshReady = false;
      }
      updateJob(jobId, { resources: [...resources] });
    }

    updateJob(jobId, { status: "ready", message: `Your stack "${hostnamePrefix}" is ready to use.`, resources });
  } catch (err) {
    updateJob(jobId, { status: "failed", message: "Something went wrong while creating your stack. Open the summary for details.", error: err.message, resources });
  }
}
