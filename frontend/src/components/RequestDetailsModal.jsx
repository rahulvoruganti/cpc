import { useEffect, useState } from "react";
import { getRequestImpact } from "../api/client.js";

const GB = 1024 ** 3;

// Human-friendly formatting per resource unit.
function fmt(value, unit) {
  if (unit === "cores") {
    const n = Number(value || 0);
    return `${Number.isInteger(n) ? n : n.toFixed(1)} vCPU`;
  }
  const gb = Number(value || 0) / GB;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

const pct = (p) => `${Number(p || 0).toFixed(1)}%`;

// Info tooltip: reveals the total / current usage / balance breakdown for one
// resource, before and after provisioning. Kept out of the main summary on
// purpose — only surfaced on hover of the (i) icon.
function ResourceInfo({ r }) {
  return (
    <span className="info-tip" tabIndex={0} aria-label={`${r.label} capacity breakdown`}>
      <span className="info-tip-icon" aria-hidden="true">i</span>
      <span className="info-tip-pop" role="tooltip">
        <span className="info-tip-title">{r.label} capacity</span>
        <table className="info-tip-table">
          <thead>
            <tr><th></th><th>Before</th><th>After</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Total</td>
              <td>{fmt(r.total, r.unit)}</td>
              <td>{fmt(r.total, r.unit)}</td>
            </tr>
            <tr>
              <td>In use</td>
              <td>{fmt(r.currentUsed, r.unit)}</td>
              <td>{fmt(r.projectedUsed, r.unit)}</td>
            </tr>
            <tr>
              <td>Balance</td>
              <td>{fmt(r.balanceBefore, r.unit)}</td>
              <td className={r.balanceAfter < 0 ? "usage-red" : ""}>{fmt(r.balanceAfter, r.unit)}</td>
            </tr>
          </tbody>
        </table>
      </span>
    </span>
  );
}

export default function RequestDetailsModal({ request, onApprove, onReject, onClose }) {
  const [impact, setImpact] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const p = request.payload || {};
  const target = p.hostname || p.hostnamePrefix || p.templateId || p.stackId || "-";
  const os = impact?.details?.os;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getRequestImpact(request.id)
      .then((data) => { if (!cancelled) setImpact(data); })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [request.id]);

  const canApprove = impact?.canApprove && !busy && !loading;

  const approve = async () => {
    setBusy(true);
    try {
      await onApprove(request.id);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setBusy(false);
    }
  };

  const resources = impact ? [impact.resources.cpu, impact.resources.memory, impact.resources.storage] : [];
  // Worst band drives the box border so the summary reads at a glance.
  const worst = resources.some((r) => r.level === "red") ? "red"
    : resources.some((r) => r.level === "amber") ? "amber"
    : resources.length ? "green" : "";

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card modal-card-wide">
        <div className="modal-header">
          <h3>Review request</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* Requestor + requested resources */}
          <div className="req-summary">
            <div className="req-summary-row"><span>Request</span><strong className="mono">{request.id}</strong></div>
            <div className="req-summary-row"><span>Requested by</span><strong>{request.requestedBy || "—"}</strong></div>
            <div className="req-summary-row"><span>Type</span><strong>{request.kind}</strong></div>
            <div className="req-summary-row"><span>Target host</span><strong>{target}</strong></div>
            <div className="req-summary-row"><span>OS / template</span><strong>{os || (loading ? "…" : "—")}</strong></div>
            {p.environment && <div className="req-summary-row"><span>Environment</span><strong>{p.environment}</strong></div>}
            <div className="req-summary-grid">
              <div className="req-chip"><span>CPU</span><strong>{p.cpu ? `${p.cpu} vCPU` : "—"}</strong></div>
              <div className="req-chip"><span>RAM</span><strong>{p.memoryGB ? `${p.memoryGB} GB` : "—"}</strong></div>
              <div className="req-chip"><span>Storage</span><strong>{p.diskGB ? `${p.diskGB} GB` : "—"}</strong></div>
            </div>
            {impact?.requested?.units > 1 && (
              <p className="muted" style={{ fontSize: 11.5, margin: "8px 0 0" }}>
                Stack provisions {impact.requested.units} nodes — totals below reflect all of them.
              </p>
            )}
          </div>

          {/* Capacity impact — single box, one bullet per resource */}
          <div className={`usage-box usage-box-${worst || "muted"}`}>
            <div className="usage-box-title">Projected node usage after provisioning</div>
            {loading && <p className="muted" style={{ fontSize: 13, margin: 0 }}>Calculating capacity impact…</p>}
            {error && <p className="login-error" style={{ margin: 0 }}>{error}</p>}
            {!loading && !error && (
              <ul className="usage-bullets">
                {resources.map((r) => (
                  <li key={r.label} className={`usage-bullet usage-${r.level}`}>
                    <span className={`usage-bullet-dot usage-fill-${r.level}`} />
                    <span className="usage-bullet-label">{r.label}</span>
                    <span className={`usage-bullet-val usage-${r.level}`}>{pct(r.percentAfter)}</span>
                    <ResourceInfo r={r} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {impact && !impact.canApprove && (
            <p className="usage-block-warning">
              Approval blocked — provisioning would exceed 80% on {impact.blocking.join(", ")}.
            </p>
          )}

          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onReject(request)}
              disabled={busy}
            >
              Reject
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={approve}
              disabled={!canApprove}
              title={impact && !impact.canApprove ? "Usage would exceed 80%" : undefined}
            >
              {busy ? "Approving…" : "Approve"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
