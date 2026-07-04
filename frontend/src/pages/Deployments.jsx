import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getJobs } from "../api/client.js";
import JobStatus from "../components/JobStatus.jsx";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "successful", label: "Successful" },
  { key: "pending", label: "Pending" },
  { key: "failed", label: "Failed" },
];

function catClass(category) {
  if (category === "successful") return "badge-ready";
  if (category === "failed") return "badge-failed";
  if (category === "pending") return "badge-provisioning";
  return "badge-booting"; // running
}

function jobTitle(job) {
  return job.resources?.[0]?.hostname
    || job.payload?.hostname
    || job.payload?.hostnamePrefix
    || `job ${job.id}`;
}

function fmtWhen(ts) {
  if (!ts) return "";
  try { return new Date(ts).toLocaleString(); } catch { return ""; }
}

// Full-page deployment history — browse every deployment and open its live (or
// finished) monitor. The floating widget stays for at-a-glance progress; this
// page is the place to review past runs.
export default function Deployments() {
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("job");

  useEffect(() => {
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        const data = await getJobs();
        if (cancelled) return;
        setJobs(Array.isArray(data) ? data : []);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error || e.message);
      }
      timer = setTimeout(poll, 3500);
    };
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      const matchCat = filter === "all" || j.category === filter;
      const matchQuery = !q
        || String(j.id || "").toLowerCase().includes(q)
        || (j.type || "").toLowerCase().includes(q)
        || jobTitle(j).toLowerCase().includes(q);
      return matchCat && matchQuery;
    });
  }, [jobs, filter, query]);

  // Selected deployment: the one in the URL, else the newest in view.
  const selected = jobs.find((j) => String(j.id) === String(selectedId)) || filtered[0] || null;

  const select = (id) => setParams(id ? { job: String(id) } : {});

  return (
    <div className="page">
      <div className="page-head">
        <div className="eyebrow">Activity</div>
        <h1>Deployments</h1>
        <p>Browse every deployment and open its monitor to follow progress or review what happened.</p>
      </div>

      {error && <div className="login-error">{error}</div>}

      <div className="toolbar toolbar-panel">
        <input
          className="control-input"
          placeholder="Search by host, type, or job id..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="control-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>{filtered.length} deployments</span>
      </div>

      <div className="deploy-layout">
        <div className="deploy-list">
          {filtered.length === 0 ? (
            <div className="empty">No deployments match your filters.</div>
          ) : (
            filtered.map((j) => (
              <button
                key={j.id}
                className={`deploy-item ${selected && String(selected.id) === String(j.id) ? "deploy-item-active" : ""}`}
                onClick={() => select(j.id)}
              >
                <div className="deploy-item-row">
                  <span className="deploy-item-title">{(j.type || "job").toUpperCase()} · {jobTitle(j)}</span>
                  <span className={`badge ${catClass(j.category)}`}>{j.category || j.status}</span>
                </div>
                <div className="deploy-item-meta">
                  <span className="mono">#{j.id}</span>
                  {fmtWhen(j.createdAt) && <span>· {fmtWhen(j.createdAt)}</span>}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="deploy-detail">
          {selected ? (
            <JobStatus key={selected.id} jobId={selected.id} onClose={() => select(null)} />
          ) : (
            <div className="empty">Select a deployment to see its monitor.</div>
          )}
        </div>
      </div>
    </div>
  );
}
