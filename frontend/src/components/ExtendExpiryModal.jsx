import { useState } from "react";
import { extendResource } from "../api/client.js";

// Extend a resource's expiry by a number of days from now (admin only).
// Mirrors EditResourceModal's small floating-form pattern.
export default function ExtendExpiryModal({ resource, onClose, onSaved }) {
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const current = resource.expiresAt
    ? new Date(resource.expiresAt).toLocaleDateString()
    : "no expiry set";

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0) {
      setError("Enter a positive number of days.");
      return;
    }
    setBusy(true);
    try {
      await extendResource(resource.type, resource.vmid, n);
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <div className="modal-header">
          <h3>Extend {resource.name || `VMID ${resource.vmid}`}</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <form onSubmit={submit} className="modal-body">
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Current expiry: <strong>{current}</strong>
            {resource.daysLeft != null && !resource.expired && ` (${resource.daysLeft}d left)`}
            {resource.expired && " (expired)"}
          </p>

          <label className="field">
            <span>Extend by (days from now)</span>
            <input
              type="number"
              min="1"
              max="3650"
              value={days}
              autoFocus
              onChange={(e) => setDays(e.target.value)}
            />
          </label>

          <div className="extend-quick">
            {[7, 30, 90, 365].map((d) => (
              <button
                type="button"
                key={d}
                className={`chip-btn ${Number(days) === d ? "chip-btn-active" : ""}`}
                onClick={() => setDays(d)}
              >
                {d}d
              </button>
            ))}
          </div>

          <p className="muted" style={{ fontSize: 12 }}>
            The new expiry is set to {days || "…"} day{Number(days) === 1 ? "" : "s"} from now.
          </p>

          {error && <p className="login-error" style={{ marginTop: 0 }}>{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Extending…" : "Extend expiry"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
