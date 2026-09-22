import React, { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { tr } from "./tr.js";
import { EmptyState, ErrorState, Skeleton } from "./States.jsx";
import { PlusIcon } from "./icons.jsx";

export default function Members({ me, onDetail }) {
  const [users, setUsers] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", role: "member" });
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
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
      await api("POST", "/users", form);
      setForm({ name: "", phone: "", role: "member" });
      setAdding(false);
      say(tr.members.created);
      load();
    } catch (err) { fail(err); } finally { setBusy(false); }
  };
  // own token only (the server keeps this browser logged in); the list no longer carries anyone's invite token
  const regen = async (u) => {
    if (!confirm(tr.members.regenSelfConfirm)) return;
    try { await api("POST", `/users/${u.id}/regenerate-invite`); say(tr.members.regenerated); } catch (e) { fail(e); }
  };
  const decide = async (u, action) => {
    if (action === "reject" && !confirm(tr.members.rejectConfirm(u.name))) return;
    try {
      await api("POST", `/users/${u.id}/${action}`);
      say(action === "approve" ? tr.members.approved : tr.members.rejected);
      load();
      window.dispatchEvent(new Event("prova:users")); // refreshes the admin tab's pending-count bubble
    } catch (e) { fail(e); }
  };
  const toggle = async (u) => {
    try { replace(await api("PATCH", `/users/${u.id}`, { active: !u.active })); } catch (e) { fail(e); }
  };

  return (
    <section>
      <div className="page-head">
        <h2>{tr.members.title}</h2>
        {!adding && <button className="btn primary" onClick={() => setAdding(true)}><PlusIcon width="18" height="18" />{tr.members.add}</button>}
      </div>

      {adding && (
        <form className="card form" onSubmit={create}>
          <label className="field">
            <span>{tr.members.name}</span>
            <input autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">
            <span>{tr.members.phone}</span>
            <input inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={form.role === "admin"} onChange={(e) => setForm({ ...form, role: e.target.checked ? "admin" : "member" })} />
            <span>{tr.members.makeAdmin}</span>
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
                  <div className="muted small">{tr.members.signedUp} {u.joined_month}{u.phone ? ` · ${u.phone}` : ""}</div>
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
                {!u.active && <span className="chip">{tr.members.inactive}</span>}
              </div>
              <div className="muted small">{tr.members.since} {u.joined_month}{u.phone ? ` · ${u.phone}` : ""}</div>
              <div className="row wrap actions">
                {onDetail && <button className="btn sm" onClick={() => onDetail(u)}>{tr.admin.detail}</button>}
                {u.id === me.id && <button className="btn sm ghost" onClick={() => regen(u)}>{tr.members.regenSelf}</button>}
                {u.id !== me.id && (
                  <button className="btn sm ghost" onClick={() => toggle(u)}>{u.active ? tr.members.deactivate : tr.members.activate}</button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <div className={"toast" + (toast ? " show" : "")} role="status">{toast}</div>
    </section>
  );
}
