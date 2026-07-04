import { useEffect, useMemo, useState } from "react";
import {
  getVmTemplates, getContainerTemplates, getStacks, getEnvironments, getTemplateDefaults,
  getCostRates, provisionVm, provisionInternal, provisionContainer, provisionStack,
  getIacTemplate,
} from "../api/client.js";
import { useDialog } from "../components/DialogProvider.jsx";
import { IconDownload } from "../components/icons.jsx";

const IAC_TOOL_OPTIONS = [
  { id: "terraform", label: "Terraform" },
  { id: "ansible", label: "Ansible" },
  { id: "pulumi", label: "Pulumi (TypeScript)" },
  { id: "curl", label: "REST (cURL)" },
];

// Tool picker + download for a template's Infrastructure-as-Code file. The
// downloaded file targets the CPC API and authenticates with an API token
// (generated from the account menu).
function IacExport({ kind, id }) {
  const { alert } = useDialog();
  const [tool, setTool] = useState("terraform");
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      const file = await getIacTemplate({ kind, id, tool });
      const blob = new Blob([file.content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert({ title: "Download failed", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  // Stop clicks bubbling to the row (which would open the config modal).
  return (
    <div className="iac-export-inline" onClick={(e) => e.stopPropagation()}>
      <span className="iac-export-inline-label">Use with IaC:</span>
      <select className="control-select iac-export-select" value={tool} onChange={(e) => setTool(e.target.value)} aria-label="IaC tool">
        {IAC_TOOL_OPTIONS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <button
        type="button"
        className="icon-btn iac-export-download"
        onClick={download}
        disabled={busy}
        title="Download IaC file"
        aria-label="Download IaC file"
      >
        {busy ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <IconDownload />}
      </button>
    </div>
  );
}

// Sensible fallbacks so the estimate renders even before the rates load.
const DEFAULT_COST_RATES = { perCpu: 21.5, perGbRam: 1, perGbStorage: 0.14, currency: "EUR" };

const CURRENCY_SYMBOLS = { EUR: "€", USD: "$", GBP: "£" };

function formatMoney(amount, currency = "EUR") {
  const symbol = CURRENCY_SYMBOLS[currency] || "";
  const value = Number.isFinite(amount) ? amount : 0;
  return `${symbol}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Cost-estimate thresholds (per month, in the configured currency): the total
// turns amber past the first and red past the second.
const COST_AMBER_AT = 100;
const COST_RED_AT = 200;

// Days-per-unit for the "Required for" lifetime dropdown.
const TTL_UNIT_DAYS = { days: 1, months: 30, years: 365 };

// Red asterisk marking a mandatory field.
function Req() {
  return <span className="req" aria-hidden="true"> *</span>;
}

// A template's default packages. Prefer the list the backend already attached
// to the template (so it always travels with it); otherwise fall back to a
// tolerant lookup in the defaults map (match name/id, case-insensitive, and
// forgiving of extra wording like "MERN Stack").
function defaultPackagesFor(item, defaultsMap) {
  if (Array.isArray(item?.defaultPackages)) return item.defaultPackages;
  if (!item || !defaultsMap) return [];
  const cands = [item.name, item.id].filter(Boolean).map((k) => String(k).toLowerCase());
  const entry = Object.entries(defaultsMap).find(([k]) => {
    const key = k.toLowerCase();
    return cands.some((c) => c === key || c.includes(key) || key.includes(c));
  });
  return Array.isArray(entry?.[1]) ? entry[1] : [];
}

// Normalize a default-package entry to a display name (entries may be objects
// like { letter, name } or plain strings).
function pkgName(p) {
  return typeof p === "string" ? p : (p?.name || p?.letter || "");
}

const KIND_LABELS = {
  vm: "Virtual Machine",
  container: "Container",
  stack: "Stack",
};

// Catalog categories used to group the list. A stack is anything whose kind is
// "stack" OR whose template name contains "stack" (e.g. "LAMP Stack"), so
// stack-like templates are grouped with real stacks.
const CATEGORY_META = {
  stack: { label: "Stacks", icon: "🧩" },
  vm: { label: "Virtual machines", icon: "🖥" },
  container: { label: "Containers", icon: "📦" },
};
const CATEGORY_ORDER = ["stack", "vm"];

function categoryOf(row) {
  if (row.kind === "stack") return "stack";
  if (/\bstack\b/i.test(row.item?.name || "")) return "stack";
  return row.kind; // "vm" | "container"
}

// Selectable software, grouped by category so the picker stays scannable as the
// list grows. The picker scrolls internally, so adding entries here never
// changes the form's height.
const PACKAGE_CATEGORIES = [
  { name: "Languages & runtimes", items: ["dotnet-sdk", "go", "java", "nodejs", "openjdk", "php", "python"] },
  { name: "Build tools", items: ["aqt", "maven", "yarn"] },
  { name: "Containers & orchestration", items: ["docker", "docker-compose", "helm", "kubectl"] },
  { name: "Databases & cache", items: ["mongodb", "mysql", "postgres", "redis"] },
  { name: "Messaging", items: ["rabbitmq"] },
  { name: "Web & proxy", items: ["nginx"] },
  { name: "DevOps & IaC", items: ["ansible", "terraform"] },
  { name: "Monitoring", items: ["grafana", "prometheus"] },
  { name: "CLI & utilities", items: ["awscli", "curl", "git", "htop", "jq", "postman", "tmux", "vim"] },
];

// Flat list of every selectable package (derived from the categories above).
const PACKAGE_OPTIONS = PACKAGE_CATEGORIES.flatMap((c) => c.items);

// Always-visible package selector: a search box over a scrollable, category-
// grouped grid of clickable chips (click to toggle). Selected chips are
// highlighted and also listed in a summary strip so the choice stays visible
// while searching. The catalog area scrolls internally, so adding more packages
// never changes the form's height.
function PackagePicker({ categories, selected, onToggle, onClear, defaultPackages = [] }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  // Filter within each category and drop any that end up empty.
  const groups = categories
    .map((cat) => ({ name: cat.name, items: cat.items.filter((pkg) => pkg.toLowerCase().includes(q)) }))
    .filter((cat) => cat.items.length > 0);

  return (
    <div className="pkg-picker">
      <div className="pkg-picker-head">
        <label>Required packages</label>
        {selected.length > 0 && (
          <button type="button" className="pkg-clear" onClick={onClear}>
            Clear ({selected.length})
          </button>
        )}
      </div>

      {defaultPackages.length > 0 && (
        <div className="pkg-defaults">
          <span className="pkg-defaults-label">Included by default</span>
          <div className="pkg-chips">
            {defaultPackages.map((p, i) => (
              <span key={`${pkgName(p)}-${i}`} className="provision-inline-kind provision-inline-kind-fixed">{pkgName(p)}</span>
            ))}
          </div>
        </div>
      )}

      <input
        className="control-input pkg-search"
        placeholder="Search packages…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="pkg-catalog" role="listbox" aria-label="Package options" aria-multiselectable="true">
        {groups.map((cat) => (
          <div key={cat.name} className="pkg-cat">
            <div className="pkg-cat-label">{cat.name}</div>
            <div className="pkg-cat-grid">
              {cat.items.map((pkg) => {
                const checked = selected.includes(pkg);
                return (
                  <button
                    type="button"
                    key={pkg}
                    className={`pkg-option ${checked ? "on" : ""}`}
                    onClick={() => onToggle(pkg)}
                    role="option"
                    aria-selected={checked}
                  >
                    <span className="pkg-option-mark" aria-hidden="true">{checked ? "✓" : "+"}</span>
                    <span className="pkg-option-name">{pkg}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {groups.length === 0 && <div className="muted pkg-empty">No matching packages</div>}
      </div>

      <div className="pkg-selected">
        <span className="pkg-selected-label">Will be installed</span>
        <div className="pkg-chips">
          {selected.map((pkg) => (
            <button
              type="button"
              key={pkg}
              className="pkg-selected-chip"
              onClick={() => onToggle(pkg)}
              title="Remove"
            >
              {pkg}<span className="pkg-selected-x" aria-hidden="true">×</span>
            </button>
          ))}
          {selected.length === 0 && <span className="muted">No extra packages selected</span>}
        </div>
      </div>
    </div>
  );
}

function ProvisionForm({ selected, environments = [], templateDefaults = {}, costRates = DEFAULT_COST_RATES, onSubmit, busy, onClose }) {
  const item = selected.item;
  const defaultPackages = defaultPackagesFor(item, templateDefaults);
  const isInternal = item.provider === "internal";
  const isStack = selected.kind === "stack";
  const isContainer = selected.kind === "container";
  const isVm = selected.kind === "vm" && !isInternal;
  const [form, setForm] = useState({ hostname: "", cpu: 2, memoryGB: 2, diskGB: 50, ttlUnit: "days", ttlValue: 30, username: "", sudoAccess: false, environment: "" });

  const [requiredPackages, setRequiredPackages] = useState([]);

  useEffect(() => {
    setForm({ hostname: "", cpu: 2, memoryGB: 2, diskGB: 50, ttlUnit: "days", ttlValue: 30, username: "", sudoAccess: false, environment: "" });
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

  const clearRequiredPackages = () => setRequiredPackages([]);

  const effectivePackages = Array.from(new Set(requiredPackages));
  const hasHostname = form.hostname.trim().length > 0;
  const hasCpu = Number.isFinite(form.cpu) && form.cpu >= 1 && form.cpu <= 32;
  const hasMemory = Number.isFinite(form.memoryGB) && form.memoryGB >= 1 && form.memoryGB <= 256;
  const hasDisk = isContainer
    ? true
    : Number.isFinite(form.diskGB) && form.diskGB >= 5 && form.diskGB <= 2000;
  // Lifetime chosen via the unit dropdown (+ amount). "Permanent" means no
  // decommission date at all.
  const permanent = form.ttlUnit === "permanent";
  const ttlDays = permanent
    ? null
    : Math.round(Number(form.ttlValue) * (TTL_UNIT_DAYS[form.ttlUnit] || 1));
  const hasTtl = permanent || (Number.isFinite(ttlDays) && ttlDays >= 1 && ttlDays <= 3650);
  // VMs additionally require an environment and a username.
  const hasVmExtras = !isVm || (form.environment && form.username.trim().length > 0);
  const isFormValid = hasHostname && hasCpu && hasMemory && hasDisk && hasTtl && hasVmExtras;

  // Live monthly cost estimate — recomputed whenever the requested resources or
  // the admin-configured rates change. Containers have no separate disk, so
  // storage is excluded for them.
  const cost = useMemo(() => {
    const cpu = Number.isFinite(form.cpu) ? Math.max(0, form.cpu) : 0;
    const memoryGB = Number.isFinite(form.memoryGB) ? Math.max(0, form.memoryGB) : 0;
    const diskGB = isContainer || !Number.isFinite(form.diskGB) ? 0 : Math.max(0, form.diskGB);
    const cpuCost = cpu * (costRates.perCpu || 0);
    const ramCost = memoryGB * (costRates.perGbRam || 0);
    const storageCost = diskGB * (costRates.perGbStorage || 0);
    return { cpuCost, ramCost, storageCost, total: cpuCost + ramCost + storageCost, hasStorage: !isContainer };
  }, [form.cpu, form.memoryGB, form.diskGB, isContainer, costRates]);
  const currency = costRates.currency || "EUR";

  // Cost banner severity: amber past COST_AMBER_AT, red past COST_RED_AT.
  const costLevel = cost.total >= COST_RED_AT ? "red" : cost.total >= COST_AMBER_AT ? "amber" : "ok";

  // Human preview of when the resource will be decommissioned if not renewed.
  const decommissionText = useMemo(() => {
    if (permanent) return "Runs permanently — no automatic decommission.";
    if (!Number.isFinite(ttlDays) || ttlDays <= 0) return "Enter a positive amount.";
    const when = new Date(Date.now() + ttlDays * 86400_000);
    return `Decommissions on ${when.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} unless renewed.`;
  }, [permanent, ttlDays]);

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

      <div className={`cost-estimate cost-${costLevel}`} role="status" aria-live="polite">
        <div className="cost-estimate-head">
          <span className="cost-estimate-label">Estimated cost</span>
          <span className="cost-estimate-total">
            {formatMoney(cost.total, currency)}<span className="cost-estimate-period"> / month</span>
          </span>
        </div>
        <div className="cost-estimate-breakdown">
          <span>{form.cpu || 0} CPU × {formatMoney(costRates.perCpu, currency)} = {formatMoney(cost.cpuCost, currency)}</span>
          <span>{form.memoryGB || 0} GB RAM × {formatMoney(costRates.perGbRam, currency)} = {formatMoney(cost.ramCost, currency)}</span>
          {cost.hasStorage && (
            <span>{form.diskGB || 0} GB storage × {formatMoney(costRates.perGbStorage, currency)} = {formatMoney(cost.storageCost, currency)}</span>
          )}
        </div>
      </div>

      <form className="provision-form" onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          ...form,
          ttlDays,
          permanent,
          packages: effectivePackages,
          packageSelection: { required: effectivePackages, selected: effectivePackages, effective: effectivePackages },
        });
      }}>
        <div className="provision-form-body">
          <section className="provision-form-col">
            <div className="provision-col-title">Configuration</div>
            <div className="provision-field-grid">
              <div className="field">
                <label>{isStack ? "Hostname prefix" : "Hostname"}<Req /></label>
                <input required placeholder={isStack ? "myapp" : "my-vm-01"} value={form.hostname} onChange={upd("hostname")} />
              </div>
              <div className="field">
                <label>CPU cores<Req /></label>
                <input type="number" min="1" max="32" required value={form.cpu} onChange={upd("cpu")} />
              </div>
              <div className="field">
                <label>Memory (GB)<Req /></label>
                <input type="number" min="1" max="256" required value={form.memoryGB} onChange={upd("memoryGB")} />
              </div>
              {!isContainer && (
                <div className="field">
                  <label>Disk size (GB)<Req /></label>
                  <input type="number" min="5" max="2000" required value={form.diskGB} onChange={upd("diskGB")} />
                </div>
              )}
              <div className="field">
                <label>Required for<Req /></label>
                <div className="ttl-field">
                  <select value={form.ttlUnit} onChange={upd("ttlUnit")}>
                    <option value="permanent">Permanent</option>
                    <option value="days">Days</option>
                    <option value="months">Months</option>
                    <option value="years">Years</option>
                  </select>
                  {!permanent && (
                    <input
                      className="ttl-value"
                      type="number"
                      min="1"
                      required
                      value={form.ttlValue}
                      onChange={upd("ttlValue")}
                      aria-label={`Number of ${form.ttlUnit}`}
                    />
                  )}
                </div>
              </div>
              {isVm && (
                <div className="field provision-field-wide">
                  <label>Environment<Req /></label>
                  <select required value={form.environment} onChange={upd("environment")}>
                    <option value="">Select environment…</option>
                    {environments.map((e) => (
                      <option key={e.iface} value={e.iface}>{e.label}</option>
                    ))}
                  </select>
                </div>
              )}
              {isVm && (
                <>
                  <div className="field">
                    <label>Username<Req /></label>
                    <input required placeholder="e.g. appuser" value={form.username} onChange={upd("username")} autoComplete="off" />
                  </div>
                  <div className="field">
                    <label>Sudo access</label>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={form.sudoAccess}
                      className={`switch provision-sudo-switch ${form.sudoAccess ? "on" : ""}`}
                      onClick={() => setForm((f) => ({ ...f, sudoAccess: !f.sudoAccess }))}
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>
                </>
              )}
            </div>

            <ul className="provision-form-notes">
              <li>🗓 {decommissionText}</li>
              {isVm && (
                <li>🔐 A strong password is generated automatically for this user and shown in the deployment summary.</li>
              )}
              {isVm && environments.length === 0 && (
                <li>⚠ No environments mapped yet — an admin must label a network in Mappings.</li>
              )}
            </ul>
          </section>

          <section className="provision-form-col provision-form-col-side">
            {isInternal ? (
              <>
                <div className="provision-col-title">Internal workflow</div>
                <p className="muted" style={{ marginTop: 0 }}>
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
            ) : (
              <>
                <div className="provision-col-title">Software</div>
                <PackagePicker
                  categories={PACKAGE_CATEGORIES}
                  selected={requiredPackages}
                  onToggle={toggleRequiredPackage}
                  onClear={clearRequiredPackages}
                  defaultPackages={defaultPackages}
                />
              </>
            )}
          </section>
        </div>

        <div className="provision-modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !isFormValid}>{busy ? "Submitting..." : "Provision"}</button>
        </div>
      </form>
    </div>
  );
}

export default function Provision({ embedded = false }) {
  const { alert } = useDialog();
  const [vmTemplates, setVmTemplates] = useState([]);
  const [containerTemplates, setContainerTemplates] = useState([]);
  const [stacks, setStacks] = useState([]);
  const [environments, setEnvironments] = useState([]);
  const [templateDefaults, setTemplateDefaults] = useState({});
  const [costRates, setCostRates] = useState(DEFAULT_COST_RATES);
  const [kindFilter, setKindFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [requestNotice, setRequestNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getVmTemplates().then(setVmTemplates).catch(() => {});
    getContainerTemplates().then(setContainerTemplates).catch(() => {});
    getStacks().then(setStacks).catch(() => {});
    getEnvironments().then(setEnvironments).catch(() => {});
    getTemplateDefaults().then(setTemplateDefaults).catch(() => {});
    getCostRates().then(setCostRates).catch(() => {});
  }, []);

  // This page covers VMs & stacks only — containers have their own hosting page.
  const rows = useMemo(() => {
    const vmRows = vmTemplates.map((item) => ({ kind: "vm", item }));
    const stackRows = stacks.map((item) => ({ kind: "stack", item }));
    return [...vmRows, ...stackRows];
  }, [vmTemplates, stacks]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((row) => kindFilter === "all" || categoryOf(row) === kindFilter)
      .filter((row) => {
        if (!q) return true;
        return (row.item.name || "").toLowerCase().includes(q)
          || (row.item.id || "").toLowerCase().includes(q)
          || (row.item.description || "").toLowerCase().includes(q);
      })
      .sort((a, b) => (a.item.name || "").localeCompare(b.item.name || ""));
  }, [rows, kindFilter, query]);

  // Count catalog entries per category (for the filter chips).
  const categoryCounts = useMemo(() => {
    const counts = { stack: 0, vm: 0, container: 0 };
    rows.forEach((row) => { counts[categoryOf(row)] += 1; });
    return counts;
  }, [rows]);

  // Group the filtered rows into category sections, in a stable order.
  const groupedRows = useMemo(() => {
    const groups = new Map();
    for (const row of filteredRows) {
      const cat = categoryOf(row);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(row);
    }
    return CATEGORY_ORDER
      .filter((cat) => groups.has(cat))
      .map((cat) => ({ category: cat, rows: groups.get(cat) }));
  }, [filteredRows]);

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
          ttlDays: form.ttlDays,
          permanent: form.permanent,
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
          ttlDays: form.ttlDays,
          permanent: form.permanent,
        });
      }

      setSelected(null);

      // A deployment was created — pop open the floating deployment monitor
      // (maximized) so the user watches live progress without leaving the page.
      // Requests that still need approval have no job yet, so fall back to a
      // notice.
      if (result?.job?.id) {
        setRequestNotice("Provisioning started — follow the live progress in the deployment monitor.");
        window.dispatchEvent(new CustomEvent("cpc:open-deployment-monitor", { detail: { jobId: result.job.id } }));
      } else if (result?.request?.id) {
        // High-config request paused for approval — pop the monitor so the user
        // sees it on hold until an admin approves it.
        setRequestNotice(`Request ${result.request.id} exceeds the size policy — it's on hold in the deployment monitor awaiting admin approval.`);
        window.dispatchEvent(new CustomEvent("cpc:open-deployment-monitor", { detail: { requestId: result.request.id } }));
      }
    } catch (e) {
      alert({ title: "Provisioning failed", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={embedded ? "" : "page"}>
      <div className="page-head">
        <div className="eyebrow">Catalog</div>
        <h1>Virtual machines &amp; stacks</h1>
        <p>Pick a template to configure and launch — or download an IaC file to provision it from your own tool.</p>
      </div>

      <div className="tpl-toolbar toolbar-panel">
        <input
          className="control-input tpl-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, id, or description…"
          aria-label="Search catalog"
        />
        <div className="tpl-filters" role="group" aria-label="Filter by category">
          <button
            type="button"
            className={`tpl-filter ${kindFilter === "all" ? "active" : ""}`}
            aria-pressed={kindFilter === "all"}
            onClick={() => setKindFilter("all")}
          >All <span className="tpl-filter-n">{rows.length}</span></button>
          {CATEGORY_ORDER.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`tpl-filter ${kindFilter === cat ? "active" : ""}`}
              aria-pressed={kindFilter === cat}
              onClick={() => setKindFilter((cur) => (cur === cat ? "all" : cat))}
            ><span aria-hidden="true">{CATEGORY_META[cat].icon}</span> {CATEGORY_META[cat].label} <span className="tpl-filter-n">{categoryCounts[cat]}</span></button>
          ))}
        </div>
      </div>

      {groupedRows.length === 0 ? (
        <div className="empty">No catalog entries match your filters.</div>
      ) : (
        groupedRows.map(({ category, rows: catRows }) => (
          <section key={category} className="tpl-section">
            <div className="tpl-section-head">
              <span className="tpl-section-icon" aria-hidden="true">{CATEGORY_META[category].icon}</span>
              <h2 className="tpl-section-title">{CATEGORY_META[category].label}</h2>
              <span className="tpl-section-count">{catRows.length}</span>
            </div>

            <div className="tpl-grid">
              {catRows.map((row) => {
                const isSelected = selected && selected.kind === row.kind && selected.item.id === row.item.id;
                const defs = defaultPackagesFor(row.item, templateDefaults);
                return (
                  <div
                    key={`${row.kind}:${row.item.id}`}
                    className={`tpl-card ${isSelected ? "tpl-card-active" : ""}`}
                    onClick={() => setSelected(row)}
                    role="button"
                    tabIndex={0}
                    aria-label={`Configure ${row.item.name}`}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(row); } }}
                  >
                    <div className="tpl-card-head">
                      <span className="tpl-card-icon" aria-hidden="true">{CATEGORY_META[category].icon}</span>
                      <div className="tpl-card-titles">
                        <div className="tpl-card-name">{row.item.name}</div>
                        <div className="tpl-card-tags">
                          <span className="badge provision-kind-badge">{KIND_LABELS[row.kind]}</span>
                          {row.item.provider === "internal" && <span className="provision-inline-kind">Internal workflow</span>}
                        </div>
                      </div>
                    </div>

                    {!!row.item.description && <p className="tpl-card-desc">{row.item.description}</p>}

                    {defs.length > 0 && (
                      <div className="tpl-card-defaults">
                        <span className="provision-row-defaults-label">Includes by default</span>
                        <div className="tpl-card-chips">
                          {defs.map((p, i) => (
                            <span key={`${pkgName(p)}-${i}`} className="provision-inline-kind provision-inline-kind-fixed">{pkgName(p)}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="tpl-card-foot" onClick={(e) => e.stopPropagation()}>
                      <IacExport kind={row.kind} id={row.item.id} />
                      <button type="button" className="btn btn-primary btn-sm tpl-card-cta" onClick={() => setSelected(row)}>
                        Provision
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}

      {selected && (
        <div className="provision-modal-backdrop">
          <div className="provision-modal-shell">
            <ProvisionForm selected={selected} environments={environments} templateDefaults={templateDefaults} costRates={costRates} busy={busy} onSubmit={submit} onClose={() => setSelected(null)} />
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
