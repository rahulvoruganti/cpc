import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Router } from "express";
import { CONTAINER_TEMPLATES, STACKS } from "../config/catalog.js";
import { internalVmTemplates, findInternalTemplate } from "../config/internalCatalog.js";
import { getJob, listJobs } from "../services/jobStore.js";
import { logAudit } from "../services/auditService.js";
import { requireAuth } from "../middleware/auth.js";
import { getTemplateMappings, getNetworkMappings } from "../services/mappingStore.js";
import { getCostRates } from "../services/settingsStore.js";
import {
  submitProvisionRequest,
  listProvisionRequests,
  approveProvisionRequest,
  rejectProvisionRequest,
} from "../services/requestStore.js";

// The provisionable VM list is driven entirely by the admin Mappings page:
// a template only appears once it has been mapped with an OS name. The Proxmox
// template VMID (the map key) is what provisioning clones from.
function mappedVmTemplates() {
  const map = getTemplateMappings();
  return Object.entries(map)
    .filter(([, m]) => m.osName && String(m.osName).trim())
    .map(([vmid, m]) => ({
      id: `tpl-${vmid}`,
      vmid: Number(vmid),
      name: m.osName,
      osName: m.osName,
      type: "vm",
      defaultUser: m.credUser || "root",
      connectivity: m.connectivity || "ssh",
      port: m.port || null,
      packageManager: m.packageManager || null,
      cloudInitFile: m.cloudInitFile || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const router = Router();

// Everything here requires authentication.
router.use(requireAuth);

// --- Catalog ---
// VM templates come from Mappings (admin-controlled) plus the fixed internal
// workflow templates (config/internalCatalog.js, provider: "internal").
// Containers and stacks still come from the static catalog for now.
router.get("/catalog/vm-templates", (req, res) => res.json([...mappedVmTemplates(), ...internalVmTemplates()]));
router.get("/catalog/container-templates", (req, res) => res.json(CONTAINER_TEMPLATES));
router.get("/catalog/stacks", (req, res) => res.json(STACKS));

// Default packages shown per template in the Provision workspace (e.g. MEAN,
// MERN). Read live from config/templateDefaults.json so it's editable without
// a code change or restart. Shape: { "<TemplateName>": [{ letter, name }] }.
const TEMPLATE_DEFAULTS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "config", "templateDefaults.json"
);
router.get("/catalog/template-defaults", (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(TEMPLATE_DEFAULTS_FILE, "utf-8")));
  } catch {
    res.json({});
  }
});

// Per-month unit prices used to estimate resource cost on the provisioning
// form. Admin-configured under Settings → Cost estimation; readable by any
// authenticated user so the live estimate can render.
router.get("/catalog/cost-rates", (req, res) => res.json(getCostRates()));

// Environments the user can deploy into = admin-labelled networks (Mappings).
router.get("/catalog/environments", (req, res) => {
  const nets = getNetworkMappings();
  const envs = Object.entries(nets)
    .filter(([, m]) => m.label && String(m.label).trim())
    .map(([iface, m]) => ({ iface, label: m.label, type: m.type || "bridge" }))
    .sort((a, b) => a.label.localeCompare(b.label));
  res.json(envs);
});

// --- Provisioning ---
router.post("/provision/vm", (req, res) => {
  const { templateId, hostname, cpu, memoryGB, diskGB, packages, packageSelection, username, sudoAccess, environment } = req.body;
  if (!templateId || !hostname || !cpu || !memoryGB || !diskGB) {
    return res.status(400).json({ error: "templateId, hostname, cpu, memoryGB, diskGB are required" });
  }
  if (!environment) {
    return res.status(400).json({ error: "environment (network) is required" });
  }
  if (!username || !String(username).trim()) {
    return res.status(400).json({ error: "username is required" });
  }
  const payload = {
    templateId, hostname, cpu, memoryGB, diskGB, packages, packageSelection,
    username: String(username).trim(), sudoAccess: !!sudoAccess, environment,
  };
  const result = submitProvisionRequest({ kind: "vm", payload, requestedBy: req.user.username, source: "portal" });
  logAudit({
    actor: req.user,
    action: "vm.request",
    target: hostname,
    detail: {
      templateId,
      cpu,
      memoryGB,
      diskGB,
      packages,
      packageSelection,
      requestId: result.request.id,
      jobId: result.job?.id || null,
      status: result.request.status,
    },
  });
  res.status(202).json({ request: result.request, job: result.job || null });
});

// Internal workflow provisioning (never calls Proxmox). Unlike a real VM, no
// environment/username is required; the workflow allocates the network,
// storage, firewall and DNS itself via the configured internal system APIs.
router.post("/provision/internal", (req, res) => {
  const { templateId, hostname, cpu, memoryGB, diskGB } = req.body;
  if (!templateId || !hostname || !cpu || !memoryGB || !diskGB) {
    return res.status(400).json({ error: "templateId, hostname, cpu, memoryGB, diskGB are required" });
  }
  if (!findInternalTemplate(templateId)) {
    return res.status(400).json({ error: `Unknown internal template: ${templateId}` });
  }
  const payload = { templateId, hostname, cpu, memoryGB, diskGB };
  const result = submitProvisionRequest({ kind: "internal", payload, requestedBy: req.user.username, source: "portal" });
  logAudit({
    actor: req.user,
    action: "internal.request",
    target: hostname,
    detail: {
      templateId,
      cpu,
      memoryGB,
      diskGB,
      requestId: result.request.id,
      jobId: result.job?.id || null,
      status: result.request.status,
    },
  });
  res.status(202).json({ request: result.request, job: result.job || null });
});

router.post("/provision/container", (req, res) => {
  const { templateId, hostname, cpu, memoryGB, packages, packageSelection } = req.body;
  if (!templateId || !hostname || !cpu || !memoryGB) {
    return res.status(400).json({ error: "templateId, hostname, cpu, memoryGB are required" });
  }
  const payload = { templateId, hostname, cpu, memoryGB, packages, packageSelection };
  const result = submitProvisionRequest({ kind: "container", payload, requestedBy: req.user.username, source: "portal" });
  logAudit({
    actor: req.user,
    action: "container.request",
    target: hostname,
    detail: {
      templateId,
      cpu,
      memoryGB,
      packages,
      packageSelection,
      requestId: result.request.id,
      jobId: result.job?.id || null,
      status: result.request.status,
    },
  });
  res.status(202).json({ request: result.request, job: result.job || null });
});

router.post("/provision/stack", (req, res) => {
  const { stackId, hostnamePrefix, cpu, memoryGB, diskGB, packages, packageSelection } = req.body;
  if (!stackId || !hostnamePrefix || !cpu || !memoryGB || !diskGB) {
    return res.status(400).json({ error: "stackId, hostnamePrefix, cpu, memoryGB, diskGB are required" });
  }
  const payload = { stackId, hostnamePrefix, cpu, memoryGB, diskGB, packages, packageSelection };
  const result = submitProvisionRequest({ kind: "stack", payload, requestedBy: req.user.username, source: "portal" });
  logAudit({
    actor: req.user,
    action: "stack.request",
    target: hostnamePrefix,
    detail: {
      stackId,
      packages,
      packageSelection,
      requestId: result.request.id,
      jobId: result.job?.id || null,
      status: result.request.status,
    },
  });
  res.status(202).json({ request: result.request, job: result.job || null });
});

// --- Provision requests / approvals ---
router.get("/requests", (req, res) => {
  res.json(listProvisionRequests(req.user));
});

router.post("/requests/:id/approve", (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Only admins can approve requests" });
  }

  const result = approveProvisionRequest({ id: req.params.id, approver: req.user.username });
  if (!result) return res.status(404).json({ error: "Request not found" });

  logAudit({
    actor: req.user,
    action: "request.approve",
    target: `Request ${req.params.id}`,
    detail: { requestId: req.params.id, jobId: result.job?.id || null },
  });

  res.json({ request: result.request, job: result.job || null });
});

router.post("/requests/:id/reject", (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Only admins can reject requests" });
  }

  const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
    ? req.body.reason.trim()
    : "Rejected by admin";

  const request = rejectProvisionRequest({ id: req.params.id, reviewer: req.user.username, reason });
  if (!request) return res.status(404).json({ error: "Request not found" });

  logAudit({
    actor: req.user,
    action: "request.reject",
    target: `Request ${req.params.id}`,
    detail: { requestId: req.params.id, reason },
  });

  res.json({ request });
});

// --- Job status ---
router.get("/jobs", (req, res) => {
  const all = listJobs();
  const visible = req.user.role === "admin"
    ? all
    : all.filter((j) => j.payload?.requestedBy === req.user.username);
  res.json(visible);
});
router.get("/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

export default router;
