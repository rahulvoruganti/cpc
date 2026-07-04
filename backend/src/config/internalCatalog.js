// Config-driven catalog for the internal provisioning workflow.
//
// Selecting this template does NOT clone a Proxmox VM — it runs Colruyt's
// internal provisioning process end to end across three stages (Preparation,
// Provisioning, Post actions), calling each team's API or Ansible playbook in
// turn. Each step's endpoint + token is configured in the admin Settings tab
// ("Internal provisioning systems"); the actual calls live in
// services/internalProvisioningApis.js.
//
// Per step:
//   stage  – which of the 3 stages it belongs to (drives grouping in the UI)
//   via    – the team / API / playbook it calls (shown while it runs)
//   system – the settings key (INTERNAL_<SYSTEM>_URL) it calls; when that
//            endpoint isn't configured the step is simulated.
//   kind   – "api" or "ansible" (informational)
//
// Edit this file to add / reorder steps or add more internal templates.

export const INTERNAL_WORKFLOW = [
  // --- Stage 1: Preparation ---
  { key: "datacenter", stage: "Preparation", label: "Determine datacenter", via: "Linux team API", system: "LINUX", kind: "api" },
  { key: "server-street", stage: "Preparation", label: "Reserve server street", via: "Linux team API", system: "LINUX", kind: "api" },
  { key: "iso-template", stage: "Preparation", label: "Create / identify ISO / template", via: "Linux team API", system: "LINUX", kind: "api" },
  { key: "ip", stage: "Preparation", label: "Reserve IP", via: "Network team API", system: "NETWORK", kind: "api" },

  // --- Stage 2: Provisioning ---
  { key: "vm-create", stage: "Provisioning", label: "VM creation", via: "Compute & Storage team API", system: "COMPUTE", kind: "api" },

  // --- Stage 3: Post actions ---
  { key: "omi", stage: "Post actions", label: "OMI agent", via: "Linux team Ansible playbook", system: "LINUX_ANSIBLE", kind: "ansible" },
  { key: "ppdm", stage: "Post actions", label: "Setting PPDM tag", via: "Linux team Ansible playbook", system: "LINUX_ANSIBLE", kind: "ansible" },
  { key: "cmdb", stage: "Post actions", label: "ServiceNow CMDB update", via: "ServiceNow Ansible playbook", system: "SERVICENOW_ANSIBLE", kind: "ansible" },
  { key: "guardicore", stage: "Post actions", label: "Guardicore agent", via: "Linux team Ansible playbook", system: "LINUX_ANSIBLE", kind: "ansible" },
  { key: "defender", stage: "Post actions", label: "Defender agent", via: "Linux team Ansible playbook", system: "LINUX_ANSIBLE", kind: "ansible" },
  { key: "grant-perms", stage: "Post actions", label: "Grant VM permissions", via: "Compute & Storage team API", system: "COMPUTE", kind: "api" },
];

// The ordered list of stages (for UI grouping / progress display).
export const INTERNAL_STAGES = ["Preparation", "Provisioning", "Post actions"];

export const INTERNAL_TEMPLATES = [
  {
    id: "internal-linux",
    name: "Colruyt Internal (Standard Build)",
    provider: "internal",
    osName: "RHEL 9 (internal standard)",
    description:
      "Runs Colruyt's internal provisioning workflow end to end across three stages — Preparation, Provisioning and Post actions — calling each team's API or Ansible playbook. No Proxmox VM is created.",
    workflow: INTERNAL_WORKFLOW,
    stages: INTERNAL_STAGES,
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
    stages: t.stages,
    // Surface the step labels (grouped by stage) so the form can preview the
    // workflow before it runs.
    workflowSteps: t.workflow.map((s) => `${s.stage}: ${s.label}`),
  }));
}
