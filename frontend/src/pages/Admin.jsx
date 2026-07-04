import { useSearchParams } from "react-router-dom";
import Users from "./Users.jsx";
import Mappings from "./Mappings.jsx";
import Settings from "./Settings.jsx";

const TABS = [
  { id: "users", label: "Users" },
  { id: "mappings", label: "Mappings" },
  { id: "settings", label: "Settings" },
];

export default function Admin() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const active = TABS.some((t) => t.id === requested) ? requested : "users";

  const selectTab = (id) => setParams(id === "users" ? {} : { tab: id }, { replace: true });

  return (
    <div className="page">
      <div className="admin-tabs" role="tablist" aria-label="Administration sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            className={`admin-tab ${active === t.id ? "active" : ""}`}
            onClick={() => selectTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="admin-tab-panel">
        {active === "users" && <Users embedded />}
        {active === "mappings" && <Mappings embedded />}
        {active === "settings" && <Settings />}
      </div>
    </div>
  );
}
