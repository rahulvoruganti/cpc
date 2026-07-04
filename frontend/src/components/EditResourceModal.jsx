import { useState } from "react";
import { editResource } from "../api/client.js";

// Edit CPU / memory / disk for an existing VM or container.
// cpu & memory hot-apply where the guest supports it; disk can only grow.
export default function EditResourceModal({ resource, onClose, onSaved }) {
  const isVm = resource.type === "vm" || resource.type === "qemu";
  const kind = isVm ? "vm" : "container";

  const [cpu, setCpu] = useState(resource.cpu || 1);
  const [memoryGB, setMemoryGB] = useState(resource.memGB || 1);
  const [diskGB, setDiskGB] = useState(resource.maxdiskGB || 10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const minDisk = resource.maxdiskGB || 1;

  const submit = async (e) => {
    e.preventDefault();
    setError("");

    const specs = {};
    if (Number(cpu) !== resource.cpu) specs.cpu = Number(cpu);
    if (Number(memoryGB) !== resource.memGB) specs.memoryGB = Number(memoryGB);
    if (Number(diskGB) !== resource.maxdiskGB) specs.diskGB = Number(diskGB);

    if (Number(diskGB) < minDisk) {
      setError(`Disk can only grow — minimum ${minDisk} GB.`);
      return;
    }
    if (Object.keys(specs).length === 0) {
      setError("Nothing changed.");
      return;
    }

    setBusy(true);
    try {
      await editResource(kind, resource.vmid, specs);
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
          <h3>Edit {resource.name || `VMID ${resource.vmid}`}</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <form onSubmit={submit} className="modal-body">
          <label className="field">
            <span>vCPU cores</span>
            <input type="number" min="1" max="64" value={cpu}
              onChange={(e) => setCpu(e.target.value)} />
          </label>

          <label className="field">
            <span>Memory (GB)</span>
            <input type="number" min="1" max="256" value={memoryGB}
              onChange={(e) => setMemoryGB(e.target.value)} />
          </label>

          <label className="field">
            <span>Disk (GB) <em className="muted">— grow only, min {minDisk}</em></span>
            <input type="number" min={minDisk} max="2048" value={diskGB}
              onChange={(e) => setDiskGB(e.target.value)} />
          </label>

          <p className="muted" style={{ fontSize: 12 }}>
            CPU and memory apply live where the guest supports hotplug; otherwise they
            take effect on the next reboot. Disk grows immediately.
          </p>

          {error && <p className="login-error" style={{ marginTop: 0 }}>{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
