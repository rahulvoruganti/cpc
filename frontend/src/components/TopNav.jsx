import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { getMyPreferences, updateMyPreferences } from "../api/client.js";

const THEMES = [
  { id: "colruyt", label: "Colruyt" },
  { id: "slate", label: "Slate" },
  { id: "forest", label: "Forest" },
  { id: "sunrise", label: "Sunrise" },
];

function initials(name = "") {
  return name.split(/[\s.@]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("");
}

export default function TopNav() {
  const { user, signOut, patchPreferences, isAdmin } = useAuth();
  const [theme, setTheme] = useState(() => user?.preferences?.theme || "colruyt");
  const [showBackground, setShowBackground] = useState(() => user?.preferences?.showBackground ?? true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState("root");
  const menuRef = useRef(null);

  useEffect(() => {
    if (user?.preferences) {
      if (user.preferences.theme) setTheme(user.preferences.theme);
      if (typeof user.preferences.showBackground === "boolean") {
        setShowBackground(user.preferences.showBackground);
      }
    }

    getMyPreferences()
      .then((d) => {
        const prefs = d.preferences || {};
        if (prefs.theme) setTheme(prefs.theme);
        if (typeof prefs.showBackground === "boolean") setShowBackground(prefs.showBackground);
        patchPreferences?.(prefs);
      })
      .catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.body.setAttribute("data-ornaments", showBackground ? "on" : "off");
  }, [showBackground]);

  useEffect(() => {
    if (!menuOpen) setMenuView("root");
  }, [menuOpen]);

  useEffect(() => {
    const onDocClick = (e) => {
      if (!menuRef.current?.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const savePreferences = async (partial) => {
    patchPreferences?.(partial);
    try {
      await updateMyPreferences(partial);
    } catch {
      // Keep optimistic UI; backend will sync on next successful preferences fetch.
    }
  };

  const handleThemeChange = async (nextTheme) => {
    setTheme(nextTheme);
    await savePreferences({ theme: nextTheme });
  };

  const handleBackgroundToggle = async (nextValue) => {
    setShowBackground(nextValue);
    await savePreferences({ showBackground: nextValue });
  };

  const links = [
    { to: "/", label: "Dashboard", end: true },
    { to: "/provision", label: "Provisioning" },
    { to: "/resources", label: "Resources" },
    { to: "/deployments", label: "Deployments" },
    { to: "/requests", label: "Requests" },
  ];
  if (isAdmin) {
    links.push({ to: "/admin", label: "Admin" });
    links.push({ to: "/audit", label: "Audit" });
  }

  return (
    <nav className="topnav">
      <div className="topnav-brand">
        <span className="topnav-mark">CPC</span>
        Colruyt Private Cloud
      </div>

      <div className="topnav-links">
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            className={({ isActive }) => `topnav-link ${isActive ? "active" : ""}`}
          >
            {l.label}
          </NavLink>
        ))}
      </div>

      <div className="topnav-user">
        <div className="user-menu" ref={menuRef}>
          <button
            className="user-chip-btn"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Open account menu"
            aria-expanded={menuOpen}
          >
            <span className="user-chip">
              <span className="user-avatar">{initials(user?.displayName || user?.username)}</span>
              <span className="user-meta">
                <div className="name">{user?.displayName || user?.username}</div>
                <div className="role">{user?.role}</div>
              </span>
              <span className="user-caret">▾</span>
            </span>
          </button>

          {menuOpen && (
            <div className="user-menu-popover">
              <div className="user-menu-head">
                <div className="name">{user?.displayName || user?.username}</div>
                <div className="role">{user?.role}</div>
              </div>

              {menuView === "root" && (
                <>
                  <button className="menu-row" onClick={() => setMenuView("preferences")}>
                    <span className="menu-row-label">Preferences</span>
                    <span className="menu-row-arrow">›</span>
                  </button>
                  <button className="btn-menu-signout" onClick={signOut}>Sign out</button>
                </>
              )}

              {menuView === "preferences" && (
                <>
                  <button className="popover-back" onClick={() => setMenuView("root")}>← Back</button>
                  <div className="user-menu-section-title">Preferences</div>
                  <label className="topnav-theme-wrap" title="Theme">
                    <span>Theme</span>
                    <select className="topnav-theme" value={theme} onChange={(e) => handleThemeChange(e.target.value)}>
                      {THEMES.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                  </label>

                  <label className="pref-toggle-row">
                    <span>Decorative background</span>
                    <input
                      type="checkbox"
                      checked={showBackground}
                      onChange={(e) => handleBackgroundToggle(e.target.checked)}
                    />
                  </label>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
