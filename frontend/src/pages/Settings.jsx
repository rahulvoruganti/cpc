import { useEffect, useRef, useState } from "react";
import {
  getSettings, updateSettings,
  testProxmoxConnection, testK3sConnection,
} from "../api/client.js";

// Which categories support a live connectivity test, and how to run it.
const TESTERS = {
  proxmox: { label: "Save & test connection", run: testProxmoxConnection },
  k3s: { label: "Save & test connection", run: testK3sConnection },
};

// Build the flat { KEY: value } form state from the grouped server response.
function formFromGroups(groups) {
  const state = {};
  for (const group of groups) {
    for (const field of group.fields) {
      state[field.key] = field.secret ? "" : field.value;
    }
  }
  return state;
}

function Toggle({ checked, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

function Field({ field, value, onChange }) {
  if (field.type === "bool" || field.type === "boolNegated") {
    return (
      <div className="set-row set-row-toggle">
        <div className="set-row-label">
          <label>{field.label}</label>
          {field.hint && <p className="set-help">{field.hint}</p>}
        </div>
        <Toggle checked={!!value} onChange={(v) => onChange(field.key, v)} />
      </div>
    );
  }

  return (
    <div className="set-row">
      <div className="set-row-label">
        <label htmlFor={`set-${field.key}`}>{field.label}</label>
        {field.secret && (
          <span className={`set-tag ${field.isSet ? "on" : ""}`}>{field.isSet ? "configured" : "not set"}</span>
        )}
      </div>
      <input
        id={`set-${field.key}`}
        className="control-input"
        type={field.type === "number" ? "number" : "text"}
        value={value ?? ""}
        placeholder={field.secret && field.isSet ? "•••••••• (leave blank to keep)" : field.placeholder}
        autoComplete={field.secret ? "new-password" : "off"}
        onChange={(e) => onChange(field.key, e.target.value)}
      />
    </div>
  );
}

export default function Settings() {
  const [groups, setGroups] = useState([]);
  const [form, setForm] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testResult, setTestResult] = useState(null);
  const noticeTimer = useRef(null);

  const load = () => {
    setLoading(true);
    getSettings()
      .then((d) => {
        const gs = d.groups || [];
        setGroups(gs);
        setForm(formFromGroups(gs));
        setActiveId((curr) => curr || gs[0]?.id || null);
        setError("");
      })
      .catch((e) => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const flash = (msg) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 4000);
  };

  const onChange = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const d = await updateSettings(form);
      const gs = d.groups || [];
      setGroups(gs);
      setForm(formFromGroups(gs));
      flash("Settings saved.");
      return true;
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveAndTest = async (tester) => {
    const ok = await save();
    if (!ok) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await tester.run();
      const detail = r.gitVersion || r.pveversion || r.platform;
      setTestResult({ ok: true, text: `Connected to ${r.url || r.host}${detail ? ` · ${detail}` : ""}.` });
    } catch (e) {
      setTestResult({ ok: false, text: e.response?.data?.error || e.message });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return <div className="set-loading"><span className="spinner" /></div>;
  }

  const active = groups.find((g) => g.id === activeId) || groups[0];
  const tester = active ? TESTERS[active.id] : null;

  return (
    <div className="settings">
      <div className="page-head">
        <div className="eyebrow">Administration</div>
        <h1>Settings</h1>
        <p>Configure integrations and environment settings without editing the
          <span className="mono"> .env</span> file. Saved values override it and persist across restarts.</p>
      </div>

      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="set-notice">{notice}</div>}

      <div className="set-layout">
        <nav className="set-nav" aria-label="Setting categories">
          {groups.map((g) => (
            <button
              key={g.id}
              className={`set-nav-item ${g.id === active?.id ? "active" : ""}`}
              onClick={() => { setActiveId(g.id); setTestResult(null); }}
            >
              {g.title}
            </button>
          ))}
        </nav>

        {active && (
          <section className="set-panel card">
            <header className="set-panel-head">
              <div>
                <h2>{active.title}</h2>
                {active.note && <p>{active.note}</p>}
              </div>
              <span className={`badge ${active.live ? "badge-running" : "badge-warn"}`}>
                {active.live ? "applies live" : "restart required"}
              </span>
            </header>

            <div className="set-fields">
              {active.fields.map((field) => (
                <Field key={field.key} field={field} value={form[field.key]} onChange={onChange} />
              ))}
            </div>

            {tester && testResult && (
              <div className={`set-test ${testResult.ok ? "ok" : "err"}`}>
                {testResult.ok ? "✓ " : "✕ "}{testResult.text}
              </div>
            )}

            <footer className="set-panel-actions">
              <button className="btn btn-primary" onClick={save} disabled={saving || testing}>
                {saving ? "Saving…" : "Save changes"}
              </button>
              {tester && (
                <button className="btn btn-ghost" onClick={() => saveAndTest(tester)} disabled={saving || testing}>
                  {testing ? "Testing…" : tester.label}
                </button>
              )}
            </footer>
          </section>
        )}
      </div>
    </div>
  );
}
