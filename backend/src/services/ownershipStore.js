import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const OWNER_FILE = path.join(DATA_DIR, "ownership.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(OWNER_FILE)) {
    fs.writeFileSync(OWNER_FILE, JSON.stringify({ owners: {} }, null, 2));
  }
}

function read() {
  ensureStore();
  return JSON.parse(fs.readFileSync(OWNER_FILE, "utf-8"));
}

function write(store) {
  fs.writeFileSync(OWNER_FILE, JSON.stringify(store, null, 2));
}

// owners: { "105": { username, hostname, createdAt } }

export function setOwner(vmid, { username, hostname }) {
  const store = read();
  store.owners[String(vmid)] = {
    username,
    hostname,
    createdAt: new Date().toISOString(),
  };
  write(store);
}

export function getOwner(vmid) {
  return read().owners[String(vmid)] || null;
}

// Record the (DHCP-discovered) IP for a VM so the Resources list and web
// terminal can find it — replaces the old static IP pool lookup.
export function setOwnerIp(vmid, ip) {
  const store = read();
  const key = String(vmid);
  if (!store.owners[key]) store.owners[key] = { username: null, hostname: null, createdAt: new Date().toISOString() };
  store.owners[key].ip = ip;
  write(store);
}

export function removeOwner(vmid) {
  const store = read();
  if (store.owners[String(vmid)]) {
    delete store.owners[String(vmid)];
    write(store);
  }
}

export function listOwned(username) {
  const owners = read().owners;
  return Object.entries(owners)
    .filter(([, o]) => o.username === username)
    .map(([vmid, o]) => ({ vmid: Number(vmid), ...o }));
}

export function allOwners() {
  return read().owners;
}
