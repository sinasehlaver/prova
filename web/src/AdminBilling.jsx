import React, { useEffect, useRef, useState } from "react";
import { api, apiUpload } from "./api.js";
import { tr } from "./tr.js";
import { ChevronLeftIcon } from "./icons.jsx";
import { EmptyState, ErrorState, Skeleton } from "./States.jsx";
import { CreditCard, ItemList, KalanCard, MonthNav, StatusPill, UploadG, fmtTRY, monthLabel } from "./Billing.jsx";

const A = tr.admin;
const fmtDateTimeShort = (ms) => new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Istanbul" }).format(ms);
const nowMonth = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);
const nextOf = (m) => (m.slice(5) === "12" ? `${+m.slice(0, 4) + 1}-01` : `${m.slice(0, 5)}${String(+m.slice(5) + 1).padStart(2, "0")}`);

export function useToast() {
  const [msg, setMsg] = useState("");
  const t = useRef();
  const say = (m) => { setMsg(m); clearTimeout(t.current); t.current = setTimeout(() => setMsg(""), 2200); };
  return [say, <div key="toast" className={"toast" + (msg ? " show" : "")} role="status">{msg}</div>];
}

/** Receipt card: extracted amount next to expected, inline PDF, approve / reject with an optional note. */
function ReceiptCard({ r, onReview, showUser = true }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const review = async (action) => { setBusy(true); try { await onReview(r, action, note); setNote(""); } finally { setBusy(false); } };
  const found = r.found_try ?? r.amounts[0];
  const off = found != null && Math.round(found * 100) !== Math.round(r.expected_try * 100); // no PDF (cash) is not "wrong"
  return (
    <li className="card a-rcpt">
      <div className="a-rcpt-top">
        <span><b>{showUser ? r.user_name : monthLabel(r.month)}</b>{showUser && <span className="muted small"> · {monthLabel(r.month)}</span>}</span>
        <StatusPill status={r.status === "ok" ? "paid" : undefined} flag={r.status === "ok" ? undefined : r.status} partial={r.status === "ok" && r.remaining_try > 0} />
      </div>
      <div className="cmp">
        <div><small>{A.expected}</small><b className="amount">{fmtTRY(r.expected_try)}</b></div>
        <div className={off ? "off" : ""}><small>{A.found}</small><b className="amount">{found == null ? "—" : fmtTRY(found)}</b></div>
      </div>
      {r.status === "ok" && (r.remaining_try > 0 || r.overpaid_try > 0) && (
        <div className="cmp">
          <div><small>{A.applied}</small><b className="amount">{fmtTRY(r.applied_try)}</b></div>
          {r.remaining_try > 0 ? <div className="off"><small>{A.remainingLeft}</small><b className="amount">{fmtTRY(r.remaining_try)}</b></div>
            : <div className="good"><small>{A.overpaid}</small><b className="amount">{fmtTRY(r.overpaid_try)}</b></div>}
        </div>
      )}
      <p className="rcpt-msg">{r.message}</p>
      <div>
        <div className="muted small">{A.covers}</div>
        <ul className="covers">
          {r.charges.map((c) => <li key={c.id}>{c.kind === "subscription" ? tr.billing.subscription : c.kind === "adjustment" ? c.note || tr.billing.adjustment : tr.billing.booking} · {fmtTRY(c.amount_try)}</li>)}
        </ul>
      </div>
      <div className="muted small">{r.filename} · {fmtDateTimeShort(r.uploaded_at)}{r.bank_ref ? ` · ${A.bankRef}: ${r.bank_ref}` : ""}</div>
      <div className="review">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={A.notePh} aria-label={A.notePh} />
        <button className="btn good" disabled={busy || (r.status === "ok" && r.admin_note != null)} onClick={() => review("approve")}>{A.approve}</button>
        <button className="btn danger" disabled={busy || (r.status !== "ok" && r.admin_note != null)} onClick={() => review("reject")}>{A.reject}</button>
      </div>
      <div className="row wrap">
        <button className="btn sm ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "PDF'i gizle" : "PDF'i göster"}</button>
        <a className="link" href={`/api/receipts/${r.id}/pdf`} target="_blank" rel="noreferrer">{A.openPdf}</a>
      </div>
      {open && <embed className="embed" src={`/api/receipts/${r.id}/pdf`} type="application/pdf" title={r.filename || "Dekont"} />}
    </li>
  );
}

const STATUS_OPTS = ["ok", "mismatch", "unreadable", "duplicate"];

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
  const review = async (r, action, note) => {
    try {
      const upd = await api("POST", `/admin/receipts/${r.id}/${action}`, { note });
      setList((l) => l.map((x) => (x.id === r.id ? upd : x)));
      loadOv();
      say(action === "approve" ? A.approved : A.rejected);
    } catch (e) { say(e.message || tr.err.generic); }
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
      <ul className="list">{(list || []).map((r) => <ReceiptCard key={r.id} r={r} onReview={review} />)}</ul>
      {toast}
    </section>
  );
}

/**
 * Manual payment recording - the member-facing self-serve upload is switched off, so this is how money gets booked.
 * The admin ticks the paid items, types the amount that was actually paid and may attach the dekont PDF. The PDF is
 * only parsed for a SUGGESTION (POST /admin/receipts/parse stores nothing); what counts is the typed amount, which
 * the server allocates oldest-item-first (under = kalan stays, over = spills onto the month, then becomes credit).
 */
function RecordPayment({ userId, month, sel, outstanding, onSaved, say }) {
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const typed = useRef(false); // once the admin types an amount, the selection/PDF stop overwriting it
  useEffect(() => { if (!typed.current) setAmount(outstanding > 0 ? String(outstanding) : ""); }, [outstanding]);

  const pick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!/pdf$/i.test(f.name) && f.type !== "application/pdf") return say(tr.billing.onlyPdf);
    setFile(f); setParsed(null); setBusy(true);
    try {
      const p = await apiUpload(`/admin/receipts/parse?expected_try=${outstanding}`, f);
      setParsed(p);
      if (p.suggest_try != null && !typed.current) setAmount(String(p.suggest_try));
    } catch (err) { say(err.message || tr.err.generic); } finally { setBusy(false); }
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const q = new URLSearchParams({ month, amount_try: String(amount), charges: [...sel].join(",") });
      if (file) q.set("filename", file.name);
      if (note.trim()) q.set("note", note.trim());
      const out = await apiUpload(`/admin/users/${userId}/receipts?${q}`, file);
      say(out.duplicate ? A.pay.dupWarn : A.pay.saved);
      setFile(null); setParsed(null); setNote(""); typed.current = false;
      await onSaved();
    } catch (err) { say(err.message || tr.err.generic); } finally { setBusy(false); }
  };

  if (!sel.size && outstanding <= 0)
    return <section className="card form pay-form"><h3>{A.pay.title}</h3><p className="hint">{A.pay.none}</p></section>;
  const n = Number(amount);
  const delta = n > 0 ? n - outstanding : 0;
  return (
    <form className="card form pay-form" onSubmit={save}>
      <h3>{A.pay.title}</h3>
      <p className="hint">{A.pay.hint}</p>
      <div className="upload-sum"><span>{A.pay.selected(sel.size)}</span><b className="amount">{A.pay.outstanding(fmtTRY(outstanding))}</b></div>
      <div className="row wrap">
        <label className="btn file" aria-disabled={busy}>
          <input type="file" accept="application/pdf,.pdf" onChange={pick} disabled={busy} />
          <UploadG width="16" height="16" />{file ? A.pay.changePdf : A.pay.pickPdf}
        </label>
        {file && (
          <>
            <span className="muted small">{file.name}</span>
            <button type="button" className="btn sm ghost" onClick={() => { setFile(null); setParsed(null); }}>{A.pay.clearPdf}</button>
          </>
        )}
      </div>
      {busy && file && !parsed && <p className="pay-parsed"><span className="spin" /> {A.pay.reading}</p>}
      {parsed && (
        <p className={"pay-parsed" + (parsed.duplicate ? " warn" : "")}>
          {parsed.found_try == null ? A.pay.foundNone : A.pay.found(fmtTRY(parsed.found_try))}
          {parsed.duplicate ? ` ${A.pay.dupWarn}` : ""}
        </p>
      )}
      <div className="filters" style={{ marginBottom: 0 }}>
        <label className="field"><span>{A.pay.amount}</span>
          <input type="number" min="1" step="1" required value={amount} onChange={(e) => { typed.current = true; setAmount(e.target.value); }} />
        </label>
        <label className="field"><span>{A.pay.note}</span><input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {delta < 0 && <p className="hint warn">{A.pay.under}</p>}
      {delta > 0 && <p className="hint warn">{A.pay.over}</p>}
      <div className="row end"><button className="btn primary" disabled={busy || !sel.size || !(n > 0)}>{A.pay.submit}</button></div>
    </form>
  );
}

/** Per-user payments + reservations (admin). */
export function UserDetail({ user, onBack }) {
  const [data, setData] = useState(null);
  const [res, setRes] = useState(null);
  const [adj, setAdj] = useState({ amount: "", label: "" });
  const [sel, setSel] = useState(new Set());
  const [say, toast] = useToast();
  const [loadErr, setLoadErr] = useState("");
  const load = (month) => {
    setLoadErr("");
    return api("GET", `/admin/users/${user.id}/billing${month ? `?month=${month}` : ""}`).then(
      (d) => { setData(d); setSel(new Set(d.items.filter((i) => i.status === "unpaid").map((i) => i.id))); },
      (e) => { setLoadErr(e.message || tr.err.load); say(e.message); },
    );
  };
  const toggleSel = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  useEffect(() => { load(); api("GET", `/admin/users/${user.id}/reservations`).then(setRes, () => {}); }, [user.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const waive = async (it, waived) => { try { await api("POST", `/admin/charges/${it.id}/waive`, { waived }); say(waived ? A.waived : A.unwaive); load(data.month); } catch (e) { say(e.message); } };
  const review = async (r, action, note) => { try { await api("POST", `/admin/receipts/${r.id}/${action}`, { note }); say(action === "approve" ? A.approved : A.rejected); load(data.month); } catch (e) { say(e.message); } };
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
          <ItemList items={data.items} selectable selected={sel} onToggle={toggleSel} extra={(it) =>
            it.status === "unpaid" ? <button className="btn sm ghost" onClick={() => waive(it, true)}>{A.waive}</button>
              : it.status === "waived" ? <button className="btn sm ghost" onClick={() => waive(it, false)}>{A.unwaive}</button> : null} />
          <RecordPayment
            userId={user.id} month={data.month} sel={sel} say={say} onSaved={() => load(data.month)}
            outstanding={data.items.filter((i) => sel.has(i.id) && i.status === "unpaid").reduce((s, i) => s + (i.remaining_try ?? i.amount_try), 0)}
          />
          <form className="card form" style={{ marginTop: "var(--s-4)" }} onSubmit={addAdj}>
            <h3>{A.adjust}</h3>
            <div className="filters" style={{ marginBottom: 0 }}>
              <label className="field"><span>{A.adjustAmount}</span><input type="number" min="1" step="1" required value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} /></label>
              <label className="field"><span>{A.adjustLabel}</span><input required maxLength={120} placeholder={A.adjustPh} value={adj.label} onChange={(e) => setAdj({ ...adj, label: e.target.value })} /></label>
            </div>
            <div className="row end"><button className="btn primary" disabled={!adj.amount || !adj.label.trim()}>{A.adjustAdd}</button></div>
          </form>
          <h3 className="sec-title">{A.payments}</h3>
          {!data.receipts.length && <EmptyState title={tr.empty.receipts[0]} body={tr.empty.receipts[1]} />}
          <ul className="list">{data.receipts.map((r) => <ReceiptCard key={r.id} r={r} onReview={review} showUser={false} />)}</ul>
        </>
      )}
      <h3 className="sec-title">{A.reservations}</h3>
      {res && !res.length && <EmptyState title={tr.empty.reservations[0]} body={tr.empty.reservations[1]} />}
      {res && res.length > 0 && (
        <ul className="card plain-list">
          {res.map((r) => (
            <li key={r.id} className={r.cancelled_at ? "gone" : ""}>
              <span>{fmtDateTimeShort(r.start_ms)}{r.note ? ` · ${r.note}` : ""}{r.cancelled_at ? ` (${A.cancelledRes})` : ""}</span>
              <span className="num">{r.booker_name}</span>
            </li>
          ))}
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
