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
import { buildInstallPlan, aiTroubleshoot } from "./aiOps.js";
import { INTERNAL_APIS } from "./internalProvisioningApis.js";
import { findInternalTemplate } from "../config/internalCatalog.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Full VM deployment pipeline. Each phase updates the job so the deployment
// monitor shows step-by-step progress. Post-boot configuration always SSHes in
// as the template's root account (from Mappings) — never the end-user account.
export async function runVmJob(jobId, payload) {
  const {
    templateId, hostname, cpu, memoryGB, diskGB,
    packages = [], username, sudoAccess = false, environment,
  } = payload;

  const step = (status, message) => updateJob(jobId, { status, message });
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

    // 1) Clone the template.
    step("provisioning", "Creating your virtual machine…");
    newVmid = await pve.getNextVmid();
    await pve.cloneVm({ templateVmid: tpl.vmid, newVmid, hostname });

    // 2) Monitor the config lock (held while Proxmox copies the disk).
    step("provisioning", "Preparing the virtual machine…");
    await pve.waitForUnlock({ vmid: newVmid, onTick: () => {} });

    // 3) A short settle, then resize. Disk can only grow — never below the
    //    template's current size.
    await sleep(6000);
    const currentDisk = await pve.getDiskSizeGB({ vmid: newVmid, disk: "scsi0" }).catch(() => null);
    const targetDisk = currentDisk ? Math.max(Number(diskGB) || 0, currentDisk) : Number(diskGB);
    const growDisk = currentDisk && targetDisk > currentDisk ? targetDisk : (currentDisk ? undefined : targetDisk);
    step("provisioning", `Applying your selected size: ${cpu} vCPU, ${memoryGB} GB RAM, ${targetDisk} GB disk…`);
    await pve.editVm({ vmid: newVmid, cores: cpu, memory: Number(memoryGB) * 1024, diskGB: growDisk });

    // 4) Attach the selected environment (bridge/VLAN) on DHCP, enable the guest
    //    agent, and link the mapping's cloud-init snippet.
    step("provisioning", `Connecting it to the "${environment}" network…`);
    await pve.setVmNetwork({ vmid: newVmid, iface: environment });
    if (cloudInitFile) await pve.setCicustom({ vmid: newVmid, file: cloudInitFile });

    // Tag the VM with the owner, their groups and the environment — this drives
    // who can see it in the Resources view.
    const owner = payload.requestedBy;
    const groups = owner ? groupsForUser(owner) : [];
    await pve.setVmTags({ vmid: newVmid, tags: ownerTags({ username: owner, groups, environment }) })
      .catch((e) => updateJob(jobId, { message: `Note: could not set tags (${e.message})` }));

    const resource = { vmid: newVmid, hostname, type: "vm", ip: null, environment, sshReady: false };
    updateJob(jobId, { resources: [resource] });

    // 5) Boot.
    step("booting", "Starting up your virtual machine…");
    await pve.startVm({ vmid: newVmid });

    // 6) Discover the DHCP-assigned IP via the guest agent.
    step("booting", "Waiting for it to get a network address…");
    const ip = await discoverVmIp(newVmid, { timeoutMs: 600000, intervalMs: 10000 });
    if (!ip) {
      updateJob(jobId, {
        status: "ready",
        message: "Your VM started but we couldn't reach it on the network yet. It was created, but may still be finishing startup.",
        resources: [{ ...resource, sshReady: false }],
      });
      return;
    }
    setOwnerIp(newVmid, ip);
    resource.ip = ip;
    updateJob(jobId, { message: "Almost there — waiting for the VM to come online…", resources: [{ ...resource }] });

    const online = await waitForPort({ host: ip, port: sshPort, timeoutMs: 180000, intervalMs: 5000 });
    if (!online) {
      updateJob(jobId, {
        status: "ready",
        message: "Your VM is running but isn't accepting connections yet. It was created, but may still be finishing startup.",
        resources: [{ ...resource, sshReady: false }],
      });
      return;
    }

    // 7) Configure over SSH as root: create the user, grant sudo, install the
    //    required packages, enable services. AI assists on failures (cached).
    const generatedPassword = username ? generatePassword() : null;
    const plan = buildInstallPlan({ packageManager, packages, username, password: generatedPassword, sudo: sudoAccess });
    const stepResults = [];

    let stepNum = 0;
    for (const s of plan) {
      stepNum += 1;
      step("provisioning", `Setting up your environment (step ${stepNum} of ${plan.length})…`);
      let res = await runSsh({ host: ip, port: sshPort, username: rootUser, password: rootPass, command: s.cmd })
        .catch((e) => ({ code: 1, stdout: "", stderr: e.message }));

      // On failure, ask AI for a fix (cached) and retry once.
      if (res.code !== 0) {
        const fix = await aiTroubleshoot({ command: s.cmd, stderr: res.stderr, osName: tpl.name, packageManager }).catch(() => null);
        if (fix?.fix) {
          updateJob(jobId, { message: "Resolving a setup issue automatically…" });
          await runSsh({ host: ip, port: sshPort, username: rootUser, password: rootPass, command: fix.fix }).catch(() => {});
          res = await runSsh({ host: ip, port: sshPort, username: rootUser, password: rootPass, command: s.cmd })
            .catch((e) => ({ code: 1, stdout: "", stderr: e.message }));
        }
      }
      stepResults.push({ name: s.name, ok: res.code === 0, stderr: res.code === 0 ? "" : (res.stderr || "").slice(0, 300) });
    }

    // 8) Validate: confirm each requested package is present.
    step("provisioning", "Running final checks…");
    const validations = [];
    for (const pkg of packages) {
      const check = await runSsh({
        host: ip, port: sshPort, username: rootUser, password: rootPass,
        command: `command -v ${pkg} >/dev/null 2>&1 || rpm -q ${pkg} >/dev/null 2>&1 || dpkg -s ${pkg} >/dev/null 2>&1 || apk info -e ${pkg} >/dev/null 2>&1 && echo OK || echo MISSING`,
      }).catch(() => ({ stdout: "MISSING" }));
      validations.push({ package: pkg, present: /OK/.test(check.stdout || "") });
    }

    const stepsOk = stepResults.every((r) => r.ok);
    const pkgsOk = validations.every((v) => v.present);
    const allOk = stepsOk && pkgsOk;

    // 9) Final status uses the monitor's categories: accessible+ok => success.
    //    The streamed message stays a plain, credential-free sentence; the full
    //    details (incl. the login password) live in `result` for the Summary
    //    popup, so nothing sensitive appears in the deployment monitor stream.
    const message = allOk
      ? `Your VM "${hostname}" is ready to use. Open the summary for login details.`
      : `Your VM "${hostname}" is ready, but some setup steps had issues. Open the summary for details.`;

    updateJob(jobId, {
      status: "ready",
      message,
      resources: [{ ...resource, sshReady: true }],
      result: {
        hostname,
        vmid: newVmid,
        ip,
        environment,
        username: username || null,
        generatedPassword,
        sudo: sudoAccess,
        validations,
        steps: stepResults,
        allOk,
      },
    });
  } catch (err) {
    // Keep the streamed line friendly; retain the raw error for the summary.
    updateJob(jobId, {
      status: "failed",
      message: "Something went wrong while creating your VM. Open the summary for details.",
      error: err.message,
    });
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

      // Mark in-flight, then make the real call — its own latency provides the
      // timing (no artificial delay).
      steps[i].state = "active";
      updateJob(jobId, { status: "provisioning", message: `${step.label}…`, steps: snapshot() });

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
