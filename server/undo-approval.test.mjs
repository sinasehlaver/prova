import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeTestApp } from "./test-helpers.mjs";
import { COOKIE } from "./lib/auth.mjs";
import { nextMonth } from "./lib/billing.mjs";
import { currentMonth } from "./lib/tz.mjs";

const t = await makeTestApp();
after(() => t.close());
const M = currentMonth();
const NEXT = nextMonth(M);
const J = (r) => r.json();
const mk = async (name) => {
  const u = await J(await t.fetch("/api/users", { method: "POST", as: t.admin, body: { name } }));
  return (await t.db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [u.id] })).rows[0];
};
const bill = async (as, month = M) => J(await t.fetch(`/api/billing?month=${month}`, { as }));
const admin = (path, opts = {}) => t.fetch("/api/admin" + path, { as: t.admin, ...opts });
let seq = 0;
const upload = async (u) => J(await fetch(`${t.base}/api/billing/receipts`, {
  method: "POST", headers: { "content-type": "application/pdf", cookie: `${COOKIE}=${u.invite_token}` },
  body: Buffer.from(`%PDF-1.4\n%undo-${Date.now()}-${seq++}\n`, "latin1"),
}));
const approve = (id, body) => admin(`/receipts/${id}/approve`, { method: "POST", body });
const undo = (id, as) => t.fetch(`/api/admin/receipts/${id}/undo-approval`, { method: "POST", as: as ?? t.admin });

test("undo approval: part-payment reverts, re-approve works, authz + 404/409", async () => {
  const u = await mk("GeriAl");
  const a = await upload(u);
  assert.equal((await approve(a.id, { amount_try: 600 })).status, 200);
  assert.equal((await bill(u)).kalan, 900);
  assert.equal((await undo(a.id, u)).status, 403);
  const un = await J(await undo(a.id));
  assert.equal(un.status, "pending");
  const v = await bill(u);
  assert.equal(v.kalan, 1500);
  assert.equal(v.receipts[0].status, "pending");
  assert.equal((await undo(a.id)).status, 409);
  assert.equal((await undo(99999)).status, 404);
  assert.equal((await approve(a.id, { amount_try: 1500 })).status, 200);
  assert.equal((await bill(u)).kalan, 0);
});

test("undo approval: surplus credit disappears; credit used via 'Alacağı hesaba kat' comes back", async () => {
  const u = await mk("GeriAlKredi");
  const a = await upload(u);
  assert.equal((await approve(a.id, { amount_try: 2000 })).status, 200); // 1500 + 500 surplus
  assert.equal((await bill(u)).credit.balance_try, 500);
  const b = await upload(u);
  const rb = await approve(b.id, { amount_try: 1000, credit_try: 500, month: NEXT, charges: `sub:${NEXT}` });
  assert.equal(rb.status, 200, await rb.clone().text());
  assert.equal((await bill(u)).credit.balance_try, 0);
  await undo(b.id);
  assert.equal((await bill(u)).credit.balance_try, 500); // credit given back
  await undo(a.id);
  const v = await bill(u);
  assert.equal(v.credit.balance_try, 0); // surplus gone
  assert.equal(v.kalan, 1500);
});

test("undo approval: admin-recorded payment without PDF is 409", async () => {
  const w = await mk("GeriAlKayit");
  const id = (await bill(w)).items[0].id;
  const rec = await J(await fetch(`${t.base}/api/admin/users/${w.id}/receipts?month=${M}&amount_try=1500&charges=${id}`, {
    method: "POST", headers: { "content-type": "application/pdf", cookie: `${COOKIE}=${t.admin.invite_token}` },
  }));
  assert.equal(rec.status, "ok");
  assert.equal((await undo(rec.id)).status, 409);
});
