import { useEffect, useMemo, useState } from "react";
import { approveProvisionRequest, getProvisionRequests } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import RejectRequestModal from "../components/RejectRequestModal.jsx";

function statusClass(status = "") {
  const s = status.toLowerCase();
  if (s.includes("pending")) return "badge badge-provisioning";
  if (s.includes("approved") || s.includes("completed")) return "badge badge-ready";
  if (s.includes("failed") || s.includes("rejected")) return "badge badge-failed";
  if (s.includes("provision")) return "badge badge-booting";
  return "badge badge-stopped";
}

export default function Requests() {
  const { isAdmin } = useAuth();
  const [items, setItems] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [query, setQuery] = useState("");
  const [rejectTarget, setRejectTarget] = useState(null);  // request being rejected

  const load = async () => {
    const data = await getProvisionRequests();
    setItems(Array.isArray(data) ? data : []);
  };

  useEffect(() => {
    load().catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((r) =>
      (r.id || "").toLowerCase().includes(q)
      || (r.requestedBy || "").toLowerCase().includes(q)
      || (r.kind || "").toLowerCase().includes(q)
      || (r.status || "").toLowerCase().includes(q)
      || (r.payload?.hostname || r.payload?.hostnamePrefix || "").toLowerCase().includes(q)
    );
  }, [items, query]);

  const handleApprove = async (id) => {
    setBusyId(id);
    try {
      await approveProvisionRequest(id);
      await load();
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    } finally {
      setBusyId(null);
    }
  };


  return (
    <div className="page">
      <div className="page-head">
        <div className="eyebrow">Workflow</div>
        <h1>Requests</h1>
        <p>{isAdmin ? "Review and approve user requests before provisioning." : "Track all provisioning requests and current status."}</p>
      </div>

      <div className="toolbar toolbar-panel" style={{ marginBottom: 14 }}>
        <input
          className="control-input"
          placeholder="Search by request id, user, kind, status..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>{filtered.length} requests</span>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Request</th>
              {isAdmin && <th>User</th>}
              <th>Target</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Created</th>
              <th>Job</th>
              {isAdmin && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const target = r.payload?.hostname || r.payload?.hostnamePrefix || r.payload?.templateId || r.payload?.stackId || "-";
              const canReview = isAdmin && r.status === "pending_approval";
              return (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  {isAdmin && <td>{r.requestedBy}</td>}
                  <td>{target}</td>
                  <td>{r.kind}</td>
                  <td><span className={statusClass(r.status)}>{r.status}</span></td>
                  <td className="mono">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="mono">{r.jobId || "-"}</td>
                  {isAdmin && (
                    <td className="actions-cell">
                      <button className="btn btn-primary btn-sm" disabled={!canReview || busyId === r.id} onClick={() => handleApprove(r.id)}>Approve</button>
                      <button className="btn btn-ghost btn-sm" disabled={!canReview || busyId === r.id} onClick={() => setRejectTarget(r)}>Reject</button>
                    </td>
                  )}
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 8 : 6} className="muted" style={{ textAlign: "center", padding: 24 }}>
                  No requests found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rejectTarget && (
        <RejectRequestModal
          request={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onDone={() => load().catch(() => {})}
        />
      )}
    </div>
  );
}
