import React, { useEffect, useId, useRef, useState } from "react";
import { api, apiUpload } from "./api.js";
import { tr } from "./tr.js";
import { ChevronLeftIcon } from "./icons.jsx";
import { EmptyState, ErrorState, Skeleton } from "./States.jsx";
import { CheckG, CreditCard, CreditCover, DashG, ItemList, KalanCard, MonthNav, StatusPill, UploadG, fmtTRY, itemTitle, monthLabel, nowMonth } from "./Billing.jsx";

const A = tr.admin;
const fmtDateTimeShort = (ms) => new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Istanbul" }).format(ms);
const keyOf = (it) => it.key ?? String(it.id); // charge id, or `sub:YYYY-MM` for a future month's planned rent (prepay)
const nextOf = (m) => (m.slice(5) === "12" ? `${+m.slice(0, 4) + 1}-01` : `${m.slice(0, 5)}${String(+m.slice(5) + 1).padStart(2, "0")}`);

export function useToast() {
  const [msg, setMsg] = useState("");
  const t = useRef();
  const say = (m) => { setMsg(m); clearTimeout(t.current); t.current = setTimeout(() => setMsg(""), 2200); };
  return [say, <div key="toast" className={"toast" + (msg ? " show" : "")} role="status">{msg}</div>];
}

const P = A.pay;
const chargeName = (c) => (c.kind === "subscription" ? tr.billing.subscription : c.kind === "adjustment" ? c.note || tr.billing.adjustment : tr.billing.booking);
const DraftG = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="3 3.2" aria-hidden="true"><circle cx="12" cy="12" r="8" /></svg>
);

/** Inline PDF toggle + "open in a new tab". Only ever rendered when there IS a PDF (a cash payment has none - no button). */
function PdfToggle({ src, title }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="row wrap">
        <button type="button" className="btn sm ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? P.hidePdf : P.showPdf}</button>
        <a className="link" href={src} target="_blank" rel="noreferrer">{A.openPdf}</a>
      </div>
      {open && <embed className="embed" src={src} type="application/pdf" title={title || "Dekont"} />}
    </>
  );
}

/**
 * The money lines of a payment, the same shape before (draft: `children` = the amount input) and after saving:
 * selected items' total, what was paid, then what that leaves - kalan borç, or where the surplus went (the month's
 * other items, then credit the community owes). Saved cards feed the SERVER's numbers (expected/paid/spill/overpaid
 * from listReceipts); the draft preview mirrors allocateRaw's order on the same monthView data - the server decides.
 */
function PaySummary({ count, sum, paid, spill, owed, saved, paidLabel = P.paid, children }) {
  const left = Math.max(0, sum - paid);
  return (
    <dl className="pay-sum">
      <div><dt>{P.selectedSum(count)}</dt><dd className="amount">{fmtTRY(sum)}</dd></div>
      <div className="pay-paid"><dt>{children ? children[0] : paidLabel}</dt><dd className="amount">{children ? children[1] : fmtTRY(paid)}</dd></div>
      {paid > 0 && left > 0 && <div className="pay-out warn"><dt>{P.left}</dt><dd className="amount">{fmtTRY(left)}</dd></div>}
      {paid > 0 && left === 0 && spill === 0 && owed === 0 && <div className="pay-out good"><dt>{P.exact}</dt><dd><CheckG /></dd></div>}
      {spill > 0 && <div className="pay-out"><dt>{saved ? P.spillSaved : P.spill}</dt><dd className="amount">{fmtTRY(spill)}</dd></div>}
      {owed > 0 && <div className="pay-out good"><dt>{P.owed}</dt><dd className="amount">{fmtTRY(owed)}</dd></div>}
    </dl>
  );
}

/**
 * DRAFT payment - nothing is saved until "Ödemeyi onayla". The admin multi-selects what the payment covers (the
 * month's still-open items), types what was paid (prefilled with the selected total until typed) and sees the result
 * live. Two modes: `receipt` = a member's pending upload (its PDF is already there, reject is offered), else a fresh
 * admin record (optional dekont upload). `onSave({charges, amount, note, file})` returns false to keep the draft.
 */
//
// Multi-month (2026-09-23): `elsewhere` = the member's open items in OTHER months (older debt, already-made future
// bookings, next month's planned rent `sub:YYYY-MM`) - one payment can cover e.g. this month's extra + next month's
// rent. A surplus still only spills onto THIS month's other items (server: pickRaw), mirrored below.
// `credit` > 0 (admin record only) offers "Alacaktan öde": the member's existing credit pays the picked items, no new
// money, no PDF, no spill (server: recordPayment fromCredit).
function PaymentComposer({ items, elsewhere = [], credit = 0, receipt, head, onSave, onReject, say }) {
  const isOpen = (i) => (i.status === "unpaid" || i.status === "upcoming") && i.remaining_try > 0;
  const open = items.filter(isOpen);
  const away = elsewhere.filter(isOpen);
  const all = [...open, ...away];
  const [sel, setSel] = useState(() => new Set());
  const [amount, setAmount] = useState("");
  const typed = useRef(false); // once the admin types an amount, the selection stops overwriting it
  const [note, setNote] = useState("");
  const [file, setFile] = useState(null);
  const [blobUrl, setBlobUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [useCredit, setUseCredit] = useState(false);
  const fromCredit = useCredit && credit > 0 && !receipt;
  const amountId = useId();
  const openKey = all.map((i) => `${keyOf(i)}:${i.remaining_try}`).join(",");
  useEffect(() => { setSel((s) => new Set([...s].filter((k) => all.some((i) => keyOf(i) === k)))); }, [openKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const sum = all.filter((i) => sel.has(keyOf(i))).reduce((s, i) => s + i.remaining_try, 0);
  const others = fromCredit ? 0 : open.filter((i) => !sel.has(keyOf(i))).reduce((s, i) => s + i.remaining_try, 0);
  const suggest = fromCredit ? Math.min(sum, credit) : sum;
  useEffect(() => { if (!typed.current) setAmount(suggest > 0 ? String(suggest) : ""); }, [suggest]);
  useEffect(() => {
    if (!file) { setBlobUrl(null); return undefined; }
    const u = URL.createObjectURL(file);
    setBlobUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const n = Number(amount);
  const paid = n > 0 ? n : 0;
  const surplus = fromCredit ? 0 : Math.max(0, paid - sum); // from credit: an unspent rest simply stays credit
  const spill = Math.min(surplus, others);
  const overCredit = fromCredit && paid > credit;
  const toggle = (id) => setSel((s) => { const x = new Set(s); x.has(id) ? x.delete(id) : x.add(id); return x; });
  const pickRow = (it, showMonth) => (
    <li key={keyOf(it)}>
      <label className={"bill-item" + (it.status === "upcoming" ? " upcoming" : "")} data-kind={it.kind}>
        <input type="checkbox" checked={sel.has(keyOf(it))} onChange={() => toggle(keyOf(it))} />
        <div>
          <div className="bill-title">{itemTitle(it)}</div>
          {(showMonth || it.paid_try > 0) && (
            <div className="bill-sub">
              {showMonth && <span className="pick-month">{monthLabel(it.month)}</span>}
              {it.paid_try > 0 && <span className="bill-left">{tr.billing.ofAmount(fmtTRY(it.paid_try))} · <b>{P.itemLeft(fmtTRY(it.remaining_try))}</b></span>}
            </div>
          )}
        </div>
        <span className="bill-amount amount">{fmtTRY(it.remaining_try)}</span>
      </label>
    </li>
  );
  const pick = (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!/pdf$/i.test(f.name) && f.type !== "application/pdf") return say(tr.billing.onlyPdf);
    setFile(f);
  };
  const run = async (fn) => {
    setBusy(true);
    try {
      if ((await fn()) !== false) { setSel(new Set()); setNote(""); setFile(null); setUseCredit(false); typed.current = false; setAmount(""); }
    } catch (err) { say(err.message || tr.err.generic); } finally { setBusy(false); }
  };
  const submit = (e) => { e.preventDefault(); run(() => onSave({ charges: [...sel], amount: n, note: note.trim(), file: fromCredit ? null : file, fromCredit })); };

  if (!receipt && !all.length)
    return <section className="card pay-card pay-form draft"><div className="pay-head">{head}</div><p className="hint">{P.none}</p></section>;
  return (
    <form className={"card pay-card pay-form draft" + (receipt ? " a-rcpt" : "")} onSubmit={submit}>
      <div className="pay-head">
        {head}
        <span className="pill draft"><DraftG />{receipt ? tr.billing.status.pending : P.draft}</span>
      </div>
      <p className="hint">{receipt ? A.pendingHint : P.hint}</p>
      {all.length > 0 ? (
        <fieldset className="pay-items">
          <legend>{P.covers}</legend>
          {open.length > 0 ? <ul className="pay-pick">{open.map((it) => pickRow(it, false))}</ul> : <p className="hint">{P.none}</p>}
          {away.length > 0 && (
            <>
              <div className="pay-legend pay-away">{P.otherMonths}</div>
              <ul className="pay-pick">{away.map((it) => pickRow(it, true))}</ul>
            </>
          )}
        </fieldset>
      ) : <p className="hint">{P.none}</p>}
      {credit > 0 && !receipt && (
        <div className="pay-credit">
          <label className="check"><input type="checkbox" checked={useCredit} onChange={(e) => { setUseCredit(e.target.checked); typed.current = false; }} /><span>{P.fromCredit(fmtTRY(credit))}</span></label>
          {fromCredit && <p className="hint">{P.fromCreditHint}</p>}
        </div>
      )}
      <PaySummary count={sel.size} sum={sum} paid={paid} spill={spill} owed={surplus - spill}>
        {[
          <label key="l" htmlFor={amountId}>{fromCredit ? P.creditUsed : P.amount}</label>,
          <input key="i" id={amountId} className="pay-amount" type="number" min="1" max={fromCredit ? credit : undefined} step="1" required inputMode="numeric" value={amount}
            onChange={(e) => { typed.current = true; setAmount(e.target.value); }} />,
        ]}
      </PaySummary>
      {overCredit && <p className="hint warn-text" role="alert">{P.overCredit}</p>}
      <label className="field"><span>{P.note}</span><input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {receipt ? (receipt.has_pdf && <PdfToggle src={`/api/receipts/${receipt.id}/pdf`} title={receipt.filename} />) : fromCredit ? null : (
        <div className="pay-pdf">
          <div className="row wrap">
            <label className="btn file" aria-disabled={busy}>
              <input type="file" accept="application/pdf,.pdf" onChange={pick} disabled={busy} />
              <UploadG width="16" height="16" />{file ? P.changePdf : P.pickPdf}
            </label>
            {file && (
              <>
                <span className="muted small pdf-name">{file.name}</span>
                <button type="button" className="btn sm ghost" onClick={() => setFile(null)}>{P.clearPdf}</button>
              </>
            )}
          </div>
          {file && blobUrl && <PdfToggle key={blobUrl} src={blobUrl} title={file.name} />}
        </div>
      )}
      {!sel.size && all.length > 0 && <p className="hint">{P.pickFirst}</p>}
      <div className="row end wrap">
        {onReject && <button type="button" className="btn danger" disabled={busy} onClick={() => run(() => onReject(note.trim()))}>{A.reject}</button>}
        <button className="btn primary" disabled={busy || !sel.size || !(n > 0) || overCredit}>{P.submit}</button>
      </div>
    </form>
  );
}

/** A member's own upload, not yet reviewed = a DRAFT payment with the PDF already attached. Items = the receipt's
 *  month (from the caller when it has them, else fetched). Approve = recordPayment's allocation into this row. */
function PendingReceiptCard({ r, items: given, elsewhere: givenElse, onReview, showUser, say }) {
  const [fetched, setFetched] = useState(null);
  const [err, setErr] = useState("");
  const load = () => { setErr(""); api("GET", `/admin/users/${r.user_id}/billing?month=${r.month}`).then((d) => setFetched(d), (e) => setErr(e.message || tr.err.load)); };
  useEffect(() => { if (!given) load(); }, [given, r.user_id, r.month]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = given ?? fetched?.items;
  const elsewhere = given ? givenElse : fetched?.other_open;
  const head = <span><b>{showUser ? r.user_name : monthLabel(r.month)}</b>{showUser && <span className="muted small"> · {monthLabel(r.month)}</span>}<span className="muted small"> · {fmtDateTimeShort(r.uploaded_at)}</span></span>;
  if (!items) return <li>{err ? <ErrorState message={err} onRetry={load} /> : <Skeleton rows={2} />}</li>;
  return (
    <li>
      <PaymentComposer items={items} elsewhere={elsewhere} receipt={r} head={head} say={say}
        onSave={({ charges, amount, note }) => onReview(r, "approve", note, { amount_try: amount, charges, month: r.month })}
        onReject={(note) => onReview(r, "reject", note)} />
    </li>
  );
}

/**
 * A payment AFTER it was saved ("Ödemeyi onayla"): read-only. Only the items it was recorded for (not the whole
 * list), their total, what was actually paid, and what that left - kalan / surplus on other items / credit.
 * PDF only if there is one. The undo (reject) is tucked away in a disclosure. Rejected/undone ones render muted.
 */
function ReceiptCard({ r, onReview, showUser = true, items, elsewhere, say }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (r.status === "pending") return <PendingReceiptCard r={r} items={items} elsewhere={elsewhere} onReview={onReview} showUser={showUser} say={say} />;
  const ok = r.status === "ok";
  const review = async (action) => { setBusy(true); try { if ((await onReview(r, action, note)) !== false) setNote(""); } finally { setBusy(false); } };
  const picked = r.charges.filter((c) => c.selected !== false);
  const adminNote = ok ? (r.admin_note || "").replace(/^Yönetici (kaydetti|onayladı):?\s*/, "") : "";
  return (
    <li className={"card pay-card a-rcpt " + (ok ? "saved" : "void")}>
      <div className="pay-head">
        <span><b>{showUser ? r.user_name : monthLabel(r.month)}</b>{showUser && <span className="muted small"> · {monthLabel(r.month)}</span>}</span>
        {ok ? <span className="pill ok"><CheckG />{P.savedPill}</span>
          : r.admin_note != null ? <span className="pill"><DashG />{A.rejected}</span> : <StatusPill flag={r.status} />}
      </div>
      <div className="muted small">{fmtDateTimeShort(r.uploaded_at)}{r.bank_ref ? ` · ${A.bankRef}: ${r.bank_ref}` : ""}</div>
      {!ok && <p className="rcpt-msg">{r.message}</p>}
      {picked.length > 0 && (
        <div className="pay-items">
          <div className="pay-legend">{P.coversSaved}</div>
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
      {ok && <PaySummary saved count={picked.length} sum={r.expected_try} paid={r.paid_try} spill={r.spill_try} owed={r.overpaid_try} paidLabel={r.from_credit ? P.creditUsed : P.paid} />}
      {adminNote && <p className="rcpt-msg">{adminNote}</p>}
      {r.has_pdf && <PdfToggle src={`/api/receipts/${r.id}/pdf`} title={r.filename} />}
      {(ok || r.charges.length > 0) && <details className="pay-undo">
        <summary>{ok ? P.undo : P.redo}</summary>
        {ok && <p className="hint">{P.undoHint}</p>}
        <div className="review">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={A.notePh} aria-label={A.notePh} />
          {ok ? <button type="button" className="btn danger" disabled={busy} onClick={() => review("reject")}>{P.undoBtn}</button>
            : <button type="button" className="btn good" disabled={busy} onClick={() => review("approve")}>{P.redo}</button>}
        </div>
      </details>}
    </li>
  );
}

const STATUS_OPTS = ["ok", "mismatch", "unreadable", "duplicate", "pending"];

const O = A.overview;

/**
 * Everyone at a glance: one row per member with what they still owe. `outstanding_try` is the SELECTED month,
 * `debt_try` every month up to now (unpaid items stay in their own month - nothing rolls forward), both computed
 * server-side by GET /admin/billing/overview so the totals are one SQL SUM, not N requests.
 */
function Outstanding({ data, onDetail }) {
  const clear = data.total_debt_try === 0;
  return (
    <>
      <section className={"card owe-sum" + (clear ? " clear" : "")} aria-label={O.totalOutstanding}>
        <div>
          <small>{O.totalOutstanding}</small>
          <b className="amount">{fmtTRY(data.total_outstanding_try)}</b>
        </div>
        <div>
          <small>{O.totalDebt}</small>
          <b className="amount">{fmtTRY(data.total_debt_try)}</b>
        </div>
        <p className="owe-note">{clear ? O.allClear : O.owing(data.owing_count, data.users.length)}</p>
      </section>
      {!data.users.length ? <EmptyState title={O.empty[0]} body={O.empty[1]} /> : (
        <ul className="card owe-list" aria-label={O.title}>
          <li className="owe-head" aria-hidden="true"><span>{O.member}</span><span>{O.thisMonth}</span><span>{O.debt}</span></li>
          {data.users.map((u) => (
            <li key={u.id}>
              <button type="button" className="owe-row" onClick={() => onDetail(u)} aria-label={O.open(u.name)}>
                <span className="owe-name">{u.name}{!u.active && <span className="muted small"> · {O.inactive}</span>}</span>
                <span className={"owe-amt amount" + (u.outstanding_try > 0 ? " owed" : "")}>{fmtTRY(u.outstanding_try)}</span>
                <span className={"owe-amt amount" + (u.debt_try > 0 ? " owed" : "")}>{fmtTRY(u.debt_try)}</span>
              </button>
            </li>
          ))}
          <li className="owe-total">
            <span>{O.totalRow}</span>
            <span className="owe-amt amount">{fmtTRY(data.total_outstanding_try)}</span>
            <span className="owe-amt amount">{fmtTRY(data.total_debt_try)}</span>
          </li>
        </ul>
      )}
    </>
  );
}

/**
 * The "Ödemeler" admin screen. Defaults to the CURRENT month and to ALL members: no member is pre-selected, the
 * overview above lists everyone. A row click hands the member to the per-user drill-down (UserDetail) upstairs.
 */
export function Payments({ onDetail }) {
  const [month, setMonth] = useState(nowMonth());
  const [f, setF] = useState({ user_id: "", status: "" });
  const [allMonths, setAllMonths] = useState(false);
  const [ov, setOv] = useState(null);
  const [ovErr, setOvErr] = useState("");
  const [list, setList] = useState(null);
  const [users, setUsers] = useState([]);
  const [say, toast] = useToast();
  useEffect(() => { api("GET", "/users").then(setUsers, () => {}); }, []);

  const [loadErr, setLoadErr] = useState("");
  const loadOv = () => {
    setOvErr(""); setOv(null);
    api("GET", `/admin/billing/overview?month=${month}`).then(setOv, (e) => setOvErr(e.message || tr.err.load));
  };
  useEffect(loadOv, [month]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = () => {
    const q = new URLSearchParams(Object.entries({ ...f, month: allMonths ? "" : month }).filter(([, v]) => v)).toString();
    setLoadErr(""); setList(null);
    api("GET", "/admin/receipts" + (q ? "?" + q : "")).then(setList, (e) => setLoadErr(e.message || tr.err.load));
  };
  useEffect(load, [f, month, allMonths]); // eslint-disable-line react-hooks/exhaustive-deps
  const review = async (r, action, note, extra) => {
    try {
      const upd = await api("POST", `/admin/receipts/${r.id}/${action}`, { note, ...extra });
      setList((l) => l.map((x) => (x.id === r.id ? upd : x)));
      loadOv();
      say(action === "approve" ? A.approved : A.rejected);
    } catch (e) { say(e.message || tr.err.generic); return false; }
  };
  return (
    <section>
      <div className="page-head"><h2>{O.title}</h2></div>
      {ov && <MonthNav month={ov.month} months={ov.months} onChange={setMonth} />}
      {!ov && (ovErr ? <ErrorState message={ovErr} onRetry={loadOv} /> : <Skeleton rows={3} />)}
      {ov && <Outstanding data={ov} onDetail={onDetail} />}

      <h3 className="sec-title">{A.receiptsTitle}</h3>
      <div className="filters">
        <label className="field"><span>{A.member}</span>
          <select value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })}>
            <option value="">{A.all}</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label className="field"><span>{A.statusLabel}</span>
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="">{A.all}</option>
            {STATUS_OPTS.map((s) => <option key={s} value={s}>{tr.billing.status[s === "ok" ? "paid" : s]}</option>)}
          </select>
        </label>
      </div>
      <label className="check"><input type="checkbox" checked={allMonths} onChange={(e) => setAllMonths(e.target.checked)} /><span>{A.allMonths}</span></label>
      {!list && (loadErr ? <ErrorState message={loadErr} onRetry={load} /> : <Skeleton rows={3} />)}
      {list && !list.length && <EmptyState title={tr.empty.receipts[0]} body={tr.empty.receipts[1]} />}
      <ul className="list">{(list || []).map((r) => <ReceiptCard key={r.id} r={r} onReview={review} say={say} />)}</ul>
      {toast}
    </section>
  );
}

/**
 * Admin records a payment by hand: a DRAFT PaymentComposer over the month's open items. The dekont PDF is optional
 * evidence only - it is no longer parsed for an amount in the UI (the admin types what was paid; the server still
 * stores the parse metadata and flags a re-filed dekont with `duplicate`, shown as a toast after saving).
 */
function RecordPayment({ userId, month, items, elsewhere, credit, onSaved, say }) {
  const save = async ({ charges, amount, note, file, fromCredit }) => {
    const q = new URLSearchParams({ month, amount_try: String(amount), charges: charges.join(",") });
    if (file) q.set("filename", file.name);
    if (note) q.set("note", note);
    if (fromCredit) q.set("from_credit", "1");
    const out = await apiUpload(`/admin/users/${userId}/receipts?${q}`, file);
    say(out.duplicate ? P.dupWarn : P.saved);
    await onSaved();
  };
  return <PaymentComposer items={items} elsewhere={elsewhere} credit={credit} head={<h3>{P.title}</h3>} onSave={save} say={say} />;
}

/** Per-user payments + reservations (admin). */
export function UserDetail({ user, onBack }) {
  const [data, setData] = useState(null);
  const [res, setRes] = useState(null);
  const [adj, setAdj] = useState({ amount: "", label: "" });
  const [say, toast] = useToast();
  const [loadErr, setLoadErr] = useState("");
  const load = (month) => {
    setLoadErr("");
    return api("GET", `/admin/users/${user.id}/billing${month ? `?month=${month}` : ""}`).then(
      (d) => setData(d),
      (e) => { setLoadErr(e.message || tr.err.load); say(e.message); },
    );
  };
  useEffect(() => { load(); api("GET", `/admin/users/${user.id}/reservations`).then(setRes, () => {}); }, [user.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const waive = async (it, waived) => { try { await api("POST", `/admin/charges/${it.id}/waive`, { waived }); say(waived ? A.waived : A.unwaive); load(data.month); } catch (e) { say(e.message); } };
  const review = async (r, action, note, extra) => {
    try { await api("POST", `/admin/receipts/${r.id}/${action}`, { note, ...extra }); say(action === "approve" ? A.approved : A.rejected); await load(data.month); }
    catch (e) { say(e.message); return false; }
  };
  const [settle, setSettle] = useState({ amount: "", note: "" });
  const settleCredit = async (e) => {
    e.preventDefault();
    try {
      await api("POST", `/admin/users/${user.id}/credit/settle`, { amount_try: settle.amount === "" ? undefined : Number(settle.amount), note: settle.note });
      setSettle({ amount: "", note: "" }); say(A.credit.settled); load(data.month);
    } catch (err) { say(err.message); }
  };
  const addAdj = async (e) => {
    e.preventDefault();
    try {
      await api("POST", `/admin/users/${user.id}/charges`, { month: data.month, amount_try: Number(adj.amount), note: adj.label });
      setAdj({ amount: "", label: "" }); say(A.adjusted); load(data.month);
    } catch (err) { say(err.message); }
  };

  return (
    <section>
      <div className="detail-head">
        <button className="icon-btn" onClick={onBack} aria-label={A.back}><ChevronLeftIcon /></button>
        <h2>{user.name}</h2>
      </div>
      {!data && (loadErr ? <ErrorState message={loadErr} onRetry={() => load()} /> : <Skeleton rows={3} />)}
      {data && (
        <>
          <MonthNav month={data.month} months={data.months} onChange={load} />
          <KalanCard data={data} />
          <CreditCover cover={data.credit_cover} />
          {data.credit.balance_try > 0 && (
            <CreditCard credit={data.credit}>
              <form className="form-row" onSubmit={settleCredit}>
                <label className="field"><span>{A.credit.amountLabel}</span><input type="number" min="1" max={data.credit.balance_try} step="1" value={settle.amount} onChange={(e) => setSettle({ ...settle, amount: e.target.value })} /></label>
                <label className="field"><span>{A.notePh}</span><input maxLength={200} placeholder={A.credit.notePh} value={settle.note} onChange={(e) => setSettle({ ...settle, note: e.target.value })} /></label>
                <button className="btn primary">{A.credit.settle}</button>
              </form>
            </CreditCard>
          )}
          {data.credit.settlements.length > 0 && (
            <ul className="card plain-list" aria-label={A.credit.history}>
              {data.credit.settlements.map((x) => <li key={x.id}><span>{fmtDateTimeShort(x.created_at)}{x.note ? ` · ${x.note}` : ""}</span><span className="num">{fmtTRY(x.amount_try)}</span></li>)}
            </ul>
          )}
          {/* read-only item list (waive/unwaive only) - WHAT a payment covers is picked inside the payment form below */}
          <ItemList items={data.items} empty={data.future ? tr.billing.future.empty : undefined} extra={(it) =>
            it.status === "unpaid" ? <button className="btn sm ghost" onClick={() => waive(it, true)}>{A.waive}</button>
              : it.status === "waived" ? <button className="btn sm ghost" onClick={() => waive(it, false)}>{A.unwaive}</button> : null} />
          {/* order matters (user request 2026-09-23): add an extra charge first, then record the payment that covers it */}
          <form className="card form adj-form" onSubmit={addAdj}>
            <h3>{A.adjust}</h3>
            <div className="filters" style={{ marginBottom: 0 }}>
              <label className="field"><span>{A.adjustAmount}</span><input type="number" min="1" step="1" required value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} /></label>
              <label className="field"><span>{A.adjustLabel}</span><input required maxLength={120} placeholder={A.adjustPh} value={adj.label} onChange={(e) => setAdj({ ...adj, label: e.target.value })} /></label>
            </div>
            <div className="row end"><button className="btn primary" disabled={!adj.amount || !adj.label.trim()}>{A.adjustAdd}</button></div>
          </form>
          <RecordPayment userId={user.id} month={data.month} items={data.items} elsewhere={data.other_open} credit={data.credit.balance_try} say={say} onSaved={() => load(data.month)} />
          <h3 className="sec-title">{A.payments}</h3>
          {!data.receipts.length && <EmptyState title={tr.empty.receipts[0]} body={tr.empty.receipts[1]} />}
          <ul className="list">{data.receipts.map((r) => (
            <ReceiptCard key={r.id} r={r} onReview={review} showUser={false} say={say}
              items={r.month === data.month ? data.items : undefined} elsewhere={r.month === data.month ? data.other_open : undefined} />
          ))}</ul>
        </>
      )}
      <h3 className="sec-title">{A.reservations}</h3>
      {res && !res.length && <EmptyState title={tr.empty.reservations[0]} body={tr.empty.reservations[1]} />}
      {res && res.length > 0 && (
        <ul className="card plain-list">
          {res.map((r) => (
            <li key={r.id} className={r.cancelled_at ? "gone" : ""}>
              <span>{fmtDateTimeShort(r.start_ms)}{r.note ? ` · ${r.note}` : ""} · {tr.cal.peopleCount(r.people)}{r.cancelled_at ? ` (${A.cancelledRes})` : ""}</span>
              <span className="num">{fmtTRY(r.charge_try ?? 0)}</span>
            </li>
          ))}
          <li className="total">
            <span>{A.resTotal}</span>
            <span className="num amount">{fmtTRY(res.filter((r) => !r.cancelled_at).reduce((s, r) => s + (r.charge_try ?? 0), 0))}</span>
          </li>
        </ul>
      )}
      {toast}
    </section>
  );
}

export function Fees() {
  const [fees, setFees] = useState(null);
  const [form, setForm] = useState({ effective_from: nextOf(nowMonth()), subscription_try: "", booking_try: "" });
  const [say, toast] = useToast();
  const [loadErr, setLoadErr] = useState("");
  const loadFees = () => { setLoadErr(""); api("GET", "/admin/fees").then(setFees, (e) => setLoadErr(e.message || tr.err.load)); };
  useEffect(loadFees, []); // eslint-disable-line react-hooks/exhaustive-deps
  const now = nowMonth();
  const cur = fees?.find((x) => x.effective_from <= now);
  useEffect(() => { if (cur && form.subscription_try === "") setForm((f) => ({ ...f, subscription_try: cur.subscription_try, booking_try: cur.booking_try })); }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (e) => {
    e.preventDefault();
    try {
      setFees(await api("POST", "/admin/fees", { effective_from: form.effective_from, subscription_try: Number(form.subscription_try), booking_try: Number(form.booking_try) }));
      say(A.feesSaved);
    } catch (err) { say(err.message); }
  };
  return (
    <section>
      <div className="page-head"><h2>{A.feesTitle}</h2></div>
      {!fees && (loadErr ? <ErrorState message={loadErr} onRetry={loadFees} /> : <Skeleton rows={1} />)}
      {cur && (
        <div className="card fee-now" aria-label={A.feesNow}>
          <div><small>{A.feesSub}</small><b className="amount">{fmtTRY(cur.subscription_try)}</b></div>
          <div><small>{A.feesBook}</small><b className="amount">{fmtTRY(cur.booking_try)}</b></div>
        </div>
      )}
      <form className="card form" onSubmit={save}>
        <h3>{A.feesNew}</h3>
        <label className="field"><span>{A.feesFrom}</span><input type="month" required min={nextOf(now)} value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} /></label>
        <div className="filters" style={{ marginBottom: 0 }}>
          <label className="field"><span>{A.feesSub}</span><input type="number" min="0" step="50" required value={form.subscription_try} onChange={(e) => setForm({ ...form, subscription_try: e.target.value })} /></label>
          <label className="field"><span>{A.feesBook}</span><input type="number" min="0" step="50" required value={form.booking_try} onChange={(e) => setForm({ ...form, booking_try: e.target.value })} /></label>
        </div>
        <p className="hint">{A.feesNote}</p>
        <div className="row end"><button className="btn primary">{A.feesSave}</button></div>
      </form>
      {fees && (
        <>
          <h3 className="sec-title">{A.feesHistory}</h3>
          <ul className="card plain-list">
            {fees.map((x) => (
              <li key={x.id}>
                <span>{x.effective_from === "2000-01" ? "—" : monthLabel(x.effective_from)}</span>
                <span className="num">{fmtTRY(x.subscription_try)} · {fmtTRY(x.booking_try)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {toast}
    </section>
  );
}

export function PaySettings() {
  const [s, setS] = useState(null);
  const [say, toast] = useToast();
  const [loadErr, setLoadErr] = useState("");
  const [withPdf, setWithPdf] = useState(false);
  const loadS = () => { setLoadErr(""); api("GET", "/admin/settings").then(setS, (e) => setLoadErr(e.message || tr.err.load)); };
  useEffect(loadS, []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (e) => {
    e.preventDefault();
    try { setS(await api("PUT", "/admin/settings", s)); say(A.settingsSaved); } catch (err) { say(err.message); }
  };
  if (!s) return <section><div className="page-head"><h2>{A.settingsTitle}</h2></div>{loadErr ? <ErrorState message={loadErr} onRetry={loadS} /> : <Skeleton rows={2} />}</section>;
  return (
    <section>
      <div className="page-head"><h2>{A.settingsTitle}</h2></div>
      <form className="card form" onSubmit={save}>
        <label className="field"><span>{A.settingsIban}</span><input value={s.iban} placeholder="TR00 0000 0000 0000 0000 0000 00" autoComplete="off" onChange={(e) => setS({ ...s, iban: e.target.value })} /></label>
        <label className="field"><span>{A.settingsHolder}</span><input value={s.holder} onChange={(e) => setS({ ...s, holder: e.target.value })} /></label>
        <label className="check">
          <input type="checkbox" checked={s.requireRecipient} onChange={(e) => setS({ ...s, requireRecipient: e.target.checked })} />
          <span>{A.settingsRequire}</span>
        </label>
        <p className="hint">{A.settingsRequireHint}</p>
        <div className="row end"><button className="btn primary">{A.settingsSave}</button></div>
      </form>
      <section className="card form export" aria-label={tr.export.title}>
        <h3>{tr.export.title}</h3>
        <p className="hint">{tr.export.hint}</p>
        <label className="check">
          <input type="checkbox" checked={withPdf} onChange={(e) => setWithPdf(e.target.checked)} />
          <span>{tr.export.withPdf}</span>
        </label>
        <div className="row wrap">
          <a className="btn primary" href={`/api/admin/export?format=json${withPdf ? "&pdf=1" : ""}`} download>{tr.export.json}</a>
          <a className="btn" href="/api/admin/export?format=csv" download>{tr.export.csv}</a>
        </div>
      </section>
      {toast}
    </section>
  );
}
