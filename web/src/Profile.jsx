import React, { useState } from "react";
import { api } from "./api.js";
import { tr } from "./tr.js";
import Sheet from "./Sheet.jsx";
import "./profile.css";

const monthLabel = (ym) => {
  const [y, m] = String(ym || "").split("-");
  return tr.profile.months[Number(m) - 1] ? `${tr.profile.months[Number(m) - 1]} ${y}` : ym;
};

/** Own-profile sheet: name + phone editable, role/joined read-only, logout. */
export default function Profile({ me, onClose, onSaved, onLogout }) {
  const [name, setName] = useState(me.name);
  const [phone, setPhone] = useState(me.phone || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const dirty = name.trim() !== me.name || phone.trim() !== (me.phone || "");

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(""); setSaved(false);
    try { onSaved(await api("PATCH", "/me", { name, phone })); setSaved(true); }
    catch (err) { setError(err.message || tr.err.generic); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true);
    try { await api("POST", "/logout"); } catch { /* cookie may already be gone */ }
    onLogout();
  };

  return (
    <Sheet title={tr.profile.title} onClose={onClose}>
      <form className="sheet-form" onSubmit={save}>
        <label className="field">
          <span>{tr.profile.name}</span>
          <input required maxLength={80} value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} />
        </label>
        <label className="field">
          <span>{tr.profile.phone} <span className="muted small">({tr.profile.phoneHint})</span></span>
          <input inputMode="tel" maxLength={30} value={phone} onChange={(e) => { setPhone(e.target.value); setSaved(false); }} />
        </label>
        <dl className="profile-facts">
          <div><dt>{tr.profile.role}</dt><dd>{me.role === "admin" ? tr.profile.roleAdmin : tr.profile.roleMember}</dd></div>
          <div><dt>{tr.profile.joined}</dt><dd>{monthLabel(me.joined_month)}</dd></div>
        </dl>
        {error && <p className="notice bad" role="alert">{error}</p>}
        {saved && <p className="notice ok" role="status">{tr.profile.saved}</p>}
        <div className="row end wrap sheet-actions profile-actions">
          <button type="button" className="btn danger" onClick={logout} disabled={busy}>{tr.profile.logout}</button>
          <button className="btn primary" disabled={busy || !dirty || !name.trim()}>{tr.profile.save}</button>
        </div>
      </form>
    </Sheet>
  );
}
