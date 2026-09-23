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

test("bootstrap admin (lowest id, from seed) is hidden from GET /users for everyone else; a later-promoted admin stays visible", async () => {
  // the BOOTSTRAP admin promotes an existing member to admin ("make users admins") - so we have a non-bootstrap admin's eye view
  const promoted = await (await t.fetch(`/api/users/${t.member2.id}`, { method: "PATCH", as: t.boot, body: { role: "admin" } })).json();
  assert.equal(promoted.role, "admin");

  const listFromPromoted = await (await t.fetch("/api/users", { as: t.member2 })).json();
  assert.ok(!listFromPromoted.some((u) => u.id === t.boot.id), "bootstrap admin must not appear in a promoted admin's list");
  assert.ok(listFromPromoted.some((u) => u.id === t.member2.id && u.role === "admin"), "the promoted admin sees themselves");

  const listFromMember = await (await t.fetch("/api/users", { as: t.member })).status; // members are 403, can't see any list
  assert.equal(listFromMember, 403);
  const members = await (await t.fetch("/api/members", { as: t.member })).json(); // the member-level id+name picker
  assert.ok(!members.some((u) => u.id === t.boot.id), "bootstrap admin must not appear in /api/members either");
  assert.ok((await (await t.fetch("/api/members", { as: t.boot })).json()).some((u) => u.id === t.boot.id), "…except to itself");

  const listFromBootstrap = await (await t.fetch("/api/users", { as: t.boot })).json();
  assert.ok(listFromBootstrap.some((u) => u.id === t.boot.id), "the bootstrap admin still sees themselves in their own list");
  assert.ok(listFromBootstrap.some((u) => u.id === t.member2.id && u.role === "admin"), "promoted admin also visible to the bootstrap admin");

  // another admin can't reach the bootstrap admin by id (no demote / deactivate / token takeover / billing peek)
  for (const [path, method, body] of [
    [`/api/users/${t.boot.id}`, "PATCH", { role: "member" }],
    [`/api/users/${t.boot.id}/regenerate-invite`, "POST", undefined],
    [`/api/admin/users/${t.boot.id}/billing`, "GET", undefined],
    [`/api/admin/users/${t.boot.id}/charges`, "POST", { month: "2026-01", amount_try: 100, note: "x" }],
  ]) assert.equal((await t.fetch(path, { method, as: t.member2, body })).status, 404, `${method} ${path}`);
  assert.equal((await t.fetch(`/api/admin/users/${t.boot.id}/billing`, { as: t.boot })).status, 200, "own page still works");

  // /me says observer only to the bootstrap admin itself
  assert.equal((await (await t.fetch("/api/me", { as: t.boot })).json()).observer, true);
  assert.equal((await (await t.fetch("/api/me", { as: t.admin })).json()).observer, false);

  // demote back so later tests aren't affected by this test
  await t.fetch(`/api/users/${t.member2.id}`, { method: "PATCH", as: t.boot, body: { role: "member" } });
});

test("bootstrap admin: can't reserve or hold, never billed, not in economics; full admin read access", async () => {
  const H = 3600_000;
  const start = Math.ceil(Date.now() / H) * H + 40 * 24 * H;
  const r = await t.fetch("/api/reservations", { method: "POST", as: t.boot, body: { start_ms: start, hours: 1 } });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /rezervasyon yapamaz/);
  assert.equal((await t.fetch("/api/holds", { method: "POST", as: t.boot, body: { start_ms: start, hours: 1 } })).status, 403);
  // a real admin (not the bootstrap one) still books normally
  assert.equal((await t.fetch("/api/reservations", { method: "POST", as: t.admin, body: { start_ms: start + 5 * H, hours: 1 } })).status, 201);

  // own billing page: opens, nothing to pay, no charge materialised, no planned rent for next month
  const bill = await (await t.fetch("/api/billing", { as: t.boot })).json();
  assert.equal(bill.kalan, 0);
  assert.equal(bill.items.length, 0);
  assert.equal(bill.other_open.length, 0);
  const next = bill.months[bill.months.indexOf(bill.month) + 1];
  assert.equal((await (await t.fetch(`/api/billing?month=${next}`, { as: t.boot })).json()).projected_try, 0);

  // economics: the summary materialises every REAL active member's rent, not the bootstrap admin's; a legacy charge
  // on the bootstrap admin (from before this rule) doesn't count toward income or member numbers either
  const eco1 = await (await t.fetch("/api/admin/economics", { as: t.boot })).json();
  assert.equal((await t.db.execute({ sql: "SELECT COUNT(*) n FROM charges WHERE user_id = ?", args: [t.boot.id] })).rows[0].n, 0);
  await t.db.execute({ sql: "INSERT INTO charges (user_id, month, kind, amount_try) VALUES (?, ?, 'subscription', 99999)", args: [t.boot.id, eco1.month] });
  const eco2 = await (await t.fetch("/api/admin/economics", { as: t.boot })).json();
  assert.deepEqual(eco2.months.at(-1), eco1.months.at(-1), "legacy bootstrap charge must not reach economics");
  const ov = await (await t.fetch("/api/admin/billing/overview", { as: t.boot })).json();
  assert.ok(!ov.users.some((u) => u.id === t.boot.id));
  await t.db.execute({ sql: "DELETE FROM charges WHERE user_id = ?", args: [t.boot.id] });
  // no ad-hoc charge can be put on it either (even by itself)
  assert.equal((await t.fetch(`/api/admin/users/${t.boot.id}/charges`, { method: "POST", as: t.boot, body: { month: eco1.month, amount_try: 100, note: "x" } })).status, 409);

  // observe everything: every admin read works for the bootstrap admin
  for (const p of ["/api/users", "/api/admin/billing/overview", "/api/admin/receipts", "/api/admin/economics", "/api/admin/fees",
    "/api/admin/settings", "/api/admin/export", "/api/reservations/audit", "/api/alerts", `/api/admin/users/${t.member.id}/billing`])
    assert.equal((await t.fetch(p, { as: t.boot })).status, 200, p);

  // alerts raised by it show "Yönetici", never its real name
  const a = await (await t.fetch("/api/alerts", { method: "POST", as: t.boot, body: { kind_id: 3 } })).json();
  assert.equal(a.raised_by_name, "Yönetici");
  await t.fetch(`/api/alerts/${a.id}/close`, { method: "POST", as: t.boot });
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

test("POST /api/login: credential login works for approved users", async () => {
  // Create a user with email + password via admin
  const u = await (await t.fetch("/api/users", { method: "POST", as: t.admin, body: { name: "Login Test", email: "logintest@example.com" } })).json();
  // Set password hash directly (simulate user setting it)
  const { hashPassword } = await import("./lib/auth.mjs");
  const hash = await hashPassword("testpass123");
  await t.db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [hash, u.id] });
  
  // Login with correct credentials
  const login = await t.fetch("/api/login", { method: "POST", body: { email: "logintest@example.com", password: "testpass123" } });
  assert.equal(login.status, 200);
  const data = await login.json();
  assert.equal(data.id, u.id);
  assert.equal(data.email, "logintest@example.com");
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /prova_session=/);
  
  // Cookie works for /me
  const me = await t.fetch("/api/me", { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  const meData = await me.json();
  assert.equal(meData.id, u.id);
  
  // Wrong password fails
  const badLogin = await t.fetch("/api/login", { method: "POST", body: { email: "logintest@example.com", password: "wrong" } });
  assert.equal(badLogin.status, 401);
  
  // Non-existent email fails
  const noUser = await t.fetch("/api/login", { method: "POST", body: { email: "nobody@example.com", password: "testpass123" } });
  assert.equal(noUser.status, 401);
  
  // Pending user cannot log in with credentials
  const pending = await (await t.fetch("/api/signup", { method: "POST", body: { name: "Pending", email: "pending@example.com", password: "testpass123" } })).json();
  const pendingLogin = await t.fetch("/api/login", { method: "POST", body: { email: "pending@example.com", password: "testpass123" } });
  assert.equal(pendingLogin.status, 401);
  // clean up: don't leak a pending user into later tests that assume they're the only one
  await t.fetch(`/api/users/${pending.id}/reject`, { method: "POST", as: t.admin });
});

const signup = (body, headers) => t.fetch("/api/signup", { method: "POST", body, headers });
const cookieOf = (r) => {
  const m = r.headers.get("set-cookie")?.match(/prova_session=([^;]+)/);
  return m ? { invite_token: decodeURIComponent(m[1]) } : null;
};

test("signup -> pending (only /me works, everything else 403) -> admin approves -> full access", async () => {
  const r = await signup({ name: " Selin Aksoy ", email: "selin@example.com", password: "secret123", phone: "0532 111 22 33" });
  assert.equal(r.status, 201);
  const me = await r.json();
  assert.deepEqual([me.name, me.role, me.status, me.active], ["Selin Aksoy", "member", "pending", false]);
  assert.ok(me.email === "selin@example.com");
  const pend = cookieOf(r);

  const st = await (await t.fetch("/api/me", { as: pend })).json();
  assert.equal(st.status, "pending");
  for (const [m, p] of [["GET", "/api/reservations"], ["GET", "/api/members"], ["GET", "/api/billing"], ["POST", "/api/billing/receipts"], ["GET", "/api/alerts"], ["PATCH", "/api/me"], ["GET", "/api/users"], ["GET", "/api/admin/fees"]]) {
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
  const r = await signup({ name: "Reddedilecek", email: "reject@example.com", password: "secret123" });
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
  assert.equal((await signup({ name: "  ", email: "x@y.com", password: "secret123" })).status, 400);
  assert.equal((await signup({ name: "A", email: "bad", password: "secret123" })).status, 400);
  assert.equal((await signup({ name: "A", email: "a@b.com", password: "short" })).status, 400);
  assert.equal((await t.fetch("/api/signup", { method: "POST", as: t.member, body: { name: "Başka", email: "baska@example.com", password: "secret123" } })).status, 409);
  const r = await signup({ name: "Link Test", email: "link@example.com", password: "secret123" });
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
    for (let i = 0; i < 7; i++) codes.push((await t2.fetch("/api/signup", { method: "POST", body: { name: "Kisi " + i, email: `kisi${i}@example.com`, password: "secret123" } })).status);
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
