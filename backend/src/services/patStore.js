import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// Personal Access Tokens — long-lived credentials a user generates to drive the
// CPC API from Terraform / Ansible / CLI without an interactive login. Only a
// SHA-256 hash of each token is stored; the raw value is shown once at creation.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const PAT_FILE = path.join(DATA_DIR, "pats.json");

const TOKEN_PREFIX = "cpc_pat_";

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PAT_FILE)) fs.writeFileSync(PAT_FILE, JSON.stringify({ pats: [] }, null, 2));
}
function read() {
  ensureStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(PAT_FILE, "utf-8"));
    return parsed && Array.isArray(parsed.pats) ? parsed : { pats: [] };
  } catch {
    return { pats: [] };
  }
}
function write(store) {
  ensureStore();
  fs.writeFileSync(PAT_FILE, JSON.stringify(store, null, 2));
}

const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

// Strip the secret hash before returning metadata to a client.
const publicView = ({ tokenHash, ...meta }) => meta;

export function createPat({ username, role, name, expiresInDays }) {
  const store = read();
  const raw = `${TOKEN_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
  const now = new Date();
  let expiresAt = null;
  const days = Number(expiresInDays);
  if (Number.isFinite(days) && days > 0) {
    expiresAt = new Date(now.getTime() + days * 86400000).toISOString();
  }
  const record = {
    id: crypto.randomBytes(8).toString("hex"),
    name: (name && String(name).trim()) || "token",
    username,
    role,
    prefix: `${raw.slice(0, 16)}…`,
    tokenHash: hashToken(raw),
    createdAt: now.toISOString(),
    lastUsedAt: null,
    expiresAt,
  };
  store.pats.push(record);
  write(store);
  return { token: raw, pat: publicView(record) };
}

export function listPats(username) {
  return read().pats
    .filter((p) => p.username === username)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(publicView);
}

export function revokePat(username, id) {
  const store = read();
  const before = store.pats.length;
  store.pats = store.pats.filter((p) => !(p.id === id && p.username === username));
  if (store.pats.length === before) return false;
  write(store);
  return true;
}

// Validate a presented token. Returns { username, role, patId } or null.
export function verifyPat(token) {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const store = read();
  const h = hashToken(token);
  const rec = store.pats.find((p) => p.tokenHash === h);
  if (!rec) return null;
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) return null;
  rec.lastUsedAt = new Date().toISOString();
  write(store);
  return { username: rec.username, role: rec.role, patId: rec.id };
}

export const isPatToken = (token) => typeof token === "string" && token.startsWith(TOKEN_PREFIX);
