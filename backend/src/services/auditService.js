import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const AUDIT_FILE = path.join(DATA_DIR, "audit.json");

const MAX_ENTRIES = 5000; // keep file bounded

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(AUDIT_FILE)) {
    fs.writeFileSync(AUDIT_FILE, JSON.stringify({ entries: [] }, null, 2));
  }
}

function read() {
  ensureStore();
  return JSON.parse(fs.readFileSync(AUDIT_FILE, "utf-8"));
}

function write(store) {
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(store, null, 2));
}

/**
 * Record an action.
 * @param {object} p
 * @param {object} p.actor   - { id, username, role } or null for system
 * @param {string} p.action  - e.g. "vm.create", "vm.delete", "auth.login"
 * @param {string} p.target  - e.g. "VMID 105" or hostname
 * @param {string} p.status  - "success" | "failure"
 * @param {object} [p.detail]
 */
export function logAudit({ actor, action, target = "", status = "success", detail = {} }) {
  const store = read();
  store.entries.push({
    id: nanoid(10),
    timestamp: new Date().toISOString(),
    actor: actor ? { id: actor.id, username: actor.username, role: actor.role } : { username: "system" },
    action,
    target,
    status,
    detail,
  });
  if (store.entries.length > MAX_ENTRIES) {
    store.entries = store.entries.slice(-MAX_ENTRIES);
  }
  write(store);
}

export function listAudit({ limit = 200, action, username } = {}) {
  let entries = read().entries.slice().reverse(); // newest first
  if (action) entries = entries.filter((e) => e.action === action);
  if (username) entries = entries.filter((e) => e.actor?.username === username);
  return entries.slice(0, limit);
}
