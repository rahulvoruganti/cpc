import { useEffect, useState } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  RadialBarChart, RadialBar, PolarAngleAxis,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";
import { getDashboard } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";

function fmtBytes(b) {
  if (!b) return "0";
  const gb = b / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`;
}
function fmtUptime(s) {
  if (!s) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

// Read the active theme's palette from CSS custom properties so the charts
// re-colour automatically when the user switches themes.
function useThemeColors() {
  const read = () => {
    const s = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (s.getPropertyValue(name) || fallback).trim();
    return {
      brand: v("--brand", "#3f3f3f"),
      accent: v("--accent", "#1f6feb"),
      ok: v("--ok", "#15a34a"),
      warn: v("--warn", "#d97706"),
      danger: v("--danger", "#dc2626"),
      line: v("--line", "#e4e7ec"),
      ink3: v("--ink-3", "#8b94a0"),
    };
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setColors(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return colors;
}

function Gauge({ value, label, color, sub }) {
  const data = [{ value }];
  return (
    <div className="gauge-wrap">
      <ResponsiveContainer width="100%" height={160}>
        <RadialBarChart
          innerRadius="72%" outerRadius="100%" data={data}
          startAngle={220} endAngle={-40}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar background={{ fill: "var(--line-2)" }} dataKey="value" cornerRadius={20} fill={color} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="gauge-center">
        <strong>{value}%</strong>
        <span>{label}</span>
      </div>
      {sub && <div className="muted gauge-sub">{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const c = useThemeColors();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = () => getDashboard().then(setData).catch((e) => setError(e.response?.data?.error || e.message));
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const memPct = data?.node?.memoryTotal
    ? Math.round((data.node.memoryUsed / data.node.memoryTotal) * 100)
    : 0;
  const cpuPct = data?.node?.cpu ? Math.round(data.node.cpu * 100) : 0;

  const vms = data?.counts?.vms ?? 0;
  const containers = data?.counts?.containers ?? 0;
  const running = data?.counts?.running ?? 0;
  const stopped = data?.counts?.stopped ?? 0;
  const totalResources = vms + containers;

  const compositionData = [
    { name: "VMs", value: vms, fill: c.accent },
    { name: "Containers", value: containers, fill: c.brand },
  ];
  const powerData = [
    { name: "Running", value: running, fill: c.ok },
    { name: "Stopped", value: stopped, fill: c.ink3 },
  ];
  const barData = [
    { name: "VMs", count: vms, fill: c.accent },
    { name: "Containers", count: containers, fill: c.brand },
  ];

  const kpis = [
    { label: "Total resources", value: totalResources, accent: c.brand },
    { label: "Running", value: running, accent: c.ok },
    { label: "VMs", value: vms, accent: c.accent },
    { label: "Containers", value: containers, accent: c.warn },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div className="eyebrow">Overview</div>
        <h1>Welcome back, {(user?.displayName || user?.username || "").split(/[\s.]/)[0]}</h1>
        <p>
          {data?.scope === "owned"
            ? "Your virtual machines and containers, and their current status."
            : "Live status of all resources on your private cloud infrastructure."}
        </p>
      </div>

      {error && <div className="login-error">{error}</div>}

      {/* KPI tiles */}
      <div className="kpi-row">
        {kpis.map((k) => (
          <div className="kpi-tile card" key={k.label}>
            <span className="kpi-accent" style={{ background: k.accent }} />
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="dash-grid">
        <div className="card card-pad">
          <div className="chart-title">Resource composition</div>
          <div className="donut-hold">
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={compositionData} dataKey="value" nameKey="name"
                  innerRadius={62} outerRadius={90} paddingAngle={2} strokeWidth={0}
                >
                  {compositionData.map((e) => <Cell key={e.name} fill={e.fill} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
            <div className="donut-hold-center">
              <strong>{totalResources}</strong>
              <span>Total</span>
            </div>
          </div>
        </div>

        <div className="card card-pad">
          <div className="chart-title">Power state</div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={powerData} dataKey="value" nameKey="name" outerRadius={90} strokeWidth={0}>
                {powerData.map((e) => <Cell key={e.name} fill={e.fill} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="card card-pad">
          <div className="chart-title">Resources by type</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={barData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={c.line} vertical={false} />
              <XAxis dataKey="name" tickLine={false} axisLine={{ stroke: c.line }} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
              <Tooltip cursor={{ fill: "var(--line-2)" }} />
              <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                {barData.map((e) => <Cell key={e.name} fill={e.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {data?.node && (
        <>
          <div className="section-title">Node health</div>
          <div className="dash-grid">
            <div className="card card-pad">
              <div className="chart-title">CPU load</div>
              <Gauge value={cpuPct} label="CPU" color={cpuPct >= 85 ? c.danger : cpuPct >= 60 ? c.warn : c.ok} />
            </div>
            <div className="card card-pad">
              <div className="chart-title">Memory usage</div>
              <Gauge
                value={memPct}
                label="Memory"
                color={memPct >= 85 ? c.danger : memPct >= 60 ? c.warn : c.ok}
                sub={`${fmtBytes(data.node.memoryUsed)} / ${fmtBytes(data.node.memoryTotal)}`}
              />
            </div>
            <div className="card card-pad uptime-card">
              <div className="chart-title">Uptime</div>
              <div className="uptime-chart-value">{fmtUptime(data.node.uptime)}</div>
              <div className="muted" style={{ fontSize: 12 }}>since last boot</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
