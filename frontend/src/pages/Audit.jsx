import { useEffect, useState } from "react";
import { getAudit } from "../api/client.js";

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const ACTION_LABELS = {
  "auth.login": "Sign in",
  "vm.create": "Create VM",
  "vm.start": "Start VM", "vm.stop": "Stop VM", "vm.shutdown": "Shutdown VM",
  "vm.reboot": "Reboot VM", "vm.delete": "Delete VM",
  "container.create": "Create container",
  "container.start": "Start container", "container.stop": "Stop container",
  "container.shutdown": "Shutdown container", "container.reboot": "Reboot container",
  "container.delete": "Delete container",
  "stack.create": "Create stack",
  "user.create": "Create user", "user.update_role": "Change role", "user.delete": "Delete user",
};

export default function Audit() {
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [page, setPage] = useState(1);

  const load = () => getAudit({ limit: 300 }).then(setEntries).catch((e) => setError(e.response?.data?.error || e.message));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  useEffect(() => { setPage(1); }, [filter, statusFilter, actionFilter]);

  const shown = filter
    ? entries.filter((e) =>
        (e.actor?.username || "").toLowerCase().includes(filter.toLowerCase()) ||
        (e.action || "").toLowerCase().includes(filter.toLowerCase()) ||
        (e.target || "").toLowerCase().includes(filter.toLowerCase()))
    : entries;

  const actionKeys = Array.from(new Set(entries.map((e) => e.action).filter(Boolean))).sort();
  const filtered = shown.filter((e) => {
    const statusOk = statusFilter === "all" || e.status === statusFilter;
    const actionOk = actionFilter === "all" || e.action === actionFilter;
    return statusOk && actionOk;
  });
  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);

  return (
    <div className="page">
      <div className="page-head">
        <div className="eyebrow">Compliance</div>
        <h1>Audit log</h1>
        <p>Every provisioning, lifecycle, and access event, newest first.</p>
      </div>

      {error && <div className="login-error">{error}</div>}

      <div className="toolbar toolbar-panel">
        <input
          className="control-input"
          placeholder="Filter by user, action, or target…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select className="control-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All results</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
        </select>
        <select className="control-select" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
          <option value="all">All actions</option>
          {actionKeys.map((action) => (
            <option key={action} value={action}>{ACTION_LABELS[action] || action}</option>
          ))}
        </select>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>{filtered.length} events</span>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        {filtered.length === 0 ? (
          <div className="empty">No matching events.</div>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>Result</th></tr>
            </thead>
            <tbody>
              {pageItems.map((e) => (
                <tr key={e.id}>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>{fmtTime(e.timestamp)}</td>
                  <td>{e.actor?.username || "system"}</td>
                  <td>{ACTION_LABELS[e.action] || e.action}</td>
                  <td className="mono">{e.target || "—"}</td>
                  <td>
                    <span className={`badge ${e.status === "success" ? "badge-running" : "badge-failed"}`}>{e.status}</span>
                  </td>
                </tr>
              ))}
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
    </div>
  );
}
