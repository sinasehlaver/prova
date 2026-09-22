import React, { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { tr } from "./tr.js";
import { EmptyState, ErrorState, Skeleton } from "./States.jsx";
import Sheet from "./Sheet.jsx";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "./icons.jsx";

const EMPTY = { label_problem: "", label_resolved: "", icon: "" };

/** Admin: add / edit / reorder / delete alert kinds (delete only while a kind has no history). */
export default function AlertKinds() {
  const [kinds, setKinds] = useState(null);
  const [edit, setEdit] = useState(null); // { id?, ...fields }
  const [err, setErr] = useState("");
  const [toast, setToast] = useState("");
  const timer = useRef();
  const say = (m) => { setToast(m); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(""), 2200); };
  const fail = (e) => say(e.message || tr.err.generic);
  const [loadErr, setLoadErr] = useState("");
  const load = () => { setLoadErr(""); api("GET", "/alerts/kinds").then(setKinds, (e) => setLoadErr(e.message || tr.err.load)); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const move = async (i, d) => {
    const ids = kinds.map((k) => k.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    try { setKinds(await api("POST", "/alerts/kinds/reorder", { ids })); } catch (e) { fail(e); }
  };
  const save = async (e) => {
    e.preventDefault();
    setErr("");
    try {
      const { id, ...b } = edit;
      const k = id ? await api("PATCH", `/alerts/kinds/${id}`, b) : await api("POST", "/alerts/kinds", b);
      setKinds((ks) => (id ? ks.map((x) => (x.id === k.id ? k : x)) : [...ks, k]));
      setEdit(null);
      say(tr.kinds.saved);
    } catch (e2) { setErr(e2.message || tr.err.generic); }
  };
  const del = async () => {
    setErr("");
    try {
      await api("DELETE", `/alerts/kinds/${edit.id}`);
      setKinds((ks) => ks.filter((x) => x.id !== edit.id));
      setEdit(null);
      say(tr.kinds.deleted);
    } catch (e) { setErr(e.message || tr.err.generic); }
  };
  const set = (k) => (e) => setEdit({ ...edit, [k]: e.target.value });

  return (
    <section className="kinds-admin">
      <div className="page-head">
        <h2>{tr.kinds.title}</h2>
        <button className="btn primary" onClick={() => { setErr(""); setEdit(EMPTY); }}><PlusIcon width="18" height="18" />{tr.kinds.add}</button>
      </div>
      {!kinds && (loadErr ? <ErrorState message={loadErr} onRetry={load} /> : <Skeleton rows={2} />)}
      {kinds && !kinds.length && <EmptyState title={tr.empty.kinds[0]} body={tr.empty.kinds[1]} />}
      <ul className="list">
        {(kinds || []).map((k, i) => (
          <li key={k.id} className="card kind-row">
            <span className="alert-emoji" aria-hidden="true">{k.icon}</span>
            <div className="kind-row-main">
              <b>{k.label_problem}</b>
              <div className="muted small">{k.label_resolved}</div>
            </div>
            <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={tr.kinds.up}><ChevronLeftIcon style={{ transform: "rotate(90deg)" }} /></button>
            <button className="icon-btn" disabled={i === kinds.length - 1} onClick={() => move(i, 1)} aria-label={tr.kinds.down}><ChevronRightIcon style={{ transform: "rotate(90deg)" }} /></button>
            <button className="btn sm" onClick={() => { setErr(""); setEdit(k); }}>{tr.kinds.edit}</button>
          </li>
        ))}
      </ul>
      {edit && (
        <Sheet title={edit.id ? tr.kinds.editTitle : tr.kinds.add} onClose={() => setEdit(null)}>
          <form className="sheet-form" onSubmit={save}>
            <label className="field"><span>{tr.kinds.icon}</span><input data-autofocus required maxLength={8} value={edit.icon} onChange={set("icon")} /></label>
            <label className="field"><span>{tr.kinds.problem}</span><input required value={edit.label_problem} onChange={set("label_problem")} /></label>
            <label className="field"><span>{tr.kinds.resolved}</span><input required value={edit.label_resolved} onChange={set("label_resolved")} /></label>
            {err && <p className="notice bad" role="alert">{err}</p>}
            <div className="row end wrap sheet-actions">
              {edit.id && <button type="button" className="btn danger" onClick={del}>{tr.kinds.delete}</button>}
              <button type="button" className="btn ghost" onClick={() => setEdit(null)}>{tr.cal.cancel}</button>
              <button className="btn primary">{tr.kinds.save}</button>
            </div>
          </form>
        </Sheet>
      )}
      <div className={"toast" + (toast ? " show" : "")} role="status">{toast}</div>
    </section>
  );
}
