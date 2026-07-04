import axios from "axios";
import https from "https";

// K3s / Kubernetes API config is read from process.env at call time so changes
// saved in the admin Settings tab take effect without a restart.
function k3sConfig() {
  return {
    url: (process.env.K3S_API_URL || "").replace(/\/+$/, ""),
    token: process.env.K3S_API_TOKEN,
    verifyTls: process.env.K3S_VERIFY_TLS === "true",
  };
}

let client = null;
let clientSig = null;

function ensureClient() {
  const cfg = k3sConfig();
  const sig = `${cfg.url}:${cfg.verifyTls}`;
  if (!client || sig !== clientSig) {
    client = axios.create({
      baseURL: cfg.url,
      httpsAgent: new https.Agent({ rejectUnauthorized: cfg.verifyTls }),
    });
    clientSig = sig;
  }
  return client;
}

// Authenticated GET against the cluster API using the bearer token.
export async function k3sRequest(path) {
  const cfg = k3sConfig();
  if (!cfg.url) throw new Error("K3s API URL is not configured");
  if (!cfg.token) throw new Error("K3s API token is not configured");
  try {
    const res = await ensureClient().get(path, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    return res.data;
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data || err.message;
    throw new Error(`K3s API error [GET ${path}]: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}

// Lightweight connectivity check for the admin Settings tab. Reads /version.
export async function testConnection() {
  const v = await k3sRequest("/version");
  return {
    url: k3sConfig().url,
    gitVersion: v?.gitVersion ?? null,
    platform: v?.platform ?? null,
  };
}
