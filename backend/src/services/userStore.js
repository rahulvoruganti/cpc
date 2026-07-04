import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const DEFAULT_PREFERENCES = { theme: "slate", showBackground: true };

function withDefaults(user) {
  return {
    ...user,
    preferences: {
      ...DEFAULT_PREFERENCES,
      ...(user.preferences || {}),
    },
  };
}

function sanitizeUser(user) {
  const normalized = withDefaults(user);
  const { passwordHash, ...safe } = normalized;
  return safe;
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    // Seed a default admin on first run. Password must be changed after.
    const adminPass = process.env.CPC_ADMIN_PASSWORD || "admin123";
    const seed = {
      users: [
        {
          id: nanoid(8),
          username: "admin",
          displayName: "Administrator",
          email: "admin@cpc.local",
          role: "admin",
          source: "local",
          passwordHash: bcrypt.hashSync(adminPass, 10),
          createdAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify(seed, null, 2));
  }
}

function read() {
  ensureStore();
  const store = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  store.users = (store.users || []).map(withDefaults);
  return store;
}

function write(store) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(store, null, 2));
}

export function listUsers() {
  return read().users.map(sanitizeUser);
}

export function findByUsername(username) {
  return read().users.find((u) => u.username.toLowerCase() === username.toLowerCase());
}

export function findById(id) {
  return read().users.find((u) => u.id === id);
}

export function verifyPassword(user, password) {
  if (!user.passwordHash) return false;
  return bcrypt.compareSync(password, user.passwordHash);
}

export function createUser({ username, password, displayName, email, role = "user", source = "local" }) {
  const store = read();
  if (store.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error(`User "${username}" already exists`);
  }
  const user = {
    id: nanoid(8),
    username,
    displayName: displayName || username,
    email: email || "",
    role,
    source,
    passwordHash: password ? bcrypt.hashSync(password, 10) : null,
    preferences: { ...DEFAULT_PREFERENCES },
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  write(store);
  return sanitizeUser(user);
}

// Upsert an Entra/OIDC-authenticated user (no local password).
export function upsertExternalUser({ username, displayName, email, role = "user", source = "entra" }) {
  const store = read();
  let user = store.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (user) {
    user.displayName = displayName || user.displayName;
    user.email = email || user.email;
    user.source = source;
    write(store);
  } else {
    user = {
      id: nanoid(8),
      username,
      displayName: displayName || username,
      email: email || "",
      role,
      source,
      passwordHash: null,
      preferences: { ...DEFAULT_PREFERENCES },
      createdAt: new Date().toISOString(),
    };
    store.users.push(user);
    write(store);
  }
  return sanitizeUser(user);
}

export function updateUserRole(id, role) {
  const store = read();
  const user = store.users.find((u) => u.id === id);
  if (!user) throw new Error("User not found");
  user.role = role;
  write(store);
  return sanitizeUser(user);
}

export function updateUserPreferences(id, preferences = {}) {
  const store = read();
  const user = store.users.find((u) => u.id === id);
  if (!user) throw new Error("User not found");
  user.preferences = {
    ...DEFAULT_PREFERENCES,
    ...(user.preferences || {}),
    ...(preferences || {}),
  };
  write(store);
  return sanitizeUser(user);
}

export function deleteUser(id) {
  const store = read();
  const before = store.users.length;
  store.users = store.users.filter((u) => u.id !== id);
  if (store.users.length === before) throw new Error("User not found");
  write(store);
}
