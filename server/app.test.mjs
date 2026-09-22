import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeTestApp } from "./test-helpers.mjs";
import { migrate } from "./lib/db.mjs";

const t = await makeTestApp();
after(() => t.close());

test("migrations are idempotent", async () => {
  const count = async () => (await t.db.execute("SELECT COUNT(*) n FROM schema_migrations")).rows[0].n;
  const before = await count();
  await migrate(t.db);
  await migrate(t.db);
  assert.equal(await count(), before);
  const tables = (await t.db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => r.name);
  for (const n of ["users", "fees", "reservations", "reservation_attendees", "charges", "receipts", "receipt_charges", "alert_kinds", "alerts", "costs", "cost_templates", "settings"])
    assert.ok(tables.includes(n), n);
});

test("seed: fees, alert kinds, settings", async () => {
  const q = async (s) => (await t.db.execute(s)).rows;
  assert.deepEqual({ ...(await q("SELECT subscription_try s, booking_try b FROM fees"))[0] }, { s: 1500, b: 500 });
  assert.ok((await q("SELECT 1 FROM alert_kinds")).length >= 10);
  assert.equal((await q("SELECT value FROM settings WHERE key='max_reservation_hours'"))[0].value, "4");
});

test("invite link sets a cookie that authenticates /api/me", async () => {
  const r = await t.fetch(`/i/${t.member.invite_token}`);
  assert.equal(r.status, 302);
  const cookie = r.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Max-Age=\d{7,}/i);
  const me = await fetch(t.base + "/api/me", { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).name, t.member.name);
});

test("bad invite token: redirected, no cookie", async () => {
  const r = await t.fetch("/i/nope");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.match(r.headers.get("location"), /davet=gecersiz/);
});

test("role gating", async () => {
  assert.equal((await t.fetch("/api/me")).status, 401);
  assert.equal((await t.fetch("/api/users")).status, 401);
  assert.equal((await t.fetch("/api/users", { as: t.member })).status, 403);
  assert.equal((await t.fetch("/api/users", { method: "POST", as: t.member, body: { name: "x" } })).status, 403);
  assert.equal((await t.fetch(`/api/users/${t.member.id}/regenerate-invite`, { method: "POST", as: t.member })).status, 403);
  assert.equal((await t.fetch("/api/users", { as: t.admin })).status, 200);
});

test("admin creates member, regenerate invalidates old link, deactivate blocks login", async () => {
  const c = await t.fetch("/api/users", { method: "POST", as: t.admin, body: { name: "Deniz" } });
  assert.equal(c.status, 201);
  const u = await c.json();
  assert.ok(u.invite_token);
  assert.equal((await t.fetch("/api/me", { as: u })).status, 200);

  const g = await (await t.fetch(`/api/users/${u.id}/regenerate-invite`, { method: "POST", as: t.admin })).json();
  assert.notEqual(g.invite_token, u.invite_token);
  assert.equal((await t.fetch("/api/me", { as: u })).status, 401); // old cookie dead
  assert.equal((await t.fetch("/api/me", { as: g })).status, 200);

  const p = await t.fetch(`/api/users/${u.id}`, { method: "PATCH", as: t.admin, body: { active: false } });
  assert.equal((await p.json()).active, false);
  assert.equal((await t.fetch("/api/me", { as: g })).status, 401);
  assert.equal((await t.fetch(`/i/${g.invite_token}`)).headers.get("location"), "/?davet=gecersiz");
});

test("admin cannot deactivate self; empty name rejected", async () => {
  assert.equal((await t.fetch(`/api/users/${t.admin.id}`, { method: "PATCH", as: t.admin, body: { active: false } })).status, 400);
  assert.equal((await t.fetch("/api/users", { method: "POST", as: t.admin, body: { name: " " } })).status, 400);
});

test("every admin route: anonymous 401, member 403 (admin area is strongly guarded)", async () => {
  const routes = [
    ["GET", "/api/users"], ["POST", "/api/users"], ["PATCH", "/api/users/1"], ["POST", "/api/users/1/regenerate-invite"],
    ["POST", "/api/users/1/approve"], ["POST", "/api/users/1/reject"],
    ["GET", "/api/admin/billing/overview"],
    ["GET", "/api/admin/receipts"], ["POST", "/api/admin/receipts/1/approve"], ["POST", "/api/admin/receipts/1/reject"],
    ["POST", "/api/admin/receipts/parse"],
    ["GET", "/api/admin/users/1/billing"], ["GET", "/api/admin/users/1/receipts"], ["POST", "/api/admin/users/1/receipts"],
    ["GET", "/api/admin/users/1/reservations"],
    ["POST", "/api/admin/users/1/charges"], ["POST", "/api/admin/charges/1/waive"],
    ["POST", "/api/billing/receipts"], // self-serve member upload is off: admin-only reason, members get 403
    ["GET", "/api/admin/fees"], ["POST", "/api/admin/fees"], ["GET", "/api/admin/settings"], ["PUT", "/api/admin/settings"],
    ["GET", "/api/admin/economics"], ["POST", "/api/admin/economics/apply"],
    ["GET", "/api/admin/costs"], ["POST", "/api/admin/costs"], ["PATCH", "/api/admin/costs/1"], ["DELETE", "/api/admin/costs/1"],
    ["GET", "/api/admin/cost-templates"], ["PUT", "/api/admin/cost-templates/kira"], ["DELETE", "/api/admin/cost-templates/kira"],
    ["GET", "/api/admin/export"],
    ["POST", "/api/alerts/kinds"], ["POST", "/api/alerts/kinds/reorder"], ["PATCH", "/api/alerts/kinds/1"], ["DELETE", "/api/alerts/kinds/1"],
    ["GET", "/api/admin/not-a-route-yet"], // anything new under /api/admin/* is gated by default
  ];
  for (const [method, path] of routes) {
    assert.equal((await t.fetch(path, { method, body: method === "GET" ? undefined : {} })).status, 401, `anon ${method} ${path}`);
    assert.equal((await t.fetch(path, { method, as: t.member, body: method === "GET" ? undefined : {} })).status, 403, `member ${method} ${path}`);
  }
});

test("PATCH /api/me: own name + phone only, name required, validated", async () => {
  const u = (await (await t.fetch("/api/users", { method: "POST", as: t.admin, body: { name: "Profil Test" } })).json());
  assert.equal((await t.fetch("/api/me", { method: "PATCH", body: { name: "x" } })).status, 401);
  const ok = await t.fetch("/api/me", { method: "PATCH", as: u, body: { name: "  Yeni Ad ", phone: "+90 532 000 00 00", role: "admin", active: false } });
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.deepEqual([j.name, j.phone, j.role, j.active], ["Yeni Ad", "+90 532 000 00 00", "member", true]); // role/active not settable
  assert.equal((await t.fetch("/api/me", { as: u }).then((r) => r.json())).name, "Yeni Ad");
  assert.equal((await t.fetch("/api/me", { method: "PATCH", as: u, body: { name: "  ", phone: "" } })).status, 400);
  assert.equal((await t.fetch("/api/me", { method: "PATCH", as: u, body: { name: "A", phone: "abc" } })).status, 400);
  assert.equal((await t.fetch("/api/me", { method: "PATCH", as: u, body: { name: "A".repeat(81) } })).status, 400);
  const cleared = await (await t.fetch("/api/me", { method: "PATCH", as: u, body: { name: "Yeni Ad", phone: "" } })).json();
  assert.equal(cleared.phone, null);
  assert.equal((await t.fetch("/api/me", { as: t.member })).status, 200); // other users untouched
  assert.notEqual((await t.fetch("/api/me", { as: t.member }).then((r) => r.json())).name, "Yeni Ad");
});

test("POST /api/logout clears the cookie but keeps the invite token valid", async () => {
  const r = await t.fetch("/api/logout", { method: "POST", as: t.member });
  assert.equal(r.status, 200);
  const sc = r.headers.get("set-cookie");
  assert.match(sc, /prova_session=;/);
  assert.match(sc, /Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  assert.equal((await t.fetch("/api/me")).status, 401); // no cookie -> logged out
  assert.equal((await t.fetch(`/i/${t.member.invite_token}`)).status, 302); // same link logs back in
  assert.equal((await t.fetch("/api/me", { as: t.member })).status, 200);
  assert.equal((await t.fetch("/api/logout", { method: "POST" })).status, 200); // idempotent when logged out
});

const signup = (body, headers) => t.fetch("/api/signup", { method: "POST", body, headers });
const cookieOf = (r) => ({ invite_token: decodeURIComponent(r.headers.get("set-cookie").match(/prova_session=([^;]+)/)[1]) });

test("signup -> pending (only /me works, everything else 403) -> admin approves -> full access", async () => {
  const r = await signup({ name: " Selin Aksoy ", phone: "0532 111 22 33" });
  assert.equal(r.status, 201);
  const me = await r.json();
  assert.deepEqual([me.name, me.role, me.status, me.active], ["Selin Aksoy", "member", "pending", false]);
  const pend = cookieOf(r);

  const st = await (await t.fetch("/api/me", { as: pend })).json();
  assert.equal(st.status, "pending");
  for (const [m, p] of [["GET", "/api/reservations"], ["GET", "/api/members"], ["GET", "/api/billing"], ["GET", "/api/alerts"], ["PATCH", "/api/me"], ["GET", "/api/users"], ["GET", "/api/admin/fees"]]) {
    const x = await t.fetch(p, { as: pend, method: m, body: m === "GET" ? undefined : { name: "x" } });
    assert.equal(x.status, 403, `${m} ${p}`);
  }
  // not visible as a member to anyone else, not charged: pending stays out of every active=1 query
  const names = (await (await t.fetch("/api/members", { as: t.member })).json()).map((u) => u.name);
  assert.ok(!names.includes("Selin Aksoy"));
  // admin sees it first, without invite tokens
  const list = await (await t.fetch("/api/users", { as: t.admin })).json();
  assert.equal(list[0].name, "Selin Aksoy");
  assert.equal(list[0].pending, true);
  assert.ok(list.every((u) => !("invite_token" in u)));
  assert.equal((await t.fetch(`/api/users/${me.id}`, { method: "PATCH", as: t.admin, body: { active: true } })).status, 409);

  // members can't approve
  assert.equal((await t.fetch(`/api/users/${me.id}/approve`, { method: "POST", as: t.member })).status, 403);
  assert.equal((await t.fetch(`/api/users/${me.id}/approve`, { method: "POST", as: pend })).status, 403);

  const ap = await t.fetch(`/api/users/${me.id}/approve`, { method: "POST", as: t.admin });
  assert.equal(ap.status, 200);
  assert.equal((await ap.json()).status, "approved");
  assert.equal((await t.fetch(`/api/users/${me.id}/approve`, { method: "POST", as: t.admin })).status, 409); // already approved
  assert.equal((await (await t.fetch("/api/me", { as: pend })).json()).status, "approved");
  assert.equal((await t.fetch("/api/reservations", { as: pend })).status, 200);
  assert.equal((await t.fetch("/api/billing", { as: pend })).status, 200);
  assert.equal((await t.fetch("/api/users", { as: pend })).status, 403); // still not admin
  const names2 = (await (await t.fetch("/api/members", { as: t.member })).json()).map((u) => u.name);
  assert.ok(names2.includes("Selin Aksoy"));
});

test("signup -> admin rejects -> account gone, cookie dead", async () => {
  const r = await signup({ name: "Reddedilecek" });
  const me = await r.json();
  const pend = cookieOf(r);
  assert.equal((await t.fetch(`/api/users/${me.id}/reject`, { method: "POST", as: t.member })).status, 403);
  assert.equal((await t.fetch(`/api/users/${me.id}/reject`, { method: "POST", as: t.admin })).status, 200);
  assert.equal((await t.fetch("/api/me", { as: pend })).status, 401);
  assert.equal((await t.fetch(`/i/${pend.invite_token}`)).headers.get("location"), "/?davet=gecersiz");
  assert.ok(!(await (await t.fetch("/api/users", { as: t.admin })).json()).some((u) => u.id === me.id));
  assert.equal((await t.fetch(`/api/users/${me.id}/reject`, { method: "POST", as: t.admin })).status, 404);
  // an approved member can't be "rejected" (deleted) through this route
  assert.equal((await t.fetch(`/api/users/${t.member.id}/reject`, { method: "POST", as: t.admin })).status, 409);
});

test("signup validation; already logged in; /i/ link still logs a pending account in", async () => {
  assert.equal((await signup({ name: "  " })).status, 400);
  assert.equal((await signup({ name: "A", phone: "abc" })).status, 400);
  assert.equal((await t.fetch("/api/signup", { method: "POST", as: t.member, body: { name: "Başka" } })).status, 409);
  const r = await signup({ name: "Link Test" });
  const u = await (await t.fetch("/api/users", { as: t.admin })).json();
  const row = (await t.db.execute("SELECT invite_token FROM users WHERE name = 'Link Test'")).rows[0];
  assert.equal((await t.fetch(`/i/${row.invite_token}`)).status, 302);
  assert.equal((await t.fetch("/api/me", { as: row })).status, 200);
  assert.ok(r.ok && u.length > 0);
});

test("signup is rate limited per IP", async () => {
  const t2 = await makeTestApp();
  try {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await t2.fetch("/api/signup", { method: "POST", body: { name: "Kisi " + i } })).status);
    assert.deepEqual(codes, [201, 201, 201, 201, 201, 429, 429]);
  } finally { await t2.close(); }
});

test("existing/admin-created users stay approved; migration default", async () => {
  const rows = (await t.db.execute({ sql: "SELECT status FROM users WHERE id IN (?,?,?)", args: [t.admin.id, t.member.id, t.member2.id] })).rows;
  assert.ok(rows.every((x) => x.status === "approved"));
  const u = await (await t.fetch("/api/users", { method: "POST", as: t.admin, body: { name: "Elle Eklenen" } })).json();
  assert.equal(u.status, "approved");
  assert.equal((await t.fetch("/api/me", { as: u })).status, 200);
});
