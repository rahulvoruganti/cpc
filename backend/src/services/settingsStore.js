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
    note: "Applies immediately. Endpoints the internal workflow (Internal Linux Server) calls — one per system. A step whose URL is blank fails until it's configured.",
    live: true,
    fields: [
      { key: "INTERNAL_ITSM_URL", label: "ITSM endpoint URL", type: "text", placeholder: "https://itsm.internal/api/requests" },
      { key: "INTERNAL_ITSM_TOKEN", label: "ITSM API token", type: "text", secret: true },
      { key: "INTERNAL_IPAM_URL", label: "IPAM endpoint URL", type: "text", placeholder: "https://ipam.internal/api/allocate" },
      { key: "INTERNAL_IPAM_TOKEN", label: "IPAM API token", type: "text", secret: true },
      { key: "INTERNAL_COMPUTE_URL", label: "Compute broker URL", type: "text", placeholder: "https://compute.internal/api/reserve" },
      { key: "INTERNAL_COMPUTE_TOKEN", label: "Compute broker token", type: "text", secret: true },
      { key: "INTERNAL_STORAGE_URL", label: "Storage orchestrator URL", type: "text", placeholder: "https://storage.internal/api/volumes" },
      { key: "INTERNAL_STORAGE_TOKEN", label: "Storage orchestrator token", type: "text", secret: true },
      { key: "INTERNAL_FIREWALL_URL", label: "Firewall change URL", type: "text", placeholder: "https://firewall.internal/api/changes" },
      { key: "INTERNAL_FIREWALL_TOKEN", label: "Firewall change token", type: "text", secret: true },
      { key: "INTERNAL_DNS_URL", label: "DNS endpoint URL", type: "text", placeholder: "https://dns.internal/api/records" },
      { key: "INTERNAL_DNS_TOKEN", label: "DNS API token", type: "text", secret: true },
      { key: "INTERNAL_CMDB_URL", label: "CMDB endpoint URL", type: "text", placeholder: "https://cmdb.internal/api/ci" },
      { key: "INTERNAL_CMDB_TOKEN", label: "CMDB API token", type: "text", secret: true },
      { key: "INTERNAL_VERIFY_TLS", label: "Verify TLS certificates", type: "bool" },
      { key: "INTERNAL_HTTP_TIMEOUT_MS", label: "HTTP timeout (ms)", type: "number", placeholder: "30000" },
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

// Apply persisted overrides as soon as this module is imported, so it must be
// imported before any service that captures env at module load.
applyToEnv();
