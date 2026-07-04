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

export const INTERNAL_WORKFLOW = [
  { key: "itsm", api: "openServiceRequest", label: "Registering the service request in ITSM" },
  { key: "ipam", api: "allocateIpAddress", label: "Requesting an IP address from IPAM" },
  { key: "compute", api: "reserveCompute", label: "Reserving compute capacity in the datacenter" },
  { key: "storage", api: "reserveStorage", label: "Reserving a storage volume on the SAN" },
  { key: "firewall", api: "requestFirewallAccess", label: "Requesting firewall access rules" },
  { key: "dns", api: "createDnsRecord", label: "Creating the DNS record" },
  { key: "cmdb", api: "registerCmdbItem", label: "Registering the configuration item in the CMDB" },
  { key: "handover", api: "finalizeHandover", label: "Finalizing and handing over the workspace" },
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
