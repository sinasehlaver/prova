import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeTestApp } from "./test-helpers.mjs";

const H = 3600_000;
const t = await makeTestApp();
after(() => t.close());

const day = (n) => Math.floor((Date.now() + 3 * H) / (24 * H)) * 24 * H - 3 * H + 10 * H + n * 24 * H;
// past rows are inserted directly (back-filling via the API is covered elsewhere)
const mk = async (booker, start) => Number((await t.db.execute({
  sql: "INSERT INTO reservations (booker_id, start_ms, end_ms, people) VALUES (?,?,?,0)", args: [booker.id, start, start + H],
})).lastInsertRowid);
const req = (id, as, body = {}) => t.fetch(`/api/reservations/${id}/deletion-request`, { method: "POST", as, body });

test("request: auth, own + past only, no duplicates", async () => {
  const past = await mk(t.member, day(-5));
  const future = await mk(t.member, day(5));
  const others = await mk(t.member2, day(-6));
  assert.equal((await req(past, null)).status, 401);
  assert.equal((await req(future, t.member)).status, 409);
  assert.equal((await req(others, t.member)).status, 404);
  assert.equal((await req(999999, t.member)).status, 404);
  assert.equal((await req(past, t.member, { reason: "yanlış girdim" })).status, 201);
  assert.equal((await req(past, t.member)).status, 409);
  const mine = await (await t.fetch("/api/reservations/mine", { as: t.member })).json();
  assert.equal(mine.find((r) => r.id === past).del_req, "pending");
});

test("admin list/count/approve/reject authz + effects", async () => {
  const a = await mk(t.member, day(-10)), b = await mk(t.member, day(-11));
  const ia = (await (await req(a, t.member, { reason: "x".repeat(500) })).json()).id;
  const ib = (await (await req(b, t.member)).json()).id;
  assert.equal((await t.fetch("/api/deletion-requests")).status, 401);
  assert.equal((await t.fetch("/api/deletion-requests", { as: t.member })).status, 403);
  assert.equal((await t.fetch(`/api/deletion-requests/${ia}/approve`, { method: "POST", as: t.member })).status, 403);
  const list = await (await t.fetch("/api/deletion-requests", { as: t.admin })).json();
  assert.ok(list.some((x) => x.id === ia) && list.some((x) => x.id === ib));
  assert.equal(list.find((x) => x.id === ia).reason.length, 300);
  const cnt = await (await t.fetch("/api/deletion-requests/count", { as: t.admin })).json();
  assert.equal(cnt.count, list.length);

  assert.equal((await t.fetch(`/api/deletion-requests/${ia}/approve`, { method: "POST", as: t.admin })).status, 200);
  const row = (await t.db.execute({ sql: "SELECT cancelled_at FROM reservations WHERE id = ?", args: [a] })).rows[0];
  assert.ok(row.cancelled_at);
  assert.equal((await t.fetch(`/api/deletion-requests/${ia}/reject`, { method: "POST", as: t.admin })).status, 409);

  assert.equal((await t.fetch(`/api/deletion-requests/${ib}/reject`, { method: "POST", as: t.admin })).status, 200);
  assert.equal((await t.db.execute({ sql: "SELECT cancelled_at FROM reservations WHERE id = ?", args: [b] })).rows[0].cancelled_at, null);
  assert.equal((await t.fetch("/api/deletion-requests/999999/approve", { method: "POST", as: t.admin })).status, 404);
  // after a rejection the member may ask again
  assert.equal((await req(b, t.member)).status, 201);
});

test("approve voids the unpaid booking charge", async () => {
  const id = await mk(t.member, day(-12));
  await t.db.execute({ sql: "INSERT INTO charges (user_id, kind, month, amount_try, reservation_id) VALUES (?,?,?,?,?)", args: [t.member.id, "booking", "2026-10", 100, id] });
  const rid = (await (await req(id, t.member)).json()).id;
  assert.equal((await t.fetch(`/api/deletion-requests/${rid}/approve`, { method: "POST", as: t.admin })).status, 200);
  const c = (await t.db.execute({ sql: "SELECT voided_at FROM charges WHERE reservation_id = ?", args: [id] })).rows[0];
  assert.ok(c.voided_at);
});
