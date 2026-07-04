import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { login, getEntraStatus, getEntraLoginUrl } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";

export default function Login() {
  const [method, setMethod] = useState(null); // null | "local" | "sso"
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [entraEnabled, setEntraEnabled] = useState(false);
  const { signIn, user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);

  useEffect(() => {
    getEntraStatus().then((d) => setEntraEnabled(d.enabled)).catch(() => {});
  }, []);

  const handleLocal = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { token, user } = await login(username, password);
      signIn(token, user);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  const handleEntra = async () => {
    setError("");
    try {
      const { url } = await getEntraLoginUrl();
      window.location.href = url;
    } catch (err) {
      setError("Microsoft sign-in is unavailable. Contact your administrator.");
    }
  };

  return (
    <div className="login-wrap">
      <aside className="login-aside">
        <div className="brand-lg">
          <span className="topnav-mark">CPC</span>
          Colruyt Private Cloud
        </div>
        <div className="pitch">
          <div className="eyebrow" style={{ color: "#9aa3b2" }}>Self-service infrastructure</div>
          <h2>Spin up environments in minutes, not tickets.</h2>
          <p>
            Provision VMs, containers, and full stacks on internal infrastructure —
            request, track, and connect, all from one place.
          </p>
        </div>
        <div className="foot">Internal use only &middot; Colruyt Group</div>
      </aside>

      <main className="login-main">
        <div className="login-card">
          {!method && (
            <>
              <h1>Sign in</h1>
              <p className="sub">Choose how you'd like to sign in.</p>

              {error && <div className="login-error">{error}</div>}

              <div className="method-list">
                <button
                  className="method-option"
                  onClick={() => (entraEnabled ? handleEntra() : setMethod("sso"))}
                >
                  <span className="ms-grid"><span /><span /><span /><span /></span>
                  <span className="method-text">
                    <span className="method-title">Company account (SSO)</span>
                    <span className="method-sub">
                      {entraEnabled ? "Sign in with Microsoft Entra ID" : "Not configured yet"}
                    </span>
                  </span>
                </button>

                <button className="method-option" onClick={() => setMethod("local")}>
                  <span className="method-icon">CPC</span>
                  <span className="method-text">
                    <span className="method-title">Local account</span>
                    <span className="method-sub">Sign in with username and password</span>
                  </span>
                </button>
              </div>
            </>
          )}

          {method === "local" && (
            <>
              <button className="btn-back" onClick={() => { setMethod(null); setError(""); }}>&larr; Back</button>
              <h1>Local sign in</h1>
              <p className="sub">Enter your CPC username and password.</p>

              {error && <div className="login-error">{error}</div>}

              <form onSubmit={handleLocal}>
                <div className="field">
                  <label>Username</label>
                  <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
                </div>
                <div className="field">
                  <label>Password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                </div>
                <button className="btn btn-primary" style={{ width: "100%" }} disabled={busy}>
                  {busy ? "Signing in…" : "Sign in"}
                </button>
              </form>
            </>
          )}

          {method === "sso" && (
            <>
              <button className="btn-back" onClick={() => { setMethod(null); setError(""); }}>&larr; Back</button>
              <h1>Company account</h1>
              <p className="sub">Single sign-on is not available yet.</p>
              <div className="login-error">
                Microsoft Entra ID hasn't been configured. Ask an administrator to set it up
                under Settings, then use a local account in the meantime.
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
