import { useEffect, useState } from "react";
import { getResources, resourceAction } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import TerminalModal from "../components/TerminalModal.jsx";
import EditResourceModal from "../components/EditResourceModal.jsx";
import ExtendExpiryModal from "../components/ExtendExpiryModal.jsx";
import PowerMenu from "../components/PowerMenu.jsx";
import RowMenu from "../components/RowMenu.jsx";
import TagsMenu from "../components/TagsMenu.jsx";
import SnapshotModal from "../components/SnapshotModal.jsx";
import BackupModal from "../components/BackupModal.jsx";
import {
  IconPlay,
  IconPower,
  IconReboot,
  IconTerminal,
  IconEdit,
  IconCalendarPlus,
  IconTrash,
  IconServer,
  IconBox,
  IconActions,
  IconCamera,
  IconArchive,
} from "../components/icons.jsx";

function fmtMem(b) {
  if (!b) return "—";
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}

function fmtDisk(r) {
  if (r.maxdiskGB) return `${r.maxdiskGB} GB`;
  if (r.maxdisk) return `${(r.maxdisk / 1024 ** 3).toFixed(1)} GB`;
  return "—";
}

// Render an expiry cell: a badge coloured by how close (or past) the date is.
function ExpiryCell({ r }) {
  if (!r.expiresAt) return <span className="muted">—</span>;
  const when = new Date(r.expiresAt).toLocaleDateString();
  if (r.expired) return <span className="badge badge-danger" title={when}>Expired</span>;
  const soon = r.daysLeft != null && r.daysLeft <= 7;
  return (
    <span className={`badge ${soon ? "badge-warn" : "badge-neutral"}`} title={when}>
      {r.daysLeft}d left
    </span>
  );
}

export default function Resources() {
  const { isAdmin } = useAuth();
  const [resources, setResources] = useState([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState({});       // vmid -> action label
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [connectTarget, setConnectTarget] = useState(null);  // { vmid, ip, hostname }
  const [editTarget, setEditTarget] = useState(null);        // resource being edited
  const [extendTarget, setExtendTarget] = useState(null);    // resource whose expiry is being extended
  const [snapshotTarget, setSnapshotTarget] = useState(null); // resource whose snapshots are managed
  const [backupTarget, setBackupTarget] = useState(null);    // resource whose backup is configured

  const load = () => getResources().then(setResources).catch((e) => setError(e.response?.data?.error || e.message));

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setPage(1);
  }, [query, statusFilter, typeFilter, pageSize]);

  const act = async (r, action) => {
    if (action === "delete" && !confirm(`Delete ${r.name} (VMID ${r.vmid})? This cannot be undone.`)) return;
    if (action === "reset" && !confirm(`Hard reset ${r.name} (VMID ${r.vmid})? This forcibly resets the machine without a clean shutdown and may cause data loss.`)) return;
    setPending((p) => ({ ...p, [r.vmid]: action }));
    setError("");
    try {
      await resourceAction(r.type, r.vmid, action);
      setTimeout(load, 1200);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setPending((p) => { const n = { ...p }; delete n[r.vmid]; return n; });
    }
  };

  const q = query.trim().toLowerCase();
  const matchesQuery = (r) => !q
    || (r.name || "").toLowerCase().includes(q)
    || String(r.vmid || "").includes(q)
    || (r.owner || "").toLowerCase().includes(q);

  // Search-only set: the summary chips count against this so they stay stable
  // while acting as status/type toggles (and reflect the active search).
  const byQuery = resources.filter(matchesQuery);

  const filtered = byQuery
    .filter((r) => {
      const matchStatus = statusFilter === "all" || r.status === statusFilter;
      const matchType = typeFilter === "all" || r.type === typeFilter;
      return matchStatus && matchType;
    })
    // Always order by VMID so rows keep a stable position across the 8s poll
    // (Proxmox doesn't guarantee a consistent order) and don't visibly shuffle.
    .sort((a, b) => Number(a.vmid) - Number(b.vmid));

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);
  const runningCount = byQuery.filter((r) => r.status === "running").length;
  const stoppedCount = byQuery.filter((r) => r.status !== "running").length;
  const vmCount = byQuery.filter((r) => r.type === "vm").length;
  const ctCount = byQuery.filter((r) => r.type === "container").length;

  // Clicking a summary chip sets the matching filter (and clicking the active
  // one again clears it). "Total" resets both status and type filters.
  const isDefaultView = statusFilter === "all" && typeFilter === "all";
  const showAll = () => { setStatusFilter("all"); setTypeFilter("all"); };
  const toggleStatus = (s) => setStatusFilter((cur) => (cur === s ? "all" : s));
  const toggleType = (t) => setTypeFilter((cur) => (cur === t ? "all" : t));

  return (
    <div className="page">
      <div className="page-head">
        <div className="eyebrow">Inventory</div>
        <h1>Resources</h1>
        <p>{isAdmin
          ? "All virtual machines and containers on the node. Control power state or delete."
          : "Virtual machines and containers you've created. Control their power state."}</p>
      </div>

      {error && <div className="login-error">{error}</div>}

      <div className="toolbar toolbar-panel">
        <input
          className="control-input"
          placeholder="Search name, VMID, owner..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="control-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All status</option>
          <option value="running">Running</option>
          <option value="stopped">Stopped</option>
        </select>
        <select className="control-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">All types</option>
          <option value="vm">VM</option>
          <option value="container">Container</option>
        </select>
        <select className="control-select" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
          <option value={10}>10 per page</option>
          <option value={20}>20 per page</option>
          <option value={50}>50 per page</option>
        </select>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>{filtered.length} items</span>
      </div>

      <div className="summary-strip" style={{ marginBottom: 14 }}>
        <button
          type="button"
          className={`summary-chip ${isDefaultView ? "summary-chip-active" : ""}`}
          onClick={showAll}
          title="Show all resources"
        ><span className="icon">⚙</span> {byQuery.length} total</button>
        <button
          type="button"
          className={`summary-chip ${statusFilter === "running" ? "summary-chip-active" : ""}`}
          onClick={() => toggleStatus("running")}
          title="Filter by running"
        ><span className="icon">●</span> {runningCount} running</button>
        <button
          type="button"
          className={`summary-chip ${statusFilter === "stopped" ? "summary-chip-active" : ""}`}
          onClick={() => toggleStatus("stopped")}
          title="Filter by stopped"
        ><span className="icon">○</span> {stoppedCount} stopped</button>
        <button
          type="button"
          className={`summary-chip ${typeFilter === "vm" ? "summary-chip-active" : ""}`}
          onClick={() => toggleType("vm")}
          title="Filter by VMs"
        ><span className="icon">🖥</span> {vmCount} VMs</button>
        <button
          type="button"
          className={`summary-chip ${typeFilter === "container" ? "summary-chip-active" : ""}`}
          onClick={() => toggleType("container")}
          title="Filter by containers"
        ><span className="icon">📦</span> {ctCount} containers</button>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        {filtered.length === 0 ? (
          <div className="empty">{isAdmin
            ? "No resources match your filters right now."
            : "No matching resources yet. Try clearing filters or provision a new resource."}</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>VMID</th><th>Name</th><th>Status</th><th>CPU</th>
                <th>RAM</th><th>Storage</th><th>IP</th><th>OS</th>
                {isAdmin && <th>Owner</th>}
                <th>Expiry</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((r) => {
                const running = r.status === "running";
                const busy = pending[r.vmid];

                // Power menu is contextual: when running, only Power off +
                // Reboot; when stopped, only Power on (admin-only).
                const powerItems = [];
                if (running) {
                  powerItems.push({ key: "shutdown", label: "Power off", icon: <IconPower size={15} style={{ color: "var(--warn)" }} />, onClick: () => act(r, "shutdown") });
                  powerItems.push({ key: "reboot", label: "Reboot", icon: <IconReboot size={15} className="icon-spin-hover" style={{ color: "var(--accent)" }} />, onClick: () => act(r, "reboot") });
                } else if (isAdmin) {
                  powerItems.push({ key: "start", label: "Power on", icon: <IconPlay size={15} style={{ color: "var(--ok)" }} />, onClick: () => act(r, "start") });
                }

                // Actions menu: Console (running), Edit, Renew, Snapshot,
                // Backup, and Delete (admin). Snapshot/Backup are VM-only.
                const actionItems = [
                  running && { key: "console", label: "Console", icon: <IconTerminal size={15} />, onClick: () => setConnectTarget({ vmid: r.vmid, ip: r.ip, hostname: r.name || `VMID ${r.vmid}` }) },
                  { key: "edit", label: "Edit specs", icon: <IconEdit size={15} />, onClick: () => setEditTarget(r) },
                  r.expiresAt && { key: "renew", label: "Renew / extend", icon: <IconCalendarPlus size={15} />, onClick: () => setExtendTarget(r) },
                  r.type === "vm" && { key: "snapshot", label: "Snapshot", icon: <IconCamera size={15} />, onClick: () => setSnapshotTarget(r) },
                  r.type === "vm" && { key: "backup", label: "Configure backup", icon: <IconArchive size={15} />, onClick: () => setBackupTarget(r) },
                  isAdmin && { key: "delete", label: "Delete", icon: <IconTrash size={15} />, danger: true, onClick: () => act(r, "delete") },
                ].filter(Boolean);

                return (
                  <tr key={`${r.type}-${r.vmid}`}>
                    <td className="mono">{r.vmid}</td>
                    <td style={{ fontWeight: 600 }}>
                      <span className="resource-name">
                        <span className="resource-kind-icon" title={r.type === "vm" ? "Virtual machine" : "Container"}>
                          {r.type === "vm" ? <IconServer size={15} /> : <IconBox size={15} />}
                        </span>
                        {r.name || "—"}
                      </span>
                    </td>
                    <td><span className={`badge ${running ? "badge-running" : "badge-stopped"}`}>{r.status}</span></td>
                    <td className="mono">{r.cpu || "—"}</td>
                    <td className="mono">{fmtMem(r.maxmem)}</td>
                    <td className="mono">{fmtDisk(r)}</td>
                    <td className="mono">{r.ip || <span className="muted">—</span>}</td>
                    <td>{r.os || <span className="muted">—</span>}</td>
                    {isAdmin ? <td>{r.owner || <span className="muted">—</span>}</td> : null}
                    <td><ExpiryCell r={r} /></td>
                    <td>
                      <div className="actions-cell">
                        {busy ? (
                          <span className="muted" style={{ fontSize: 12 }}><span className="spinner" style={{ width: 12, height: 12 }} /> {busy}…</span>
                        ) : (
                          <>
                            {/* Three consolidated controls: Power · Actions · Info(tags) */}
                            <PowerMenu items={powerItems} />
                            <RowMenu icon={<IconActions />} title="Actions" items={actionItems} />
                            <TagsMenu resource={r} onChanged={() => setTimeout(load, 600)} />
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {filtered.length > 0 && (
        <div className="pagination-row">
          <button className="btn btn-ghost btn-sm" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
          <span className="muted">Page {safePage} / {totalPages}</span>
          <button className="btn btn-ghost btn-sm" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</button>
        </div>
      )}

      {editTarget && (
        <EditResourceModal
          resource={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => setTimeout(load, 800)}
        />
      )}

      {extendTarget && (
        <ExtendExpiryModal
          resource={extendTarget}
          onClose={() => setExtendTarget(null)}
          onSaved={() => setTimeout(load, 600)}
        />
      )}

      {connectTarget && (
        <TerminalModal
          vmid={connectTarget.vmid}
          ip={connectTarget.ip}
          hostname={connectTarget.hostname}
          onClose={() => setConnectTarget(null)}
        />
      )}

      {snapshotTarget && (
        <SnapshotModal
          resource={snapshotTarget}
          onClose={() => setSnapshotTarget(null)}
          onChanged={() => setTimeout(load, 1200)}
        />
      )}

      {backupTarget && (
        <BackupModal
          resource={backupTarget}
          onClose={() => setBackupTarget(null)}
        />
      )}
    </div>
  );
}
