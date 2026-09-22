import React, { useCallback, useEffect, useState } from "react";
import "./billing.css";
import "./economics.css";
import { api } from "./api.js";
import { tr } from "./tr.js";
import { ErrorState, Skeleton } from "./States.jsx";
import { MonthNav, monthLabel } from "./Billing.jsx";
import { useToast } from "./AdminBilling.jsx";

const E = tr.eco;
const tl = (n) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 0 }).format(n ?? 0);
const compact = new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 });
const nowMonth = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);
const addM = (m, n) => { const t = +m.slice(0, 4) * 12 + (+m.slice(5) - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; };
const shortMonth = (m) => new Intl.DateTimeFormat("tr-TR", { month: "short", timeZone: "UTC" }).format(Date.UTC(+m.slice(0, 4), +m.slice(5) - 1, 1));
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + tl(Math.abs(n));

/** Nice axis maximum: 1 / 2 / 2.5 / 5 / 10 x 10^n. */
function niceMax(v) {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((s) => s * p >= v) ?? 10) * p;
}
/** Bar with rounded top corners only (data-end), flat on the baseline. */
const topRound = (x, y, w, h, r) => {
  const k = Math.min(r, w / 2, h);
  return `M${x} ${y + h}V${y + k}Q${x} ${y} ${x + k} ${y}H${x + w - k}Q${x + w} ${y} ${x + w} ${y + k}V${y + h}Z`;
};

const CUSTOM = "__custom__";
const W = 360, H = 200, PL = 40, PR = 8, PT = 10, PB = 26;

/** Income vs cost: hollow dashed bar = expected, solid bar = collected, line + dot = cost. Hover/focus a month to read it. */
function Chart({ months }) {
  const [act, setAct] = useState(months.length - 1);
  const [table, setTable] = useState(false);
  const max = niceMax(Math.max(...months.flatMap((m) => [m.expected, m.collected, m.cost])));
  const bw = (W - PL - PR) / months.length, pw = H - PT - PB;
  const y = (v) => PT + pw - (v / max) * pw;
  const bar = Math.min(30, bw * 0.56);
  const cx = (i) => PL + bw * i + bw / 2;
  const a = months[Math.min(act, months.length - 1)];
  const desc = E.chartDesc(months.map((m) => E.rowDesc(monthLabel(m.month), tl(m.expected), tl(m.collected), tl(m.cost))).join(" "));
  return (
    <div className="card eco-chart">
      <div className="eco-head">
        <h3 id="eco-chart-h">{E.chartTitle}</h3>
        <button className="btn ghost sm" onClick={() => setTable((t) => !t)} aria-pressed={table}>{table ? E.chart : E.table}</button>
      </div>
      <ul className="eco-legend" aria-label="Gösterge">
        <li><i className="sw sw-exp" />{E.expected}</li>
        <li><i className="sw sw-inc" />{E.income}</li>
        <li><i className="sw sw-cost" />{E.cost}</li>
      </ul>
      {table ? (
        <div className="eco-tablewrap">
          <table className="eco-table">
            <thead><tr><th>{E.thMonth}</th><th>{E.expected}</th><th>{E.income}</th><th>{E.cost}</th><th>{E.balance}</th></tr></thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}><th scope="row">{monthLabel(m.month)}</th><td>{tl(m.expected)}</td><td>{tl(m.collected)}</td><td>{tl(m.cost)}</td><td className={m.balance < 0 ? "neg" : ""}>{signed(m.balance)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="eco-t eco-d" className="eco-svg">
          <title id="eco-t">{E.chartTitle}</title>
          <desc id="eco-d">{desc}</desc>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line className="grid" x1={PL} x2={W - PR} y1={y(max * f)} y2={y(max * f)} />
              <text className="axis" x={PL - 6} y={y(max * f) + 4} textAnchor="end">{compact.format(max * f)}</text>
            </g>
          ))}
          {months.map((m, i) => {
            const h1 = (m.expected / max) * pw, h2 = (m.collected / max) * pw;
            return (
              <g key={m.month} className={"eco-col" + (i === act ? " on" : "")} tabIndex={0} role="img" aria-label={E.rowDesc(monthLabel(m.month), tl(m.expected), tl(m.collected), tl(m.cost))}
                onMouseEnter={() => setAct(i)} onFocus={() => setAct(i)} onClick={() => setAct(i)}>
                <rect className="hit" x={PL + bw * i} y={PT} width={bw} height={pw + PB} />
                {h1 > 0 && <path className="b-exp" d={topRound(cx(i) - bar / 2, y(m.expected), bar, h1, 4)} />}
                {h2 > 0 && <path className="b-inc" d={topRound(cx(i) - bar / 2, y(m.collected), bar, h2, 4)} />}
                <text className="axis" x={cx(i)} y={H - 8} textAnchor="middle">{shortMonth(m.month)}</text>
              </g>
            );
          })}
          <polyline className="l-cost" points={months.map((m, i) => `${cx(i)},${y(m.cost)}`).join(" ")} />
          {months.map((m, i) => <circle key={m.month} className="d-cost" cx={cx(i)} cy={y(m.cost)} r={i === act ? 5.5 : 4} />)}
        </svg>
      )}
      <div className="eco-read" aria-live="polite">
        <b>{monthLabel(a.month)}</b>
        <dl>
          <div><dt>{E.expected}</dt><dd>{tl(a.expected)}</dd></div>
          <div><dt>{E.income}</dt><dd>{tl(a.collected)}</dd></div>
          <div><dt>{E.cost}</dt><dd>{tl(a.cost)}</dd></div>
          <div className={a.balance < 0 ? "neg" : "pos"}><dt>{E.balance}</dt><dd><span aria-hidden="true">{a.balance < 0 ? "▼ " : a.balance > 0 ? "▲ " : ""}</span>{signed(a.balance)}</dd></div>
        </dl>
      </div>
    </div>
  );
}

function Suggestion({ s, onApply, busy }) {
  const o = s.options;
  return (
    <section className="card eco-sug" aria-label={E.sugTitle}>
      <h3>{E.sugTitle}</h3>
      {s.status === "increase" && o.combined && (
        <>
          <p className="eco-headline">{E.sugRaise(tl(o.combined.S), tl(o.combined.B))}</p>
          <p className="hint">{E.now}: {tl(s.current.S)} · {tl(s.current.B)}</p>
          <button className="btn primary" disabled={busy} onClick={() => onApply("combined")}>{E.apply}</button>
        </>
      )}
      {s.status === "increase" && !o.combined && <p className="hint">{E.unavailable}</p>}
      {s.status === "increase" && (o.subscription || o.booking) && (
        <>
          <h4 className="eco-sub">{E.sugAlt}</h4>
          <ul className="plain-list eco-alt">
            {[["subscription", E.altSub(o.subscription && tl(o.subscription.S))], ["booking", E.altBook(o.booking && tl(o.booking.B))]].map(([k, label]) => o[k] && (
              <li key={k}><span>{label}</span><button className="btn sm" disabled={busy} onClick={() => onApply(k)}>{E.applyAlt}</button></li>
            ))}
          </ul>
        </>
      )}
      {s.status === "covered" && <p className="eco-ok"><span aria-hidden="true">✓ </span>{E.sugCovered}</p>}
      {s.status === "no_costs" && <p className="hint">{E.sugNoCosts}</p>}
      {s.status === "no_base" && <p className="hint">{E.sugNoBase}</p>}
      {s.costAvg > 0 && <p className="hint">{E.avg(tl(Math.round(s.costAvg)), Math.round(s.members * 10) / 10, Math.round(s.slots * 10) / 10, s.bufferPct)}</p>}
      <p className="hint eco-caveat">{E.caveat}</p>
    </section>
  );
}

/** Category select with a free-text "Başka…" escape hatch; value is the final category string. */
function CatPicker({ cats, value, onChange }) {
  const custom = value === CUSTOM || (value !== "" && !cats.includes(value));
  return (
    <div className="eco-cat">
      <label className="field"><span>{E.category}</span>
        <select value={custom ? CUSTOM : value} onChange={(e) => onChange(e.target.value === CUSTOM ? CUSTOM : e.target.value)}>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
          <option value={CUSTOM}>{E.custom}</option>
        </select>
      </label>
      {custom && <label className="field"><span className="sr">{E.customPh}</span><input placeholder={E.customPh} value={value === CUSTOM ? "" : value} maxLength={40} required onChange={(e) => onChange(e.target.value || CUSTOM)} /></label>}
    </div>
  );
}

function CostRow({ c, onSave, onDelete }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(c.amount_try);
  return (
    <li className="eco-row">
      <div className="eco-row-main">
        <b>{c.category}</b>
        {c.note && <span className="muted small">{c.note}</span>}
      </div>
      {edit ? (
        <form className="eco-edit" onSubmit={async (e) => { e.preventDefault(); if (await onSave(c.id, Number(v))) setEdit(false); }}>
          <input type="number" min="1" step="1" required aria-label={E.amount} value={v} onChange={(e) => setV(e.target.value)} autoFocus />
          <button className="btn primary sm">{E.save}</button>
          <button type="button" className="btn ghost sm" onClick={() => { setEdit(false); setV(c.amount_try); }}>{E.cancel}</button>
        </form>
      ) : (
        <>
          <span className="eco-amt num">{tl(c.amount_try)}</span>
          <button className="btn ghost sm" onClick={() => setEdit(true)}>{E.edit}</button>
          <button className="btn ghost sm danger-text" onClick={() => onDelete(c.id)} aria-label={`${E.remove}: ${c.category}`}>{E.remove}</button>
        </>
      )}
    </li>
  );
}

export default function Economics() {
  const [sum, setSum] = useState(null);
  const [costs, setCosts] = useState(null);
  const [month, setMonth] = useState(nowMonth());
  const [busy, setBusy] = useState(false);
  const [say, toast] = useToast();
  const cats = sum?.categories ?? [];
  const [form, setForm] = useState({ category: "kira", amount: "", note: "" });
  const [tpl, setTpl] = useState({ category: "kira", amount: "" });
  const months = Array.from({ length: 12 }, (_, i) => addM(nowMonth(), i - 11));

  const [loadErr, setLoadErr] = useState("");
  const loadSum = useCallback(() => api("GET", "/admin/economics").then((r) => { setSum(r); setLoadErr(""); }, (e) => { setLoadErr(e.message || tr.err.load); say(e.message); }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const loadCosts = useCallback(() => api("GET", `/admin/costs?month=${month}`).then(setCosts, (e) => { setLoadErr(e.message || tr.err.load); say(e.message); }), [month]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadSum(); }, [loadSum]);
  useEffect(() => { loadCosts(); }, [loadCosts]);
  const both = () => Promise.all([loadSum(), loadCosts()]);
  const run = async (fn, ok) => { try { await fn(); if (ok) say(ok); return true; } catch (e) { say(e.message); return false; } };

  const add = (e) => {
    e.preventDefault();
    return run(async () => { await api("POST", "/admin/costs", { month, category: form.category, amount_try: Number(form.amount), note: form.note || null }); setForm({ ...form, amount: "", note: "" }); await both(); }, E.added);
  };
  const addTpl = (e) => {
    e.preventDefault();
    return run(async () => { await api("PUT", `/admin/cost-templates/${encodeURIComponent(tpl.category)}`, { amount_try: Number(tpl.amount) }); setTpl({ ...tpl, amount: "" }); await loadCosts(); }, E.tplSaved);
  };
  const apply = async (which) => {
    setBusy(true);
    await run(async () => { const r = await api("POST", "/admin/economics/apply", { which }); setSum(r); say(E.applied(monthLabel(r.next))); });
    setBusy(false);
  };

  return (
    <section className="eco">
      <div className="page-head"><h2>{E.title}</h2></div>
      {!sum && (loadErr ? <ErrorState message={loadErr} onRetry={both} /> : <Skeleton rows={2} tall />)}
      {sum && <Suggestion s={sum.suggestion} onApply={apply} busy={busy} />}
      {sum && <Chart months={sum.months} />}

      <h3 className="sec-title">{E.monthCosts}</h3>
      <MonthNav month={month} months={months} onChange={setMonth} />
      {!costs && sum && <Skeleton rows={2} />}
      {costs && (
        <>
          <ul className="card plain-list eco-list">
            {costs.items.length === 0 && <li className="muted">{E.empty}</li>}
            {costs.items.map((c) => (
              <CostRow key={c.id + ":" + c.amount_try} c={c}
                onSave={(id, amount_try) => run(async () => { await api("PATCH", `/admin/costs/${id}`, { amount_try }); await both(); }, E.saved)}
                onDelete={(id) => run(async () => { await api("DELETE", `/admin/costs/${id}`); await both(); })} />
            ))}
            <li className="eco-total"><span>{E.total}</span><b className="num">{tl(costs.total)}</b></li>
          </ul>
          <form className="card form" onSubmit={add}>
            <CatPicker cats={cats} value={form.category} onChange={(category) => setForm({ ...form, category })} />
            <div className="filters" style={{ marginBottom: 0 }}>
              <label className="field"><span>{E.amount}</span><input type="number" min="1" step="1" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
              <label className="field"><span>{E.note}</span><input type="text" maxLength={120} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
            </div>
            <div className="row end"><button className="btn primary" disabled={!form.category || form.category === CUSTOM}>{E.add}</button></div>
          </form>

          <h3 className="sec-title">{E.templates}</h3>
          <ul className="card plain-list eco-list">
            {costs.templates.length === 0 && <li className="muted">{E.tplNone}</li>}
            {costs.templates.map((t) => (
              <li key={t.category} className="eco-row">
                <div className="eco-row-main"><b>{t.category}</b></div>
                <span className="eco-amt num">{tl(t.amount_try)}</span>
                <button className="btn ghost sm danger-text" aria-label={`${E.remove}: ${t.category}`} onClick={() => run(async () => { await api("DELETE", `/admin/cost-templates/${encodeURIComponent(t.category)}`); await loadCosts(); }, E.tplRemoved)}>{E.remove}</button>
              </li>
            ))}
          </ul>
          <form className="card form" onSubmit={addTpl}>
            <CatPicker cats={cats} value={tpl.category} onChange={(category) => setTpl({ ...tpl, category })} />
            <label className="field"><span>{E.amount}</span><input type="number" min="1" step="1" required value={tpl.amount} onChange={(e) => setTpl({ ...tpl, amount: e.target.value })} /></label>
            <p className="hint">{E.templatesHint}</p>
            <div className="row end"><button className="btn" disabled={!tpl.category || tpl.category === CUSTOM}>{E.tplAdd}</button></div>
          </form>
        </>
      )}
      {toast}
    </section>
  );
}
