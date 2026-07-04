import "dotenv/config";
// Apply persisted admin settings onto process.env BEFORE any service module is
// imported, so modules that capture env at load time see the saved overrides.
import "./services/settingsStore.js";
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

app.get("/health", (req, res) => res.json({ ok: true, product: "Colruyt Private Cloud" }));

const server = http.createServer(app);
attachTerminalWs(server);

const PORT = process.env.PORT || 4100;
server.listen(PORT, () => {
  console.log(`Colruyt Private Cloud (CPC) backend listening on :${PORT}`);
  startExpiryEnforcer();
});
