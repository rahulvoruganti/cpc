import { Router } from "express";
import { chatWithGemini } from "../services/geminiService.js";
import { requireAuth } from "../middleware/auth.js";
import { getChat, saveChat, clearChat } from "../services/chatStore.js";
import { findVmTemplate, findContainerTemplate, findStack, PACKAGE_CATALOG } from "../config/catalog.js";
import { logAudit } from "../services/auditService.js";
import * as pve from "../services/proxmoxService.js";
import { removeOwner, getOwner } from "../services/ownershipStore.js";
import { submitProvisionRequest } from "../services/requestStore.js";
import { canSeeTags } from "../services/visibility.js";
import { parseTags } from "../services/tags.js";

const router = Router();
router.use(requireAuth);

// --- Persisted chat history (per user) ---
router.get("/chat/history", (req, res) => {
  res.json({ messages: getChat(req.user.username) });
});

router.put("/chat/history", (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }
  const saved = saveChat(req.user.username, messages);
  res.json({ messages: saved });
});

router.delete("/chat/history", (req, res) => {
  clearChat(req.user.username);
  res.json({ cleared: true });
});

const DEFAULTS = { cpu: 2, memoryGB: 2, diskGB: 50 };

const RESOURCE_ACTIONS = {
  vm: {
    reboot: pve.rebootVm,
    shutdown: pve.shutdownVm,
    delete: pve.deleteVm,
  },
  container: {
    reboot: pve.rebootContainer,
    shutdown: pve.shutdownContainer,
    delete: pve.deleteContainer,
  },
};

const WORKLOAD_PROFILES = [
  {
    re: /\b(llm|large language model|ai model|inference|finetune|fine-tune|embedding|vector db|gpu)\b/i,
    vm: { cpu: 8, memoryGB: 24, diskGB: 150 },
    container: { cpu: 6, memoryGB: 16, diskGB: 100 },
    stack: { cpu: 8, memoryGB: 24, diskGB: 150 },
  },
  {
    re: /\b(stress|load\s*test|performance\s*test|benchmark)\b/i,
    vm: { cpu: 6, memoryGB: 12, diskGB: 80 },
    container: { cpu: 4, memoryGB: 8, diskGB: 60 },
    stack: { cpu: 6, memoryGB: 12, diskGB: 100 },
  },
  {
    re: /\b(database|postgres|mysql|mariadb|mongodb|redis|elastic)\b/i,
    vm: { cpu: 4, memoryGB: 8, diskGB: 120 },
    container: { cpu: 3, memoryGB: 6, diskGB: 90 },
    stack: { cpu: 4, memoryGB: 8, diskGB: 120 },
  },
];

// Map free-text use cases to the packages a workload usually needs, so the
// proposal arrives with the right boxes pre-checked (e.g. a React app -> nodejs,
// yarn, nginx, git). Every package name here must exist in the frontend
// PACKAGE_OPTIONS list so the checkbox can render it. Matches accumulate, so
// "django app behind nginx with postgres" pulls packages from all three rules.
const PACKAGE_PROFILES = [
  { re: /\b(react|reactjs|vue|vuejs|angular|svelte|next\s?\.?\s?js|nextjs|nuxt|node\s?\.?\s?js|nodejs|express|frontend|front-end|spa|web\s?app|website|javascript|typescript|npm)\b/i, packages: ["nodejs", "yarn", "nginx", "git"] },
  { re: /\b(python|django|flask|fastapi|pandas|numpy)\b/i, packages: ["python", "git"] },
  { re: /\b(llm|large language model|ai model|inference|finetune|fine-tune|embedding|machine learning|\bml\b|pytorch|tensorflow)\b/i, packages: ["python", "docker", "git"] },
  { re: /\b(java|spring|spring\s?boot)\b/i, packages: ["openjdk", "maven", "git"] },
  { re: /(\.net|dotnet|c#|asp\.net)/i, packages: ["dotnet-sdk", "git"] },
  { re: /\b(php|laravel|symfony|wordpress)\b/i, packages: ["php", "nginx", "git"] },
  { re: /\b(go|golang)\b/i, packages: ["go", "git"] },
  { re: /\b(postgres|postgresql)\b/i, packages: ["postgres"] },
  { re: /\b(mysql|mariadb)\b/i, packages: ["mysql"] },
  { re: /\b(mongo|mongodb)\b/i, packages: ["mongodb"] },
  { re: /\b(redis|caching)\b/i, packages: ["redis"] },
  { re: /\b(rabbitmq|message queue|amqp)\b/i, packages: ["rabbitmq"] },
  { re: /\b(docker|dockeri[sz]ed|container|containers|containeri[sz]ed|microservices?|podman)\b/i, packages: ["docker", "docker-compose", "git"] },
  { re: /\b(kubernetes|k8s|k3s|helm)\b/i, packages: ["kubectl", "helm", "docker"] },
  { re: /\b(terraform|infrastructure as code|iac|ansible)\b/i, packages: ["terraform", "ansible", "git"] },
  { re: /\b(grafana|prometheus|monitoring|observability|metrics)\b/i, packages: ["grafana", "prometheus"] },
  { re: /\b(nginx|reverse proxy|load balancer|web server)\b/i, packages: ["nginx"] },
  { re: /\b(aws|s3|ec2|cloud cli)\b/i, packages: ["awscli"] },
];

// Keyword fallback for when the model doesn't return packages. Kept only as a
// safety net — the primary source is the model's own package selection, which
// understands the full conversation.
function inferPackages(message) {
  const text = message || "";
  const set = new Set();
  for (const profile of PACKAGE_PROFILES) {
    if (profile.re.test(text)) profile.packages.forEach((pkg) => set.add(pkg));
  }
  return Array.from(set);
}

// Final package list for a proposal: trust the model's selection (filtered to
// the catalog), and only fall back to keyword inference if it returned nothing.
function resolvePackages(resultArgs, message) {
  const fromModel = Array.isArray(resultArgs?.packages)
    ? resultArgs.packages
        .map((pkg) => String(pkg).toLowerCase().trim())
        .filter((pkg) => PACKAGE_CATALOG.includes(pkg))
    : [];
  const packages = fromModel.length ? fromModel : inferPackages(message);
  return Array.from(new Set(packages));
}

function randomSuffix() {
  return Math.floor(1000 + Math.random() * 9000);
}

function hasExplicitResourceDetails(message) {
  return /\b\d+\s*(cpu|vcpu|vcpu|cores?|ram|memory|disk|gb)\b/i.test(message)
    || /\b(hostname|name|template|stack|container|lxc|vm)\b/i.test(message) && /\b\d+\b/.test(message)
    || /\b(redhat|rhel|alpine)\b/i.test(message) && /\b(cpu|ram|memory|disk|hostname)\b/i.test(message);
}

function inferRequestedKind(message) {
  const text = (message || "").toLowerCase();
  if (/\bstack\b/.test(text)) return "stack";
  if (/\b(container|lxc)\b/.test(text)) return "container";
  if (/\b(vm|virtual machine)\b/.test(text)) return "vm";
  return null;
}

function mergeIntent(args = {}, message) {
  const requestedKind = inferRequestedKind(message);
  if (!requestedKind || args.kind === requestedKind) {
    return args;
  }

  if (requestedKind === "container") {
    return {
      ...args,
      kind: "container",
      stackId: undefined,
      stackName: undefined,
      hostnamePrefix: undefined,
      diskGB: undefined,
    };
  }

  if (requestedKind === "stack") {
    return {
      ...args,
      kind: "stack",
      templateId: undefined,
      templateName: undefined,
      hostname: undefined,
    };
  }

  return {
    ...args,
    kind: "vm",
    stackId: undefined,
    stackName: undefined,
    hostnamePrefix: undefined,
  };
}

function getSizingDefaults(message, kind) {
  const profile = WORKLOAD_PROFILES.find((p) => p.re.test(message || ""));
  if (!profile) return DEFAULTS;
  if (kind === "stack") return profile.stack;
  if (kind === "container") return profile.container;
  return profile.vm;
}

function applySmartDefaults(args = {}, message) {
  const defaults = getSizingDefaults(message, args.kind);
  return {
    ...args,
    cpu: args.cpu || defaults.cpu || DEFAULTS.cpu,
    memoryGB: args.memoryGB || defaults.memoryGB || DEFAULTS.memoryGB,
    diskGB: args.diskGB || defaults.diskGB || DEFAULTS.diskGB,
  };
}

function buildProposal(resultArgs = {}, message = "") {
  const kind = resultArgs.kind;
  const packages = resolvePackages(resultArgs, message);

  if (kind === "stack") {
    const stack = findStack(resultArgs.stackId);
    return {
      kind,
      stackId: resultArgs.stackId || "",
      stackName: stack?.name || resultArgs.stackId || "Unknown stack",
      hostnamePrefix: resultArgs.hostnamePrefix || `stack-${randomSuffix()}`,
      cpu: resultArgs.cpu || DEFAULTS.cpu,
      memoryGB: resultArgs.memoryGB || DEFAULTS.memoryGB,
      diskGB: resultArgs.diskGB || DEFAULTS.diskGB,
      packages,
    };
  }

  if (kind === "container") {
    const template = findContainerTemplate(resultArgs.templateId);
    return {
      kind,
      templateId: resultArgs.templateId || "",
      templateName: template?.name || resultArgs.templateId || "Unknown container template",
      hostname: resultArgs.hostname || `${resultArgs.templateId || "container"}-ct-${randomSuffix()}`,
      cpu: resultArgs.cpu || DEFAULTS.cpu,
      memoryGB: resultArgs.memoryGB || DEFAULTS.memoryGB,
      packages,
    };
  }

  const template = findVmTemplate(resultArgs.templateId);
  return {
    kind: "vm",
    templateId: resultArgs.templateId || "",
    templateName: template?.name || resultArgs.templateId || "Unknown VM template",
    hostname: resultArgs.hostname || `${resultArgs.templateId || "vm"}-vm-${randomSuffix()}`,
    cpu: resultArgs.cpu || DEFAULTS.cpu,
    memoryGB: resultArgs.memoryGB || DEFAULTS.memoryGB,
    diskGB: resultArgs.diskGB || DEFAULTS.diskGB,
    packages,
  };
}

function proposalReply(proposal) {
  if (proposal.kind === "stack") {
    return `I prepared an editable proposal for the ${proposal.stackName} stack.`;
  }
  if (proposal.kind === "container") {
    return `I prepared an editable proposal for the ${proposal.templateName} container.`;
  }
  return `I prepared an editable proposal for the ${proposal.templateName} VM.`;
}

function buildProvisionPayload(resultArgs = {}, message = "") {
  const kind = resultArgs.kind;
  const packages = resolvePackages(resultArgs, message);

  if (kind === "stack") {
    return {
      kind,
      stackId: resultArgs.stackId,
      hostnamePrefix: resultArgs.hostnamePrefix || `stack-${randomSuffix()}`,
      cpu: resultArgs.cpu || DEFAULTS.cpu,
      memoryGB: resultArgs.memoryGB || DEFAULTS.memoryGB,
      diskGB: resultArgs.diskGB || DEFAULTS.diskGB,
      packages,
    };
  }

  if (kind === "container") {
    return {
      kind,
      templateId: resultArgs.templateId,
      hostname: resultArgs.hostname || `${resultArgs.templateId || "container"}-ct-${randomSuffix()}`,
      cpu: resultArgs.cpu || DEFAULTS.cpu,
      memoryGB: resultArgs.memoryGB || DEFAULTS.memoryGB,
      packages,
    };
  }

  return {
    kind: "vm",
    templateId: resultArgs.templateId,
    hostname: resultArgs.hostname || `${resultArgs.templateId || "vm"}-vm-${randomSuffix()}`,
    cpu: resultArgs.cpu || DEFAULTS.cpu,
    memoryGB: resultArgs.memoryGB || DEFAULTS.memoryGB,
    diskGB: resultArgs.diskGB || DEFAULTS.diskGB,
    packages,
  };
}

function startProvisioning(jobKind, payload, username) {
  const { request, job } = submitProvisionRequest({
    kind: jobKind,
    payload,
    requestedBy: username,
    source: "chat",
  });

  if (jobKind === "vm") {
    logAudit({ actor: { username }, action: "vm.request", target: payload.hostname, detail: { via: "chat", requestId: request.id, jobId: job?.id || null } });
  } else if (jobKind === "container") {
    logAudit({ actor: { username }, action: "container.request", target: payload.hostname, detail: { via: "chat", requestId: request.id, jobId: job?.id || null } });
  } else {
    logAudit({ actor: { username }, action: "stack.request", target: payload.hostnamePrefix, detail: { via: "chat", requestId: request.id, jobId: job?.id || null } });
  }

  return { request, job };
}

// Tag-based visibility (matches the Resources view): admins see all; others
// see resources tagged with their user tag or a group tag.
function filterByVisibility(items, user) {
  if (user.role === "admin") return items;
  return items.filter((i) => canSeeTags(i.tags, user));
}

async function listResourcesForChat(user) {
  const [allVms, allContainers] = await Promise.all([
    pve.listAllVms({}),
    pve.listAllContainers({}),
  ]);

  const norm = (item, type) => ({
    vmid: item.vmid,
    name: item.name,
    type,
    status: item.status,
    owner: getOwner(item.vmid)?.username || null,
    tags: parseTags(item.tags),
  });

  const combined = [
    ...allVms.map((v) => norm(v, "vm")),
    ...allContainers.map((c) => norm(c, "container")),
  ];

  return filterByVisibility(combined, user).sort((a, b) => a.vmid - b.vmid);
}

function resolveResourceTarget(resources, args = {}) {
  const wantedType = args.type === "vm" || args.type === "container" ? args.type : null;
  const wantedVmid = Number.isFinite(Number(args.vmid)) ? Number(args.vmid) : null;
  const wantedName = (args.name || "").trim().toLowerCase();

  let candidates = resources;
  if (wantedType) candidates = candidates.filter((r) => r.type === wantedType);
  if (wantedVmid !== null) candidates = candidates.filter((r) => r.vmid === wantedVmid);
  if (wantedName) {
    candidates = candidates.filter((r) => (r.name || "").toLowerCase() === wantedName);
    if (candidates.length === 0) {
      candidates = resources.filter((r) => (r.name || "").toLowerCase().includes(wantedName));
      if (wantedType) candidates = candidates.filter((r) => r.type === wantedType);
    }
  }

  return candidates;
}

router.post("/chat", async (req, res) => {
  const { message, history } = req.body;
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  let result;
  try {
    result = await chatWithGemini({ message, history: history || [] });
  } catch (err) {
    return res.status(502).json({ error: `Gemini request failed: ${err.message}` });
  }

  if (!result.functionCall) {
    return res.json({ reply: result.text || "I'm not sure how to help with that.", job: null });
  }

  const { name, args = {} } = result.functionCall;
  const explicitDetails = hasExplicitResourceDetails(message);
  const resolvedArgs = mergeIntent(args, message);
  const sizedArgs = applySmartDefaults(resolvedArgs, message);

  try {
    if (name === "resolve_provisioning") {
      if (sizedArgs.action === "provision" && explicitDetails) {
        const template = sizedArgs.kind === "stack"
          ? findStack(sizedArgs.stackId)
          : sizedArgs.kind === "container"
            ? findContainerTemplate(sizedArgs.templateId)
            : findVmTemplate(sizedArgs.templateId);
        if (!template) {
          return res.json({
            reply: sizedArgs.kind === "container"
              ? "You asked for a container, but no container templates are configured yet. I prepared a container proposal so you can review it after templates are added."
              : `I could not find the selected ${sizedArgs.kind === "stack" ? "stack" : "template"} in the catalog.`,
            proposal: buildProposal(sizedArgs, message),
            job: null,
          });
        }

        const payload = buildProvisionPayload(sizedArgs, message);
        const result = startProvisioning(sizedArgs.kind, payload, req.user.username);
        if (!result.job) {
          return res.json({
            reply: `Your request requires admin approval before provisioning. Track it in Requests with id ${result.request.id}.`,
            job: null,
            proposal: null,
          });
        }
        return res.json({
          reply: sizedArgs.kind === "stack"
            ? `Provisioning stack "${findStack(sizedArgs.stackId)?.name || sizedArgs.stackId}" with prefix "${payload.hostnamePrefix}". Tracking as job ${result.job.id}.`
            : sizedArgs.kind === "container"
              ? `Provisioning a container (${findContainerTemplate(sizedArgs.templateId)?.name || sizedArgs.templateId}) named "${payload.hostname}". Tracking as job ${result.job.id}.`
              : `Provisioning a VM (${findVmTemplate(sizedArgs.templateId)?.name || sizedArgs.templateId}) named "${payload.hostname}". Tracking as job ${result.job.id}.`,
          job: result.job,
          proposal: null,
        });
      }

      const proposal = buildProposal(sizedArgs, message);
      return res.json({
        reply: explicitDetails ? proposalReply(proposal) : "I prepared an editable proposal so you can review the defaults before provisioning.",
        proposal,
        job: null,
      });
    }

    if (name === "manage_resources") {
      const action = args.action;
      const resources = await listResourcesForChat(req.user);

      if (action === "list_owned") {
        const filtered = args.type ? resources.filter((r) => r.type === args.type) : resources;
        if (filtered.length === 0) {
          return res.json({
            reply: args.type
              ? `You currently have no ${args.type === "vm" ? "VMs" : "containers"} assigned to you.`
              : "You currently have no VMs or containers assigned to you.",
            job: null,
          });
        }
        return res.json({
          reply: "Here are your assigned resources:",
          resourceList: filtered,
          job: null,
        });
      }

      if (action === "status") {
        const candidates = resolveResourceTarget(resources, args);
        if (candidates.length === 0) {
          return res.json({
            reply: "I could not find that resource assigned to you.",
            job: null,
          });
        }

        if (candidates.length > 1) {
          return res.json({
            reply: "I found multiple matching resources. Please specify a VMID:",
            resourceList: candidates.slice(0, 10),
            job: null,
          });
        }

        const target = candidates[0];
        return res.json({
          reply: `${target.name || "resource"} [${target.type}] VMID ${target.vmid} is currently ${target.status || "unknown"}.`,
          job: null,
        });
      }

      if (!["reboot", "shutdown", "delete"].includes(action)) {
        return res.json({ reply: `Unsupported resource action: ${action}`, job: null });
      }

      const candidates = resolveResourceTarget(resources, args);
      if (candidates.length === 0) {
        return res.json({
          reply: "I could not find a matching resource assigned to you. Ask for your assigned list first, then specify VMID or exact name.",
          job: null,
        });
      }

      if (candidates.length > 1) {
        return res.json({
          reply: "I found multiple matching resources. Please specify a VMID:",
          resourceList: candidates.slice(0, 10),
          job: null,
        });
      }

      const target = candidates[0];
      if (action === "delete" && req.user.role !== "admin") {
        return res.json({
          reply: "Only admins can delete resources. You can still reboot or shutdown your assigned resources.",
          job: null,
        });
      }

      const fn = RESOURCE_ACTIONS[target.type]?.[action];
      if (!fn) {
        return res.json({ reply: `Unsupported target type/action: ${target.type}/${action}`, job: null });
      }

      try {
        await fn({ vmid: target.vmid });
      } catch (err) {
        logAudit({
          actor: req.user,
          action: `${target.type}.${action}`,
          target: `${target.name || "resource"} (VMID ${target.vmid})`,
          status: "failure",
          detail: { via: "chat", error: err.message },
        });
        return res.json({
          reply: `Unable to ${action}, try again later or contact admin.`,
          job: null,
        });
      }

      if (action === "delete") {
        removeOwner(target.vmid);
      }

      logAudit({
        actor: req.user,
        action: `${target.type}.${action}`,
        target: `${target.name || "resource"} (VMID ${target.vmid})`,
        status: "success",
        detail: { via: "chat" },
      });

      return res.json({
        reply: `${action[0].toUpperCase() + action.slice(1)} requested for ${target.name || "resource"} (${target.type}, VMID ${target.vmid}).`,
        job: null,
      });
    }

    return res.json({ reply: `Model called an unknown function: ${name}`, job: null });
  } catch (err) {
    return res.status(500).json({ error: `Failed to process chat action: ${err.message}` });
  }
});

export default router;
