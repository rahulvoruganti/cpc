import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

// The editable configuration surface, grouped for the admin Settings tab.
// `live: true`  → the consuming code reads process.env at call time, so a
//                 saved change takes effect immediately.
// `live: false` → the value is captured at module load, so a change is
//                 persisted and applied on the next backend restart.
// `secret: true`→ never returned to the client; a blank value on save means
//                 "keep the existing one".
export const SETTING_GROUPS = [
  {
    id: "proxmox",
    title: "Proxmox connection",
    note: "Applies immediately — the next Proxmox call uses the new settings.",
    live: true,
    fields: [
      { key: "PROXMOX_HOST", label: "Host / IP", type: "text", placeholder: "10.0.0.10" },
      { key: "PROXMOX_PORT", label: "Port", type: "text", placeholder: "8006" },
      { key: "PROXMOX_NODE", label: "Node name", type: "text", placeholder: "pve" },
      { key: "PROXMOX_USERNAME", label: "Username", type: "text", placeholder: "root@pam" },
      { key: "PROXMOX_PASSWORD", label: "Password", type: "text", secret: true },
      { key: "PROXMOX_VERIFY_SSL", label: "Verify TLS certificate", type: "bool" },
    ],
  },
  {
    id: "k3s",
    title: "K3s / Kubernetes API",
    note: "Applies immediately — used to talk to the K3s cluster API.",
    live: true,
    fields: [
      { key: "K3S_API_URL", label: "API server URL", type: "text", placeholder: "https://10.0.0.20:6443" },
      { key: "K3S_API_TOKEN", label: "API token", type: "text", secret: true },
      { key: "K3S_VERIFY_TLS", label: "Verify TLS certificate", type: "bool" },
    ],
  },
  {
    id: "vm",
    title: "VM defaults",
    note: "Applies immediately to newly provisioned resources.",
    live: true,
    fields: [
      { key: "VM_SSH_PASSWORD", label: "Default cloud-init SSH password", type: "text", secret: true },
      { key: "SNIPPET_STORAGE", label: "Cloud-init snippet storage", type: "text", placeholder: "local" },
    ],
  },
  {
    id: "internal",
    title: "Internal provisioning systems",
    note: "Applies immediately. Endpoints the Colruyt Internal workflow calls — one per team API / Ansible playbook. A step whose URL is blank is simulated until it's configured.",
    live: true,
    fields: [
      { key: "INTERNAL_LINUX_URL", label: "Linux team API URL", type: "text", placeholder: "https://linux.internal/api" },
      { key: "INTERNAL_LINUX_TOKEN", label: "Linux team API token", type: "text", secret: true },
      { key: "INTERNAL_NETWORK_URL", label: "Network team API URL", type: "text", placeholder: "https://network.internal/api/ip" },
      { key: "INTERNAL_NETWORK_TOKEN", label: "Network team API token", type: "text", secret: true },
      { key: "INTERNAL_COMPUTE_URL", label: "Compute & Storage team API URL", type: "text", placeholder: "https://compute.internal/api" },
      { key: "INTERNAL_COMPUTE_TOKEN", label: "Compute & Storage team API token", type: "text", secret: true },
      { key: "INTERNAL_LINUX_ANSIBLE_URL", label: "Linux team Ansible (AAP) URL", type: "text", placeholder: "https://aap.internal/api/v2/job_templates/…/launch/" },
      { key: "INTERNAL_LINUX_ANSIBLE_TOKEN", label: "Linux team Ansible token", type: "text", secret: true },
      { key: "INTERNAL_SERVICENOW_ANSIBLE_URL", label: "ServiceNow Ansible URL", type: "text", placeholder: "https://aap.internal/api/v2/job_templates/…/launch/" },
      { key: "INTERNAL_SERVICENOW_ANSIBLE_TOKEN", label: "ServiceNow Ansible token", type: "text", secret: true },
      { key: "INTERNAL_VERIFY_TLS", label: "Verify TLS certificates", type: "bool" },
      { key: "INTERNAL_HTTP_TIMEOUT_MS", label: "HTTP timeout (ms)", type: "number", placeholder: "30000" },
    ],
  },
  {
    id: "servicenow",
    title: "ServiceNow (ITSM)",
    note: "Applies immediately. Link the portal to your ServiceNow instance so deployment failures raise an incident there. Leave the URL blank to keep incidents mocked.",
    live: true,
    fields: [
      { key: "SERVICENOW_INSTANCE_URL", label: "Instance URL", type: "text", placeholder: "https://yourcompany.service-now.com" },
      { key: "SERVICENOW_USERNAME", label: "Username", type: "text", placeholder: "cpc.integration" },
      { key: "SERVICENOW_PASSWORD", label: "Password", type: "text", secret: true },
      { key: "SERVICENOW_INCIDENTS_ENABLED", label: "Raise an incident when a deployment fails", type: "bool" },
    ],
  },
  {
    id: "ipam",
    title: "IPAM (IP Address Management)",
    note: "Applies immediately. Link an IPAM system (phpIPAM, NetBox, Infoblox, …) so the portal can reserve and release IP addresses through its API.",
    live: true,
    fields: [
      { key: "IPAM_URL", label: "API base URL", type: "text", placeholder: "https://ipam.internal/api/v2" },
      { key: "IPAM_USERNAME", label: "Username / App ID", type: "text", placeholder: "cpc" },
      { key: "IPAM_API_TOKEN", label: "API token / key", type: "text", secret: true },
      { key: "IPAM_VERIFY_TLS", label: "Verify TLS certificate", type: "bool" },
    ],
  },
  {
    id: "ai",
    title: "AI assistant (Gemini)",
    note: "Takes effect after a backend restart.",
    live: false,
    fields: [
      { key: "GEMINI_API_KEY", label: "Gemini API key", type: "text", secret: true },
      { key: "GEMINI_MODEL", label: "Model", type: "text", placeholder: "gemini-2.5-flash" },
    ],
  },
  {
    id: "cost",
    title: "Cost estimation",
    note: "Applies immediately. Per-month unit prices (in euro) used to estimate the cost of a resource on the provisioning form.",
    live: true,
    fields: [
      { key: "COST_PER_CPU", label: "Per CPU core (€ / month)", type: "number", placeholder: "21.50", default: "21.50" },
      { key: "COST_PER_GB_RAM", label: "Per GB RAM (€ / month)", type: "number", placeholder: "1", default: "1" },
      { key: "COST_PER_GB_STORAGE", label: "Per GB storage (€ / month)", type: "number", placeholder: "0.14", default: "0.14" },
    ],
  },
  {
    id: "approvals",
    title: "Approval policy",
    note: "Takes effect after a backend restart.",
    live: false,
    fields: [
      { key: "AUTO_APPROVE_DEPLOYMENTS", label: "Auto-approve all deployments", type: "boolNegated",
        hint: "When off, deployments over the thresholds below need admin approval." },
      { key: "APPROVAL_CPU_THRESHOLD", label: "CPU cores threshold", type: "number", placeholder: "2" },
      { key: "APPROVAL_MEMORY_GB_THRESHOLD", label: "Memory (GB) threshold", type: "number", placeholder: "4" },
      { key: "APPROVAL_DISK_GB_THRESHOLD", label: "Disk (GB) threshold", type: "number", placeholder: "50" },
    ],
  },
  {
    id: "entra",
    title: "Entra ID (Azure AD) SSO",
    note: "Takes effect after a backend restart. Leave blank to disable Entra login.",
    live: false,
    fields: [
      { key: "ENTRA_TENANT_ID", label: "Tenant ID", type: "text" },
      { key: "ENTRA_CLIENT_ID", label: "Client ID", type: "text" },
      { key: "ENTRA_CLIENT_SECRET", label: "Client secret", type: "text", secret: true },
      { key: "ENTRA_REDIRECT_URI", label: "Redirect URI", type: "text",
        placeholder: "http://localhost:5273/auth/entra/callback" },
    ],
  },
];

const FIELD_BY_KEY = new Map();
for (const group of SETTING_GROUPS) {
  for (const field of group.fields) FIELD_BY_KEY.set(field.key, field);
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({}, null, 2));
  }
}

// Raw persisted overrides — a flat { KEY: "string value" } map. Only keys the
// admin has changed appear here; everything else falls through to .env defaults.
function readOverrides() {
  ensureStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeOverrides(overrides) {
  ensureStore();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(overrides, null, 2));
}

// Layer persisted overrides on top of process.env so every consumer — whether
// it reads env at call time or captured it at boot — sees the saved values.
export function applyToEnv() {
  const overrides = readOverrides();
  for (const [key, value] of Object.entries(overrides)) {
    if (FIELD_BY_KEY.has(key) && value != null) {
      process.env[key] = String(value);
    }
  }
}

function isSecretSet(key) {
  const v = process.env[key];
  return typeof v === "string" && v.trim() !== "" && v !== "CHANGE_ME";
}

// Client-safe view of the current effective config. Secrets are never sent —
// only a boolean saying whether a value is set.
export function getEffectiveSettings() {
  return {
    groups: SETTING_GROUPS.map((group) => ({
      id: group.id,
      title: group.title,
      note: group.note,
      live: group.live,
      fields: group.fields.map((field) => {
        const raw = process.env[field.key] ?? "";
        const base = { key: field.key, label: field.label, type: field.type,
          placeholder: field.placeholder || "", hint: field.hint || "" };
        if (field.secret) {
          return { ...base, secret: true, isSet: isSecretSet(field.key), value: "" };
        }
        if (field.type === "bool") {
          return { ...base, value: raw === "true" };
        }
        if (field.type === "boolNegated") {
          // Stored env is the raw string; the toggle shows the human-friendly
          // meaning (auto-approve ON == env !== "false").
          return { ...base, value: raw !== "false" };
        }
        // Fall back to the field's default when nothing has been saved yet, so
        // the form shows a sensible starting value instead of a blank box.
        if (raw === "" && field.default != null) {
          return { ...base, value: field.default };
        }
        return { ...base, value: raw };
      }),
    })),
  };
}

// Merge a { KEY: value } patch: validate keys, coerce booleans to the env
// string convention, and treat a blank secret as "leave unchanged".
export function updateSettings(patch = {}) {
  const overrides = readOverrides();

  for (const [key, value] of Object.entries(patch)) {
    const field = FIELD_BY_KEY.get(key);
    if (!field) continue; // ignore unknown keys

    if (field.secret) {
      if (value == null || String(value).trim() === "") continue; // keep existing
      overrides[key] = String(value);
      continue;
    }

    if (field.type === "bool") {
      overrides[key] = value ? "true" : "false";
      continue;
    }
    if (field.type === "boolNegated") {
      // toggle ON  → auto-approve on  → env "true"
      // toggle OFF → auto-approve off → env "false"
      overrides[key] = value ? "true" : "false";
      continue;
    }
    overrides[key] = value == null ? "" : String(value);
  }

  writeOverrides(overrides);
  applyToEnv();
  return getEffectiveSettings();
}

// Default per-month unit prices (euro) used when the admin hasn't set them.
const DEFAULT_COST_RATES = { perCpu: 21.5, perGbRam: 1, perGbStorage: 0.14 };

// Effective cost-estimation rates. Reads the current (possibly overridden) env
// values and falls back to the defaults for anything blank or non-numeric.
// Safe to expose to any authenticated user — no secrets involved.
export function getCostRates() {
  const num = (key, fallback) => {
    const parsed = Number.parseFloat(process.env[key]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    perCpu: num("COST_PER_CPU", DEFAULT_COST_RATES.perCpu),
    perGbRam: num("COST_PER_GB_RAM", DEFAULT_COST_RATES.perGbRam),
    perGbStorage: num("COST_PER_GB_STORAGE", DEFAULT_COST_RATES.perGbStorage),
    currency: "EUR",
  };
}

// Apply persisted overrides as soon as this module is imported, so it must be
// imported before any service that captures env at module load.
applyToEnv();
