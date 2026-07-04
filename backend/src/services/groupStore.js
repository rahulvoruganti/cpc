import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const GROUP_FILE = path.join(DATA_DIR, "groups.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(GROUP_FILE)) {
    fs.writeFileSync(GROUP_FILE, JSON.stringify({ groups: {} }, null, 2));
  }
}

function read() {
  ensureStore();
  const store = JSON.parse(fs.readFileSync(GROUP_FILE, "utf-8"));
  store.groups = store.groups || {};
  return store;
}

function write(store) {
  fs.writeFileSync(GROUP_FILE, JSON.stringify(store, null, 2));
}

// groups: { "<name>": { name, members: [username], createdAt } }

export function listGroups() {
  return Object.values(read().groups).sort((a, b) => a.name.localeCompare(b.name));
}

export function createGroup(name) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("Group name is required");
  const store = read();
  if (store.groups[clean]) throw new Error(`Group "${clean}" already exists`);
  store.groups[clean] = { name: clean, members: [], createdAt: new Date().toISOString() };
  write(store);
  return store.groups[clean];
}

export function deleteGroup(name) {
  const store = read();
  if (!store.groups[name]) throw new Error("Group not found");
  delete store.groups[name];
  write(store);
}

export function addMember(name, username) {
  const store = read();
  const g = store.groups[name];
  if (!g) throw new Error("Group not found");
  if (!g.members.includes(username)) g.members.push(username);
  write(store);
  return g;
}

export function removeMember(name, username) {
  const store = read();
  const g = store.groups[name];
  if (!g) throw new Error("Group not found");
  g.members = g.members.filter((m) => m !== username);
  write(store);
  return g;
}

// Group names a given user belongs to (case-insensitive on username).
export function groupsForUser(username) {
  if (!username) return [];
  const uname = String(username).toLowerCase();
  return Object.values(read().groups)
    .filter((g) => g.members.some((m) => String(m).toLowerCase() === uname))
    .map((g) => g.name);
}
