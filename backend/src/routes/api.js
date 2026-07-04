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
  getProvisionRequest,
  approveProvisionRequest,
  rejectProvisionRequest,
  confirmResizeReboot,
} from "../services/requestStore.js";
import { computeRequestImpact } from "../services/capacityService.js";
import { generateIac, IAC_TOOLS, isIacTool } from "../services/iacTemplates.js";

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

// Lifetime (in days) the requester asked for on the provisioning form. Coerce
// to a sane whole number; fall back to the system default when missing/invalid.
function normalizeTtlDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return undefined; // let expiryStore apply its default
  return Math.min(Math.round(n), 3650);
}

// Resolve a human-readable OS / template name for a request, so the admin
// review dialog can show what's being built without another lookup client-side.
function resolveRequestOs(request) {
  const p = request?.payload || {};
  if (request?.kind === "vm") {
    const tpl = [...mappedVmTemplates(), ...internalVmTemplates()].find((t) => t.id === p.templateId);
    return tpl?.osName || tpl?.name || p.templateId || null;
  }
  if (request?.kind === "internal") {
    const tpl = findInternalTemplate(p.templateId);
    return tpl?.osName || tpl?.name || p.templateId || null;
  }
  if (request?.kind === "container") {
    const tpl = CONTAINER_TEMPLATES.find((t) => t.id === p.templateId);
    return tpl?.osName || tpl?.name || p.templateId || null;
  }
  if (request?.kind === "stack") {
    const st = STACKS.find((s) => s.id === p.stackId);
    return st?.name || p.stackId || null;
  }
  return null;
}

const router = Router();

// Everything here requires authentication.
router.use(requireAuth);

// Default packages defined per template in the Provision workspace (e.g. MEAN,
// MERN). Read live from config/templateDefaults.json so it's editable without
// a code change or restart. Shape: { "<TemplateName or id>": [{ letter, name }] }.
const TEMPLATE_DEFAULTS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "config", "templateDefaults.json"
);
function readTemplateDefaults() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TEMPLATE_DEFAULTS_FILE, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
// Resolve the default packages for a template. Matches a templateDefaults key
// against the template's name or id, case-insensitively and tolerant of extra
// wording (e.g. key "MERN" matches "MERN Stack" or "ubuntu-mern"). Falls back
// to a "default"/"*" catch-all entry if present.
function defaultsForTemplate(defaults, tpl = {}) {
  const cands = [tpl.name, tpl.id, tpl.osName].filter(Boolean).map((s) => String(s).toLowerCase());
  for (const [key, val] of Object.entries(defaults)) {
    if (key === "default" || key === "*") continue;
    const k = key.toLowerCase();
    if (cands.some((c) => c === k || c.includes(k) || k.includes(c))) {
      return Array.isArray(val) ? val : [];
    }
  }
  const fallback = defaults.default || defaults["*"];
  return Array.isArray(fallback) ? fallback : [];
}
// Attach each template's default packages so they always travel with the
// template (shown in the catalog list and the config form).
function withDefaults(list) {
  const defaults = readTemplateDefaults();
  return list.map((t) => ({ ...t, defaultPackages: defaultsForTemplate(defaults, t) }));
}

// --- Catalog ---
// VM templates come from Mappings (admin-controlled) plus the fixed internal
// workflow templates (config/internalCatalog.js, provider: "internal").
// Containers and stacks still come from the static catalog for now.
router.get("/catalog/vm-templates", (req, res) => res.json(withDefaults([...mappedVmTemplates(), ...internalVmTemplates()])));
router.get("/catalog/container-templates", (req, res) => res.json(withDefaults(CONTAINER_TEMPLATES)));
router.get("/catalog/stacks", (req, res) => res.json(withDefaults(STACKS)));

router.get("/catalog/template-defaults", (req, res) => res.json(readTemplateDefaults()));

// --- Infrastructure-as-Code export ---
// The available tools, and a generator that returns a ready-to-use file for a
// given template so users can provision/manage from Terraform, Ansible, etc.
router.get("/catalog/iac/tools", (req, res) => res.json(IAC_TOOLS));

router.get("/catalog/iac", (req, res) => {
  const { kind, id, tool } = req.query;
  if (!kind || !id || !tool) {
    return res.status(400).json({ error: "kind, id and tool are required" });
  }
  if (!isIacTool(tool)) {
    return res.status(400).json({ error: `Unknown tool: ${tool}` });
  }

  let template = null;
  if (kind === "vm") template = [...mappedVmTemplates(), ...internalVmTemplates()].find((t) => t.id === id);
  else if (kind === "container") template = CONTAINER_TEMPLATES.find((t) => t.id === id);
  else if (kind === "stack") template = STACKS.find((t) => t.id === id);
  if (!template) {
    return res.status(404).json({ error: `Template not found: ${kind}/${id}` });
  }

  const baseUrl = process.env.CPC_PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  const file = generateIac({ tool, kind, template, baseUrl });
  res.json(file);
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
  const { templateId, hostname, cpu, memoryGB, diskGB, ttlDays, permanent, packages, packageSelection, username, sudoAccess, environment } = req.body;
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
    templateId, hostname, cpu, memoryGB, diskGB, ttlDays: normalizeTtlDays(ttlDays), permanent: !!permanent, packages, packageSelection,
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
  const { templateId, hostname, cpu, memoryGB, diskGB, ttlDays, permanent } = req.body;
  if (!templateId || !hostname || !cpu || !memoryGB || !diskGB) {
    return res.status(400).json({ error: "templateId, hostname, cpu, memoryGB, diskGB are required" });
  }
  if (!findInternalTemplate(templateId)) {
    return res.status(400).json({ error: `Unknown internal template: ${templateId}` });
  }
  const payload = { templateId, hostname, cpu, memoryGB, diskGB, ttlDays: normalizeTtlDays(ttlDays), permanent: !!permanent };
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
  const { templateId, hostname, cpu, memoryGB, ttlDays, permanent, packages, packageSelection } = req.body;
  if (!templateId || !hostname || !cpu || !memoryGB) {
    return res.status(400).json({ error: "templateId, hostname, cpu, memoryGB are required" });
  }
  const payload = { templateId, hostname, cpu, memoryGB, ttlDays: normalizeTtlDays(ttlDays), permanent: !!permanent, packages, packageSelection };
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
  const { stackId, hostnamePrefix, cpu, memoryGB, diskGB, ttlDays, permanent, packages, packageSelection } = req.body;
  if (!stackId || !hostnamePrefix || !cpu || !memoryGB || !diskGB) {
    return res.status(400).json({ error: "stackId, hostnamePrefix, cpu, memoryGB, diskGB are required" });
  }
  const payload = { stackId, hostnamePrefix, cpu, memoryGB, diskGB, ttlDays: normalizeTtlDays(ttlDays), permanent: !!permanent, packages, packageSelection };
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

// Capacity impact of a pending request — powers the admin review dialog. Admins
// only, since it exposes node-wide provisioning totals.
router.get("/requests/:id/impact", async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Only admins can view request impact" });
  }
  const request = getProvisionRequest(req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found" });
  try {
    const impact = await computeRequestImpact(request);
    const p = request.payload || {};
    // Requestor / target context for the review dialog.
    impact.details = {
      requestedBy: request.requestedBy || null,
      createdAt: request.createdAt || null,
      kind: request.kind,
      hostname: p.hostname || p.hostnamePrefix || null,
      os: resolveRequestOs(request),
      environment: p.environment || null,
      username: p.username || null,
    };
    res.json(impact);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post("/requests/:id/approve", async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Only admins can approve requests" });
  }

  let result;
  try {
    result = await approveProvisionRequest({ id: req.params.id, approver: req.user.username });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  if (!result) return res.status(404).json({ error: "Request not found" });

  logAudit({
    actor: req.user,
    action: "request.approve",
    target: `Request ${req.params.id}`,
    detail: { requestId: req.params.id, jobId: result.job?.id || null },
  });

  res.json({ request: result.request, job: result.job || null });
});

// Owner (or admin) confirms the reboot after an approved resize was applied.
router.post("/requests/:id/confirm-reboot", async (req, res) => {
  const request = getProvisionRequest(req.params.id);
  if (!request || request.kind !== "resize") {
    return res.status(404).json({ error: "Resize request not found" });
  }
  if (req.user.role !== "admin" && request.requestedBy !== req.user.username) {
    return res.status(403).json({ error: "You can only reboot your own resource" });
  }
  try {
    const result = await confirmResizeReboot({ id: req.params.id, actor: req.user.username });
    logAudit({
      actor: req.user,
      action: "resize.reboot",
      target: `VMID ${request.payload?.vmid}`,
      detail: { requestId: req.params.id },
    });
    res.json({ request: result.request });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
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
