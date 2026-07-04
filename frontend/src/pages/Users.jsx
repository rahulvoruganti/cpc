import { useEffect, useState } from "react";
import {
  getUsers, createUser, updateUserRole, deleteUser,
  getGroups, createGroup, deleteGroup, addGroupMember, removeGroupMember,
} from "../api/client.js";
import { useDialog } from "../components/DialogProvider.jsx";

// --- Groups management ---
function GroupsPanel({ users }) {
  const { confirm, alert } = useDialog();
  const [groups, setGroups] = useState([]);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState(false);
  const [memberPick, setMemberPick] = useState({}); // groupName -> username to add

  const load = () => getGroups().then(setGroups).catch((e) => setError(e.response?.data?.error || e.message));
  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setPending(true); setError("");
    try { await createGroup(newName.trim()); setNewName(""); load(); }
    catch (err) { setError(err.response?.data?.error || err.message); }
    finally { setPending(false); }
  };

  const remove = async (name) => {
    if (!(await confirm({ title: "Delete group", message: `Delete group "${name}"?`, confirmLabel: "Delete", tone: "danger" }))) return;
    try { await deleteGroup(name); load(); } catch (e) { alert({ title: "Couldn't delete group", message: e.response?.data?.error || e.message, tone: "danger" }); }
  };

  const addMember = async (name) => {
    const username = memberPick[name];
    if (!username) return;
    try { await addGroupMember(name, username); setMemberPick((m) => ({ ...m, [name]: "" })); load(); }
    catch (e) { alert({ title: "Couldn't add member", message: e.response?.data?.error || e.message, tone: "danger" }); }
  };

  const removeMember = async (name, username) => {
    try { await removeGroupMember(name, username); load(); } catch (e) { alert({ title: "Couldn't remove member", message: e.response?.data?.error || e.message, tone: "danger" }); }
  };

  return (
    <div style={{ marginTop: 28 }}>
      <div className="row-between" style={{ marginBottom: 12 }}>
        <div><div className="eyebrow">Access control</div><h2 style={{ margin: 0 }}>Groups</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>Add users to groups. VMs are tagged with the owner's groups so group members can see them.</p>
        </div>
        <form onSubmit={create} style={{ display: "flex", gap: 8 }}>
          <input className="control-input" placeholder="New group name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="btn btn-primary" disabled={pending || !newName.trim()}>Add group</button>
        </form>
      </div>

      {error && <div className="login-error">{error}</div>}

      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead><tr><th>Group</th><th>Members</th><th>Add member</th><th></th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.name}>
                <td style={{ fontWeight: 600 }}>{g.name}</td>
                <td>
                  <div className="group-members">
                    {g.members.length === 0 && <span className="muted">no members</span>}
                    {g.members.map((mUser) => (
                      <span key={mUser} className="badge badge-neutral group-member-chip">
                        {mUser}
                        <button className="chip-x" title="Remove" onClick={() => removeMember(g.name, mUser)}>×</button>
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <div style={{ display: "flex", gap: 6 }}>
                    <select className="control-select" value={memberPick[g.name] || ""} onChange={(e) => setMemberPick((m) => ({ ...m, [g.name]: e.target.value }))}>
                      <option value="">Select user…</option>
                      {users.filter((u) => !g.members.includes(u.username)).map((u) => (
                        <option key={u.id} value={u.username}>{u.displayName || u.username}</option>
                      ))}
                    </select>
                    <button className="btn btn-ghost btn-sm" onClick={() => addMember(g.name)} disabled={!memberPick[g.name]}>Add</button>
                  </div>
                </td>
                <td><button className="btn btn-danger btn-sm" onClick={() => remove(g.name)}>Delete</button></td>
              </tr>
            ))}
            {groups.length === 0 && <tr><td colSpan={4} className="empty">No groups yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Users({ embedded = false }) {
  const { confirm, alert } = useDialog();
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ username: "", password: "", displayName: "", email: "", role: "user" });
  const [busy, setBusy] = useState(false);

  const load = () => getUsers().then(setUsers).catch((e) => setError(e.response?.data?.error || e.message));
  useEffect(() => { load(); }, []);

  const upd = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await createUser(form);
      setForm({ username: "", password: "", displayName: "", email: "", role: "user" });
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (u) => {
    const next = u.role === "admin" ? "user" : "admin";
    try { await updateUserRole(u.id, next); load(); }
    catch (e) { alert({ title: "Couldn't change role", message: e.response?.data?.error || e.message, tone: "danger" }); }
  };

  const remove = async (u) => {
    if (!(await confirm({ title: "Delete user", message: `Delete user "${u.username}"?`, confirmLabel: "Delete", tone: "danger" }))) return;
    try { await deleteUser(u.id); load(); }
    catch (e) { alert({ title: "Couldn't delete user", message: e.response?.data?.error || e.message, tone: "danger" }); }
  };

  return (
    <div className={embedded ? "" : "page"}>
      <div className="page-head row-between">
        <div>
          <div className="eyebrow">Access control</div>
          <h1>Users</h1>
          <p>Manage local accounts and roles. Entra ID users appear here after first sign-in.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "Add user"}
        </button>
      </div>

      {error && <div className="login-error">{error}</div>}

      {showForm && (
        <div className="card card-pad" style={{ maxWidth: 480, marginBottom: 24 }}>
          <form onSubmit={submit}>
            <div className="field"><label>Username</label><input required value={form.username} onChange={upd("username")} /></div>
            <div className="field"><label>Password</label><input type="password" required value={form.password} onChange={upd("password")} /></div>
            <div className="field"><label>Display name</label><input value={form.displayName} onChange={upd("displayName")} /></div>
            <div className="field"><label>Email</label><input type="email" value={form.email} onChange={upd("email")} /></div>
            <div className="field">
              <label>Role</label>
              <select value={form.role} onChange={upd("role")}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button className="btn btn-primary" disabled={busy}>{busy ? "Creating…" : "Create user"}</button>
          </form>
        </div>
      )}

      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr><th>User</th><th>Email</th><th>Source</th><th>Role</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{u.displayName || u.username}</div>
                  <div className="muted mono" style={{ fontSize: 12 }}>{u.username}</div>
                </td>
                <td>{u.email || "—"}</td>
                <td><span className="badge badge-user">{u.source}</span></td>
                <td><span className={`badge ${u.role === "admin" ? "badge-admin" : "badge-user"}`}>{u.role}</span></td>
                <td>
                  <div className="actions-cell">
                    <button className="btn btn-ghost btn-sm" onClick={() => changeRole(u)}>
                      Make {u.role === "admin" ? "user" : "admin"}
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => remove(u)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <GroupsPanel users={users} />
    </div>
  );
}
