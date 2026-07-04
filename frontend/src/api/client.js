import axios from "axios";

const api = axios.create({ baseURL: "/api" });

// Attach JWT from localStorage on every request.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("cpc_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401, clear token and bounce to login.
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("cpc_token");
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

// --- Auth ---
export const login = (username, password) =>
  api.post("/auth/login", { username, password }).then((r) => r.data);
export const getEntraStatus = () => api.get("/auth/entra/status").then((r) => r.data);
export const getEntraLoginUrl = () => api.get("/auth/entra/login-url").then((r) => r.data);
export const entraCallback = (code) => api.post("/auth/entra/callback", { code }).then((r) => r.data);
export const getMe = () => api.get("/auth/me").then((r) => r.data);
export const getMyPreferences = () => api.get("/auth/preferences").then((r) => r.data);
export const updateMyPreferences = (preferences) =>
  api.put("/auth/preferences", { preferences }).then((r) => r.data);

// --- Catalog & provisioning ---
export const getVmTemplates = () => api.get("/catalog/vm-templates").then((r) => r.data);
export const getContainerTemplates = () => api.get("/catalog/container-templates").then((r) => r.data);
export const getStacks = () => api.get("/catalog/stacks").then((r) => r.data);
export const getTemplateDefaults = () => api.get("/catalog/template-defaults").then((r) => r.data);
export const getEnvironments = () => api.get("/catalog/environments").then((r) => r.data);
export const getCostRates = () => api.get("/catalog/cost-rates").then((r) => r.data);
export const provisionVm = (p) => api.post("/provision/vm", p).then((r) => r.data);
export const provisionInternal = (p) => api.post("/provision/internal", p).then((r) => r.data);
export const provisionContainer = (p) => api.post("/provision/container", p).then((r) => r.data);
export const provisionStack = (p) => api.post("/provision/stack", p).then((r) => r.data);
export const getProvisionRequests = () => api.get("/requests").then((r) => r.data);
export const approveProvisionRequest = (id) => api.post(`/requests/${id}/approve`).then((r) => r.data);
export const rejectProvisionRequest = (id, reason) =>
  api.post(`/requests/${id}/reject`, { reason }).then((r) => r.data);

// --- Jobs ---
export const getJob = (id) => api.get(`/jobs/${id}`).then((r) => r.data);
export const getJobs = () => api.get("/jobs").then((r) => r.data);

// --- Container hosting (K3s / Kubernetes) ---
export const getK8sContext = () => api.get("/k3s/context").then((r) => r.data);
export const getK8sNamespaces = () => api.get("/k3s/namespaces").then((r) => r.data);
export const createK8sNamespace = (p) => api.post("/k3s/namespaces", p).then((r) => r.data);
export const deleteK8sNamespace = (name) =>
  api.delete(`/k3s/namespaces/${encodeURIComponent(name)}`).then((r) => r.data);
export const getK8sPods = (ns) =>
  api.get(`/k3s/namespaces/${encodeURIComponent(ns)}/pods`).then((r) => r.data);
export const getK8sDeployments = (ns) =>
  api.get(`/k3s/namespaces/${encodeURIComponent(ns)}/deployments`).then((r) => r.data);
export const createK8sDeployment = (ns, p) =>
  api.post(`/k3s/namespaces/${encodeURIComponent(ns)}/deployments`, p).then((r) => r.data);
export const deleteK8sDeployment = (ns, name) =>
  api.delete(`/k3s/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(name)}`).then((r) => r.data);

// --- Chat ---
export const sendChatMessage = (p) => api.post("/chat", p).then((r) => r.data);
export const getChatHistory = () => api.get("/chat/history").then((r) => r.data);
export const saveChatHistory = (messages) => api.put("/chat/history", { messages }).then((r) => r.data);
export const clearChatHistory = () => api.delete("/chat/history").then((r) => r.data);

// --- Dashboard & resources ---
export const getDashboard = () => api.get("/dashboard").then((r) => r.data);
export const getResources = () => api.get("/resources").then((r) => r.data);
export const resourceAction = (type, vmid, action) =>
  api.post(`/resources/${type}/${vmid}/${action}`).then((r) => r.data);
export const editResource = (type, vmid, specs) =>
  api.put(`/resources/${type}/${vmid}/config`, specs).then((r) => r.data);
export const extendResource = (type, vmid, days) =>
  api.post(`/resources/${type}/${vmid}/extend`, days != null ? { days } : {}).then((r) => r.data);

// --- Admin: mappings (templates + networks) ---
export const getMappings = () => api.get("/mappings").then((r) => r.data);
export const saveTemplateMapping = (vmid, mapping) =>
  api.put(`/mappings/templates/${vmid}`, mapping).then((r) => r.data);
export const deleteTemplateMapping = (vmid) =>
  api.delete(`/mappings/templates/${vmid}`).then((r) => r.data);
export const saveNetworkMapping = (iface, mapping) =>
  api.put(`/mappings/networks/${encodeURIComponent(iface)}`, mapping).then((r) => r.data);
export const deleteNetworkMapping = (iface) =>
  api.delete(`/mappings/networks/${encodeURIComponent(iface)}`).then((r) => r.data);

// --- Admin: system settings (.env config) ---
export const getSettings = () => api.get("/settings").then((r) => r.data);
export const updateSettings = (values) => api.put("/settings", { values }).then((r) => r.data);
export const testProxmoxConnection = () => api.post("/settings/proxmox/test").then((r) => r.data);
export const testK3sConnection = () => api.post("/settings/k3s/test").then((r) => r.data);

// --- Admin: users & audit ---
export const getUsers = () => api.get("/users").then((r) => r.data);
export const createUser = (p) => api.post("/users", p).then((r) => r.data);
export const updateUserRole = (id, role) => api.put(`/users/${id}/role`, { role }).then((r) => r.data);
export const deleteUser = (id) => api.delete(`/users/${id}`).then((r) => r.data);
export const getAudit = (params) => api.get("/audit", { params }).then((r) => r.data);

// --- Admin: groups ---
export const getGroups = () => api.get("/groups").then((r) => r.data);
export const createGroup = (name) => api.post("/groups", { name }).then((r) => r.data);
export const deleteGroup = (name) => api.delete(`/groups/${encodeURIComponent(name)}`).then((r) => r.data);
export const addGroupMember = (name, username) =>
  api.post(`/groups/${encodeURIComponent(name)}/members`, { username }).then((r) => r.data);
export const removeGroupMember = (name, username) =>
  api.delete(`/groups/${encodeURIComponent(name)}/members/${encodeURIComponent(username)}`).then((r) => r.data);

export default api;
