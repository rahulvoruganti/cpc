import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const FILE = path.join(DATA_DIR, "notifications.json");

// Keep the store bounded so the file doesn't grow without limit.
const MAX_NOTIFICATIONS = 500;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ notifications: [] }, null, 2));
}

function read() {
  ensureStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return Array.isArray(parsed.notifications) ? parsed.notifications : [];
  } catch {
    return [];
  }
}

function write(list) {
  ensureStore();
  const trimmed = list
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, MAX_NOTIFICATIONS);
  fs.writeFileSync(FILE, JSON.stringify({ notifications: trimmed }, null, 2));
}

// A notification targets either a specific user (`recipient`) or everyone with a
// role (`role`, e.g. "admin"). `link` is a client route the bell opens on click.
export function addNotification({ recipient = null, role = null, type = "info", title, message = "", link = null, meta = {} }) {
  const list = read();
  const note = {
    id: nanoid(10),
    recipient,
    role,
    type,
    title,
    message,
    link,
    meta,
    read: false,
    createdAt: new Date().toISOString(),
  };
  list.push(note);
  write(list);
  return note;
}

// Convenience wrappers.
export function notifyAdmins(payload) {
  return addNotification({ ...payload, role: "admin", recipient: null });
}
export function notifyUser(username, payload) {
  return addNotification({ ...payload, recipient: username, role: null });
}

// Everything visible to a user: addressed to them directly, or to their role.
function isForUser(note, user) {
  if (note.recipient && note.recipient === user.username) return true;
  if (note.role && note.role === user.role) return true;
  return false;
}

export function listForUser(user, { limit = 50 } = {}) {
  return read()
    .filter((n) => isForUser(n, user))
    .slice(0, limit);
}

export function unreadCountForUser(user) {
  return read().filter((n) => isForUser(n, user) && !n.read).length;
}

export function markRead(id, user) {
  const list = read();
  const note = list.find((n) => n.id === id && isForUser(n, user));
  if (!note) return false;
  note.read = true;
  write(list);
  return true;
}

export function markAllRead(user) {
  const list = read();
  let changed = 0;
  for (const n of list) {
    if (isForUser(n, user) && !n.read) { n.read = true; changed += 1; }
  }
  if (changed) write(list);
  return changed;
}
