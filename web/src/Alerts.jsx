import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { tr } from "./tr.js";
import { EmptyState, ErrorState, Skeleton } from "./States.jsx";
import Sheet from "./Sheet.jsx";
import { ago, severity } from "./ago.js";
import { fmtShort, fmtTime } from "./time.js";

const SVG = (d) => (props) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{d}</svg>
);
const WarnIcon = SVG(<><path d="M12 4 2.8 19.5h18.4L12 4Z" /><path d="M12 10v4.5M12 17.3v.01" /></>);
const ClockIcon = SVG(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
const CheckIcon = SVG(<path d="m5 12.5 4.5 4.5L19 7.5" />);

const agoText = (ms) => tr.alerts.ago(ago(ms));

/** Open alerts, refreshed every 60s, on focus/visibility, and whenever any component calls the returned `changed()`. */
function useOpenAlerts() {
  const [open, setOpen] = useState(null);
  const load = useCallback(() => api("GET", "/alerts").then(setOpen, () => {}), []);
  useEffect(() => {
    load();
    const iv = setInterval(load, 60_000);
    const vis = () => document.visibilityState === "visible" && load();
    window.addEventListener("focus", load);
    window.addEventListener("prova:alerts", load);
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(iv);
      window.removeEventListener("focus", load);
      window.removeEventListener("prova:alerts", load);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [load]);
  return [open, () => window.dispatchEvent(new Event("prova:alerts"))];
}

/** Detail sheet for one open alert, opened by tapping its top-bar badge. Same resolve action as the old banner/tab. */
function AlertDetail({ alert: a, onClose, onResolved }) {
  const [busy, setBusy] = useState(false);
  const urgent = severity(a.raised_at) === "urgent";
  const Icon = urgent ? ClockIcon : WarnIcon;
  const close = async () => {
    setBusy(true);
    try { await api("POST", `/alerts/${a.id}/close`); onResolved(); } catch {} finally { setBusy(false); }
  };
  return (
    <Sheet title={a.label_problem} onClose={onClose}>
      <div className={"alert-detail " + (urgent ? "urgent" : "warn")}>
        <span className="alert-emoji" aria-hidden="true">{a.icon}</span>
        <div className="alert-text">
          <span className="alert-meta">
            <Icon width="14" height="14" />
            {urgent && <strong>{tr.alerts.longOpen} · </strong>}
            {tr.alerts.raisedAgo(a.raised_by_name, agoText(a.raised_at))}
          </span>
        </div>
      </div>
      <div className="sheet-actions row end">
        <button className="btn good" onClick={close} disabled={busy}>
          <CheckIcon />{a.label_resolved}
        </button>
      </div>
    </Sheet>
  );
}

/** Compact icon-only badges in the top bar, next to the brand heading — replaces the old full-width sticky
 * banner so open alerts stop eating vertical space. One badge per open alert (amber; red border after >48h),
 * no visible text until tapped; tapping opens AlertDetail with the same resolve action. The full scrollable
 * history/raise UI still lives on the "Uyarılar" tab (default export below). */
export function AlertBadges() {
  const [open, changed] = useOpenAlerts();
  const [selId, setSelId] = useState(null);
  useEffect(() => {
    if (selId != null && open && !open.some((a) => a.id === selId)) setSelId(null);
  }, [open, selId]);
  if (!open?.length) return null;
  const sel = open.find((a) => a.id === selId);
  return (
    <>
      <div className="alert-badges" role="group" aria-label={tr.alerts.bannerLabel}>
        {open.map((a) => {
          const urgent = severity(a.raised_at) === "urgent";
          return (
            <button
              key={a.id}
              type="button"
              className={"alert-badge " + (urgent ? "urgent" : "warn")}
              onClick={() => setSelId(a.id)}
              aria-label={tr.alerts.badgeLabel(a.label_problem, urgent, tr.alerts.raisedAgo(a.raised_by_name, agoText(a.raised_at)))}
            >
              <span aria-hidden="true">{a.icon}</span>
            </button>
          );
        })}
      </div>
      {sel && <AlertDetail alert={sel} onClose={() => setSelId(null)} onResolved={() => { changed(); setSelId(null); }} />}
    </>
  );
}

const PAGE = 20;

export default function Alerts() {
  const [kinds, setKinds] = useState(null);
  const [open, changed] = useOpenAlerts();
  const [hist, setHist] = useState([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(0);
  const [toast, setToast] = useState("");
  const timer = useRef();
  const say = (m) => { setToast(m); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(""), 2200); };
  const fail = (e) => say(e.message || tr.err.generic);

  const loadHist = useCallback(async (before) => {
    const rows = await api("GET", `/alerts/history?limit=${PAGE}` + (before ? `&before=${before}` : ""));
    setHist((h) => (before ? [...h, ...rows] : rows));
    setMore(rows.length === PAGE);
  }, []);
  const [kindsErr, setKindsErr] = useState("");
  const [histErr, setHistErr] = useState(false);
  const loadKinds = useCallback(() => {
    setKindsErr("");
    api("GET", "/alerts/kinds").then(setKinds, (e) => setKindsErr(e.message || tr.err.load));
  }, []);
  const loadFirst = useCallback(() => { setHistErr(false); loadHist().catch(() => setHistErr(true)); }, [loadHist]);
  useEffect(() => {
    loadKinds();
    loadFirst();
    // history follows open-alert changes (raise/close from here or the banner)
    const reload = () => loadHist().catch(() => {});
    window.addEventListener("prova:alerts", reload);
    return () => window.removeEventListener("prova:alerts", reload);
  }, [loadHist]); // eslint-disable-line react-hooks/exhaustive-deps

  const raise = async (k) => {
    setBusy(k.id);
    try {
      const r = await fetch("/api/alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind_id: k.id }) });
      const a = await r.json();
      if (!r.ok) throw new Error(a.error);
      say(r.status === 201 ? tr.alerts.raised : tr.alerts.already(a.raised_by_name));
      changed();
    } catch (e) { fail(e); } finally { setBusy(0); }
  };
  const openOf = (k) => open?.find((a) => a.kind_id === k.id);

  return (
    <section>
      <div className="page-head"><h2>{tr.alerts.title}</h2></div>
      <p className="muted">{tr.alerts.hint}</p>
      {!kinds && (kindsErr ? <ErrorState message={kindsErr} onRetry={loadKinds} /> : <Skeleton rows={4} />)}
      {kinds && !kinds.length && <EmptyState title={tr.empty.alertsNoKinds[0]} body={tr.empty.alertsNoKinds[1]} />}
      <div className="kind-grid">
        {(kinds || []).map((k) => {
          const a = openOf(k);
          return (
            <button key={k.id} className={"kind-btn" + (a ? " open" : "")} onClick={() => raise(k)} disabled={busy === k.id}>
              <span className="kind-emoji" aria-hidden="true">{k.icon}</span>
              <span className="kind-label">{k.label_problem}</span>
              <span className="kind-state">
                {a ? <><WarnIcon width="14" height="14" />{tr.alerts.raisedAgo(a.raised_by_name, agoText(a.raised_at))}</> : tr.alerts.tap}
              </span>
            </button>
          );
        })}
      </div>

      <h3 className="sect">{tr.alerts.history}</h3>
      {histErr && hist.length === 0 && <ErrorState onRetry={loadFirst} />}
      {open && !histErr && hist.length === 0 && <EmptyState title={tr.empty.history[0]} body={tr.empty.history[1]} />}
      <ul className="list">
        {hist.map((a) => (
          <li key={a.id} className="card hist">
            <span className="alert-emoji" aria-hidden="true">{a.icon}</span>
            <div className="hist-main">
              <b>{a.label_problem}</b>
              <div className="muted small">{tr.alerts.by(a.raised_by_name, `${fmtShort(a.raised_at)} ${fmtTime(a.raised_at)}`)}</div>
              {a.closed_at ? (
                <div className="small hist-done"><CheckIcon width="14" height="14" />{tr.alerts.doneBy(a.closed_by_name, `${fmtShort(a.closed_at)} ${fmtTime(a.closed_at)}`)}</div>
              ) : (
                <div className="small hist-open"><WarnIcon width="14" height="14" />{tr.alerts.stillOpen}</div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {more && <div className="row end"><button className="btn ghost" onClick={() => loadHist(hist[hist.length - 1].id).catch(fail)}>{tr.alerts.more}</button></div>}
      <div className={"toast" + (toast ? " show" : "")} role="status">{toast}</div>
    </section>
  );
}
