import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeTestApp } from "./test-helpers.mjs";
import { nextMonth } from "./lib/billing.mjs";
import { currentMonth } from "./lib/tz.mjs";

const t = await makeTestApp();
after(() => t.close());

const M = currentMonth();
const NEXT = nextMonth(M);
const J = (r) => r.json();
const prev = (m, n) => { let y = +m.slice(0, 4), mo = +m.slice(5) - n; while (mo < 1) { mo += 12; y--; } return `${y}-${String(mo).padStart(2, "0")}`; };
const mk = async (name) => {
  const u = await J(await t.fetch("/api/users", { method: "POST", as: t.admin, body: { name } }));
  return (await t.db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [u.id] })).rows[0];
};
const bill = (as, month = M) => t.fetch(`/api/billing?month=${month}`, { as }).then(J);
const nCharges = async (u) => (await t.db.execute({ sql: "SELECT COUNT(*) n FROM charges WHERE user_id = ?", args: [u.id] })).rows[0].n;

test("PATCH /users/:id joined_month: admin only, validated; earlier materialises past rent, later keeps existing charges", async () => {
  const u = await mk("Başlangıç");
  const patch = (as, joined_month) => t.fetch(`/api/users/${u.id}`, { method: "PATCH", as, body: { joined_month } });
  assert.equal((await patch(t.member, prev(M, 2))).status, 403);
  for (const bad of ["2026-13", "x", "2024-12", NEXT, 202601, null])
    assert.equal((await patch(t.admin, bad)).status, 400, String(bad));

  const P2 = prev(M, 2);
  assert.ok(P2 >= "2025-01");
  const r = await patch(t.admin, P2);
  assert.equal(r.status, 200);
  assert.equal((await J(r)).joined_month, P2);
  const b = await bill(u);
  assert.equal(b.months[0], P2);
  assert.equal(b.other_open.filter((i) => i.kind === "subscription" && i.id != null).length, 2);

  const before = await nCharges(u);
  assert.equal((await patch(t.admin, M)).status, 200); // later: existing rows stay
  assert.equal(await nCharges(u), before);
  assert.equal((await bill(u)).months[0], P2); // browseFrom keeps the oldest live charge reachable
  // other fields untouched when joined_month omitted
  const keep = await J(await t.fetch(`/api/users/${u.id}`, { method: "PATCH", as: t.admin, body: { name: "Yeni Ad" } }));
  assert.equal(keep.joined_month, M);
});
