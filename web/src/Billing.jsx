// Member view: mostly read-only, plus a self-serve dekont upload (re-enabled 2026-09-22, admin-approval-only - see
// lib/billing.mjs / lib/payments.mjs). A member can upload a PDF; it lands as a 'pending' receipt that affects no
// balance until an admin reviews it (AdminBilling -> Payments/UserDetail). The shared pieces below are reused there.
import React, { useEffect, useRef, useState } from "react";
import Fold from "./Fold.jsx";
import usePoll from "./usePoll.js";
import "./billing.css";
import { api, apiUpload } from "./api.js";
import { tr } from "./tr.js";
import { EmptyState, ErrorState, Skeleton } from "./States.jsx";
import { fmtShort, fmtTime } from "./time.js";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon } from "./icons.jsx";
import { ConfirmSheet, GridPick } from "./Controls.jsx";

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
  return r ? `${tr.billing.booking} · ${dayTime.format(r.start_ms)}–${fmtTime(r.end_ms)}${r.people > 0 ? ` · ${tr.cal.peopleCount(r.people)}` : ""}` : tr.billing.booking;
}

/** Title for a receipt's covered charge (listReceipts' `charges` shape - no `reservation`/`status`, just kind/note). */
export const chargeName = (c) => (c.kind === "subscription" ? tr.billing.subscription : c.kind === "adjustment" ? c.note || tr.billing.adjustment : tr.billing.booking);

/**
 * The money lines of a payment/receipt, shared by the admin's draft+saved views (AdminBilling.jsx) and the member's
 * own read-only receipt row below: selected items' total, what was paid, then what that leaves - kalan borç, or
 * where the surplus went (the month's other items, then credit the community owes). `owedLabel` lets the caller
 * phrase the last row in their own voice (admin: third person "üyeye borçlu"; member: second person "sana borçlu").
 */
export function PaySummary({ count, sum, paid, spill, owed, saved, credit = 0, paidLabel = tr.admin.pay.paid, owedLabel = tr.admin.pay.owed, children }) {
  const left = Math.max(0, sum - credit - paid);
  const P = tr.admin.pay;
  return (
    <dl className="pay-sum">
      <div><dt>{P.selectedSum(count)}</dt><dd className="amount">{fmtTRY(sum)}</dd></div>
      {credit > 0 && <div className="pay-credit-row"><dt>{P.creditMinus}</dt><dd className="amount">−{fmtTRY(credit)}</dd></div>}
      {credit > 0 && <div><dt>{P.toPay}</dt><dd className="amount">{fmtTRY(Math.max(0, sum - credit))}</dd></div>}
      {(children || paid > 0 || !credit) && <div className="pay-paid"><dt>{children ? children[0] : credit > 0 ? P.payNow : paidLabel}</dt><dd className="amount">{children ? children[1] : fmtTRY(paid)}</dd></div>}
      {(paid > 0 || credit > 0) && left > 0 && <div className="pay-out warn"><dt>{P.left}</dt><dd className="amount">{fmtTRY(left)}</dd></div>}
      {(paid > 0 || credit > 0) && left === 0 && spill === 0 && owed === 0 && <div className="pay-out good"><dt>{P.exact}</dt><dd><CheckG /></dd></div>}
      {spill > 0 && <div className="pay-out"><dt>{saved ? P.spillSaved : P.spill}</dt><dd className="amount">{fmtTRY(spill)}</dd></div>}
      {owed > 0 && <div className="pay-out good"><dt>{owedLabel}</dt><dd className="amount">{fmtTRY(owed)}</dd></div>}
    </dl>
  );
}

export function MonthNav({ month, months, onChange }) {
  const i = months.indexOf(month);
  const future = month > nowMonth();
  const y = month.slice(0, 4), mi = +month.slice(5, 7) - 1;
  const names = Array.from({ length: 12 }, (_, m) => new Intl.DateTimeFormat("tr-TR", { month: "long", timeZone: "UTC" }).format(Date.UTC(2000, m, 1)));
  const key = (yy, m) => `${yy}-${String(m + 1).padStart(2, "0")}`;
  const has = new Set(months);
  const monthItems = names.map((n, m) => ({ value: m, label: n.slice(0, 3), aria: `${n} ${y}`, disabled: !has.has(key(y, m)) }));
  const yearItems = [...new Set(months.map((m) => m.slice(0, 4)))].map((yy) => ({ value: yy, label: yy, aria: yy }));
  const pickYear = (yy) => {
    const inY = months.filter((m) => m.startsWith(yy));
    if (!inY.length) return;
    const want = key(yy, mi);
    onChange(has.has(want) ? want : want < inY[0] ? inY[0] : inY[inY.length - 1]);
  };
  return (
    <div className="mnav">
      <button className="icon-btn" disabled={i <= 0} onClick={() => onChange(months[i - 1])} aria-label={tr.billing.monthPrev}><ChevronLeftIcon /></button>
      <strong aria-live="polite" aria-label={monthLabel(month)}>
        <GridPick className="pick-month" value={mi} label={names[mi]} items={monthItems} ariaLabel={tr.cal.pickMonth} onPick={(m) => onChange(key(y, m))} />
        <GridPick className="pick-year" value={y} label={y} items={yearItems} ariaLabel={tr.cal.pickYear} onPick={pickYear} />
        {future && <span className="pill future">{tr.billing.future.badge}</span>}</strong>
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

/** Read-only list of REAL unpaid items from months before the viewed one (payload other_open), grouped by month. */
export function PastOpen({ data, admin = false }) {
  const past = (data.other_open ?? []).filter((i) => i.id != null && i.month < data.month);
  if (!past.length) return null;
  const P = tr.billing.past;
  const months = [...new Set(past.map((i) => i.month))];
  const sumOf = (list) => fmtTRY(list.reduce((a, i) => a + (i.remaining_try ?? i.amount_try ?? 0), 0));
  const body = (
    <>
      <p className="hint">{admin ? P.hintAdmin : P.hint}</p>
      {months.map((m) => {
        const list = past.filter((i) => i.month === m);
        return admin
          ? <div key={m}><div className="muted small">{monthLabel(m)}</div><ItemList items={list} /></div>
          : <Fold key={m} title={monthLabel(m)} sum={sumOf(list)} defaultOpen={false} className="fold-month"><ItemList items={list} /></Fold>;
      })}
    </>
  );
  if (admin) return <section aria-label={P.title}><h3 className="sec-title">{P.title}</h3>{body}</section>;
  return <Fold title={P.title} sum={sumOf(past)} defaultOpen={false}>{body}</Fold>;
}

/**
 * Cumulative unpaid over all months up to today (payload debt_try / debt_months), per month; tapping a month opens it.
 * Hidden unless some of the debt sits in a month other than the one being viewed (otherwise KalanCard says it all).
 */
export function DebtCard({ data, onPick, admin = false }) {
  const rows = data.debt_months ?? [];
  if (!(data.debt_try > 0) || !rows.some((m) => m.month !== data.month)) return null;
  const D = tr.billing.debt;
  const title = admin ? D.titleAdmin : D.title;
  const list = (
    <>
      <p className="hint">{admin ? D.hintAdmin : D.hint}</p>
        <ul className="debt-list">
          {rows.map((m) => (
            <li key={m.month}>
              <button type="button" className={"debt-row" + (m.month === data.month ? " cur" : "")} onClick={() => onPick(m.month)} aria-label={`${D.open} ${monthLabel(m.month)}`}>
                <span>{monthLabel(m.month)}</span><span className="amount">{fmtTRY(m.remaining_try)}</span>
              </button>
            </li>
          ))}
        </ul>
    </>
  );
  return (
    <section className="card debt" aria-label={title}>
      {admin ? <><div className="debt-label">{title}</div><div className="debt-amount amount">{fmtTRY(data.debt_try)}</div>{list}</> : <Fold title={title} defaultOpen={false} sum={fmtTRY(data.debt_try)} className="fold-debt">{list}</Fold>}
    </section>
  );
}

/**
 * DISPLAY-ONLY: how much of this (current or future) month the member's existing credit would cover, after what it
 * would first go to (older debt, earlier months' planned rent). Server-computed (creditOutlook); nothing is applied -
 * an admin still settles it by hand ("Alacaktan öde"). Renders nothing when there's no credit or nothing to cover.
 */
export function CreditCover({ cover, admin = false }) {
  if (!cover || !(cover.need_try > 0) || !(cover.covered_try > 0)) return null;
  const C = admin ? { ...tr.billing.cover, ...tr.billing.cover.admin } : tr.billing.cover; // admin = third person; `prior` is neutral
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
export function CreditCard({ credit, children, admin = false }) {
  if (!credit || (credit.balance_try <= 0 && !children)) return null;
  const owed = credit.balance_try > 0;
  const K = tr.billing.credit;
  const owedText = admin ? K.owedAdmin : K.owed;
  const title = admin ? K.titleAdmin : K.title;
  return (
    <section className={"card credit" + (owed ? "" : " none")} aria-label={title}>
      <div className="credit-label">{title}</div>
      <div className="credit-amount amount">{owed ? owedText(fmtTRY(credit.balance_try)) : K.none}</div>
      {owed && <p className="hint">{admin ? K.hintAdmin : K.hint}</p>}
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

/**
 * Own receipt, read-only. Besides the sentence (r.message), an 'ok' receipt also gets the SAME structured
 * breakdown the admin sees for it (AdminBilling.jsx ReceiptCard/PaySummary): which items it covered, the total,
 * what was actually paid, and what that left (kalan / spilled onto other items / credit) - previously only the
 * admin view showed this, the member's own page had just the one sentence (mentioning only "Kalan" or the
 * surplus/"artan" credit, never the paid/covered total). Same data the admin sees, already in this receipt's
 * `charges`/`expected_try`/`paid_try`/`spill_try`/`overpaid_try` (listReceipts, scoped to the caller's own user_id).
 */
/** "Dekontu sil" button + ConfirmSheet; `onDelete` does the request. Callers only render it when the receipt is deletable (not 'ok'). */
export function DeleteReceipt({ onDelete, paid = false }) {
  const [sure, setSure] = useState(false);
  const D = tr.billing.del, btn = paid ? D.okBtn : D.btn;
  return (
    <>
      <button type="button" className="btn danger" onClick={() => setSure(true)}>{btn}</button>
      {sure && <ConfirmSheet title={paid ? D.okTitle : D.title} body={paid ? D.okBody : D.body} confirmLabel={btn} danger onClose={() => setSure(false)} onConfirm={onDelete} />}
    </>
  );
}

/** Member edits a rejected own upload (new PDF and/or a message) and sends it back to review. */
function ResubmitForm({ r, onDone, onCancel }) {
  const R = tr.billing.resubmit;
  const [file, setFile] = useState(null), [msg, setMsg] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const send = async (e) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { await apiUpload(`/billing/receipts/${r.id}/resubmit?message=${encodeURIComponent(msg.trim())}${file ? `&filename=${encodeURIComponent(file.name)}` : ""}`, file); onDone(); }
    catch (x) { setErr(x.message || tr.err.generic); setBusy(false); }
  };
  return (
    <form className="resubmit" onSubmit={send}>
      <p className="hint">{R.hint}</p>
      <label className="btn file"><input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} /><UploadG width="16" height="16" />{file ? file.name : R.pick}</label>
      <label className="field"><span>{R.note}</span><input maxLength={300} value={msg} onChange={(e) => setMsg(e.target.value)} /></label>
      {err && <p className="hint" role="alert">{err}</p>}
      <div className="row end wrap">
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>{R.cancel}</button>
        <button className="btn primary" disabled={busy}>{R.send}</button>
      </div>
    </form>
  );
}

export function ReceiptRow({ r, onDelete, onResubmitted, children }) {
  const [editing, setEditing] = useState(false);
  const rejected = r.status === "mismatch" && r.charges.length === 0;
  const ok = r.status === "ok";
  const picked = r.charges.filter((c) => c.selected !== false);
  return (
    <li className="card rcpt">
      <div className="rcpt-head">
        <span className="rcpt-name">{r.filename || `Dekont #${r.id}`}</span>
        {rejected ? <span className="pill warn">{tr.billing.rejectedPill}</span> : <StatusPill status={ok ? "paid" : undefined} flag={ok ? undefined : r.status} partial={ok && r.remaining_try > 0} />}
      </div>
      <p className="rcpt-msg">{r.message}</p>
      {picked.length > 0 && (
        <div className="pay-items">
          <div className="pay-legend">{tr.billing.coversSelf}</div>
          <ul className="pay-covered">
            {picked.map((c) => (
              <li key={c.id}>
                <span>{chargeName(c)}{c.month && c.month !== r.month && <span className="muted small"> · {monthLabel(c.month)}</span>}</span>
                <span className="amount">{fmtTRY(c.amount_try)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {ok && <PaySummary saved count={picked.length} sum={r.expected_try} paid={r.cash_try ?? r.paid_try} credit={r.credit_try ?? 0} spill={r.spill_try} owed={r.overpaid_try}
        paidLabel={tr.admin.pay.paid} owedLabel={tr.billing.owedSelf} />}
      <div className="row wrap">
        {r.has_pdf && <a className="link" href={`/api/receipts/${r.id}/pdf`} target="_blank" rel="noreferrer">{tr.billing.view}</a>}
        <span className="muted small">{dayTime.format(r.uploaded_at)}</span>
        {rejected && onResubmitted && !editing && <button type="button" className="btn" onClick={() => setEditing(true)}>{tr.billing.resubmit.btn}</button>}
        {onDelete && r.status !== "ok" && !String(r.admin_note ?? "").startsWith("Yönetici kaydetti") && <DeleteReceipt onDelete={() => onDelete(r)} />}
      </div>
      {editing && <ResubmitForm r={r} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); onResubmitted(r); }} />}
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
  const [shown, setShown] = useState(false); // masked until tapped: no casual screenshots / shoulder-surfing
  const spaced = (v) => v.replace(/(.{4})/g, "$1 ").trim();
  const masked = pay_to.iban ? spaced(pay_to.iban.slice(0, 4) + "•".repeat(pay_to.iban.length - 6) + pay_to.iban.slice(-2)) : "";
  return (
    <section className="card payto" aria-label={tr.billing.payTo}>
      <h3>{tr.billing.payTo}</h3>
      {pay_to.iban ? (
        <>
          <div className="payto-row">
            <span className="iban">{shown ? spaced(pay_to.iban) : masked}</span>
            <span className="row wrap">
              <button className="btn sm" onClick={() => setShown(!shown)}>{shown ? tr.billing.hideIban : tr.billing.showIban}</button>
              <button className="btn sm" onClick={async () => { await copyText(pay_to.iban); onCopied?.(); }}><CopyIcon width="16" height="16" />{tr.billing.copyIban}</button>
            </span>
          </div>
          {pay_to.holder && <div className="muted small">{tr.billing.holder}: {pay_to.holder}</div>}
        </>
      ) : <p className="muted small" style={{ margin: 0 }}>{pay_to.hidden ? tr.billing.ibanWhenOwed : tr.billing.noIban}</p>}
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
  usePoll((ok) => api("GET", "/billing" + (data?.month ? `?month=${data.month}` : "")).then((d) => { if (ok()) setData(d); }), { enabled: !!data });

  const upload = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!/pdf$/i.test(f.name) && f.type !== "application/pdf") return say(tr.billing.onlyPdf);
    setUploading(true);
    try {
      await apiUpload("/billing/receipts" + (data?.month ? `?month=${data.month}` : ""), f);
      say(tr.billing.uploaded);
      await load(data?.month);
    } catch (err) { say(err.message || tr.err.generic); } finally { setUploading(false); }
  };

  const removeReceipt = async (r) => {
    try { await api("DELETE", `/billing/receipts/${r.id}`); say(tr.billing.del.done); await load(data?.month); }
    catch (err) { say(err.message || tr.err.generic); }
  };

  if (!data) return <section><div className="page-head"><h2>{tr.billing.title}</h2></div>{loadErr ? <ErrorState message={loadErr} onRetry={() => { setLoadErr(""); load(); }} /> : <Skeleton rows={3} />}</section>;

  return (
    <section>
      <div className="page-head"><h2>{tr.billing.title}</h2></div>
      <MonthNav month={data.month} months={data.months} onChange={load} />
      <KalanCard data={data} />
      <DebtCard data={data} onPick={load} />
      <CreditCover cover={data.credit_cover} />
      <CreditCard credit={data.credit} />
      <PayTo pay_to={data.pay_to} onCopied={() => say(tr.billing.copied)} />

      <Fold title={tr.billing.items} defaultOpen={false} sum={fmtTRY(data.items.reduce((a, i) => a + (i.amount_try ?? 0), 0))}>
        <ItemList items={data.items} empty={data.future ? tr.billing.future.empty : undefined} />
      </Fold>
      <PastOpen data={data} />

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
          <ul className="list">{data.receipts.map((r) => <ReceiptRow key={r.id} r={r} onDelete={removeReceipt} onResubmitted={async () => { say(tr.billing.resubmit.done); await load(data?.month); }} />)}</ul>
        </>
      )}
      <div className={"toast" + (toast ? " show" : "")} role="status">{toast}</div>
    </section>
  );
}
