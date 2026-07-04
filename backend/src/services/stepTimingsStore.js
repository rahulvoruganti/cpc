import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const FILE = path.join(DATA_DIR, "step-timings.json");

// ETAs are the learned average duration per template+step, padded by a buffer
// so the estimate is realistic rather than optimistic. Both are configurable.
const BUFFER = Number(process.env.ETA_BUFFER || 1.25);
const MIN_ETA_SEC = 2;
// Weight of the newest sample in the exponential moving average (0..1). Higher
// = adapts faster to recent runs; lower = smoother.
const EMA_ALPHA = 0.35;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ templates: {} }, null, 2));
}

function read() {
  ensureStore();
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    s.templates = s.templates || {};
    return s;
  } catch {
    return { templates: {} };
  }
}

function write(store) {
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

// Estimated seconds for a step: learned average × buffer, or the caller's
// seeded default when we have no history yet for this template+step.
export function etaFor(templateKey, stepKey, defaultSec) {
  const rec = read().templates[templateKey]?.[stepKey];
  const base = rec && rec.samples > 0 ? rec.avgSec : defaultSec;
  return Math.max(MIN_ETA_SEC, Math.ceil(base * BUFFER));
}

// Fold a completed step's actual duration into the moving average.
export function recordDuration(templateKey, stepKey, sec) {
  if (!templateKey || !stepKey || !(sec >= 0)) return;
  const store = read();
  store.templates[templateKey] = store.templates[templateKey] || {};
  const prev = store.templates[templateKey][stepKey];
  const avgSec = prev && prev.samples > 0
    ? Math.round(prev.avgSec * (1 - EMA_ALPHA) + sec * EMA_ALPHA)
    : Math.round(sec);
  store.templates[templateKey][stepKey] = {
    avgSec,
    lastSec: Math.round(sec),
    samples: (prev?.samples || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  write(store);
}

export function allTimings() {
  return read().templates;
}
