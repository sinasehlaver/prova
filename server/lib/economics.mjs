// Economics: pure fee suggestion + DB helpers (costs, templates, monthly income vs cost). Money = whole TRY ints.
// suggestFees is DB-free and unit-tested (money path). Writes go through serial() (never nest it).
import { serial } from "./serial.mjs";
import { ensureMonth, fail, feeFor, isMonth, nextMonth, setFee } from "./billing.mjs";
import { monthOf } from "./tz.mjs";

export const BUFFER_PCT = 10;
export const DEFAULT_CATEGORIES = ["kira", "su", "elektrik", "internet", "aidat", "diğer"];

/** Round UP to the next 50 TRY step (1e-6 slop so 1500.0000000001 stays 1500). */
export const ceil50 = (n) => Math.ceil(Math.round(n * 1e6) / 1e6 / 50) * 50;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const num = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * costs: monthly cost totals (only the last 3 positive ones are averaged). memberCount / avgAttendeeSlotsPerMonth: trailing
 * averages (N members paying a subscription, P booking charges per month). current: {S,B} fees the suggestion starts from.
 * I = N*S + P*B, needed = C*(1+buffer), k = needed/I. k>1 -> keep the S:B ratio (combined) + subscription-only + booking-only,
 * each rounded UP to 50 TRY. An option is null when its base is 0 (no members / no bookings / no income to scale).
 * status: 'no_costs' | 'covered' (k<=1, no suggestion) | 'increase' | 'no_base' (short but no usage data to price against).
 */
export function suggestFees({ costs = [], memberCount = 0, avgAttendeeSlotsPerMonth = 0, current = {}, bufferPct = BUFFER_PCT }) {
  const S = num(current.S), B = num(current.B), N = num(memberCount), P = num(avgAttendeeSlotsPerMonth);
  const C = mean(costs.map(num).filter((x) => x > 0).slice(-3));
  const income = N * S + P * B;
  const needed = C * (1 + num(bufferPct) / 100);
  const k = income > 0 ? needed / income : null;
  const out = { status: "no_costs", costAvg: C, needed, income, k, members: N, slots: P, bufferPct: num(bufferPct), current: { S, B }, options: { combined: null, subscription: null, booking: null } };
  if (!(C > 0)) return out;
  if (needed <= income) return { ...out, status: "covered" };
  const gap = needed - income;
  const opt = (s, b) => ({ S: s, B: b, income: Math.round(N * s + P * b) });
  out.options = {
    combined: income > 0 ? opt(ceil50(k * S), ceil50(k * B)) : null,
    subscription: N > 0 ? opt(ceil50(S + gap / N), B) : null,
    booking: P > 0 ? opt(S, ceil50(B + gap / P)) : null,
  };
  out.status = Object.values(out.options).some(Boolean) ? "increase" : "no_base";
  return out;
}

export const addMonths = (m, n) => {
  let [y, mo] = m.split("-").map(Number);
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};

// ---- costs + templates
const cleanCat = (c) => {
  const s = String(c ?? "").trim().slice(0, 40);
  if (!s) throw fail(400, "Kategori gerekli");
  return s;
};
const cleanAmt = (n) => {
  if (!Number.isInteger(n) || n <= 0 || n > 10_000_000) throw fail(400, "Tutar pozitif tam sayı olmalı");
  return n;
};
const cleanNote = (n) => String(n ?? "").trim().slice(0, 120) || null;
const mustMonth = (m) => { if (!isMonth(m)) throw fail(400, "Geçersiz ay"); return m; };

/** Lazy + idempotent: the first time a month is opened with no costs, copy the templates in. A settings flag remembers it
 *  so deleting every cost later does not bring them back. */
export const ensureCostMonth = (db, month) => serial(async () => {
  const key = `costs_prefilled:${month}`;
  if ((await db.execute({ sql: "SELECT 1 FROM settings WHERE key = ?", args: [key] })).rows.length) return;
  const mark = { sql: "INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')", args: [key] };
  if ((await db.execute({ sql: "SELECT COUNT(*) n FROM costs WHERE month = ?", args: [month] })).rows[0].n > 0) return void (await db.execute(mark));
  const t = (await db.execute("SELECT category, amount_try FROM cost_templates ORDER BY rowid")).rows;
  if (!t.length) return;
  await db.batch([...t.map((r) => ({ sql: "INSERT INTO costs (month, category, amount_try, note) VALUES (?,?,?,NULL)", args: [month, r.category, r.amount_try] })), mark], "write");
});

export async function listCosts(db, month) {
  mustMonth(month);
  await ensureCostMonth(db, month);
  const items = (await db.execute({ sql: "SELECT id, category, amount_try, note FROM costs WHERE month = ? ORDER BY id", args: [month] })).rows;
  return { month, items, total: items.reduce((s, c) => s + c.amount_try, 0), templates: await listTemplates(db) };
}
export const listTemplates = async (db) => (await db.execute("SELECT category, amount_try FROM cost_templates ORDER BY rowid")).rows;

export const addCost = (db, { month, category, amountTry, note }) => serial(async () => {
  const r = await db.execute({ sql: "INSERT INTO costs (month, category, amount_try, note) VALUES (?,?,?,?)", args: [mustMonth(month), cleanCat(category), cleanAmt(amountTry), cleanNote(note)] });
  return Number(r.lastInsertRowid);
});
export const updateCost = (db, id, b) => serial(async () => {
  const c = (await db.execute({ sql: "SELECT * FROM costs WHERE id = ?", args: [id] })).rows[0];
  if (!c) throw fail(404, "Gider bulunamadı");
  await db.execute({
    sql: "UPDATE costs SET category = ?, amount_try = ?, note = ? WHERE id = ?",
    args: [b.category === undefined ? c.category : cleanCat(b.category), b.amount_try === undefined ? c.amount_try : cleanAmt(b.amount_try), b.note === undefined ? c.note : cleanNote(b.note), id],
  });
});
export const deleteCost = (db, id) => serial(async () => {
  if (!(await db.execute({ sql: "DELETE FROM costs WHERE id = ?", args: [id] })).rowsAffected) throw fail(404, "Gider bulunamadı");
});
export const putTemplate = (db, category, amountTry) => serial(() =>
  db.execute({ sql: "INSERT INTO cost_templates (category, amount_try) VALUES (?,?) ON CONFLICT(category) DO UPDATE SET amount_try = excluded.amount_try", args: [cleanCat(category), cleanAmt(amountTry)] }));
export const deleteTemplate = (db, category) => serial(async () => {
  if (!(await db.execute({ sql: "DELETE FROM cost_templates WHERE category = ?", args: [category] })).rowsAffected) throw fail(404, "Şablon bulunamadı");
});

// ---- income vs cost
/** Last 6 months (ending now) of expected / collected income vs cost, plus a fee suggestion from the trailing 3 months. */
export async function economicsSummary(db, { now = Date.now(), bufferPct = BUFFER_PCT } = {}) {
  const cur = monthOf(now), next = nextMonth(cur), first = addMonths(cur, -5);
  // ponytail: only the current month's subscription charges are materialised (as if every member opened the app);
  // past months use what exists. Add a cron/backfill if lazy materialisation leaves holes in history.
  for (const u of (await db.execute("SELECT * FROM users WHERE active = 1")).rows) await ensureMonth(db, u, cur);
  await ensureCostMonth(db, cur);
  const ch = (await db.execute({
    sql: `SELECT month,
            COALESCE(SUM(CASE WHEN voided_at IS NULL AND waived_at IS NULL THEN amount_try END), 0) expected,
            COALESCE(SUM(CASE WHEN voided_at IS NULL AND paid_receipt_id IS NOT NULL THEN amount_try END), 0) collected,
            COALESCE(SUM(kind = 'subscription' AND voided_at IS NULL AND waived_at IS NULL), 0) n,
            COALESCE(SUM(CASE WHEN kind = 'booking' AND voided_at IS NULL AND waived_at IS NULL
                         THEN COALESCE((SELECT people FROM reservations r WHERE r.id = charges.reservation_id), 1) END), 0) p
          FROM charges WHERE month BETWEEN ? AND ? GROUP BY month`, args: [first, cur],
  })).rows;
  const co = (await db.execute({ sql: "SELECT month, SUM(amount_try) cost FROM costs WHERE month BETWEEN ? AND ? GROUP BY month", args: [first, cur] })).rows;
  const byC = new Map(ch.map((r) => [r.month, r])), byK = new Map(co.map((r) => [r.month, Number(r.cost)]));
  const months = [];
  for (let i = -5; i <= 0; i++) {
    const m = addMonths(cur, i), c = byC.get(m);
    const collected = Number(c?.collected ?? 0), cost = byK.get(m) ?? 0;
    months.push({ month: m, expected: Number(c?.expected ?? 0), collected, cost, balance: collected - cost, members: Number(c?.n ?? 0), slots: Number(c?.p ?? 0) });
  }
  // costs: the last 3 months incl. this one (a freshly entered rise must show up at once). Usage (members, booking slots):
  // the 3 complete months before this one (this month's bookings are still partial); no data there -> current month.
  const win = months.slice(2, 5), now0 = months[5];
  const usage = win.filter((x) => x.members > 0);
  if (!usage.length && now0.members > 0) usage.push(now0);
  const f = await feeFor(db, next);
  const suggestion = suggestFees({
    costs: months.slice(3).filter((x) => x.cost > 0).map((x) => x.cost),
    memberCount: mean(usage.map((x) => x.members)), avgAttendeeSlotsPerMonth: mean(usage.map((x) => x.slots)),
    current: { S: f.subscription_try, B: f.booking_try }, bufferPct,
  });
  return { month: cur, next, months: months.map(({ members, slots, ...m }) => m), suggestion, fees: { next: { S: f.subscription_try, B: f.booking_try } } };
}

/** Recompute the suggestion and write the chosen option as the fee row for NEXT month (existing fee logic: setFee). */
export async function applySuggestion(db, which, now = Date.now()) {
  if (!["combined", "subscription", "booking"].includes(which)) throw fail(400, "Geçersiz seçenek");
  const opt = (await economicsSummary(db, { now })).suggestion.options[which];
  if (!opt) throw fail(409, "Bu seçenek şu an geçerli değil");
  await setFee(db, { effectiveFrom: nextMonth(monthOf(now)), subscriptionTry: opt.S, bookingTry: opt.B, now });
  return economicsSummary(db, { now });
}
