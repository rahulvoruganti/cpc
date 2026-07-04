// Catalog of provisionable items. Edit this file to add templates as you create them in Proxmox.

export const VM_TEMPLATES = [
  {
    id: "alpine",
    name: "Alpine Linux",
    vmid: 100,
    type: "vm",
    defaultUser: "root",
    osFamily: "linux",
  },
  {
    id: "rhel",
    name: "RHEL",
    vmid: 200,
    type: "vm",
    defaultUser: "cloud-user",
    osFamily: "linux",
  },
];

export const CONTAINER_TEMPLATES = [
  // Add LXC template VMIDs here once created, e.g.:
  // { id: "ubuntu-lxc", name: "Ubuntu 22.04 LXC", vmid: 300, type: "container" },
];

// A "stack" provisions multiple VMs/containers together (e.g. a 3-tier app).
// No stacks are hardcoded — the Provision catalog is driven by Proxmox/Mappings.
export const STACKS = [];

// The full set of packages the provisioning assistant may pre-select. Must stay
// in sync with PACKAGE_OPTIONS in frontend/src/components/ChatWidget.jsx so every
// selected package has a checkbox to render.
export const PACKAGE_CATALOG = [
  "ansible", "aqt", "awscli", "curl", "docker", "docker-compose", "dotnet-sdk",
  "git", "go", "grafana", "helm", "htop", "java", "jq", "kubectl", "maven",
  "mongodb", "mysql", "nginx", "nodejs", "openjdk", "php", "postgres", "postman",
  "prometheus", "python", "rabbitmq", "redis", "terraform", "tmux", "vim", "yarn",
];

export function findVmTemplate(id) {
  return VM_TEMPLATES.find((t) => t.id === id);
}

export function findContainerTemplate(id) {
  return CONTAINER_TEMPLATES.find((t) => t.id === id);
}

export function findStack(id) {
  return STACKS.find((s) => s.id === id);
}
