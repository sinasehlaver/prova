import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tr } from "./tr.js";
import Sheet from "./Sheet.jsx";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons.jsx";

/* Shared form controls: Select (listbox), DatePicker, MonthPicker, ConfirmSheet. No native <select>/date/month/confirm anywhere.
 * Popovers portal to <body> (position: fixed) so a scrolling .sheet never clips them; focus stays on the trigger. */

function Chevron() {
  return <svg className="ctl-chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="m2.5 4.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** Popover anchored under (or above) `anchor`. Closes on outside press / Esc (Esc never reaches the Sheet). */
function Popover({ anchor, onClose, minWidth = 0, children, className = "", onKeyDown }) {
  const ref = useRef();
  const [pos, setPos] = useState(null);
  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect(), p = ref.current;
    if (!a || !p) return;
    const ph = p.offsetHeight, below = window.innerHeight - a.bottom - 8, above = a.top - 8;
    const up = ph > below && above > below;
    const w = Math.max(a.width, minWidth);
    const left = Math.min(Math.max(8, a.left), Math.max(8, window.innerWidth - w - 8));
    setPos({ left, width: w, ...(up ? { bottom: window.innerHeight - a.top + 6, maxHeight: above } : { top: a.bottom + 6, maxHeight: below }) });
  }, [anchor, minWidth]);
  useLayoutEffect(place, [place]);
  useEffect(() => {
    const down = (e) => { if (!ref.current?.contains(e.target) && !anchor.current?.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", down);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("mousedown", down); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor, onClose, place]);
  const key = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation?.(); onClose(); anchor.current?.focus(); return; }
    onKeyDown?.(e);
  };
  return createPortal(
    <div ref={ref} className={`ctl-pop ${className}`} style={pos ? pos : { visibility: "hidden", top: 0, left: 0 }} onKeyDown={key}>{children}</div>,
    document.body
  );
}

/** Listbox dropdown. options: [{value,label}]. onChange(value) gets the option's original value (number stays number). */
export function Select({ value, onChange, options, className = "", ariaLabel, autofocus, disabled, id }) {
  const btn = useRef();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [act, setAct] = useState(0);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const cur = options[idx];
  const close = useCallback(() => setOpen(false), []);
  const openIt = () => { setAct(idx); setOpen(true); };
  const pick = (i) => { setOpen(false); if (options[i] && options[i].value !== value) onChange(options[i].value); };
  useEffect(() => { if (open) document.getElementById(`${uid}-${act}`)?.scrollIntoView({ block: "nearest" }); }, [open, act, uid]);
  const onKey = (e) => {
    const k = e.key;
    if (k === "Escape") { if (open) { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation?.(); close(); } return; }
    if (!open) { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(k)) { e.preventDefault(); openIt(); } return; }
    if (k === "ArrowDown") { e.preventDefault(); setAct((a) => Math.min(options.length - 1, a + 1)); }
    else if (k === "ArrowUp") { e.preventDefault(); setAct((a) => Math.max(0, a - 1)); }
    else if (k === "Home") { e.preventDefault(); setAct(0); }
    else if (k === "End") { e.preventDefault(); setAct(options.length - 1); }
    else if (k === "Enter" || k === " ") { e.preventDefault(); pick(act); }
    else if (k === "Tab") close();
  };
  return (
    <>
      <button type="button" ref={btn} id={id} className={`ctl-btn ${className}`} role="combobox" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? `${uid}-list` : undefined} aria-activedescendant={open ? `${uid}-${act}` : undefined} aria-label={ariaLabel}
        data-autofocus={autofocus ? "" : undefined} disabled={disabled} onClick={() => (open ? close() : openIt())} onKeyDown={onKey}>
        <span className="ctl-val">{cur ? cur.label : ""}</span><Chevron />
      </button>
      {open && (
        <Popover anchor={btn} onClose={close} className="ctl-list-wrap">
          <ul className="ctl-list" role="listbox" id={`${uid}-list`}>
            {options.map((o, i) => (
              <li key={String(o.value)} id={`${uid}-${i}`} role="option" aria-selected={i === idx} className={`ctl-opt${i === act ? " act" : ""}${i === idx ? " sel" : ""}`}
                onMouseEnter={() => setAct(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}>
                <span>{o.label}</span>
                {i === idx && <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </li>
            ))}
          </ul>
        </Popover>
      )}
    </>
  );
}

const pad = (n) => String(n).padStart(2, "0");
const utc = (y, m, d = 1) => new Date(Date.UTC(y, m, d));
const MONTHS = Array.from({ length: 12 }, (_, m) => utc(2000, m).toLocaleDateString("tr-TR", { month: "long", timeZone: "UTC" }));
const MONTHS_SHORT = Array.from({ length: 12 }, (_, m) => utc(2000, m).toLocaleDateString("tr-TR", { month: "short", timeZone: "UTC" }));

function NavBtn({ children, label, onClick, disabled }) {
  return <button type="button" className="ctl-nav" aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

/** Day picker. value/min/max are "YYYY-MM-DD"; onChange(iso). */
export function DatePicker({ value, onChange, min, max, className = "", ariaLabel }) {
  const btn = useRef();
  const [open, setOpen] = useState(false);
  const [vy, setVy] = useState(+value.slice(0, 4)), [vm, setVm] = useState(+value.slice(5, 7) - 1);
  const close = useCallback(() => setOpen(false), []);
  const show = () => { setVy(+value.slice(0, 4)); setVm(+value.slice(5, 7) - 1); setOpen(true); };
  const goto = (y, m) => { const t = utc(y, m); setVy(t.getUTCFullYear()); setVm(t.getUTCMonth()); };
  const first = utc(vy, vm), lead = (first.getUTCDay() + 6) % 7, days = utc(vy, vm + 1, 0).getUTCDate();
  const iso = (d) => `${vy}-${pad(vm + 1)}-${pad(d)}`;
  const off = (d) => (min && iso(d) < min) || (max && iso(d) > max);
  const monthOff = (y, m) => (min && `${y}-${pad(m + 1)}-31` < min) || (max && `${y}-${pad(m + 1)}-01` > max);
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const label = new Date(value + "T12:00:00Z").toLocaleDateString("tr-TR", { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const pick = (d) => { close(); btn.current?.focus(); if (!off(d)) onChange(iso(d)); };
  return (
    <>
      <button type="button" ref={btn} className={`ctl-btn ${className}`} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel} data-value={value} data-min={min} onClick={() => (open ? close() : show())}>
        <span className="ctl-val">{label}</span>
        <svg className="ctl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /></svg>
      </button>
      {open && (
        <Popover anchor={btn} onClose={close} minWidth={288} className="ctl-cal">
          <div className="ctl-cal-head" role="group">
            <NavBtn label={tr.ui.prevYear} onClick={() => goto(vy - 1, vm)} disabled={monthOff(vy - 1, 11)}><ChevronLeftIcon width="14" height="14" /><ChevronLeftIcon width="14" height="14" style={{ marginLeft: -9 }} /></NavBtn>
            <NavBtn label={tr.ui.prevMonth} onClick={() => goto(vy, vm - 1)} disabled={monthOff(vy, vm - 1)}><ChevronLeftIcon width="16" height="16" /></NavBtn>
            <b className="ctl-cal-title" aria-live="polite">{MONTHS[vm]} {vy}</b>
            <NavBtn label={tr.ui.nextMonth} onClick={() => goto(vy, vm + 1)} disabled={monthOff(vy, vm + 1)}><ChevronRightIcon width="16" height="16" /></NavBtn>
            <NavBtn label={tr.ui.nextYear} onClick={() => goto(vy + 1, vm)} disabled={monthOff(vy + 1, 0)}><ChevronRightIcon width="14" height="14" /><ChevronRightIcon width="14" height="14" style={{ marginLeft: -9 }} /></NavBtn>
          </div>
          <div className="ctl-cal-grid" role="grid">
            {tr.ui.weekdays.map((w) => <span key={w} className="ctl-wd" aria-hidden="true">{w}</span>)}
            {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
            {Array.from({ length: days }, (_, i) => i + 1).map((d) => (
              <button type="button" key={d} data-iso={iso(d)} className={`ctl-day${iso(d) === value ? " sel" : ""}${iso(d) === today ? " today" : ""}`}
                disabled={off(d)} aria-pressed={iso(d) === value} aria-label={new Date(iso(d) + "T12:00:00Z").toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}
                onClick={() => pick(d)} ref={(el) => { if (el && iso(d) === value && !el.dataset.f) { el.dataset.f = "1"; el.focus({ preventScroll: true }); } }}>{d}</button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** Month picker. value/min/max are "YYYY-MM"; onChange(ym). */
export function MonthPicker({ value, onChange, min, max, className = "", ariaLabel }) {
  const btn = useRef();
  const [open, setOpen] = useState(false);
  const [vy, setVy] = useState(+(value || min || "2025").slice(0, 4));
  const close = useCallback(() => setOpen(false), []);
  const ym = (m) => `${vy}-${pad(m + 1)}`;
  const off = (m) => (min && ym(m) < min) || (max && ym(m) > max);
  const label = value ? `${MONTHS[+value.slice(5, 7) - 1]} ${value.slice(0, 4)}` : "";
  return (
    <>
      <button type="button" ref={btn} className={`ctl-btn ${className}`} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel} data-value={value} onClick={() => { if (!open) setVy(+(value || min || "2025").slice(0, 4)); setOpen(!open); }}>
        <span className="ctl-val">{label}</span>
        <svg className="ctl-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /></svg>
      </button>
      {open && (
        <Popover anchor={btn} onClose={close} minWidth={260} className="ctl-cal">
          <div className="ctl-cal-head" role="group">
            <NavBtn label={tr.ui.prevYear} onClick={() => setVy(vy - 1)} disabled={!!min && `${vy - 1}-12` < min}><ChevronLeftIcon width="16" height="16" /></NavBtn>
            <b className="ctl-cal-title" aria-live="polite">{vy}</b>
            <NavBtn label={tr.ui.nextYear} onClick={() => setVy(vy + 1)} disabled={!!max && `${vy + 1}-01` > max}><ChevronRightIcon width="16" height="16" /></NavBtn>
          </div>
          <div className="ctl-mon-grid">
            {MONTHS_SHORT.map((n, m) => (
              <button type="button" key={m} data-ym={ym(m)} className={`ctl-day${ym(m) === value ? " sel" : ""}`} disabled={off(m)} aria-pressed={ym(m) === value} aria-label={`${MONTHS[m]} ${vy}`}
                onClick={() => { close(); btn.current?.focus(); onChange(ym(m)); }} ref={(el) => { if (el && ym(m) === value && !el.dataset.f) { el.dataset.f = "1"; el.focus({ preventScroll: true }); } }}>{n}</button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** Button that opens a 3-column grid of choices. items: [{value,label,disabled,aria}]; onPick(value). Used by the calendar head's month/year buttons. */
export function GridPick({ value, label, items, onPick, className = "", ariaLabel }) {
  const btn = useRef();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" ref={btn} className={`btn sm ghost grid-pick ${className}`} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel} data-value={value} onClick={() => setOpen(!open)}>
        <span>{label}</span>
        <svg className="ctl-chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="m2.5 4.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <Popover anchor={btn} onClose={close} minWidth={240} className="ctl-cal">
          <div className="ctl-mon-grid">
            {items.map((it) => (
              <button type="button" key={it.value} data-v={it.value} className={`ctl-day${it.value === value ? " sel" : ""}`} disabled={it.disabled} aria-pressed={it.value === value} aria-label={it.aria}
                onClick={() => { close(); btn.current?.focus(); onPick(it.value); }} ref={(el) => { if (el && it.value === value && !el.dataset.f) { el.dataset.f = "1"; el.focus({ preventScroll: true }); } }}>{it.label}</button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** In-app replacement for window.confirm. */
export function ConfirmSheet({ title, body, confirmLabel, danger, onConfirm, onClose }) {
  return (
    <Sheet title={title} onClose={onClose}>
      {body && <p className="confirm-body">{body}</p>}
      <div className="row end confirm-actions">
        <button type="button" className="btn" onClick={onClose}>{tr.ui.cancel}</button>
        <button type="button" className={`btn ${danger ? "danger" : "primary"}`} data-autofocus onClick={() => { onClose(); onConfirm(); }}>{confirmLabel || tr.ui.ok}</button>
      </div>
    </Sheet>
  );
}
