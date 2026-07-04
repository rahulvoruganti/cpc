// Config-driven catalog for the internal provisioning workflow.
//
// Selecting this template does NOT clone a Proxmox VM — it runs our internal
// provisioning process end to end, calling each real internal system in turn
// (ITSM, IPAM, compute broker, SAN storage, firewall, DNS, CMDB). Each step's
// endpoint + token is configured in the admin Settings tab ("Internal
// provisioning systems"); the actual calls live in
// services/internalProvisioningApis.js.
//
// Edit this file to add / reorder steps or add more internal templates.

// `system` is the settings key (INTERNAL_<SYSTEM>_URL) the step calls. It lets
// the provisioner skip a step whose endpoint isn't configured. Note ITSM backs
// both the opening and the handover step.
export const INTERNAL_WORKFLOW = [
  { key: "itsm", api: "openServiceRequest", system: "ITSM", label: "Registering the service request in ITSM" },
  { key: "ipam", api: "allocateIpAddress", system: "IPAM", label: "Requesting an IP address from IPAM" },
  { key: "compute", api: "reserveCompute", system: "COMPUTE", label: "Reserving compute capacity in the datacenter" },
  { key: "storage", api: "reserveStorage", system: "STORAGE", label: "Reserving a storage volume on the SAN" },
  { key: "firewall", api: "requestFirewallAccess", system: "FIREWALL", label: "Requesting firewall access rules" },
  { key: "dns", api: "createDnsRecord", system: "DNS", label: "Creating the DNS record" },
  { key: "cmdb", api: "registerCmdbItem", system: "CMDB", label: "Registering the configuration item in the CMDB" },
  { key: "handover", api: "finalizeHandover", system: "ITSM", label: "Finalizing and handing over the workspace" },
];

export const INTERNAL_TEMPLATES = [
  {
    id: "internal-linux",
    name: "Internal Linux Server (Standard Build)",
    provider: "internal",
    osName: "RHEL 9 (internal standard)",
    description:
      "Runs the standard internal provisioning workflow end to end — ITSM, IPAM, compute, storage, firewall, DNS and CMDB. Each system is called via its configured endpoint; no Proxmox VM is created.",
    workflow: INTERNAL_WORKFLOW,
  },
];

export function findInternalTemplate(id) {
  return INTERNAL_TEMPLATES.find((t) => t.id === id) || null;
}

export function isInternalTemplateId(id) {
  return typeof id === "string" && id.startsWith("internal-");
}

// Catalog shape consumed by the Provision page (same fields the mapped VM
// templates expose, plus `provider` so the UI can flag / branch on it).
export function internalVmTemplates() {
  return INTERNAL_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    provider: t.provider,
    osName: t.osName,
    type: "vm",
    description: t.description,
    // Surface the step labels so the form can show what the workflow will do.
    workflowSteps: t.workflow.map((s) => s.label),
  }));
}
