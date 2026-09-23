import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { tr } from "./tr.js";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "./icons.jsx";
import Sheet from "./Sheet.jsx";
import { ErrorState, Skeleton } from "./States.jsx";
import { D, H, dayStart, fmtDay, fmtLong, fmtShort, fmtTime, fmtWd, hourLabel, weekStart } from "./time.js";

// ponytail: fixed 08:00-24:00 window in the UI (API accepts any whole hour). Make it a setting if a room runs earlier.
const FROM = 8, TO = 24;
const WEEKS = 8; // load window; the day strip and both navigations stay inside it
const VIEW_KEY = "prova.calview";
const POLL_MS = 12_000; // bookings + soft holds refresh

const useWide = () => {
  const q = "(min-width: 900px)";
  const [w, setW] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q), on = () => setW(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return w;
};

// Shared by Grid (drag span clamping) and NewSheet (start-hour options): true if the whole hour [h, h+1) on day d is
// bookable (not past, not covered by a live reservation or someone else's soft hold).
const isFreeHour = (res, holds, now, d, h) => d + h * H > now
  && !res.some((r) => r.start_ms < d + (h + 1) * H && r.end_ms > d + h * H)
  && !holds.some((k) => k.start_ms < d + (h + 1) * H && k.end_ms > d + h * H);

// Touch: a short hold-and-still arms drag mode (so a plain vertical swipe still scrolls the page); mouse arms instantly.
const TOUCH_ARM_MS = 220, MOVE_CANCEL_PX = 10;

/** Hour grid for 1 day (phone) or 7 days (wide). Booked blocks span rows; free slots are buttons.
 *  onSelect(day, hour, hours) fires for both a plain tap/click (hours=1) and a drag spanning multiple free hours. */
// readOnly (bootstrap/observer admin): free hours render as plain "Boş" cells, not selectable.
function Grid({ days, res, holds, now, meId, maxHours, onSelect, onRes, readOnly = false }) {
  const multi = days.length > 1;
  const cells = [];
  const [drag, setDrag] = useState(null); // { day, h0, hours } — visual span while a drag is in progress
  const dragRef = useRef(null); // { day, startH, curH, pointerId, armed } authoritative state for the pointer handlers
  const draggedRef = useRef(false); // did the span actually change while armed? (vs. a plain tap/long-press)
  const suppressClickRef = useRef(false); // swallow the synthetic click that follows a real drag's pointerup
  const armTimerRef = useRef(null);

  const cellAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const slot = el?.closest?.(".slot[data-day][data-hour]");
    if (!slot || slot.disabled) return null;
    return { day: Number(slot.dataset.day), hour: Number(slot.dataset.hour) };
  };
  const span = (day, startH, curH) => {
    if (curH === startH) return { h0: startH, hours: 1 };
    if (curH > startH) {
      let n = 1;
      for (let h = startH + 1; h < TO && h <= curH && n < maxHours; h++) {
        if (!isFreeHour(res, holds, now, day, h)) break;
        n++;
      }
      return { h0: startH, hours: n };
    }
    let n = 1, h0 = startH;
    for (let h = startH - 1; h >= FROM && h >= curH && n < maxHours; h--) {
      if (!isFreeHour(res, holds, now, day, h)) break;
      h0 = h; n++;
    }
    return { h0, hours: n };
  };
  const arm = (e, day, startH) => {
    dragRef.current = { day, startH, curH: startH, pointerId: e.pointerId, armed: true };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ day, h0: startH, hours: 1 });
  };
  const onDown = (e, day, hour) => {
    if (e.button != null && e.button !== 0) return; // ignore right/middle click
    clearTimeout(armTimerRef.current);
    draggedRef.current = false;
    if (e.pointerType === "touch") {
      const x0 = e.clientX, y0 = e.clientY;
      dragRef.current = { day, startH: hour, curH: hour, pointerId: e.pointerId, armed: false, x0, y0 };
      armTimerRef.current = setTimeout(() => { if (dragRef.current?.pointerId === e.pointerId) arm(e, day, hour); }, TOUCH_ARM_MS);
    } else {
      arm(e, day, hour);
    }
  };
  const onMove = (e) => {
    const st = dragRef.current;
    if (!st || e.pointerId !== st.pointerId) return;
    if (!st.armed) {
      if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) > MOVE_CANCEL_PX) { clearTimeout(armTimerRef.current); dragRef.current = null; }
      return; // let the browser scroll — never armed, never captured
    }
    e.preventDefault();
    const hit = cellAt(e.clientX, e.clientY);
    if (!hit || hit.day !== st.day || hit.hour === st.curH) return;
    st.curH = hit.hour;
    draggedRef.current = true;
    setDrag({ day: st.day, ...span(st.day, st.startH, st.curH) });
  };
  const onUp = (e) => {
    clearTimeout(armTimerRef.current);
    const st = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!st || !st.armed || !draggedRef.current) return; // plain tap/long-press: let the native click open a 1h sheet
    suppressClickRef.current = true;
    const { h0, hours } = span(st.day, st.startH, st.curH);
    onSelect(st.day, h0, hours);
  };
  const onClickSlot = (day, hour) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    onSelect(day, hour, 1);
  };
  days.forEach((d, ci) => {
    const col = ci + 2, winS = d + FROM * H, winE = d + TO * H;
    const covered = new Set();
    for (const r of res) {
      const s = Math.max(r.start_ms, winS), e = Math.min(r.end_ms, winE);
      if (s >= e) continue;
      const row = (s - winS) / H + 2, n = (e - s) / H;
      for (let i = 0; i < n; i++) covered.add(row + i);
      cells.push(
        <button key={`r${r.id}-${d}`} className={"res" + (r.booker_id === meId ? " mine" : "")} style={{ gridColumn: col, gridRow: `${row} / span ${n}` }}
          onClick={() => onRes(r)} aria-label={`${r.booker_name}, ${fmtTime(r.start_ms)} – ${fmtTime(r.end_ms)}`}>
          <span className="res-name">{r.booker_name}</span>
          <span className="res-time num">{fmtTime(r.start_ms)} – {fmtTime(r.end_ms)}</span>
          {r.note && n > 1 && <span className="res-note">{r.note}</span>}
          {r.booker_id === meId && <span className="res-mine">{tr.cal.mine}</span>}
        </button>
      );
    }
    // soft holds of OTHER members ("X is choosing these hours"): not booked yet, but not selectable either
    for (const k of holds) {
      const s = Math.max(k.start_ms, winS), e = Math.min(k.end_ms, winE);
      if (s >= e) continue;
      const row = (s - winS) / H + 2, n = (e - s) / H;
      for (let i = 0; i < n; i++) covered.add(row + i);
      cells.push(
        <div key={`h${k.id}-${d}`} className="held" style={{ gridColumn: col, gridRow: `${row} / span ${n}` }}
          aria-label={`${tr.cal.held}: ${tr.cal.heldBy(k.user_name)}, ${fmtTime(k.start_ms)} – ${fmtTime(k.end_ms)}`}>
          <span className="held-title">{tr.cal.held}</span>
          <span className="held-by">{tr.cal.heldBy(k.user_name)}</span>
        </div>
      );
    }
    for (let h = FROM; h < TO; h++) {
      const row = h - FROM + 2;
      if (covered.has(row)) continue;
      const past = d + h * H <= now;
      const inDrag = drag && drag.day === d && h >= drag.h0 && h < drag.h0 + drag.hours;
      if (readOnly) {
        cells.push(
          <div key={`f${d}-${h}`} className="slot ro" style={{ gridColumn: col, gridRow: row }} aria-label={`${fmtLong(d)} ${hourLabel(h)} ${past ? tr.cal.pastSlot : tr.cal.free}`}>
            {!past && !multi && <span className="slot-label">{tr.cal.free}</span>}
          </div>
        );
        continue;
      }
      cells.push(
        <button key={`f${d}-${h}`} className={"slot" + (inDrag ? " dragging" : "")} style={{ gridColumn: col, gridRow: row }} disabled={past}
          data-day={d} data-hour={h}
          onPointerDown={(e) => onDown(e, d, h)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onClick={() => onClickSlot(d, h)} aria-label={`${fmtLong(d)} ${hourLabel(h)} ${past ? tr.cal.pastSlot : tr.cal.free}`}>
          {!past && <span className="slot-label">{multi ? <PlusIcon width="16" height="16" /> : tr.cal.free}</span>}
        </button>
      );
    }
  });
  return (
    <div className={"cal-grid " + (multi ? "cal-week" : "cal-day")} style={{ "--cols": days.length }}>
      {multi && days.map((d, i) => (
        <div key={d} className={"cal-head" + (dayStart(now) === d ? " today" : "")} style={{ gridColumn: i + 2, gridRow: 1 }}>
          <span>{fmtWd(d)}</span><b className="num">{fmtDay(d)}</b>
        </div>
      ))}
      {Array.from({ length: TO - FROM }, (_, i) => (
        <div key={i} className="cal-hour num" style={{ gridColumn: 1, gridRow: i + 2 }}>{hourLabel(FROM + i)}</div>
      ))}
      {cells}
    </div>
  );
}

const HOLD_REFRESH_MS = 45_000; // server TTL is ~2 min: keep the hold alive while the sheet stays open

function NewSheet({ day, hour, hours: initialHours, res, holds, now, maxHours, maxPeople, onClose, onDone }) {
  const [h0, setH0] = useState(hour);
  const [hours, setHours] = useState(Number.isInteger(initialHours) && initialHours >= 1 ? initialHours : 1);
  const [note, setNote] = useState("");
  const [people, setPeople] = useState(1);
  const [err, setErr] = useState("");
  const [holdErr, setHoldErr] = useState(""); // someone else got these hours first (409 on the hold)
  const [busy, setBusy] = useState(false);
  const closed = useRef(false);

  const free = (h) => isFreeHour(res, holds, now, day, h);
  const starts = useMemo(() => Array.from({ length: TO - FROM }, (_, i) => FROM + i).filter(free), [res, holds, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const room = (h) => { let n = 0; while (n < maxHours && h + n < TO && free(h + n)) n++; return n; };
  const start = starts.includes(h0) ? h0 : starts[0];
  const fit = Math.min(hours, room(start) || 1);

  // Soft hold on the picked hours while the sheet is open (others see "Rezerve ediliyor"); re-sent on every change and
  // every 45 s; released on close. A 409 means another member holds/booked them first -> friendly message + grid refresh.
  useEffect(() => {
    if (start === undefined) return;
    let stop = false;
    const put = () => api("POST", "/holds", { start_ms: day + start * H, hours: fit }).then(
      () => { if (closed.current) api("DELETE", "/holds").catch(() => {}); else if (!stop) setHoldErr(""); },
      (x) => { if (!stop) { setHoldErr(x.message || tr.err.generic); if (x.status === 409) onDone(null); } }
    );
    put();
    const t = setInterval(put, HOLD_REFRESH_MS);
    return () => { stop = true; clearInterval(t); };
  }, [day, start, fit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const drop = () => fetch("/api/holds", { method: "DELETE", keepalive: true }).catch(() => {});
    window.addEventListener("pagehide", drop);
    return () => { closed.current = true; window.removeEventListener("pagehide", drop); api("DELETE", "/holds").catch(() => {}); };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await api("POST", "/reservations", { start_ms: day + start * H, hours: fit, note, people });
      onDone(tr.cal.booked);
    } catch (x) { setErr(x.message || tr.err.generic); onDone(null); } finally { setBusy(false); }
  };

  return (
    <Sheet title={tr.cal.newTitle} onClose={onClose}>
      {starts.length === 0 ? <p className="muted">{tr.cal.noFree}</p> : (
        <form className="sheet-form" onSubmit={submit}>
          <p className="sheet-sub">{fmtLong(day)}</p>
          <label className="field">
            <span>{tr.cal.start}</span>
            <select data-autofocus value={start} onChange={(e) => setH0(Number(e.target.value))}>
              {starts.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </label>
          <div className="field" role="radiogroup" aria-label={tr.cal.duration}>
            <span>{tr.cal.duration}</span>
            <div className="seg">
              {Array.from({ length: maxHours }, (_, i) => i + 1).map((n) => (
                <button type="button" key={n} role="radio" aria-checked={fit === n} disabled={n > room(start)} onClick={() => setHours(n)}>
                  {tr.cal.hours(n)}
                </button>
              ))}
            </div>
            <span className="muted small num">{fmtTime(day + start * H)} – {fmtTime(day + (start + fit) * H)}</span>
          </div>
          <label className="field">
            <span>{tr.cal.note}</span>
            <input value={note} maxLength={200} placeholder={tr.cal.notePh} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="field" role="group" aria-label={tr.cal.people}>
            <span>{tr.cal.people}</span>
            <div className="seg stepper">
              <button type="button" aria-label={tr.cal.fewer} disabled={people <= 1} onClick={() => setPeople(people - 1)}>−</button>
              <output className="num" aria-live="polite">{people}</output>
              <button type="button" aria-label={tr.cal.more} disabled={people >= maxPeople} onClick={() => setPeople(people + 1)}>+</button>
            </div>
            <span className="muted small">{tr.cal.peopleHint}</span>
          </div>
          {(err || holdErr) && <p className="notice bad" role="alert">{err || holdErr}</p>}
          <div className="row end">
            <button type="button" className="btn ghost" onClick={onClose}>{tr.cal.cancel}</button>
            <button className="btn primary" disabled={busy || !!holdErr}>{tr.cal.submit}</button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

// Same folding as server/lib/reservations.mjs firstName(): lower-case, ı->i, no diacritics.
const fold = (s) => String(s ?? "").trim().split(/\s+/)[0].toLocaleLowerCase("tr").replace(/ı/g, "i").normalize("NFD").replace(/[̀-ͯ]/g, "");
const MIN_REASON = 5;

function ViewSheet({ r, now, me, onClose, onDone }) {
  const [sure, setSure] = useState(false);
  const [danger, setDanger] = useState(false); // admin acting on someone else's booking: hard gate
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const own = r.booker_id === me.id;
  const can = r.start_ms > now && (own || me.role === "admin");
  const first = r.booker_name.trim().split(/\s+/)[0];
  const armed = fold(typed) === fold(r.booker_name) && reason.trim().length >= MIN_REASON;
  const cancel = async () => {
    setBusy(true); setErr("");
    try {
      await api("DELETE", `/reservations/${r.id}`, own ? undefined : { confirm: typed.trim(), reason: reason.trim() });
      onDone(tr.cal.cancelled);
    } catch (x) { setErr(x.message || tr.err.generic); setBusy(false); }
  };
  return (
    <Sheet title={r.booker_name} onClose={onClose}>
      <p className="sheet-sub">{fmtLong(r.start_ms)}</p>
      <p className="view-time num">{tr.cal.range(fmtTime(r.start_ms), fmtTime(r.end_ms))} <span className="muted">· {tr.cal.hours((r.end_ms - r.start_ms) / H)}</span></p>
      {r.note && <p>{r.note}</p>}
      <p className="muted small">{tr.cal.peopleCount(r.people)}</p>
      {err && <p className="notice bad" role="alert">{err}</p>}
      {can && !own && danger && (
        <form className="danger-zone" role="alertdialog" aria-labelledby="dz-title" onSubmit={(e) => { e.preventDefault(); if (armed && !busy) cancel(); }}>
          <h3 id="dz-title">{tr.cal.dangerTitle}</h3>
          <p>{tr.cal.dangerBody(r.booker_name)}</p>
          <p className="danger-what num"><b>{r.booker_name}</b> · {fmtLong(r.start_ms)}, {tr.cal.range(fmtTime(r.start_ms), fmtTime(r.end_ms))}</p>
          <label className="field">
            <span>{tr.cal.dangerConfirm(first)}</span>
            <input data-autofocus value={typed} autoComplete="off" autoCapitalize="off" spellCheck="false" onChange={(e) => setTyped(e.target.value)} />
          </label>
          <label className="field">
            <span>{tr.cal.dangerReason}</span>
            <input value={reason} maxLength={300} placeholder={tr.cal.dangerReasonPh} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row end wrap">
            <button type="button" className="btn ghost" onClick={() => { setDanger(false); setTyped(""); setReason(""); }} disabled={busy}>{tr.cal.cancel}</button>
            <button className="btn danger solid" disabled={!armed || busy}>{tr.cal.dangerGo}</button>
          </div>
        </form>
      )}
      {can && !(danger && !own) && (
        <div className="row end wrap sheet-actions">
          {!own ? <button className="btn danger" onClick={() => setDanger(true)}>{tr.cal.adminCancel}</button>
          : !sure ? <button className="btn danger" onClick={() => setSure(true)}>{tr.cal.cancelBooking}</button> : (
            <>
              <span className="muted small">{tr.cal.cancelSure}</span>
              <button className="btn ghost" onClick={() => setSure(false)} disabled={busy}>{tr.cal.cancel}</button>
              <button className="btn danger" onClick={cancel} disabled={busy} data-autofocus>{tr.cal.cancelYes}</button>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

export default function Calendar({ me }) {
  const wide = useWide();
  const [now, setNow] = useState(Date.now());
  const today = dayStart(now);
  const [sel, setSel] = useState(today); // anchor day: the shown day (Gün) or any day of the shown week (Hafta)
  const [pref, setPref] = useState(() => { try { const v = localStorage.getItem(VIEW_KEY); return v === "day" || v === "week" ? v : null; } catch { return null; } });
  const [res, setRes] = useState(null); // null = loading
  const [holds, setHolds] = useState([]); // other members' live soft holds
  const [loadErr, setLoadErr] = useState("");
  const [maxHours, setMaxHours] = useState(4);
  const [maxPeople, setMaxPeople] = useState(20);
  const [sheet, setSheet] = useState(null);
  const [toast, setToast] = useState("");
  const timer = useRef();
  const stripRef = useRef();

  const from = weekStart(dayStart(Date.now()));
  const load = useCallback(
    (quiet) => api("GET", `/reservations?from=${from}&to=${from + WEEKS * 7 * D}`).then((r) => { setRes(r); setLoadErr(""); }, (e) => { if (!quiet) { setLoadErr(e.message || tr.err.load); say(e.message); } }),
    [from] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const loadHolds = useCallback(() => api("GET", "/holds").then(setHolds, () => {}), []);
  const say = (m) => { setToast(m); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(""), 2400); };

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api("GET", "/reservations/config").then((c) => { setMaxHours(c.max_hours); setMaxPeople(c.max_people); }, () => {});
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => { clearInterval(t); clearTimeout(timer.current); };
  }, []);

  // Poll bookings + holds so two people looking at the same free hour see it turn "Rezerve ediliyor" / booked without a reload.
  useEffect(() => {
    const tick = () => { if (!document.hidden) { setNow(Date.now()); load(true); loadHolds(); } };
    loadHolds();
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); window.removeEventListener("focus", tick); };
  }, [load, loadHolds]);
  const liveHolds = holds.filter((k) => k.expires_at > now);

  const done = (msg) => { load(); loadHolds(); if (msg) { setSheet(null); say(msg); } };
  // Gün / Hafta: an explicit choice is remembered (localStorage); until then phones open on Gün and wide screens on Hafta.
  const view = pref ?? (wide ? "week" : "day");
  const setView = (v) => {
    setPref(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode: choice lasts for this visit only */ }
    // keep the anchor sensible: Hafta -> Gün lands on today when it is inside the week, else that week's first day
    if (v === "day" && weekStart(sel) === weekStart(today)) setSel(today);
    else if (v === "day") setSel(weekStart(sel));
  };
  const last = from + WEEKS * 7 * D - D; // last loaded day
  const strip = Array.from({ length: Math.round((last - today) / D) + 1 }, (_, i) => today + i * D);
  const wk = weekStart(sel);
  const days = view === "week" ? Array.from({ length: 7 }, (_, i) => wk + i * D) : [sel];
  const shown = view === "week" ? wk : sel;
  const step = view === "week" ? 7 * D : D;
  const prevOk = view === "week" ? wk > weekStart(today) : sel > today;
  const nextOk = view === "week" ? wk + 7 * D <= last : sel < last;
  const go = (dir) => setSel(Math.min(last, Math.max(today, sel + dir * step)));
  const atToday = view === "week" ? wk === weekStart(today) : sel === today;
  const firstFree = () => { for (let h = FROM; h < TO; h++) if (shown + h * H > now) return h; return FROM; };
  useEffect(() => { stripRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: "center", block: "nearest" }); }, [sel, view]);

  return (
    <section className="cal">
      <div className="page-head">
        <h2>{tr.cal.title}</h2>
        {!me.observer && (
          <button className="btn primary" onClick={() => setSheet({ kind: "new", day: view === "week" ? Math.max(today, wk) : sel, hour: firstFree() })}>
            <PlusIcon width="18" height="18" />{tr.cal.book}
          </button>
        )}
      </div>
      {me.observer && <p className="notice observer-note" role="note">{tr.cal.observer}</p>}

      <div className="cal-sticky">
        <div className="seg view-toggle" role="radiogroup" aria-label={tr.cal.viewLabel}>
          {[["day", tr.cal.viewDay], ["week", tr.cal.viewWeek]].map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}>{label}</button>
          ))}
        </div>

        <div className="week-nav">
          <button className="icon-btn" onClick={() => go(-1)} disabled={!prevOk} aria-label={view === "week" ? tr.cal.weekPrev : tr.cal.dayPrev}><ChevronLeftIcon /></button>
          <strong className="num">{view === "week" ? `${fmtShort(wk)} – ${fmtShort(wk + 6 * D)}` : fmtLong(sel)}</strong>
          <button className="icon-btn" onClick={() => go(1)} disabled={!nextOk} aria-label={view === "week" ? tr.cal.weekNext : tr.cal.dayNext}><ChevronRightIcon /></button>
          {!atToday && <button className="btn sm ghost" onClick={() => setSel(today)}>{tr.cal.today}</button>}
        </div>
      </div>
      {view === "day" && (
        <div className="strip" role="tablist" aria-label={tr.cal.days} ref={stripRef}>
          {strip.map((d) => (
            <button key={d} role="tab" aria-selected={d === sel} className="strip-day" onClick={() => setSel(d)}>
              <span>{d === today ? tr.cal.today : fmtWd(d)}</span><b className="num">{fmtDay(d)}</b>
            </button>
          ))}
        </div>
      )}

      {res ? (
        <div className="card cal-card">
          <Grid days={days} res={res} holds={liveHolds} now={now} meId={me.id} maxHours={maxHours} readOnly={!!me.observer}
            onSelect={(day, hour, hours) => setSheet({ kind: "new", day, hour, hours })}
            onRes={(r) => setSheet({ kind: "view", r })} />
        </div>
      ) : loadErr ? <ErrorState message={loadErr} onRetry={() => load()} /> : <Skeleton rows={4} />}

      {sheet?.kind === "new" && (
        <NewSheet day={sheet.day} hour={sheet.hour} hours={sheet.hours} res={res || []} holds={liveHolds} now={now} maxHours={maxHours} maxPeople={maxPeople}
          onClose={() => setSheet(null)} onDone={done} />
      )}
      {sheet?.kind === "view" && <ViewSheet r={sheet.r} now={now} me={me} onClose={() => setSheet(null)} onDone={done} />}
      <div className={"toast" + (toast ? " show" : "")} role="status">{toast}</div>
    </section>
  );
}
