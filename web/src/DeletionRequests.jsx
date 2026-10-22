import React, { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { tr } from "./tr.js";
import { EmptyState, ErrorState, Skeleton } from "./States.jsx";
import usePoll from "./usePoll.js";

export const DELREQ_EVENT = "prova:delreq-changed";
const fmt = (ms) => new Intl.DateTimeFormat("tr-TR", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Istanbul" }).format(ms);

/** Admin-only count of pending past-reservation deletion requests (30 s poll + visibility + DELREQ_EVENT), like useReceiptCount. */
export function useRequestCount(enabled) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) { setN(0); return; }
    let live = true;
    const load = () => api("GET", "/deletion-requests/count").then((r) => { if (live) setN(r.count | 0); }, () => {});
    const tick = () => document.visibilityState === "visible" && load();
    load();
    const iv = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener(DELREQ_EVENT, load);
    return () => { live = false; clearInterval(iv); document.removeEventListener("visibilitychange", tick); window.removeEventListener(DELREQ_EVENT, load); };
  }, [enabled]);
  return n;
}

/** Admin section "İstekler": pending requests to delete a member's past reservation. Approve cancels it (unpaid charge voided). */
export default function DeletionRequests() {
  const T = tr.delReq;
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api("GET", "/deletion-requests").then((r) => { setRows(r); setErr(""); }, (e) => setErr(e.message || tr.err.generic)), []);
  useEffect(() => { load(); }, [load]);
  usePoll((ok) => api("GET", "/deletion-requests").then((r) => { if (ok()) setRows(r); }));
  const act = async (id, verb) => {
    setBusy(true);
    try { await api("POST", `/deletion-requests/${id}/${verb}`); window.dispatchEvent(new Event(DELREQ_EVENT)); await load(); }
    catch (e) { setErr(e.message || tr.err.generic); load(); } finally { setBusy(false); }
  };
  if (err && !rows) return <ErrorState message={err} onRetry={load} />;
  if (!rows) return <Skeleton rows={3} />;
  return (
    <section>
      <div className="page-head"><h2>{T.title}</h2></div>
      {err && <div className="notice" role="alert">{err}</div>}
      {!rows.length && <EmptyState title={T.empty[0]} body={T.empty[1]} />}
      {rows.length > 0 && (
        <div className="card">
          <ul className="plain-list">
            {rows.map((d) => (
              <li key={d.id}>
                <span>
                  <b>{d.requester_name}</b> · {fmt(d.start_ms)}{d.note ? ` · ${d.note}` : ""}
                  {d.reason && <><br /><span className="muted small">{T.reason}: {d.reason}</span></>}
                </span>
                <span>
                  <button className="btn sm danger solid" disabled={busy} onClick={() => act(d.id, "approve")}>{T.approve}</button>{" "}
                  <button className="btn sm" disabled={busy} onClick={() => act(d.id, "reject")}>{T.reject}</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
