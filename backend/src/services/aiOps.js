import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "ai-playbook.json");

const { GEMINI_API_KEY, GEMINI_MODEL = "gemini-2.5-flash" } = process.env;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ---- cache ----
function readCache() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CACHE_FILE)) return { plans: {}, troubleshoot: {} };
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    return { plans: c.plans || {}, troubleshoot: c.troubleshoot || {} };
  } catch { return { plans: {}, troubleshoot: {} }; }
}
function writeCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); } catch { /* best-effort */ }
}

// Package-manager command templates.
const PM = {
  apt: { refresh: "apt-get update -y", install: (p) => `DEBIAN_FRONTEND=noninteractive apt-get install -y ${p}` },
  yum: { refresh: "yum makecache -y || true", install: (p) => `yum install -y ${p}` },
  dnf: { refresh: "dnf makecache -y || true", install: (p) => `dnf install -y ${p}` },
  apk: { refresh: "apk update", install: (p) => `apk add --no-cache ${p}` },
  zypper: { refresh: "zypper -n refresh || true", install: (p) => `zypper -n install ${p}` },
};

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`; // single-quote for shell

// Build the deterministic ordered install plan. Each step is { name, cmd }.
// (Kept deterministic so provisioning works with or without an AI key.)
export function buildInstallPlan({ packageManager, packages = [], username, password, sudo }) {
  const pm = PM[packageManager] || PM.apt;
  const pkgs = packages.filter(Boolean).join(" ");
  const steps = [];

  if (username) {
    steps.push({
      name: `create user ${username}`,
      cmd: `id ${shq(username)} >/dev/null 2>&1 || useradd -m -s /bin/bash ${shq(username)} 2>/dev/null || adduser -D ${shq(username)}`,
    });
    steps.push({
      name: "set user password",
      cmd: `echo ${shq(`${username}:${password}`)} | chpasswd 2>/dev/null || (echo ${shq(password)}; echo ${shq(password)}) | passwd ${shq(username)}`,
    });
    if (sudo) {
      steps.push({
        name: "grant sudo",
        cmd: `(usermod -aG sudo ${shq(username)} 2>/dev/null || usermod -aG wheel ${shq(username)} 2>/dev/null || true); ` +
          `printf '%s ALL=(ALL) NOPASSWD:ALL\\n' ${shq(username)} > /etc/sudoers.d/${username} && chmod 440 /etc/sudoers.d/${username}`,
      });
    }
  }

  if (pkgs) {
    steps.push({ name: "refresh package index", cmd: pm.refresh });
    steps.push({ name: `install packages (${pkgs})`, cmd: pm.install(pkgs) });
    // Best-effort enable of any package that ships a same-named service.
    steps.push({
      name: "enable services",
      cmd: `for s in ${pkgs}; do systemctl enable --now "$s" 2>/dev/null || rc-update add "$s" default 2>/dev/null || true; done`,
    });
  }

  return steps;
}

// ---- AI troubleshooting (best-effort; deterministic fallback = give up) ----
function errKey({ command, stderr }) {
  const sig = `${command}::${(stderr || "").slice(0, 200)}`;
  return sig.replace(/\s+/g, " ").trim().slice(0, 300);
}

// Ask the model for a single corrective shell command for a failed step.
// Returns { fix, note } or null. Results are cached to ai-playbook.json.
export async function aiTroubleshoot({ command, stderr, osName, packageManager }) {
  const cache = readCache();
  const key = errKey({ command, stderr });
  if (cache.troubleshoot[key]) return cache.troubleshoot[key];

  if (!GEMINI_API_KEY || GEMINI_API_KEY === "CHANGE_ME") return null;

  const prompt = `You are fixing a failed Linux provisioning step over SSH (root).
OS: ${osName || "unknown"}  Package manager: ${packageManager || "unknown"}
Command that failed:
${command}
stderr:
${(stderr || "").slice(0, 1200)}

Reply with STRICT JSON only: {"fix": "<a single non-interactive shell command that resolves the error, or null>", "note": "<short reason>"}.
Do not include markdown fences.`;

  try {
    const res = await axios.post(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }, { headers: { "Content-Type": "application/json" }, timeout: 20000 });

    const text = res.data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || "";
    const json = JSON.parse(text.replace(/```json|```/g, "").trim());
    const result = json.fix ? { fix: String(json.fix), note: json.note || "" } : null;
    if (result) { cache.troubleshoot[key] = result; writeCache(cache); }
    return result;
  } catch {
    return null; // AI unavailable / unparseable — caller proceeds without a fix
  }
}
