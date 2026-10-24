import React, { useEffect, useRef, useState } from "react";
import Fold from "./Fold.jsx";
import { api } from "./api.js";
import { tr } from "./tr.js";
import { EmptyState, ErrorState, Skeleton } from "./States.jsx";
import { ConfirmSheet, Select } from "./Controls.jsx";
import Sheet from "./Sheet.jsx";
import { fmtTRY, monthLabel } from "./Billing.jsx";
import { PlusIcon } from "./icons.jsx";

const ROLE_OPTS = [
  { value: "member", label: tr.members.roleMember },
  { value: "listener", label: tr.members.roleListener },
  { value: "admin", label: tr.members.roleAdmin },
];

const ROLE_OPTS_ROW = [...ROLE_OPTS, { value: "inactive", label: tr.members.inactive }];
const M = tr.members;

/** Pasif / back to active (ADR 0001 #6/#7/#10). p = GET /users/:id/status-preview. Going passive: balance + this month's
 *  day-15 effect. Reactivating: tick which passive months get aidat (none by default) + this month's day-15 effect. */
function StatusSheet({ u, p, onClose, onConfirm }) {
  const [pick, setPick] = useState(() => new Set());
  const off = u.active;
  const toggle = (m) => setPick((s) => { const n = new Set(s); n.has(m) ? n.delete(m) : n.add(m); return n; });
  return (
    <Sheet title={off ? M.passiveTitle : M.reactTitle} onClose={onClose}>
      {off ? (
        <div className="confirm-body">
          {p.debt_try !== 0 && <p>{M.passiveDebt(fmtTRY(p.debt_try))}</p>}
          {p.credit_try !== 0 && <p>{M.passiveCredit(fmtTRY(p.credit_try))}</p>}
          <p className="muted">{p.early ? M.passiveEarly : M.passiveLate}</p>
        </div>
      ) : (
        <>
          <ul className="card plain-list react-months">
            <li><label className="check"><input type="checkbox" checked={pick.size === p.months.length} onChange={(e) => setPick(e.target.checked ? new Set(p.months) : new Set())} /><span>{M.reactAll}</span></label></li>
            {p.months.map((m) => (
              <li key={m}><label className="check"><input type="checkbox" checked={pick.has(m)} onChange={() => toggle(m)} /><span>{monthLabel(m)}</span></label></li>
            ))}
          </ul>
          <p className="muted confirm-body">{p.early ? M.reactEarly : M.reactLate}</p>
        </>
      )}
      <div className="row end confirm-actions">
        <button type="button" className="btn" onClick={onClose}>{tr.ui.cancel}</button>
        <button type="button" className="btn primary" data-autofocus onClick={() => { onClose(); onConfirm(p.months.filter((m) => pick.has(m))); }}>{off ? M.passiveConfirm : M.reactConfirm}</button>
      </div>
    </Sheet>
  );
}

export default function Members({ me, onDetail }) {
  const [users, setUsers] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", role: "member" });
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(null); // member pending a reject confirm
  const [status, setStatus] = useState(null); // { u, newRole, p }: Pasif / reactivate sheet
  const timer = useRef();

  const say = (m) => { setToast(m); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(""), 2200); };
  const fail = (e) => say(e.message || tr.err.generic);
  const [loadErr, setLoadErr] = useState("");
  const load = () => { setLoadErr(""); return api("GET", "/users").then(setUsers, (e) => setLoadErr(e.message || tr.err.load)); };
  useEffect(() => { load(); }, []);
  const pending = (users || []).filter((u) => u.pending);
  const approved = (users || []).filter((u) => !u.pending);
  const replace = (u) => setUsers((us) => us.map((x) => (x.id === u.id ? u : x)));

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const n = await api("POST", "/users", form);
      setForm({ name: "", email: "", phone: "", role: "member" });
      setAdding(false);
      say(n.early === false ? `${tr.members.created} · ${M.reactLate}` : tr.members.created);
      load();
    } catch (err) { fail(err); } finally { setBusy(false); }
  };

  const decide = async (u, action, confirmed) => {
    if (action === "reject" && !confirmed) { setSure(u); return; }
    try {
      const n = await api("POST", `/users/${u.id}/${action}`);
      say(action === "approve" ? (n.early === false ? `${tr.members.approved} · ${M.reactLate}` : tr.members.approved) : tr.members.rejected);
      load();
      window.dispatchEvent(new Event("prova:users")); // refreshes the admin tab's pending-count bubble
    } catch (e) { fail(e); }
  };

  // "Pasif" is a pseudo-type: PATCH active=false (reservations/charges untouched, the user just can't use the app). Any real type reactivates.
  // Going passive or coming back first fetches the preview (balance, day-15 side, passive months) for the sheet; a
  // reactivation with no passive months to offer skips the sheet and just says the day-15 effect.
  const changeRole = async (u, newRole) => {
    const cur = u.active ? u.role : "inactive";
    if (newRole === cur) return;
    if (newRole !== "inactive" && u.active) return applyRole(u, newRole);
    try {
      const p = await api("GET", `/users/${u.id}/status-preview`);
      if (!u.active && !p.months.length) return applyRole(u, newRole, [], p);
      setStatus({ u, newRole, p });
    } catch (e) { fail(e); }
  };
  const applyRole = async (u, newRole, billMonths, p) => {
    const body = newRole === "inactive" ? { active: false } : { role: newRole, active: true, ...(billMonths ? { bill_months: billMonths } : {}) };
    try {
      replace(await api("PATCH", `/users/${u.id}`, body));
      say(p && !u.active ? `${tr.members.roleChanged} · ${p.early ? M.reactEarly : M.reactLate}` : tr.members.roleChanged);
    } catch (e) { fail(e); }
  };

  return (
    <section>
      {status && <StatusSheet u={status.u} p={status.p} onClose={() => setStatus(null)} onConfirm={(months) => applyRole(status.u, status.newRole, months, status.p)} />}
      {sure && <ConfirmSheet title={tr.members.reject} body={tr.members.rejectConfirm(sure.name)} confirmLabel={tr.members.reject} danger onClose={() => setSure(null)} onConfirm={() => decide(sure, "reject", true)} />}
      <Fold foldKey="members.list" tag="h2" defaultOpen={false} title={tr.members.title} sum={users ? approved.length + pending.length : null}
        actions={!adding && <button className="btn primary" onClick={() => setAdding(true)}><PlusIcon width="18" height="18" />{tr.members.add}</button>}>

      {adding && (
        <form className="card form" onSubmit={create}>
          <label className="field">
            <span>{tr.members.name}</span>
            <input autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">
            <span>{tr.members.email}</span>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="field">
            <span>{tr.members.phone}</span>
            <input inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </label>
          <label className="field">
            <span>{tr.members.role}</span>
            <Select value={form.role} onChange={(v) => setForm({ ...form, role: v })} options={ROLE_OPTS} />
          </label>
          <div className="row end">
            <button type="button" className="btn ghost" onClick={() => setAdding(false)}>{tr.members.cancel}</button>
            <button className="btn primary" disabled={busy || !form.name.trim()}>{tr.members.create}</button>
          </div>
        </form>
      )}

      {!users && (loadErr ? <ErrorState message={loadErr} onRetry={load} /> : <Skeleton rows={3} />)}
      {users && approved.length === 0 && pending.length === 0 && <EmptyState title={tr.empty.members[0]} body={tr.empty.members[1]} />}
      {pending.length > 0 && (
        <div className="pending-block">
          <h3 className="pending-title">{tr.members.pendingTitle} <span className="chip accent">{pending.length}</span></h3>
          <ul className="list">
            {pending.map((u) => (
              <li key={u.id} className="card member pending">
                <div className="avatar" aria-hidden="true">{u.name.slice(0, 1).toLocaleUpperCase("tr")}</div>
                <div className="member-main">
                  <div className="member-name">{u.name}<span className="chip accent">{tr.members.pendingBadge}</span></div>
                  <div className="muted small">{tr.members.signedUp} {u.joined_month}{u.phone ? ` · ${u.phone}` : ""}{u.email ? ` · ${u.email}` : ""}</div>
                  <div className="row wrap actions">
                    <button className="btn sm good" onClick={() => decide(u, "approve")}>{tr.members.approve}</button>
                    <button className="btn sm danger" onClick={() => decide(u, "reject")}>{tr.members.reject}</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="list">
        {approved.map((u) => (
          <li key={u.id} className={"card member" + (u.active ? "" : " off")}>
            <div className="avatar" aria-hidden="true">{u.name.slice(0, 1).toLocaleUpperCase("tr")}</div>
            <div className="member-main">
              <div className="member-name">
                {u.name}
                {u.id === me.id && <span className="chip">{tr.members.you}</span>}
                {u.role === "admin" && <span className="chip accent">{tr.members.admin}</span>}
                {u.role === "listener" && <span className="chip">{tr.members.roleListener}</span>}
                {!u.active && <span className="chip">{tr.members.inactive}</span>}
              </div>
              <div className="muted small">{tr.members.since} {u.joined_month}{u.phone ? ` · ${u.phone}` : ""}{u.email ? ` · ${u.email}` : ""}</div>
              <div className="row wrap actions">
                {onDetail && <button className="btn sm" onClick={() => onDetail(u)}>{tr.admin.detail}</button>}
                {u.id !== me.id && (
                  <label className="field-inline">
                    <span className="muted small">{tr.members.role}</span>
                    <Select className="sm" ariaLabel={tr.members.role} value={u.active ? u.role : "inactive"} onChange={(v) => changeRole(u, v)} options={ROLE_OPTS_ROW} />
                  </label>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      </Fold>
      <div className={"toast" + (toast ? " show" : "")} role="status">{toast}</div>
    </section>
  );
}