import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const EXPIRY_FILE = path.join(DATA_DIR, "expiry.json");

// Default lifetime applied to every provisioned resource. Admins can extend it.
export const DEFAULT_TTL_DAYS = Number(process.env.RESOURCE_TTL_DAYS || 30);

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EXPIRY_FILE)) {
    fs.writeFileSync(EXPIRY_FILE, JSON.stringify({ expiry: {} }, null, 2));
  }
}

function read() {
  ensureStore();
  return JSON.parse(fs.readFileSync(EXPIRY_FILE, "utf-8"));
}

function write(store) {
  fs.writeFileSync(EXPIRY_FILE, JSON.stringify(store, null, 2));
}

// expiry: { "105": { expiresAt, setBy, updatedAt } }

function daysFromNow(days) {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

export function getExpiry(vmid) {
  return read().expiry[String(vmid)] || null;
}

// Set a default expiry only if the resource doesn't already have one. Called
// on provision — safe to invoke repeatedly (won't keep pushing the date out).
export function setDefaultExpiry(vmid, setBy = "system") {
  const store = read();
  const key = String(vmid);
  if (store.expiry[key]) return store.expiry[key];
  const record = {
    expiresAt: daysFromNow(DEFAULT_TTL_DAYS),
    setBy,
    updatedAt: new Date().toISOString(),
  };
  store.expiry[key] = record;
  write(store);
  return record;
}

// Admin action: push the expiry out by N days from now (or set an explicit date).
export function extendExpiry(vmid, { days, expiresAt, setBy = "admin" } = {}) {
  const store = read();
  const key = String(vmid);
  const record = {
    expiresAt: expiresAt || daysFromNow(days ?? DEFAULT_TTL_DAYS),
    setBy,
    updatedAt: new Date().toISOString(),
  };
  store.expiry[key] = record;
  write(store);
  return record;
}

export function removeExpiry(vmid) {
  const store = read();
  const key = String(vmid);
  if (store.expiry[key]) {
    delete store.expiry[key];
    write(store);
  }
}

export function allExpiries() {
  return read().expiry;
}

export function isExpired(vmid) {
  const rec = getExpiry(vmid);
  return rec ? new Date(rec.expiresAt).getTime() <= Date.now() : false;
}
