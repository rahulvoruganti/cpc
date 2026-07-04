import "dotenv/config";
// Apply persisted admin settings onto process.env BEFORE any service module is
// imported, so modules that capture env at load time see the saved overrides.
import "./services/settingsStore.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import http from "http";
import cors from "cors";
import apiRoutes from "./routes/api.js";
import settingsRoutes from "./routes/settings.js";
import chatRoutes from "./routes/chat.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import resourceRoutes from "./routes/resources.js";
import auditRoutes from "./routes/audit.js";
import mappingRoutes from "./routes/mappings.js";
import k3sRoutes from "./routes/k3s.js";
import notificationRoutes from "./routes/notifications.js";
import { attachTerminalWs } from "./routes/terminal.js";
import { startExpiryEnforcer } from "./services/expiryEnforcer.js";

const app = express();
app.use(cors());
app.use(express.json());

// Public auth endpoints + protected feature endpoints all under /api
app.use("/api", authRoutes);
app.use("/api", apiRoutes);
app.use("/api", chatRoutes);
app.use("/api", userRoutes);
app.use("/api", resourceRoutes);
app.use("/api", auditRoutes);
app.use("/api", mappingRoutes);
app.use("/api", settingsRoutes);
app.use("/api", k3sRoutes);
app.use("/api", notificationRoutes);

app.get("/health", (req, res) => res.json({ ok: true, product: "Colruyt Private Cloud" }));

// In production (e.g. the Docker image) the backend also serves the built
// frontend, so a single container answers the SPA, the /api routes and the
// /ws/ssh WebSocket from one origin. In dev this stays off — Vite serves the
// frontend on its own port and proxies /api + /ws here.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.env.FRONTEND_DIST || path.resolve(__dirname, "..", "..", "frontend", "dist");
const serveFrontend = process.env.NODE_ENV === "production" || process.env.SERVE_FRONTEND === "true";
if (serveFrontend && fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA fallback: any non-API/WS/health GET returns index.html so client-side
  // routing (React Router) works on deep links and refreshes.
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/ws") || req.path === "/health") return next();
    res.sendFile(path.join(distDir, "index.html"));
  });
  console.log(`Serving frontend from ${distDir}`);
}

const server = http.createServer(app);
attachTerminalWs(server);

const PORT = process.env.PORT || 4100;
server.listen(PORT, () => {
  console.log(`Colruyt Private Cloud (CPC) backend listening on :${PORT}`);
  startExpiryEnforcer();
});
