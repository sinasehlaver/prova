// ADR 0001 #9 (docs/adr/0001-debt-and-credit-rules.md): a fee change opens "Etkilenen kalemler" reviews instead of
// re-pricing; apply / keep per item, paid items included (price down -> alacak, price up -> debt).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeTestApp } from "./test-helpers.mjs";
import { COOKIE } from "./lib/auth.mjs";
import { ensureMonth, feeFor, nextMonth } from "./lib/billing.mjs";
import { currentMonth } from "./lib/tz.mjs";

const t = await makeTestApp();
after(() => t.close());

const M = currentMonth(), NEXT = nextMonth(M), FAR = nextMonth(NEXT);
const J = async (r) => r.json();
const mk = async (name) => {
  const u = await J(await t.fetch("/api/users", { method: "POST", as: t.admin, body: { name } }));
  return (await t.db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [u.id] })).rows[0];
};
const admin = (path, opts = {}) => t.fetch("/api/admin" + path, { as: t.admin, ...opts });
const view = async (u, month) => J(await admin(`/users/${u.id}/billing?month=${month}`));
const sub = async (u, month) => (await view(u, month)).items.find((i) => i.kind === "subscription");
const credit = async (u, month) => (await view(u, month)).credit.balance_try;
const pay = (u, month, charges, amount) =>
  fetch(`${t.base}/api/admin/users/${u.id}/receipts?month=${month}&charges=${charges.join(",")}&amount_try=${amount}`, {
    method: "POST", headers: { "content-type": "application/pdf", cookie: `${COOKIE}=${t.admin.invite_token}` },
  });
const setFee = async (month, subTry) => {
  const f = await feeFor(t.db, month);
  return J(await admin("/fees", { method: "POST", body: { effective_from: month, subscription_try: subTry, booking_try: f.booking_try } }));
};
const reviews = async () => J(await admin("/fee-reviews"));
const reviewOf = async (chargeId) => (await reviews()).find((r) => r.charge_id === chargeId);
const resolve = (ids, decision) => admin("/fee-reviews/resolve", { method: "POST", body: { ids, decision } });

test("price down: paid -> alacak, unpaid -> lower kalan, part-paid now covered -> paid", async () => {
  const [full, none, part] = [await mk("Rv Full"), await mk("Rv None"), await mk("Rv Part")];
  for (const u of [full, none, part]) await ensureMonth(t.db, u, FAR);
  const s = {};
  for (const u of [full, none, part]) s[u.id] = await sub(u, FAR);
  const old = s[full.id].amount_try;
  assert.equal((await pay(full, FAR, [s[full.id].id], old)).status, 201);
  assert.equal((await pay(part, FAR, [s[part.id].id], old - 500)).status, 201);
  const res = await setFee(FAR, old - 500);
  assert.ok(res.reviews >= 3);
  for (const u of [full, none, part]) assert.equal((await sub(u, FAR)).amount_try, old); // nothing changed yet
  const rf = await reviewOf(s[full.id].id), rn = await reviewOf(s[none.id].id), rp = await reviewOf(s[part.id].id);
  assert.deepEqual([rf.old_try, rf.new_try, rf.status, rf.credit_try, rf.debt_try], [old, old - 500, "paid", 500, 0]);
  assert.deepEqual([rn.credit_try, rn.debt_try], [0, -500]);
  assert.deepEqual([rp.covered_try, rp.credit_try, rp.debt_try], [old - 500, 0, -500]);
  const r = await resolve([rf.id, rn.id, rp.id], "apply");
  assert.equal(r.status, 200);
  const body = await J(r);
  assert.equal(body.resolved, 3);
  assert.ok(!body.open.some((o) => [rf.id, rn.id, rp.id].includes(o.id)));
  assert.equal((await sub(full, FAR)).amount_try, old - 500);
  assert.equal((await sub(full, FAR)).status, "paid");
  assert.equal(await credit(full, FAR), 500); // over-coverage = alacak
  assert.equal((await sub(none, FAR)).amount_try, old - 500);
  assert.equal((await sub(none, FAR)).status, "unpaid");
  assert.equal((await sub(part, FAR)).status, "paid");
  assert.equal(await credit(part, FAR), 0);
  // second resolve of the same ids: already closed -> ignored
  assert.equal((await J(await resolve([rf.id], "keep"))).resolved, 0);
});

test("price up: keep leaves a paid item alone, apply turns the difference into debt", async () => {
  const [a, b] = [await mk("Rv Keep"), await mk("Rv Apply")];
  for (const u of [a, b]) await ensureMonth(t.db, u, NEXT);
  const sa = await sub(a, NEXT), sb = await sub(b, NEXT);
  const old = sa.amount_try;
  for (const [u, c] of [[a, sa], [b, sb]]) assert.equal((await pay(u, NEXT, [c.id], old)).status, 201);
  await setFee(NEXT, old + 500);
  const ra = await reviewOf(sa.id), rb = await reviewOf(sb.id);
  assert.deepEqual([rb.debt_try, rb.credit_try], [500, 0]);
  assert.equal((await resolve([ra.id], "keep")).status, 200);
  assert.equal((await resolve([rb.id], "apply")).status, 200);
  assert.equal((await sub(a, NEXT)).amount_try, old);
  assert.equal((await sub(a, NEXT)).status, "paid");
  const vb = await sub(b, NEXT);
  assert.deepEqual([vb.amount_try, vb.status], [old + 500, "unpaid"]);
  assert.equal(vb.covered_try, old);
  const decisions = (await t.db.execute({ sql: "SELECT id, decision FROM fee_reviews WHERE id IN (?, ?)", args: [ra.id, rb.id] })).rows;
  assert.deepEqual(Object.fromEntries(decisions.map((d) => [d.id, d.decision])), { [ra.id]: "keep", [rb.id]: "apply" });
  await setFee(NEXT, old);
});

test("price up after a spent price-down alacak: the spent part comes back as Harcanan alacak", async () => {
  const u = await mk("Rv Spent");
  await ensureMonth(t.db, u, M);
  const s = await sub(u, M), old = s.amount_try;
  assert.equal((await pay(u, M, [s.id], old)).status, 201);
  await setFee(M, old - 500);
  assert.equal((await resolve([(await reviewOf(s.id)).id], "apply")).status, 200);
  assert.equal(await credit(u, M), 500);
  // spend the 500 alacak on an extra charge, then put the price back up
  assert.equal((await admin(`/users/${u.id}/charges`, { method: "POST", body: { month: M, amount_try: 500, note: "Test" } })).status, 201);
  assert.equal((await admin(`/users/${u.id}/credit/pay`, { method: "POST" })).status, 200);
  assert.equal(await credit(u, M), 0);
  await setFee(M, old);
  assert.equal((await resolve([(await reviewOf(s.id)).id], "apply")).status, 200);
  const items = (await view(u, M)).items;
  const spent = items.find((i) => i.kind === "adjustment" && /^Harcanan alacak/.test(i.note ?? ""));
  assert.equal(spent?.amount_try, 500);
  assert.equal(await credit(u, M), 0);
});

test("re-setting the old price drops the open review; stale (waived) rows are hidden and close as keep", async () => {
  const [u, w] = [await mk("Rv Back"), await mk("Rv Waived")];
  for (const x of [u, w]) await ensureMonth(t.db, x, FAR);
  const su = await sub(u, FAR), sw = await sub(w, FAR), cur = su.amount_try;
  await setFee(FAR, cur + 1000);
  const rw = await reviewOf(sw.id);
  assert.ok(await reviewOf(su.id));
  assert.equal((await admin(`/charges/${sw.id}/waive`, { method: "POST", body: {} })).status, 200);
  assert.equal(await reviewOf(sw.id), undefined); // hidden once waived
  assert.equal((await J(await resolve([rw.id], "apply"))).resolved, 1);
  assert.equal((await t.db.execute({ sql: "SELECT decision FROM fee_reviews WHERE id = ?", args: [rw.id] })).rows[0].decision, "keep");
  assert.equal((await sub(w, FAR)).amount_try, cur);
  await setFee(FAR, cur);
  assert.equal(await reviewOf(su.id), undefined);
});

test("resolve validation + member is refused", async () => {
  for (const body of [{ ids: [1], decision: "maybe" }, { ids: [], decision: "apply" }, { ids: "1", decision: "apply" },
    { ids: [1.5], decision: "keep" }, { ids: [-1], decision: "keep" }, { ids: Array(1001).fill(1), decision: "keep" }, {}])
    assert.equal((await admin("/fee-reviews/resolve", { method: "POST", body })).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal((await J(await resolve([999999], "apply"))).resolved, 0);
  assert.equal((await t.fetch("/api/admin/fee-reviews", { as: t.member })).status, 403);
  assert.equal((await t.fetch("/api/admin/fee-reviews/resolve", { as: t.member, method: "POST", body: { ids: [1], decision: "apply" } })).status, 403);
});
