import { Router } from "express";
import {
  issueToken,
  isEntraConfigured,
  getEntraAuthUrl,
  exchangeEntraCode,
} from "../services/authService.js";
import {
  findByUsername,
  findById,
  verifyPassword,
  upsertExternalUser,
  updateUserPreferences,
} from "../services/userStore.js";
import { logAudit } from "../services/auditService.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// --- Local login ---
router.post("/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }
  const user = findByUsername(username);
  if (!user || user.source !== "local" || !verifyPassword(user, password)) {
    logAudit({ actor: { username }, action: "auth.login", status: "failure", detail: { reason: "bad credentials" } });
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = issueToken(user);
  logAudit({ actor: user, action: "auth.login", status: "success", detail: { method: "local" } });
  const { passwordHash, ...safe } = user;
  res.json({ token, user: safe });
});

// --- Entra ID availability + login URL ---
router.get("/auth/entra/status", (req, res) => {
  res.json({ enabled: isEntraConfigured() });
});

router.get("/auth/entra/login-url", (req, res) => {
  if (!isEntraConfigured()) {
    return res.status(400).json({ error: "Entra ID is not configured" });
  }
  res.json({ url: getEntraAuthUrl(req.query.state) });
});

// --- Entra ID callback: exchange code, upsert user, return our JWT ---
router.post("/auth/entra/callback", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });
  if (!isEntraConfigured()) {
    return res.status(400).json({ error: "Entra ID is not configured" });
  }
  try {
    const profile = await exchangeEntraCode(code);
    const user = upsertExternalUser({
      username: profile.username,
      displayName: profile.displayName,
      email: profile.email,
      source: "entra",
    });
    const token = issueToken(user);
    logAudit({ actor: user, action: "auth.login", status: "success", detail: { method: "entra" } });
    res.json({ token, user });
  } catch (err) {
    logAudit({ actor: { username: "unknown" }, action: "auth.login", status: "failure", detail: { method: "entra", error: err.message } });
    res.status(502).json({ error: `Entra ID login failed: ${err.message}` });
  }
});

// --- Who am I ---
router.get("/auth/me", requireAuth, (req, res) => {
  const stored = findById(req.user.id);
  if (!stored) {
    return res.status(404).json({ error: "User not found" });
  }
  const { passwordHash, ...safe } = stored;
  res.json({ user: safe });
});

router.get("/auth/preferences", requireAuth, (req, res) => {
  const stored = findById(req.user.id);
  if (!stored) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json({ preferences: stored.preferences || { theme: "slate", showBackground: true } });
});

router.put("/auth/preferences", requireAuth, (req, res) => {
  const { preferences } = req.body || {};
  if (!preferences || typeof preferences !== "object") {
    return res.status(400).json({ error: "preferences object required" });
  }
  const allowedThemes = ["slate", "forest", "sunrise"];
  if (preferences.theme && !allowedThemes.includes(preferences.theme)) {
    return res.status(400).json({ error: `theme must be one of: ${allowedThemes.join(", ")}` });
  }
  if (preferences.showBackground !== undefined && typeof preferences.showBackground !== "boolean") {
    return res.status(400).json({ error: "showBackground must be boolean" });
  }
  try {
    const user = updateUserPreferences(req.user.id, preferences);
    res.json({ preferences: user.preferences });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

export default router;
