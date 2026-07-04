import { useEffect, useState } from "react";
import {
  getK8sContext, getK8sNamespaces, createK8sNamespace, deleteK8sNamespace,
  getK8sPods, getK8sDeployments, createK8sDeployment, deleteK8sDeployment,
} from "../api/client.js";

function phaseClass(phase) {
  const p = (phase || "").toLowerCase();
  if (p === "running" || p === "active" || p === "succeeded") return "badge-running";
  if (p === "failed" || p === "unknown") return "badge-stopped";
  return "badge-neutral";
}

// ---- Create namespace modal ----
function NewNamespaceModal({ context, onClose, onCreated }) {
  const [form, setForm] = useState({ name: "", team: "", env: "", project: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upd = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await createK8sNamespace(form);
      onCreated();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ch-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>New namespace</h3>
          <button className="ds-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
          <form className="ch-form" onSubmit={submit}>
            <div className="field">
              <label>Namespace name</label>
              <input className="ch-input" required placeholder="my-app" value={form.name} onChange={upd("name")} />
            </div>
            <div className="field">
              <label>Team {context.teams?.length === 0 && <span className="muted">— you're not in any group</span>}</label>
              <select className="ch-input" value={form.team} onChange={upd("team")}>
                <option value="">Just me (private)</option>
                {(context.teams || []).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
                Assigning a team lets everyone in that group see and manage this namespace.
              </p>
            </div>
            <div className="field">
              <label>Environment</label>
              <select className="ch-input" value={form.env} onChange={upd("env")}>
                <option value="">—</option>
                {(context.envs || []).map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Project <span className="muted">(optional)</span></label>
              <input className="ch-input" placeholder="billing-portal" value={form.project} onChange={upd("project")} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? "Creating…" : "Create namespace"}</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ---- Deploy workload modal ----
function DeployModal({ namespace, onClose, onDeployed }) {
  const [form, setForm] = useState({ name: "", image: "", replicas: 1, port: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upd = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await createK8sDeployment(namespace, {
        name: form.name,
        image: form.image,
        replicas: Number(form.replicas) || 1,
        port: form.port ? Number(form.port) : undefined,
      });
      onDeployed();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ch-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Deploy pods to <span className="mono">{namespace}</span></h3>
          <button className="ds-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
          <form className="ch-form" onSubmit={submit}>
            <div className="field">
              <label>Workload name</label>
              <input className="ch-input" required placeholder="web" value={form.name} onChange={upd("name")} />
            </div>
            <div className="field">
              <label>Container image</label>
              <input className="ch-input" required placeholder="nginx:latest" value={form.image} onChange={upd("image")} />
            </div>
            <div className="provision-field-grid">
              <div className="field">
                <label>Replicas</label>
                <input className="ch-input" type="number" min="1" max="20" value={form.replicas} onChange={upd("replicas")} />
              </div>
              <div className="field">
                <label>Container port <span className="muted">(optional)</span></label>
                <input className="ch-input" type="number" min="1" max="65535" placeholder="80" value={form.port} onChange={upd("port")} />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !form.name.trim() || !form.image.trim()}>
                {busy ? "Deploying…" : "Deploy"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ---- Namespace detail (deployments + pods) ----
function NamespaceDetail({ ns, onBack }) {
  const [deployments, setDeployments] = useState([]);
  const [pods, setPods] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showDeploy, setShowDeploy] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([getK8sDeployments(ns.name), getK8sPods(ns.name)])
      .then(([d, p]) => { setDeployments(d); setPods(p); setError(""); })
      .catch((e) => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [ns.name]);

  const removeDeployment = async (name) => {
    if (!confirm(`Delete workload "${name}" and its pods?`)) return;
    try { await deleteK8sDeployment(ns.name, name); load(); }
    catch (e) { alert(e.response?.data?.error || e.message); }
  };

  return (
    <div>
      <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 14 }}>← All namespaces</button>

      <div className="row-between" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>{ns.name}</h2>
          <div className="ch-ns-meta" style={{ marginTop: 6 }}>
            {ns.team && <span className="badge badge-neutral">team: {ns.team}</span>}
            {ns.env && <span className="badge badge-neutral">env: {ns.env}</span>}
            {ns.project && <span className="badge badge-neutral">project: {ns.project}</span>}
            <span className="muted" style={{ fontSize: 12 }}>owner: {ns.owner}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "↻ Refresh"}</button>
          <button className="btn btn-primary" onClick={() => setShowDeploy(true)}>Deploy pods</button>
        </div>
      </div>

      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="section-title" style={{ marginTop: 0 }}>Workloads</div>
      <div className="card" style={{ overflow: "auto", marginBottom: 26 }}>
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Ready</th><th>Replicas</th><th>Image</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {deployments.map((d) => (
              <tr key={d.name}>
                <td style={{ fontWeight: 600 }}>{d.name}</td>
                <td className="mono">{d.ready}/{d.replicas}</td>
                <td className="mono">{d.replicas}</td>
                <td className="mono">{d.images.join(", ") || "—"}</td>
                <td><button className="btn btn-danger btn-sm" onClick={() => removeDeployment(d.name)}>Delete</button></td>
              </tr>
            ))}
            {deployments.length === 0 && <tr><td colSpan={5} className="empty">No workloads yet. Deploy pods to get started.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="section-title">Pods</div>
      <div className="card" style={{ overflow: "auto" }}>
        <table className="table">
          <thead>
            <tr><th>Pod</th><th>Status</th><th>Ready</th><th>Restarts</th><th>Node</th><th>Image</th></tr>
          </thead>
          <tbody>
            {pods.map((p) => (
              <tr key={p.name}>
                <td className="mono">{p.name}</td>
                <td><span className={`badge ${phaseClass(p.phase)}`}>{p.phase}</span></td>
                <td className="mono">{p.ready}</td>
                <td className="mono">{p.restarts}</td>
                <td className="mono">{p.node || "—"}</td>
                <td className="mono">{p.images.join(", ")}</td>
              </tr>
            ))}
            {pods.length === 0 && <tr><td colSpan={6} className="empty">No pods running.</td></tr>}
          </tbody>
        </table>
      </div>

      {showDeploy && (
        <DeployModal namespace={ns.name} onClose={() => setShowDeploy(false)} onDeployed={() => { setShowDeploy(false); load(); }} />
      )}
    </div>
  );
}

export default function ContainerHosting({ embedded = false }) {
  const [context, setContext] = useState({ teams: [], envs: [], isAdmin: false });
  const [namespaces, setNamespaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);

  const loadNamespaces = () => {
    setLoading(true);
    getK8sNamespaces()
      .then((data) => { setNamespaces(data); setError(""); })
      .catch((e) => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    getK8sContext().then(setContext).catch(() => {});
    loadNamespaces();
  }, []);

  const remove = async (name) => {
    if (!confirm(`Delete namespace "${name}"? This removes everything inside it.`)) return;
    try { await deleteK8sNamespace(name); loadNamespaces(); }
    catch (e) { alert(e.response?.data?.error || e.message); }
  };

  return (
    <div className={embedded ? "" : "page"}>
      <div className="page-head row-between">
        <div>
          <div className="eyebrow">Container hosting</div>
          <h1>Kubernetes namespaces</h1>
          <p>Create namespaces and deploy pods on the K3s cluster. You only see namespaces you own or that belong to your team.</p>
        </div>
        {!selected && <button className="btn btn-primary" onClick={() => setShowCreate(true)}>New namespace</button>}
      </div>

      {error && (
        <div className="login-error" style={{ marginBottom: 16 }}>
          {error}
          {/K3s API (URL|token) is not configured/i.test(error) && (
            <span> — an admin can set this under <strong>Admin → Settings → K3s / Kubernetes API</strong>.</span>
          )}
        </div>
      )}

      {selected ? (
        <NamespaceDetail ns={selected} onBack={() => { setSelected(null); loadNamespaces(); }} />
      ) : (
        <div className="card" style={{ overflow: "auto" }}>
          <table className="table">
            <thead>
              <tr><th>Namespace</th><th>Team</th><th>Env</th><th>Project</th><th>Owner</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {namespaces.map((ns) => (
                <tr key={ns.name}>
                  <td style={{ fontWeight: 600 }}>{ns.name}</td>
                  <td>{ns.team || <span className="muted">—</span>}</td>
                  <td>{ns.env || <span className="muted">—</span>}</td>
                  <td>{ns.project || <span className="muted">—</span>}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{ns.owner}</td>
                  <td><span className={`badge ${phaseClass(ns.status)}`}>{ns.status}</span></td>
                  <td>
                    <div className="actions-cell">
                      <button className="btn btn-ghost btn-sm" onClick={() => setSelected(ns)}>Open</button>
                      <button className="btn btn-danger btn-sm" onClick={() => remove(ns.name)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && namespaces.length === 0 && !error && (
                <tr><td colSpan={7} className="empty">No namespaces yet. Create one to start hosting containers.</td></tr>
              )}
              {loading && <tr><td colSpan={7} className="empty">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <NewNamespaceModal
          context={context}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadNamespaces(); }}
        />
      )}
    </div>
  );
}
