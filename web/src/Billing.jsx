// Member view: mostly read-only, plus a self-serve dekont upload (re-enabled 2026-09-22, admin-approval-only - see
// lib/billing.mjs / lib/payments.mjs). A member can upload a PDF; it lands as a 'pending' receipt that affects no
// balance until an admin reviews it (AdminBilling -> Payments/UserDetail). The shared pieces below are reused there.
import React, { useEffect, useRef, useState } from "react";
import "./billing.css";
import { api, apiUpload } from "./api.js";
import { tr } from "./tr.js";
import { EmptyState, ErrorState, Skeleton } from "./States.jsx";
import { fmtShort, fmtTime } from "./time.js";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon } from "./icons.jsx";

export const fmtTRY = (n) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 2 }).format(n ?? 0);
export const monthLabel = (m) =>
  new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, 1));
const dayTime = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Istanbul" });

const G = (d) => (props) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{d}</svg>
);
export const CheckG = G(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const CrossG = G(<path d="M7 7l10 10M17 7 7 17" />);
export const AlertG = G(<><path d="M12 6v7" /><circle cx="12" cy="17.5" r="0.6" fill="currentColor" /></>);
export const DashG = G(<path d="M7 12h10" />);
export const UploadG = G(<path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14" />);

/** Item / receipt status: icon + text + tone (never colour alone). status: paid|unpaid|waived|voided|ok; flag: mismatch|unreadable|duplicate. */
export function StatusPill({ status, flag, partial }) {
  const key = flag || (partial ? "partial" : status === "ok" ? "paid" : status);
  const s = tr.billing.status;
  const [Icon, tone] =
    key === "paid" ? [CheckG, "ok"] : ["mismatch", "unreadable", "duplicate", "partial", "pending"].includes(key) ? [AlertG, "warn"] : key === "unpaid" ? [CrossG, ""] : [DashG, ""];
  return <span className={"pill " + tone}><Icon />{s[key] ?? key}</span>;
}

/** 'YYYY-MM' now in Istanbul (fixed UTC+3) - mirror of lib/tz.mjs currentMonth. */
export const nowMonth = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);

export function itemTitle(it) {
  if (it.kind === "subscription") return it.status === "upcoming" ? tr.billing.future.planned : tr.billing.subscription;
  if (it.kind === "adjustment") return it.note || tr.billing.adjustment;
  const r = it.reservation;
  return r ? `${tr.billing.booking} · ${dayTime.format(r.start_ms)}–${fmtTime(r.end_ms)}${r.people > 1 ? ` · ${tr.cal.peopleCount(r.people)}` : ""}` : tr.billing.booking;
}

export function MonthNav({ month, months, onChange }) {
  const i = months.indexOf(month);
  const future = month > nowMonth();
  return (
    <div className="mnav">
      <button className="icon-btn" disabled={i <= 0} onClick={() => onChange(months[i - 1])} aria-label={tr.billing.monthPrev}><ChevronLeftIcon /></button>
      <strong aria-live="polite">{monthLabel(month)}{future && <span className="pill future">{tr.billing.future.badge}</span>}</strong>
      <button className="icon-btn" disabled={i < 0 || i >= months.length - 1} onClick={() => onChange(months[i + 1])} aria-label={tr.billing.monthNext}><ChevronRightIcon /></button>
    </div>
  );
}

export function KalanCard({ data }) {
  const clear = data.kalan === 0 && !(data.projected_try > 0); // a future month's planned rent isn't "nothing to pay"
  return (
    <section className={"card kalan" + (clear ? " clear" : "")} aria-label={tr.billing.kalan}>
      <div className="kalan-label">{tr.billing.kalan}</div>
      <div className="kalan-amount amount">{clear ? <><CheckG width="22" height="22" />{tr.billing.allPaid}</> : fmtTRY(data.kalan)}</div>
      <div className="kalan-sub">
        <span>{tr.billing.status.paid}: {fmtTRY(data.paid)}</span><span>{tr.billing.total}: {fmtTRY(data.total)}</span>
        {data.projected_try > 0 && <span>{tr.billing.future.planned}: {fmtTRY(data.projected_try)}</span>}
      </div>
      {data.future && <p className="hint kalan-hint">{tr.billing.future.hint}</p>}
    </section>
  );
}

/**
 * DISPLAY-ONLY: how much of this (current or future) month the member's existing credit would cover, after what it
 * would first go to (older debt, earlier months' planned rent). Server-computed (creditOutlook); nothing is applied -
 * an admin still settles it by hand ("Alacaktan öde"). Renders nothing when there's no credit or nothing to cover.
 */
export function CreditCover({ cover }) {
  if (!cover || !(cover.need_try > 0) || !(cover.covered_try > 0)) return null;
  const C = tr.billing.cover;
  const full = cover.covered_try >= cover.need_try;
  return (
    <section className={"card cover" + (full ? " full" : "")} aria-label={full ? C.title : C.titlePart}>
      <div className="cover-head"><CheckG width="18" height="18" /><b>{full ? C.title : C.titlePart}</b></div>
      <p>{full ? C.full(fmtTRY(cover.need_try)) : C.part(fmtTRY(cover.covered_try), fmtTRY(cover.need_try))}</p>
      {cover.prior_try > 0 && <p className="muted small">{C.prior(fmtTRY(cover.prior_try))}</p>}
      <p className="muted small">{C.manual}</p>
    </section>
  );
}

/** What the community owes the member (overpayments not yet settled). Renders nothing at 0. `children` = admin settle form. */
export function CreditCard({ credit, children }) {
  if (!credit || (credit.balance_try <= 0 && !children)) return null;
  const owed = credit.balance_try > 0;
  return (
    <section className={"card credit" + (owed ? "" : " none")} aria-label={tr.billing.credit.title}>
      <div className="credit-label">{tr.billing.credit.title}</div>
      <div className="credit-amount amount">{owed ? tr.billing.credit.owed(fmtTRY(credit.balance_try)) : tr.billing.credit.none}</div>
      {owed && <p className="hint">{tr.billing.credit.hint}</p>}
      {children}
    </section>
  );
}

/** Item list. selectable: unpaid rows become checkboxes (Set of ids in `selected`). extra(item) renders admin actions. */
export function ItemList({ items, selectable, selected, onToggle, extra, empty = tr.empty.items }) {
  if (!items.length) return <EmptyState title={empty[0]} body={empty[1]} />;
  return (
    <ul className="card bill-list">
      {items.map((it) => {
        const pick = selectable && it.status === "unpaid";
        const Row = pick ? "label" : "div";
        return (
          <li key={it.key ?? it.id}>
            <Row className={`bill-item ${it.status}`} data-kind={it.kind}>
              {pick ? <input type="checkbox" checked={selected.has(it.id)} onChange={() => onToggle(it.id)} aria-label={itemTitle(it)} /> : <span className="bill-glyph" />}
              <div>
                <div className="bill-title">{itemTitle(it)}</div>
                <div className="bill-sub">
                  <StatusPill status={it.status} flag={it.flag} partial={it.status === "unpaid" && it.paid_try > 0} />
                  {it.status === "unpaid" && it.paid_try > 0 && <span className="bill-left">{tr.billing.ofAmount(fmtTRY(it.paid_try))} · <b>{tr.billing.remaining}: {fmtTRY(it.remaining_try)}</b></span>}
                  {it.status === "paid" && it.paid_by && <span>{tr.billing.paidBy[it.paid_by]}</span>}
                  {it.reservation?.cancelled && <span>{tr.billing.cancelledRes}</span>}
                </div>
              </div>
              <span className="bill-amount amount">{fmtTRY(it.amount_try)}</span>
              {extra && <div className="bill-actions">{extra(it)}</div>}
            </Row>
          </li>
        );
      })}
    </ul>
  );
}

export function ReceiptRow({ r, children }) {
  return (
    <li className="card rcpt">
      <div className="rcpt-head">
        <span className="rcpt-name">{r.filename || `Dekont #${r.id}`}</span>
        <StatusPill status={r.status === "ok" ? "paid" : undefined} flag={r.status === "ok" ? undefined : r.status} partial={r.status === "ok" && r.remaining_try > 0} />
      </div>
      <p className="rcpt-msg">{r.message}</p>
      <div className="row wrap">
        {r.has_pdf && <a className="link" href={`/api/receipts/${r.id}/pdf`} target="_blank" rel="noreferrer">{tr.billing.view}</a>}
        <span className="muted small">{dayTime.format(r.uploaded_at)}</span>
      </div>
      {children}
    </li>
  );
}

export const copyText = async (text) => {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
};

export function PayTo({ pay_to, onCopied }) {
  return (
    <section className="card payto" aria-label={tr.billing.payTo}>
      <h3>{tr.billing.payTo}</h3>
      {pay_to.iban ? (
        <>
          <div className="payto-row">
            <span className="iban">{pay_to.iban.replace(/(.{4})/g, "$1 ").trim()}</span>
            <button className="btn sm" onClick={async () => { await copyText(pay_to.iban); onCopied?.(); }}><CopyIcon width="16" height="16" />{tr.billing.copyIban}</button>
          </div>
          {pay_to.holder && <div className="muted small">{tr.billing.holder}: {pay_to.holder}</div>}
        </>
      ) : <p className="muted small" style={{ margin: 0 }}>{tr.billing.noIban}</p>}
    </section>
  );
}

export default function Billing() {
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState("");
  const [toast, setToast] = useState("");
  const [uploading, setUploading] = useState(false);
  const timer = useRef();
  const say = (m) => { setToast(m); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(""), 2200); };

  const load = async (month) => {
    try {
      setData(await api("GET", "/billing" + (month ? `?month=${month}` : "")));
    } catch (e) { setLoadErr(e.message || tr.err.load); say(e.message || tr.err.generic); }
  };
  useEffect(() => { load(); }, []);

  const upload = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!/pdf$/i.test(f.name) && f.type !== "application/pdf") return say(tr.billing.onlyPdf);
    setUploading(true);
    try {
      await apiUpload("/billing/receipts", f);
      say(tr.billing.uploaded);
      await load(data?.month);
    } catch (err) { say(err.message || tr.err.generic); } finally { setUploading(false); }
  };

  if (!data) return <section><div className="page-head"><h2>{tr.billing.title}</h2></div>{loadErr ? <ErrorState message={loadErr} onRetry={() => { setLoadErr(""); load(); }} /> : <Skeleton rows={3} />}</section>;

  return (
    <section>
      <div className="page-head"><h2>{tr.billing.title}</h2></div>
      <MonthNav month={data.month} months={data.months} onChange={load} />
      <KalanCard data={data} />
      <CreditCover cover={data.credit_cover} />
      <CreditCard credit={data.credit} />
      <PayTo pay_to={data.pay_to} onCopied={() => say(tr.billing.copied)} />

      <h3 className="sec-title">{tr.billing.items}</h3>
      <ItemList items={data.items} empty={data.future ? tr.billing.future.empty : undefined} />

      {/* two ways to pay, both admin-reviewed - nothing is decided automatically either way */}
      <section className="card howto" aria-label={tr.billing.howTitle}>
        <h3>{tr.billing.howTitle}</h3>
        <p>{tr.billing.howNote}</p>
        <div className="row wrap">
          <label className="btn file" aria-disabled={uploading}>
            <input type="file" accept="application/pdf,.pdf" onChange={upload} disabled={uploading} />
            <UploadG width="16" height="16" />{uploading ? tr.billing.uploading : tr.billing.uploadPick}
          </label>
        </div>
      </section>

      {data.receipts.length > 0 && (
        <>
          <h3 className="sec-title">{tr.billing.receipts}</h3>
          <ul className="list">{data.receipts.map((r) => <ReceiptRow key={r.id} r={r} />)}</ul>
        </>
      )}
      <div className={"toast" + (toast ? " show" : "")} role="status">{toast}</div>
    </section>
  );
}
