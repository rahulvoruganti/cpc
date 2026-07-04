import crypto from "crypto";
import { logAudit } from "./auditService.js";

// --- ServiceNow incident integration (MOCKED) ---
// In production this would POST to /api/now/table/incident on the configured
// instance. Here we fabricate a realistic incident number + sys_id so the
// end-to-end flow (fail → incident → notify user) can be demonstrated without
// a real ServiceNow instance. Swap createIncident's body for a real axios POST
// (using SERVICENOW_INSTANCE_URL / credentials) to go live.

const INSTANCE_URL = process.env.SERVICENOW_INSTANCE_URL || "https://dev-cpc.service-now.com";

// Sequence seeded once per process so numbers look monotonic within a session.
let seq = 1000000 + crypto.randomInt(1000, 8999);

export function createIncident({ shortDescription, description = "", callerId = "cpc-portal", jobId } = {}) {
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
