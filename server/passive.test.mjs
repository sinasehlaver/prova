// ADR 0001 block 3 (#6, #7, #10): passive months ("Aidat · Pasif"), the reactivation month picker, day-15 cutoff.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeTestApp } from "./test-helpers.mjs";
import { COOKIE } from "./lib/auth.mjs";
import { monthOf } from "./lib/tz.mjs";
import { feeFor } from "./lib/billing.mjs";
import { clock, setActive, statusPreview } from "./lib/status.mjs";

const H = 3600_000;
const t = await makeTestApp();
after(() => t.close());

const J = async (r) => r.json();
const M = monthOf(Date.now());
const shift = (m, n) => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
/** Istanbul 10:00 on `day` of month m. */
const on = (m, day) => Date.UTC(+m.slice(0, 4), +m.slice(5) - 1, day, 10) - 3 * H;
/** A member inserted directly (POST /users would apply today's real day-15 side to this month). */
const mk = async (name, joined) => {
  const { lastInsertRowid } = await t.db.execute({
    sql: "INSERT INTO users (name, role, invite_token, joined_month, created_at) VALUES (?, 'member', ?, ?, ?)",
    args: [name, "tok-" + Math.random().toString(36).slice(2), joined, Date.now()],
  });
  return fresh({ id: Number(lastInsertRowid) });
};
const fresh = async (u) => (await t.db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [u.id] })).rows[0];
const admin = (path, opts = {}) => t.fetch("/api/admin" + path, { as: t.admin, ...opts });
const view = async (u, month) => J(await admin(`/users/${u.id}/billing?month=${month}`));
const subRow = async (u, month) =>
  (await t.db.execute({ sql: "SELECT * FROM charges WHERE user_id = ? AND month = ? AND kind = 'subscription'", args: [u.id, month] })).rows[0];
const pay = (u, month, charges, amount) =>
  fetch(`${t.base}/api/admin/users/${u.id}/receipts?month=${month}&charges=${charges.join(",")}&amount_try=${amount}`, {
    method: "POST", headers: { "content-type": "application/pdf", cookie: `${COOKIE}=${t.admin.invite_token}` },
  });
const patch = (u, body) => t.fetch(`/api/users/${u.id}`, { method: "PATCH", as: t.admin, body });

test("passive on day 1-15: this month's paid aidat turns 'Aidat · Pasif' and its money becomes alacak", async () => {
  const u = await mk("Early Passive", M);
  const fee = (await feeFor(t.db, M)).subscription_try;
  assert.ok(fee > 0);
  const sub = (await view(u, M)).items.find((i) => i.kind === "subscription");
  assert.equal((await pay(u, M, [sub.id], fee)).status, 201);
  await setActive(t.db, u, false, { now: on(M, 5) });
  const it = (await view(u, M)).items.find((i) => i.kind === "subscription");
  assert.equal(it.status, "voided");
  assert.equal(it.void_kind, "passive");
  const p = await statusPreview(t.db, await fresh(u));
  assert.equal(p.credit_try, fee);
  assert.equal(p.debt_try, 0);
  // a passive member with alacak stays in the overview (#7)
  const ov = await J(await admin(`/billing/overview?month=${M}`));
  assert.equal(ov.users.find((x) => x.id === u.id)?.credit_try, fee);
});

test("passive on day 16+: this month is charged in full, nothing voided", async () => {
  const u = await mk("Late Passive", M);
  await setActive(t.db, u, false, { now: on(M, 20) });
  const row = await subRow(u, M);
  assert.ok(row && row.voided_at === null, "charged in full");
  const p = await statusPreview(t.db, await fresh(u));
  assert.ok(p.debt_try > 0, "the warning sees the debt");
  assert.equal((await t.db.execute({ sql: "SELECT passive_from FROM users WHERE id = ?", args: [u.id] })).rows[0].passive_from, shift(M, 1));
});

test("reactivate: only ticked passive months are billed; the rest show 'Aidat · Pasif'; day 1-15 bills this month", async () => {
  const a = shift(M, -3), b = shift(M, -2), c = shift(M, -1);
  const u = await mk("Back Again", a);
  await setActive(t.db, u, false, { now: on(a, 20) }); // a charged, passive from b
  assert.deepEqual((await statusPreview(t.db, await fresh(u), on(M, 5))).months, [b, c]);
  await setActive(t.db, u, true, { billMonths: [c], now: on(M, 5) });
  assert.equal((await subRow(u, b)).void_kind, "passive");
  const rc = await subRow(u, c);
  assert.ok(rc.voided_at === null && rc.amount_try > 0, "ticked month billed");
  assert.ok((await subRow(u, M)).voided_at === null, "day 1-15: this month's aidat applies");
});

test("reactivate on day 16+: this month gets 'Aidat · Pasif', aidat starts next month", async () => {
  const a = shift(M, -1);
  const u = await mk("Late Back", a);
  await setActive(t.db, u, false, { now: on(a, 3) }); // a removed (early), passive from a
  assert.equal((await subRow(u, a)).void_kind, "passive");
  assert.deepEqual((await statusPreview(t.db, await fresh(u), on(M, 20))).months, [a], "an 'Aidat · Pasif' month can still be billed");
  await setActive(t.db, u, true, { billMonths: [], now: on(M, 20) });
  assert.equal((await subRow(u, M)).void_kind, "passive");
  assert.equal((await subRow(u, a)).void_kind, "passive");
});

test("reactivate: a ticked 'Aidat · Pasif' month is un-voided (billed again)", async () => {
  const a = shift(M, -1);
  const u = await mk("Unskip", a);
  await setActive(t.db, u, false, { now: on(a, 3) });
  await setActive(t.db, u, true, { billMonths: [a], now: on(M, 5) });
  const r = await subRow(u, a);
  assert.ok(r.voided_at === null && r.void_kind === null);
});

test("PATCH /users: bad bill_months -> 400 and nothing changes; preview route; good reactivation", async () => {
  const u = await mk("Route Toggle", shift(M, -1));
  assert.equal((await patch(u, { active: false })).status, 200);
  const p = await J(await t.fetch(`/api/users/${u.id}/status-preview`, { as: t.admin }));
  assert.equal(p.active, false);
  assert.equal(typeof p.early, "boolean");
  assert.ok(Array.isArray(p.months));
  for (const bad of [["2020-01"], "2026-01", [1], Array(241).fill(M)]) {
    assert.equal((await patch(u, { active: true, bill_months: bad })).status, 400, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal((await t.db.execute({ sql: "SELECT active FROM users WHERE id = ?", args: [u.id] })).rows[0].active, 0);
  assert.equal((await patch(u, { active: true, bill_months: p.months })).status, 200);
  assert.equal((await t.db.execute({ sql: "SELECT active, passive_from FROM users WHERE id = ?", args: [u.id] })).rows[0].active, 1);
  assert.equal((await t.fetch(`/api/users/999999/status-preview`, { as: t.admin })).status, 404);
});

test("new member / approve: day 1-15 -> this month's aidat; day 16+ -> 'Aidat · Pasif', response says which", async () => {
  const keep = clock.now;
  try {
    clock.now = () => on(M, 5);
    const e = await J(await t.fetch("/api/users", { method: "POST", as: t.admin, body: { name: "Fresh Early" } }));
    assert.equal(e.early, true);
    assert.ok((await subRow(e, M)) === undefined, "no row yet: the next billing read creates it");
    clock.now = () => on(M, 20);
    const l = await J(await t.fetch("/api/users", { method: "POST", as: t.admin, body: { name: "Fresh Late" } }));
    assert.equal(l.early, false);
    assert.equal((await subRow(l, M)).void_kind, "passive");
    assert.equal((await view(l, M)).items.find((i) => i.kind === "subscription").void_kind, "passive");
  } finally { clock.now = keep; }
});
