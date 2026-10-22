import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import { tr } from "./tr.js";
import { fmtTRY } from "./Billing.jsx";
import { NewSheet } from "./Calendar.jsx";
import { ChevronRightIcon } from "./icons.jsx";
import Sheet from "./Sheet.jsx";
import { EmptyState, ErrorState, Skeleton } from "./States.jsx";
import { D, EDIT_CUTOFF_MS, H, dayStart } from "./time.js";

const TZ = "Europe/Istanbul";
const fmt = (ms) => new Intl.DateTimeFormat("tr-TR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(ms);
const hh = (ms) => new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(ms);
const monthLabel = (m) => new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric", timeZone: TZ }).format(Date.parse(`${m}-15T12:00:00+03:00`));
const sum = (rows, k) => rows.reduce((a, r) => a + (r.cancelled_at ? 0 : r[k] || 0), 0);

function Totals({ rows, label }) {
  const T = tr.myRes;
  return (
    <span className="mr-totals">
      {label && <b>{label}</b>}
      <span className="pill ok">{T.paidOf(fmtTRY(sum(rows, "paid_try")))}</span>
      <span className="pill warn">{T.unpaidOf(fmtTRY(sum(rows, "unpaid_try")))}</span>
    </span>
  );
}

/** The signed-in user's own reservations (all roles), grouped by month (newest first, collapsed by default) with paid / unpaid totals.
 *  Upcoming ones can be edited (reuses Calendar's NewSheet in edit mode) or cancelled inline. */
export default function MyReservations() {
  const T = tr.myRes;
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [sure, setSure] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [edit, setEdit] = useState(null); // { r, maxPeople, minDay, holds }
  const [toast, setToast] = useState("");
  const [ask, setAsk] = useState(null); // { r, reason } past-reservation deletion request
  const sendAsk = async () => {
    setBusy(true);
    try { await api("POST", `/reservations/${ask.r.id}/deletion-request`, { reason: ask.reason }); setAsk(null); setToast(T.delSent); setTimeout(() => setToast(""), 2500); await load(); }
    catch (e) { setErr(e.message || tr.err.generic); setAsk(null); load(); } finally { setBusy(false); }
  };
  const load = useCallback(() => api("GET", "/reservations/mine").then((r) => { setRows(r); setErr(""); }, (e) => setErr(e.message || tr.err.generic)), []);
  useEffect(() => { load(); }, [load]);

  const cancel = async (id) => {
    setBusy(true);
    try { await api("DELETE", `/reservations/${id}`); setSure(null); await load(); }
    catch (e) { setErr(e.message || tr.err.generic); } finally { setBusy(false); }
  };
  const startEdit = async (r) => {
    try {
      const [cfg, holds] = await Promise.all([api("GET", "/reservations/config"), api("GET", "/holds")]);
      setEdit({ r, maxPeople: cfg.max_people, minDay: dayStart(cfg.earliest_ms), holds });
    } catch (e) { setErr(e.message || tr.err.generic); }
  };
  const done = (msg) => { if (msg) { setEdit(null); setToast(msg); setTimeout(() => setToast(""), 2500); } load(); };

  const groups = useMemo(() => {
    const m = new Map();
    for (const r of rows || []) { if (!m.has(r.month)) m.set(r.month, []); m.get(r.month).push(r); }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [rows]);

  if (err && !rows) return <ErrorState message={err} onRetry={load} />;
  if (!rows) return <Skeleton rows={4} />;
  const now = Date.now();
  const toggle = (m) => setOpen((o) => { const n = new Set(o); if (n.has(m)) n.delete(m); else n.add(m); return n; });
  const item = (r) => {
    const can = !r.cancelled_at && r.start_ms - EDIT_CUTOFF_MS >= now;
    const locked = !r.cancelled_at && !can && r.start_ms > now;
    return (
      <li key={r.id} className={r.cancelled_at ? "gone" : ""}>
        <span>
          {fmt(r.start_ms)}–{hh(r.end_ms)}{r.note ? ` · ${r.note}` : ""} · {tr.cal.peopleCount(r.people)}{r.cancelled_at ? ` (${T.cancelled})` : ""}
          {can && (sure === r.id ? (
            <> <button className="btn sm danger solid" disabled={busy} onClick={() => cancel(r.id)}>{tr.cal.cancelYes}</button> <button className="btn sm" onClick={() => setSure(null)}>{tr.cal.cancel}</button></>
          ) : (
            <> <button className="btn sm" onClick={() => startEdit(r)}>{T.edit}</button> <button className="btn sm danger" onClick={() => setSure(r.id)}>{tr.cal.cancelBooking}</button></>
          ))}
          {!r.cancelled_at && r.start_ms <= now && (r.del_req === "pending"
            ? <> <span className="pill warn">{T.delPending}</span></>
            : <> {r.del_req === "rejected" && <span className="muted small">{T.delRejected} </span>}<button className="btn sm" onClick={() => setAsk({ r, reason: "" })}>{T.delAsk}</button></>)}
          {locked && <> <span className="muted small">{tr.cal.locked}</span></>}
        </span>
        <span className="num">{fmtTRY(r.charge_try ?? 0)}</span>
      </li>
    );
  };
  return (
    <section>
      <div className="page-head"><h2>{T.title}</h2></div>
      {err && <div className="notice" role="alert">{err}</div>}
      {!rows.length && <EmptyState title={T.empty[0]} body={T.empty[1]} />}
      {rows.length > 0 && <div className="card mr-grand"><Totals rows={rows} label={T.total} /></div>}
      {groups.map(([m, list]) => (
        <div key={m} className={"card mr-month" + (open.has(m) ? " open" : "")}>
          <button className="mr-head" aria-expanded={open.has(m)} onClick={() => toggle(m)}>
            <ChevronRightIcon className="mr-chev" aria-hidden="true" />
            <span className="mr-title">{monthLabel(m)} <span className="muted small">· {T.count(list.filter((r) => !r.cancelled_at).length)}</span></span>
            <Totals rows={list} />
          </button>
          {open.has(m) && <ul className="plain-list">{list.map(item)}</ul>}
        </div>
      ))}
      {edit && (
        <NewSheet edit={edit.r} day={dayStart(edit.r.start_ms)} hour={Math.round((edit.r.start_ms - dayStart(edit.r.start_ms)) / H)}
          hours={Math.round((edit.r.end_ms - edit.r.start_ms) / H)} res={[]} holds={edit.holds} now={now} maxPeople={edit.maxPeople}
          minDay={edit.minDay} maxDay={dayStart(now + 365 * D)} covers={() => false} onClose={() => setEdit(null)} onDone={done} />
      )}
      {ask && (
        <Sheet title={T.delTitle} onClose={() => setAsk(null)}>
          <p className="muted">{T.delHint}</p>
          <p><b>{fmt(ask.r.start_ms)}–{hh(ask.r.end_ms)}</b></p>
          <label className="field"><span>{T.delReason}</span>
            <textarea data-autofocus rows={3} maxLength={300} value={ask.reason} onChange={(e) => setAsk({ ...ask, reason: e.target.value })} />
          </label>
          <div className="actions"><button className="btn" onClick={() => setAsk(null)}>{tr.cal.cancel}</button> <button className="btn primary" disabled={busy} onClick={sendAsk}>{T.delSend}</button></div>
        </Sheet>
      )}
      <div className={"toast" + (toast ? " show" : "")} role="status">{toast}</div>
    </section>
  );
}
