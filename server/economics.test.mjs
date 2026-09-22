import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeTestApp } from "./test-helpers.mjs";
import { addMonths, ceil50, economicsSummary, suggestFees } from "./lib/economics.mjs";
import { feeFor, nextMonth } from "./lib/billing.mjs";
import { currentMonth } from "./lib/tz.mjs";

const cur = { S: 1500, B: 500 };

// ---- pure suggestFees (money path)
test("suggestFees typical: k>1 scales both, alternatives cover the shortfall, all rounded UP to 50", () => {
  // I = 5*1500 + 10*500 = 12500; needed = 15000*1.1 = 16500; k = 1.32
  const s = suggestFees({ costs: [15000, 15000, 15000], memberCount: 5, avgAttendeeSlotsPerMonth: 10, current: cur });
  assert.equal(s.status, "increase");
  assert.equal(s.income, 12500);
  assert.deepEqual([s.options.combined.S, s.options.combined.B], [2000, 700]); // 1980 -> 2000, 660 -> 700
  assert.deepEqual([s.options.subscription.S, s.options.subscription.B], [2300, 500]); // gap 4000 / 5 = +800
  assert.deepEqual([s.options.booking.S, s.options.booking.B], [1500, 900]); // gap 4000 / 10 = +400
  for (const o of Object.values(s.options)) assert.ok(o.income >= s.needed, "option covers cost+buffer");
  for (const o of Object.values(s.options)) assert.ok(o.S % 50 === 0 && o.B % 50 === 0);
});

test("suggestFees k<=1: no increase, no options", () => {
  const s = suggestFees({ costs: [10000], memberCount: 5, avgAttendeeSlotsPerMonth: 10, current: cur });
  assert.equal(s.status, "covered");
  assert.deepEqual(s.options, { combined: null, subscription: null, booking: null });
});

test("suggestFees zero members: subscription-only unavailable, no crash", () => {
  const s = suggestFees({ costs: [9000], memberCount: 0, avgAttendeeSlotsPerMonth: 10, current: cur });
  assert.equal(s.status, "increase");
  assert.equal(s.options.subscription, null);
  assert.ok(s.options.booking.B > 500);
});

test("suggestFees zero bookings: booking-only unavailable", () => {
  const s = suggestFees({ costs: [12000], memberCount: 5, avgAttendeeSlotsPerMonth: 0, current: cur });
  assert.equal(s.options.booking, null);
  assert.equal(s.options.subscription.S, 2650); // gap (13200-7500)/5 = 1140 -> 2640 -> 2650
});

test("suggestFees empty / no base guards", () => {
  assert.equal(suggestFees({}).status, "no_costs");
  const s = suggestFees({ costs: [5000], memberCount: 0, avgAttendeeSlotsPerMonth: 0, current: cur });
  assert.equal(s.status, "no_base");
  assert.equal(s.k, null);
  assert.equal(suggestFees({ costs: [5000], memberCount: 3, avgAttendeeSlotsPerMonth: 0, current: { S: 0, B: 0 } }).options.combined, null);
});

test("suggestFees uses only the last 3 costs; ceil50 rounding; buffer changes the outcome", () => {
  assert.equal(suggestFees({ costs: [99999, 1000, 2000, 3000], memberCount: 1, avgAttendeeSlotsPerMonth: 0, current: cur }).costAvg, 2000);
  assert.equal(ceil50(1500), 1500); assert.equal(ceil50(1500.4), 1550); assert.equal(ceil50(1501), 1550); assert.equal(ceil50(1500.0000000001), 1500);
  const base = { costs: [12500], memberCount: 5, avgAttendeeSlotsPerMonth: 10, current: cur };
  assert.equal(suggestFees({ ...base, bufferPct: 0 }).status, "covered"); // exactly covered
  assert.equal(suggestFees({ ...base, bufferPct: 10 }).status, "increase");
  assert.equal(suggestFees({ ...base, bufferPct: 10 }).options.combined.S, 1650); // k=1.1 -> exactly 1650, no float overshoot
});

test("addMonths crosses year boundaries", () => {
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(addMonths("2026-11", 3), "2027-02");
});

// ---- routes
const t = await makeTestApp();
after(() => t.close());
const M = currentMonth(), NEXT = nextMonth(M), PREV = addMonths(M, -1);
const A = (path, opts = {}) => t.fetch("/api/admin" + path, { as: t.admin, ...opts });
const J = (r) => r.json();

test("economics routes are admin-only", async () => {
  for (const [m, p] of [["GET", "/economics"], ["POST", "/economics/apply"], ["GET", "/costs"], ["POST", "/costs"], ["GET", "/cost-templates"], ["DELETE", "/costs/1"]])
    assert.equal((await t.fetch("/api/admin" + p, { as: t.member, method: m, body: m === "GET" ? undefined : {} })).status, 403, m + p);
  assert.equal((await t.fetch("/api/admin/economics")).status, 401);
});

test("template prefill is lazy + idempotent; costs CRUD + validation", async () => {
  await A("/cost-templates/kira", { method: "PUT", body: { amount_try: 8000 } });
  assert.deepEqual((await J(await A("/cost-templates/elektrik", { method: "PUT", body: { amount_try: 900 } }))).map((x) => x.category), ["kira", "elektrik"]);
  const a = await J(await A(`/costs?month=${PREV}`)), b = await J(await A(`/costs?month=${PREV}`));
  assert.equal(a.items.length, 2); assert.equal(b.items.length, 2); assert.equal(a.total, 8900); // second read did not duplicate
  await A(`/costs/${a.items[0].id}`, { method: "DELETE" }); // deleting does not bring the template back
  assert.equal((await J(await A(`/costs?month=${PREV}`))).items.length, 1);
  const c = await A("/costs", { method: "POST", body: { month: PREV, category: "temizlik", amount_try: 300, note: "x" } });
  assert.equal(c.status, 201);
  const { id } = await J(c);
  assert.equal((await A(`/costs/${id}`, { method: "PATCH", body: { amount_try: 350 } })).status, 200);
  assert.equal((await J(await A(`/costs?month=${PREV}`))).total, 900 + 350);
  for (const body of [{ month: PREV, category: "", amount_try: 5 }, { month: PREV, category: "a", amount_try: 1.5 }, { month: PREV, category: "a", amount_try: -1 }, { month: "2026-13", category: "a", amount_try: 5 }])
    assert.equal((await A("/costs", { method: "POST", body })).status, 400);
  assert.equal((await A(`/costs/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await A(`/costs/${id}`, { method: "DELETE" })).status, 404);
  assert.equal((await A("/cost-templates/yok", { method: "DELETE" })).status, 404);
  await A("/cost-templates/elektrik", { method: "DELETE" });
});

test("summary: income vs cost numbers match charges; apply writes a next-month fee row", async () => {
  // this month: costs 30000 (template kira is 8000 -> add explicit cost so the suggestion needs an increase)
  await A("/costs", { method: "POST", body: { month: M, category: "diğer", amount_try: 30000 } });
  // pay one charge
  const s0 = await J(await A("/economics"));
  const q = async (sql) => Number((await t.db.execute(sql)).rows[0].v);
  const sub = (await t.db.execute({ sql: "SELECT id, amount_try FROM charges WHERE month = ? AND kind = 'subscription' LIMIT 1", args: [M] })).rows[0];
  const rc = (await t.db.execute({ sql: "INSERT INTO receipts (user_id, month, sha256, status, uploaded_at) VALUES (?,?,?,?,?)", args: [t.member.id, M, "eco1", "ok", 1] })).lastInsertRowid;
  await t.db.execute({ sql: "UPDATE charges SET paid_receipt_id = ?, paid_by = 'admin' WHERE id = ?", args: [rc, sub.id] });
  await t.db.execute({ sql: "UPDATE charges SET waived_at = 1 WHERE id = (SELECT id FROM charges WHERE month = ? AND kind = 'subscription' AND paid_receipt_id IS NULL LIMIT 1)", args: [M] });
  const s = await J(await A("/economics"));
  assert.equal(s.months.length, 6);
  const row = s.months.at(-1);
  assert.equal(row.month, M);
  assert.equal(row.expected, await q(`SELECT SUM(amount_try) v FROM charges WHERE month='${M}' AND voided_at IS NULL AND waived_at IS NULL`));
  assert.equal(row.collected, sub.amount_try);
  assert.equal(row.cost, await q(`SELECT SUM(amount_try) v FROM costs WHERE month='${M}'`));
  assert.equal(row.balance, row.collected - row.cost);
  assert.ok(row.expected < s0.months.at(-1).expected, "waived charge leaves expected income");
  assert.equal(s.suggestion.status, "increase");
  assert.deepEqual(s.categories.slice(0, 2), ["kira", "su"]);

  const bad = await A("/economics/apply", { method: "POST", body: { which: "nope" } });
  assert.equal(bad.status, 400);
  const ap = await A("/economics/apply", { method: "POST", body: { which: "combined" } });
  assert.equal(ap.status, 200);
  const want = s.suggestion.options.combined;
  const f = await feeFor(t.db, NEXT);
  assert.equal(f.effective_from, NEXT);
  assert.deepEqual([f.subscription_try, f.booking_try], [want.S, want.B]);
  assert.equal((await feeFor(t.db, M)).subscription_try, 1500); // current month untouched
  assert.equal((await J(ap)).fees.next.S, want.S);
  await economicsSummary(t.db); // still computable afterwards
});
