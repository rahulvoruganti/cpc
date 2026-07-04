import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const MAP_FILE = path.join(DATA_DIR, "mappings.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MAP_FILE)) {
    fs.writeFileSync(MAP_FILE, JSON.stringify({ templates: {}, networks: {} }, null, 2));
  }
}

function read() {
  ensureStore();
  const store = JSON.parse(fs.readFileSync(MAP_FILE, "utf-8"));
  store.templates = store.templates || {};
  store.networks = store.networks || {};
  return store;
}

function write(store) {
  fs.writeFileSync(MAP_FILE, JSON.stringify(store, null, 2));
}

// --- Template mappings (keyed by Proxmox template VMID) ---
// { osName, cloudInitFile, credUser, credPassword, connectivity, port, packageManager, cloudInitSource }

export function getTemplateMappings() {
  return read().templates;
}

export function upsertTemplateMapping(vmid, patch) {
  const store = read();
  const key = String(vmid);
  const existing = store.templates[key] || {};
  // Blank password on save means "keep the current one".
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  if (patch.credPassword === "" || patch.credPassword == null) {
    next.credPassword = existing.credPassword || "";
  }
  store.templates[key] = next;
  write(store);
  return next;
}

export function deleteTemplateMapping(vmid) {
  const store = read();
  const key = String(vmid);
  if (store.templates[key]) {
    delete store.templates[key];
    write(store);
  }
}

// --- Network mappings (keyed by interface name) ---
// { type (override), label }

export function getNetworkMappings() {
  return read().networks;
}

export function upsertNetworkMapping(iface, patch) {
  const store = read();
  const existing = store.networks[iface] || {};
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  store.networks[iface] = next;
  write(store);
  return next;
}

export function deleteNetworkMapping(iface) {
  const store = read();
  if (store.networks[iface]) {
    delete store.networks[iface];
    write(store);
  }
}
