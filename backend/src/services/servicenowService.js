import crypto from "crypto";
import axios from "axios";
import { logAudit } from "./auditService.js";

// --- ServiceNow incident integration (MOCKED create) ---
// In production this would POST to /api/now/table/incident on the configured
// instance. Here we fabricate a realistic incident number + sys_id so the
// end-to-end flow (fail → incident → notify user) can be demonstrated without
// a real ServiceNow instance. Swap createIncident's body for a real axios POST
// (using the settings below) to go live. The connection test IS a real call.

// Read the instance URL live so a change saved in Settings applies immediately.
function instanceUrl() {
  return process.env.SERVICENOW_INSTANCE_URL || "https://dev-cpc.service-now.com";
}

// Whether failed deployments should raise an incident (default on).
export function incidentsEnabled() {
  return process.env.SERVICENOW_INCIDENTS_ENABLED !== "false";
}

// Verify connectivity to the configured ServiceNow instance using basic auth.
// Returns { url, platform } on success; throws with a readable message otherwise.
export async function testConnection() {
  const url = process.env.SERVICENOW_INSTANCE_URL;
  if (!url) throw new Error("ServiceNow instance URL is not configured");
  const username = process.env.SERVICENOW_USERNAME || "";
  const password = process.env.SERVICENOW_PASSWORD || "";
  try {
    const res = await axios.get(`${url.replace(/\/+$/, "")}/api/now/table/sys_user`, {
      params: { sysparm_limit: 1 },
      auth: username ? { username, password } : undefined,
      timeout: 10000,
    });
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) throw new Error(`Unexpected status ${res.status}`);
    return { url, platform: "ServiceNow ITSM" };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) throw new Error("Authentication failed — check the username and password");
    throw new Error(err.response?.data?.error?.message || err.message);
  }
}

// Sequence seeded once per process so numbers look monotonic within a session.
let seq = 1000000 + crypto.randomInt(1000, 8999);

export function createIncident({ shortDescription, description = "", callerId = "cpc-portal", jobId } = {}) {
  // Respect the admin toggle — when incidents are disabled, do nothing.
  if (!incidentsEnabled()) return null;
  const INSTANCE_URL = instanceUrl();
  seq += 1;
  const number = `INC${String(seq).padStart(7, "0")}`;
  const sysId = crypto.randomBytes(16).toString("hex");
  const incident = {
    number,
    sysId,
    state: "New",
    priority: "3 - Moderate",
    shortDescription: shortDescription || "CPC provisioning failure",
    description,
    callerId,
    jobId: jobId || null,
    url: `${INSTANCE_URL}/nav_to.do?uri=incident.do?sys_id=${sysId}`,
    createdAt: new Date().toISOString(),
    mock: true,
  };

  // Log it like any real outbound integration call.
  console.log(`[servicenow] (mock) created incident ${number} for job ${jobId || "?"}`);
  logAudit({
    actor: { username: "system", role: "system" },
    action: "servicenow.incident.create",
    target: number,
    detail: { jobId, shortDescription: incident.shortDescription, mock: true },
  });

  return incident;
}
