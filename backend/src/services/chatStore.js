import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const CHAT_FILE = path.join(DATA_DIR, "chats.json");

const MAX_MESSAGES = 200; // cap per user to keep the file bounded

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CHAT_FILE)) {
    fs.writeFileSync(CHAT_FILE, JSON.stringify({ chats: {} }, null, 2));
  }
}

function read() {
  ensureStore();
  return JSON.parse(fs.readFileSync(CHAT_FILE, "utf-8"));
}

function write(store) {
  fs.writeFileSync(CHAT_FILE, JSON.stringify(store, null, 2));
}

export function getChat(username) {
  const store = read();
  return store.chats[username] || [];
}

export function saveChat(username, messages) {
  const store = read();
  const trimmed = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES) : [];
  store.chats[username] = trimmed;
  write(store);
  return trimmed;
}

export function clearChat(username) {
  const store = read();
  delete store.chats[username];
  write(store);
}
