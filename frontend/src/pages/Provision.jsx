import { useEffect, useMemo, useRef, useState } from "react";
import {
  getVmTemplates, getContainerTemplates, getStacks, getEnvironments,
  provisionVm, provisionInternal, provisionContainer, provisionStack,
} from "../api/client.js";

const KIND_LABELS = {
  vm: "Virtual Machine",
  container: "Container",
  stack: "Stack",
};

const PACKAGE_OPTIONS = [
  "ansible",
  "aqt",
  "awscli",
  "curl",
  "docker",
  "docker-compose",
  "dotnet-sdk",
  "git",
  "go",
  "grafana",
  "helm",
  "htop",
  "java",
  "jq",
  "kubectl",
  "maven",
  "mongodb",
  "mysql",
  "nginx",
  "nodejs",
  "openjdk",
  "php",
  "postman",
  "postgres",
  "prometheus",
  "python",
  "rabbitmq",
  "redis",
  "terraform",
  "tmux",
  "vim",
  "yarn",
];

function SearchablePackageDropdown({
  label,
  options,
  selected,
  onToggle,
  helperText,
  defaultOpen = false,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);

  useEffect(() => {
    const onDocClick = (e) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const filtered = options.filter((pkg) => pkg.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="field provision-packages-field" ref={rootRef}>
      <label>{label}</label>
      <button
        type="button"
        className="provision-select-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{selected.length ? `${selected.length} selected` : "Select packages"}</span>
        <span className="muted">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="provision-select-menu">
          <input
            className="control-input provision-select-search"
            placeholder="Search packages..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="provision-select-list" role="listbox" aria-label={`${label} package options`}>
            {filtered.map((pkg) => {
              const checked = selected.includes(pkg);
              return (
                <label key={pkg} className="provision-select-item">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(pkg)}
                  />
                  <span>{pkg}</span>
                </label>
              );
            })}
            {filtered.length === 0 && <div className="muted">No matching packages</div>}
          </div>
        </div>
      )}

      {helperText && <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>{helperText}</p>}
    </div>
  );
}

function ProvisionForm({ selected, environments = [], onSubmit, busy, onClose }) {
  const item = selected.item;
  const isInternal = item.provider === "internal";
  const isStack = selected.kind === "stack";
  const isContainer = selected.kind === "container";
  const isVm = selected.kind === "vm" && !isInternal;
  const [form, setForm] = useState({ hostname: "", cpu: 2, memoryGB: 2, diskGB: 50, username: "", sudoAccess: false, environment: "" });

  const [requiredPackages, setRequiredPackages] = useState([]);
  const [showWorkflow, setShowWorkflow] = useState(false);

  useEffect(() => {
    setForm({ hostname: "", cpu: 2, memoryGB: 2, diskGB: 50, username: "", sudoAccess: false, environment: "" });
    setRequiredPackages([]);
  }, [selected.kind, item.id]);

  const upd = (k) => (e) => {
    const v = e.target.type === "number" ? Number(e.target.value)
      : e.target.type === "checkbox" ? e.target.checked
      : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  const toggleRequiredPackage = (pkg) => {
    setRequiredPackages((prev) => (prev.includes(pkg)
      ? prev.filter((p) => p !== pkg)
      : [...prev, pkg]));
  };

  const effectivePackages = Array.from(new Set(requiredPackages));
  const hasHostname = form.hostname.trim().length > 0;
  const hasCpu = Number.isFinite(form.cpu) && form.cpu >= 1 && form.cpu <= 32;
  const hasMemory = Number.isFinite(form.memoryGB) && form.memoryGB >= 1 && form.memoryGB <= 256;
  const hasDisk = isContainer
    ? true
    : Number.isFinite(form.diskGB) && form.diskGB >= 5 && form.diskGB <= 2000;
  // VMs additionally require an environment (network) and a username.
  const hasVmExtras = !isVm || (form.environment && form.username.trim().length > 0);
  const isFormValid = hasHostname && hasCpu && hasMemory && hasDisk && hasVmExtras;

  return (
    <div className="card card-pad provision-config-panel provision-modal-card">
      <div className="provision-modal-head">
        <div className="provision-config-head">
          <div className="badge provision-kind-badge">{KIND_LABELS[selected.kind]}</div>
          <h3>{item.name}</h3>
          <p className="muted">{item.id}{item.vmid ? ` • VMID ${item.vmid}` : ""}</p>
        </div>
        <button className="close-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {item.description && <p className="muted provision-config-desc">{item.description}</p>}

      {isInternal && (
        <div className="card card-pad" style={{ background: "var(--surface-2, rgba(0,0,0,0.03))", marginBottom: 16 }}>
          <button
            type="button"
            className="wf-toggle"
            onClick={() => setShowWorkflow((v) => !v)}
            aria-expanded={showWorkflow}
          >
            <span className="badge provision-kind-badge">workflow</span>
            <span className="muted">{showWorkflow ? "Hide details" : "Show details"}</span>
            <span className="wf-caret" aria-hidden="true">{showWorkflow ? "▾" : "▸"}</span>
          </button>

          {showWorkflow && (
            <>
              <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
                This does not create a Proxmox VM. It runs our standard internal provisioning process and
                calls each internal system in turn — watch it stream live in the deployment monitor:
              </p>
              <ol className="wf-track">
                {(item.workflowSteps || []).map((label, i) => (
                  <li key={i} className="wf-track-step wf-track-pending">
                    <span className="wf-track-dot">{i + 1}</span>
                    <span className="wf-track-body">
                      <span className="wf-track-label">{label}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}

      <form onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          ...form,
          packages: effectivePackages,
          packageSelection: { required: effectivePackages, selected: effectivePackages, effective: effectivePackages },
        });
      }}>
        <div className="provision-field-grid">
          <div className="field">
            <label>{isStack ? "Hostname prefix" : "Hostname"}</label>
            <input required placeholder={isStack ? "myapp" : "my-vm-01"} value={form.hostname} onChange={upd("hostname")} />
          </div>
          <div className="field">
            <label>CPU cores</label>
            <input type="number" min="1" max="32" required value={form.cpu} onChange={upd("cpu")} />
          </div>
          <div className="field">
            <label>Memory (GB)</label>
            <input type="number" min="1" max="256" required value={form.memoryGB} onChange={upd("memoryGB")} />
          </div>
          {!isContainer && (
            <div className="field">
              <label>Disk size (GB)</label>
              <input type="number" min="5" max="2000" required value={form.diskGB} onChange={upd("diskGB")} />
            </div>
          )}
        </div>

        {isVm && (
          <>
            <div className="provision-field-grid">
              <div className="field">
                <label>Environment</label>
                <select required value={form.environment} onChange={upd("environment")}>
                  <option value="">Select network…</option>
                  {environments.map((e) => (
                    <option key={e.iface} value={e.iface}>{e.label} ({e.type} · {e.iface})</option>
                  ))}
                </select>
                {environments.length === 0 && (
                  <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>No environments mapped yet — an admin must label a network in Mappings.</p>
                )}
              </div>
              <div className="field">
                <label>Username</label>
                <input required placeholder="e.g. appuser" value={form.username} onChange={upd("username")} autoComplete="off" />
              </div>
            </div>

            <label className="pref-toggle-row" style={{ marginBottom: 14 }}>
              <span>Grant sudo access to this user</span>
              <input type="checkbox" checked={form.sudoAccess} onChange={upd("sudoAccess")} />
            </label>

            <p className="muted" style={{ marginTop: 0, marginBottom: 14 }}>
              🔐 A strong password is generated automatically for this user and shown in the deployment summary.
            </p>
          </>
        )}

          {!isInternal && (
            <>
              <SearchablePackageDropdown
                label="Required packages"
                options={PACKAGE_OPTIONS}
                selected={requiredPackages}
                onToggle={toggleRequiredPackage}
                helperText="Search and select the packages to install and enable on the VM."
                defaultOpen
              />

              <div className="field provision-packages-field">
                <label>Will be installed</label>
                <div className="provision-packages-list">
                  {effectivePackages.map((pkg) => (
                    <span key={pkg} className="provision-inline-kind provision-inline-kind-final">{pkg}</span>
                  ))}
                  {effectivePackages.length === 0 && <span className="muted">No packages selected</span>}
                </div>
              </div>
            </>
          )}

        <div className="provision-modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !isFormValid}>{busy ? "Submitting..." : "Provision"}</button>
        </div>
      </form>
    </div>
  );
}

export default function Provision() {
  const [vmTemplates, setVmTemplates] = useState([]);
  const [containerTemplates, setContainerTemplates] = useState([]);
  const [stacks, setStacks] = useState([]);
  const [environments, setEnvironments] = useState([]);
  const [kindFilter, setKindFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [requestNotice, setRequestNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getVmTemplates().then(setVmTemplates).catch(() => {});
    getContainerTemplates().then(setContainerTemplates).catch(() => {});
    getStacks().then(setStacks).catch(() => {});
    getEnvironments().then(setEnvironments).catch(() => {});
  }, []);

  const rows = useMemo(() => {
    const vmRows = vmTemplates.map((item) => ({ kind: "vm", item }));
    const containerRows = containerTemplates.map((item) => ({ kind: "container", item }));
    const stackRows = stacks.map((item) => ({ kind: "stack", item }));
    return [...vmRows, ...containerRows, ...stackRows];
  }, [vmTemplates, containerTemplates, stacks]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((row) => kindFilter === "all" || row.kind === kindFilter)
      .filter((row) => {
        if (!q) return true;
        return (row.item.name || "").toLowerCase().includes(q)
          || (row.item.id || "").toLowerCase().includes(q)
          || (row.item.description || "").toLowerCase().includes(q);
      })
      .sort((a, b) => (a.item.name || "").localeCompare(b.item.name || ""));
  }, [rows, kindFilter, query]);

  const kindsByName = useMemo(() => {
    const map = new Map();
    rows.forEach((row) => {
      const name = (row.item.name || "").trim().toLowerCase();
      if (!name) return;
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(row.kind);
    });
    return map;
  }, [rows]);

  useEffect(() => {
    setPage(1);
  }, [kindFilter, query, pageSize]);

  useEffect(() => {
    if (!selected) return;
    const stillExists = rows.some((row) => row.kind === selected.kind && row.item.id === selected.item.id);
    if (!stillExists) setSelected(null);
  }, [rows, selected]);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    if (selected) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = prevOverflow || "";
    }
    return () => {
      document.body.style.overflow = prevOverflow || "";
    };
  }, [selected]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageRows = filteredRows.slice(pageStart, pageStart + pageSize);

  const submit = async (form) => {
    if (!selected) return;
    setBusy(true);
    try {
      let result;
      if (selected.item.provider === "internal") {
        result = await provisionInternal({
          templateId: selected.item.id,
          hostname: form.hostname,
          cpu: form.cpu,
          memoryGB: form.memoryGB,
          diskGB: form.diskGB,
        });
      } else if (selected.kind === "vm") {
        result = await provisionVm({ templateId: selected.item.id, ...form });
      } else if (selected.kind === "container") {
        result = await provisionContainer({ templateId: selected.item.id, ...form });
      } else {
        result = await provisionStack({
          stackId: selected.item.id,
          hostnamePrefix: form.hostname,
          cpu: form.cpu,
          memoryGB: form.memoryGB,
          diskGB: form.diskGB,
        });
      }

      if (result?.job?.id) {
        setRequestNotice("Provisioning started — follow the live progress in the deployment monitor (bottom-right).");
      } else if (result?.request?.id) {
        setRequestNotice(`Request ${result.request.id} submitted with status ${result.request.status}.`);
      }

      setSelected(null);
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="eyebrow">Catalog</div>
        <h1>Provision workspace</h1>
        <p>Search and select from catalog entries, then configure and launch from the side panel.</p>
      </div>

      <div className="summary-strip" style={{ marginBottom: 16 }}>
        <div className="summary-chip"><span className="icon">🖥</span> {vmTemplates.length} VM templates</div>
        <div className="summary-chip"><span className="icon">📦</span> {containerTemplates.length} container templates</div>
        <div className="summary-chip"><span className="icon">🧩</span> {stacks.length} stacks</div>
      </div>

      <div className="provision-workbench">
        <div className="card card-pad provision-catalog-panel">
          <div className="toolbar toolbar-panel" style={{ marginBottom: 12 }}>
            <input
              className="control-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, id, or description..."
            />
            <select className="control-select" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
              <option value="all">All kinds</option>
              <option value="vm">Virtual machines</option>
              <option value="container">Containers</option>
              <option value="stack">Stacks</option>
            </select>
            <select className="control-select" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
              <option value={20}>20 per page</option>
              <option value={50}>50 per page</option>
              <option value={100}>100 per page</option>
            </select>
            <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>{filteredRows.length} results</span>
          </div>

          <div className="provision-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>ID</th>
                  <th>Meta</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const isSelected = selected && selected.kind === row.kind && selected.item.id === row.item.id;
                  const nameKey = (row.item.name || "").trim().toLowerCase();
                  const kinds = nameKey ? Array.from(kindsByName.get(nameKey) || []) : [row.kind];
                  return (
                    <tr
                      key={`${row.kind}:${row.item.id}`}
                      className={isSelected ? "provision-row-selected" : ""}
                      onClick={() => setSelected(row)}
                    >
                      <td>
                        <div className="provision-row-title">
                          {row.item.name}
                          {row.item.provider === "internal" && (
                            <span className="provision-inline-kind" style={{ marginLeft: 8 }}>Internal workflow</span>
                          )}
                        </div>
                        {kinds.length > 1 && (
                          <div className="provision-name-kinds">
                            {kinds.map((k) => (
                              <span key={k} className="provision-inline-kind">{KIND_LABELS[k]}</span>
                            ))}
                          </div>
                        )}
                        {!!row.item.description && <div className="muted provision-row-sub">{row.item.description}</div>}
                      </td>
                      <td><span className="badge provision-kind-badge">{KIND_LABELS[row.kind]}</span></td>
                      <td className="mono">{row.item.id}</td>
                      <td className="mono">{row.item.vmid ? `VMID ${row.item.vmid}` : "-"}</td>
                    </tr>
                  );
                })}

                {pageRows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted" style={{ textAlign: "center", padding: 22 }}>
                      No catalog entries match your filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="pagination-row">
            <button className="btn btn-ghost btn-sm" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
            <span className="muted">Page {safePage} / {totalPages}</span>
            <button className="btn btn-ghost btn-sm" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</button>
          </div>
        </div>
      </div>

      {selected && (
        <div className="provision-modal-backdrop" onClick={() => setSelected(null)}>
          <div className="provision-modal-shell" onClick={(e) => e.stopPropagation()}>
            <ProvisionForm selected={selected} environments={environments} busy={busy} onSubmit={submit} onClose={() => setSelected(null)} />
          </div>
        </div>
      )}

      {requestNotice && (
        <div className="card card-pad" style={{ marginTop: 18 }}>
          <div className="section-title" style={{ marginTop: 0 }}>Provisioning started</div>
          <p className="muted" style={{ margin: 0 }}>{requestNotice}</p>
        </div>
      )}
    </div>
  );
}
