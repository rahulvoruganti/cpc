import { useEffect, useState } from "react";
import { getJobs } from "../api/client.js";
import DeploymentSummary from "./DeploymentSummary.jsx";

// A deployment is finished (and can show a summary) once it's ready or failed.
const isDone = (job) => job.status === "ready" || job.status === "failed";

// Terminal categories shown as minimized chips, side by side.
const CATS = [
  { key: "successful", label: "Successful", cls: "dep-cat-ok" },
  { key: "pending", label: "Pending", cls: "dep-cat-pending" },
  { key: "failed", label: "Failed", cls: "dep-cat-failed" },
];

function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour12: false }); } catch { return ""; }
}

function catDotClass(category) {
  if (category === "successful") return "log-dot-ok";
  if (category === "failed") return "log-dot-danger";
  if (category === "pending") return "log-dot-pending";
  return "log-dot-active"; // running
}
function stepDotClass(status) {
  if (status === "ready") return "log-dot-ok";
  if (status === "failed") return "log-dot-danger";
  if (status === "pending") return "log-dot-muted";
  return "log-dot-active";
}

function jobTitle(job) {
  return job.resources?.[0]?.hostname
    || job.payload?.hostname
    || job.payload?.hostnamePrefix
    || `job ${job.id}`;
}

function StepList({ job }) {
  // Workflow jobs carry a structured, per-step tracker — render that as circles
  // that go green as each named step finishes, instead of the raw log stream.
  if (job.steps?.length) {
    return (
      <ol className="wf-track">
        {job.steps.map((s, i) => {
          const state = job.status === "failed" && s.state === "active" ? "failed" : s.state;
          return (
            <li key={s.key || i} className={`wf-track-step wf-track-${state}`}>
              <span className="wf-track-dot">
                {state === "done" ? "✓" : state === "failed" ? "✕" : i + 1}
              </span>
              <span className="wf-track-body">
                <span className="wf-track-label">{s.label}</span>
                {s.reference && <span className="wf-track-ref mono">{s.reference}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    );
  }

  const steps = job.logs || [];
  return (
    <ol className="log-steps">
      {steps.map((s, i) => (
        <li key={i} className={s.error ? "log-step log-step-error" : "log-step"}>
          <span className={`log-dot ${stepDotClass(s.status)}`} />
          <span className="log-step-time mono">{fmtTime(s.ts)}</span>
          <span className="log-step-msg">{s.message}</span>
        </li>
      ))}
      {steps.length === 0 && <li className="log-step muted">No steps recorded.</li>}
    </ol>
  );
}

// One expandable deployment row (used by the category lists and the
// running-only filter). Expanding reveals the step tracker + summary button.
function JobRow({ job, expanded, onToggle, onSummary }) {
  return (
    <div className="log-job">
      <button className="log-job-head" onClick={onToggle} aria-expanded={expanded}>
        <span className={`log-dot ${catDotClass(job.category)}`} />
        <span className="log-job-title">{job.type.toUpperCase()} · {jobTitle(job)}</span>
        <span className="log-job-meta mono">#{job.id}</span>
        <span className="log-caret">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <>
          <StepList job={job} />
          {isDone(job) && (
            <button className="dep-summary-btn" onClick={onSummary}>
              View summary
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default function LogPanel() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("normal");    // "normal" | "min" | "max"
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState("");
  const [openCat, setOpenCat] = useState(null);  // expanded category key
  const [openJob, setOpenJob] = useState(null);  // expanded job id within a category
  const [runningOnly, setRunningOnly] = useState(false); // filter: show only running
  const [summaryJob, setSummaryJob] = useState(null); // job shown in the summary modal

  useEffect(() => {
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        const data = await getJobs();
        if (cancelled) return;
        setJobs(data);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error || e.message);
      }
      timer = setTimeout(poll, 3500);
    };
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  // jobs come newest-first from the API.
  const runningJobs = jobs.filter((j) => j.category === "running");
  const current = runningJobs[0] || jobs[0] || null;
  const counts = jobs.reduce((acc, j) => { acc[j.category] = (acc[j.category] || 0) + 1; return acc; }, {});
  const byCat = (key) => jobs.filter((j) => j.category === key);

  if (!open) {
    return (
      <button
        className="log-launcher"
        onClick={() => { setOpen(true); setMode("normal"); }}
        aria-label="Open deployment monitor"
        title="Deployment monitor"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6h16M4 12h10M4 18h7" />
          <path d="M15.5 17l2 2 3.5-4" />
        </svg>
        {runningJobs.length > 0 && <span className="log-launcher-live" aria-hidden="true" />}
      </button>
    );
  }

  return (
    <div className={`logpanel logpanel-${mode}`}>
      <div className="logpanel-header">
        <span className="logpanel-title">
          <span className="logpanel-title-dot" />
          Deployment monitor
          {runningJobs.length > 0 && (
            <button
              type="button"
              className={`logpanel-count ${runningOnly ? "logpanel-count-active" : ""}`}
              onClick={() => { setRunningOnly((v) => !v); setOpenCat(null); setOpenJob(null); }}
              title={runningOnly ? "Show all deployments" : "Show only running"}
            >
              {runningJobs.length} running
            </button>
          )}
        </span>
        <div className="logpanel-controls">
          <button className="logpanel-btn" onClick={() => setMode((m) => (m === "min" ? "normal" : "min"))}
            title={mode === "min" ? "Restore" : "Minimize"} aria-label="Minimize">{mode === "min" ? "▢" : "—"}</button>
          <button className="logpanel-btn" onClick={() => setMode((m) => (m === "max" ? "normal" : "max"))}
            title={mode === "max" ? "Restore" : "Maximize"} aria-label="Maximize">{mode === "max" ? "❐" : "▣"}</button>
          <button className="logpanel-btn" onClick={() => setOpen(false)} title="Close" aria-label="Close">×</button>
        </div>
      </div>

      {mode !== "min" && (
        <div className="logpanel-body">
          {error && <div className="log-error">{error}</div>}
          {!error && jobs.length === 0 && (
            <div className="log-empty">No deployments yet. Provisioning steps will stream here.</div>
          )}

          {/* Running-only filter (toggled from the "N running" chip) */}
          {runningOnly && (
            <div className="dep-cat-list">
              <div className="dep-current-head" style={{ marginBottom: 6 }}>
                <span className="dep-current-label">Running now</span>
                <button className="dep-summary-btn" onClick={() => setRunningOnly(false)}>Show all</button>
              </div>
              {runningJobs.length === 0 && (
                <div className="log-empty" style={{ padding: "10px 4px" }}>No running deployments.</div>
              )}
              {runningJobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  expanded={openJob === job.id}
                  onToggle={() => setOpenJob(openJob === job.id ? null : job.id)}
                  onSummary={() => setSummaryJob(job)}
                />
              ))}
            </div>
          )}

          {/* Current / last-ran deployment, shown in detail */}
          {!runningOnly && current && (
            <div className={`dep-current ${current.category === "running" ? "dep-current-running" : ""}`}>
              <div className="dep-current-head">
                <span className="dep-current-label">
                  {current.category === "running" ? "Running now" : "Last deployment"}
                </span>
                <span className={`log-status-chip ${catDotClass(current.category)}`}>{current.category}</span>
              </div>
              <div className="dep-current-title">
                {current.type.toUpperCase()} · {jobTitle(current)}
                <span className="log-job-meta mono"> #{current.id}</span>
              </div>
              <StepList job={current} />
              {isDone(current) && (
                <button className="dep-summary-btn" onClick={() => setSummaryJob(current)}>
                  View summary
                </button>
              )}
            </div>
          )}

          {/* Minimized categories, side by side */}
          {!runningOnly && jobs.length > 0 && (
            <>
              <div className="dep-cats">
                {CATS.map((c) => {
                  const n = counts[c.key] || 0;
                  const active = openCat === c.key;
                  return (
                    <button
                      key={c.key}
                      className={`dep-cat ${c.cls} ${active ? "dep-cat-open" : ""}`}
                      onClick={() => { setOpenCat(active ? null : c.key); setOpenJob(null); }}
                      title={`${n} ${c.label.toLowerCase()}`}
                    >
                      <span className="dep-cat-count">{n}</span>
                      <span className="dep-cat-name">{c.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Expanded category: list of its deployments */}
              {openCat && (
                <div className="dep-cat-list">
                  {byCat(openCat).length === 0 && (
                    <div className="log-empty" style={{ padding: "10px 4px" }}>No {openCat} deployments.</div>
                  )}
                  {byCat(openCat).map((job) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      expanded={openJob === job.id}
                      onToggle={() => setOpenJob(openJob === job.id ? null : job.id)}
                      onSummary={() => setSummaryJob(job)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {summaryJob && <DeploymentSummary job={summaryJob} onClose={() => setSummaryJob(null)} />}
    </div>
  );
}
