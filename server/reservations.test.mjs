import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeTestApp } from "./test-helpers.mjs";
import { newToken } from "./lib/auth.mjs";
import { EARLIEST_MS, currentMonth, monthOf } from "./lib/tz.mjs";

const H = 3600_000;
const t = await makeTestApp();
after(() => t.close());

// whole-hour instants in the future; each test uses its own day so bookings never collide
// 10:00 Istanbul on day (today + n + 1): always inside the 08-22 window (no reservation may end after 22:00)
const at10 = (ms) => Math.floor((ms + 3 * H) / (24 * H)) * 24 * H - 3 * H + 10 * H;
const day = (n) => at10(Date.now() + (n + 1) * 24 * H);
const book = (as, start_ms, hours = 1, extra = {}) =>
  t.fetch("/api/reservations", { method: "POST", as, body: { start_ms, hours, ...extra } });

test("auth required; members list is id+name only, active only", async () => {
  assert.equal((await t.fetch("/api/reservations")).status, 401);
  assert.equal((await t.fetch("/api/members")).status, 401);
  const m = await (await t.fetch("/api/members", { as: t.member })).json();
  assert.equal(m.length, 4);
  assert.deepEqual(Object.keys(m[0]).sort(), ["id", "name"]);
});

test("create + everyone lists it with booker name and people count (default 0)", async () => {
  const s = day(1);
  const r = await book(t.member, s, 2, { note: "  grup provası ", people: 4 });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.booker_name, t.member.name);
  assert.equal(c.end_ms - c.start_ms, 2 * H);
  assert.equal(c.note, "grup provası");
  assert.equal(c.people, 4);
  const list = await (await t.fetch(`/api/reservations?from=${s - H}&to=${s + 5 * H}`, { as: t.member2 })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, c.id);
});

test("overlap rejected 409; end==start boundary allowed on both sides", async () => {
  const s = day(2);
  assert.equal((await book(t.member, s, 2)).status, 201); // [s, s+2h)
  for (const [start, hours] of [[s, 1], [s + H, 1], [s - H, 2], [s - H, 4], [s + H, 3]]) {
    const r = await book(t.member2, start, hours);
    assert.equal(r.status, 409, `${start - s}/${hours}`);
    assert.match((await r.json()).error, /dolu/);
  }
  assert.equal((await book(t.member2, s + 2 * H, 1)).status, 201); // starts exactly at end
  assert.equal((await book(t.member2, s - H, 1)).status, 201); // ends exactly at start
});

test("concurrent identical + overlapping POSTs: exactly one wins", async () => {
  const s = day(3);
  const who = [t.member, t.member2, t.admin];
  const res = await Promise.all(Array.from({ length: 12 }, (_, i) => book(who[i % 3], s + (i % 2) * H, 2)));
  const codes = res.map((r) => r.status).sort();
  assert.equal(codes.filter((c) => c === 201).length, 1, codes.join());
  assert.equal(codes.filter((c) => c === 409).length, 11, codes.join());
  const n = (await t.db.execute({ sql: "SELECT COUNT(*) n FROM reservations WHERE start_ms >= ? AND start_ms < ?", args: [s, s + 5 * H] })).rows[0].n;
  assert.equal(n, 1);
});

test("validation: max duration, min 1h, past start, non-hour-aligned, bad people count", async () => {
  const s = day(4);
  assert.equal((await book(t.member, s, 4)).status, 201);
  assert.equal((await book(t.member, day(5), 5)).status, 201); // no max-hours cap (10:00-15:00)
  assert.equal((await book(t.member, day(32), 13)).status, 400); // 10:00 + 13h ends 23:00 > 22:00
  assert.equal((await book(t.member, day(5), 0)).status, 400);
  assert.equal((await book(t.member, day(5), 1.5)).status, 400);
  assert.equal((await book(t.member, day(5) + 30 * 60_000, 1)).status, 400);
  assert.equal((await book(t.member, EARLIEST_MS - H, 1)).status, 400); // before the floor
  for (const people of [-1, 2.5, 21, "3"]) assert.equal((await book(t.member, day(5), 1, { people })).status, 400, `people=${people}`);
  assert.equal((await book(t.member, undefined, 1)).status, 400);
});

test("no reservation ends after 22:00 Istanbul (book + hold)", async () => {
  const s = day(30); // 10:00
  assert.equal((await book(t.member, s, 12)).status, 201); // ends exactly 22:00
  const late = day(31) + 11 * H; // 21:00 start
  assert.equal((await book(t.member, late, 2)).status, 400);
  assert.equal((await book(t.member, late + H, 1)).status, 400); // 22:00 start
  assert.equal((await t.fetch("/api/holds", { method: "POST", as: t.member, body: { start_ms: late, hours: 2 } })).status, 400);
  assert.equal((await t.fetch("/api/holds", { method: "POST", as: t.member, body: { start_ms: late, hours: 1 } })).status, 200);
  assert.equal((await book(t.member, late, 1)).status, 201); // 21:00-22:00 ok
});

test("cancel: booker or admin only, frees the slot, not after start, listing hides cancelled", async () => {
  const s = day(7);
  const { id } = await (await book(t.member, s, 1)).json();
  assert.equal((await t.fetch(`/api/reservations/${id}`, { method: "DELETE" })).status, 401);
  assert.equal((await t.fetch(`/api/reservations/${id}`, { method: "DELETE", as: t.member2 })).status, 403);
  assert.equal((await t.fetch(`/api/reservations/${id}`, { method: "DELETE", as: t.member })).status, 200);
  assert.equal((await t.fetch(`/api/reservations/${id}`, { method: "DELETE", as: t.member })).status, 404);
  assert.equal((await t.db.execute({ sql: "SELECT cancelled_at FROM reservations WHERE id=?", args: [id] })).rows[0].cancelled_at > 0, true);
  const list = await (await t.fetch(`/api/reservations?from=${s}&to=${s + H}`, { as: t.member })).json();
  assert.equal(list.length, 0);
  const again = await book(t.member2, s, 1); // slot free again
  assert.equal(again.status, 201);
  const { id: id2 } = await again.json();
  // admin on someone else's booking needs the hard gate (see the dedicated test below)
  const gate = { confirm: t.member2.name.split(" ")[0], reason: "oda bakıma alınacak" };
  assert.equal((await t.fetch(`/api/reservations/${id2}`, { method: "DELETE", as: t.admin, body: gate })).status, 200);
});

const audit = async (id) => (await t.db.execute({ sql: "SELECT * FROM reservation_audit WHERE reservation_id = ?", args: [id] })).rows;
const cancelledAt = async (id) => (await t.db.execute({ sql: "SELECT cancelled_at FROM reservations WHERE id=?", args: [id] })).rows[0].cancelled_at;

test("admin cancelling ANOTHER member's booking: hard gate (typed first name + reason), audited", async () => {
  const s = day(8);
  const { id } = await (await book(t.member, s, 1)).json();
  const del = (as, body) => t.fetch(`/api/reservations/${id}`, { method: "DELETE", as, body });
  const first = t.member.name.split(" ")[0];
  // no body, no reason, short reason, no/wrong confirm -> 400 and the booking is untouched
  for (const body of [undefined, {}, { confirm: first }, { confirm: first, reason: "yok" }, { reason: "yeterince uzun neden" }, { confirm: "Baskasi", reason: "yeterince uzun neden" }, { confirm: first, reason: "     " }]) {
    const r = await del(t.admin, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok((await r.json()).error);
    assert.equal(await cancelledAt(id), null);
  }
  assert.equal((await audit(id)).length, 0);
  // a member cannot cancel someone else's booking, gate or not
  assert.equal((await del(t.member2, { confirm: first, reason: "yeterince uzun neden" })).status, 403);
  assert.equal(await cancelledAt(id), null);
  // passes: case-insensitive first name + reason; actor, booker and reason recorded
  const ok = await del(t.admin, { confirm: ` ${first.toUpperCase()} `, reason: "  Oda bakıma alınacak  " });
  assert.equal(ok.status, 200);
  assert.ok((await cancelledAt(id)) > 0);
  const [a] = await audit(id);
  assert.equal(a.action, "admin_cancel");
  assert.equal(a.actor_id, t.admin.id);
  assert.equal(a.booker_id, t.member.id);
  assert.equal(a.reason, "Oda bakıma alınacak");
  assert.equal(a.start_ms, s);
  // audit list: admin only; export carries the table
  assert.equal((await t.fetch("/api/reservations/audit", { as: t.member })).status, 403);
  const list = await (await t.fetch("/api/reservations/audit", { as: t.admin })).json();
  assert.equal(list.find((x) => x.reservation_id === id).actor_name, t.admin.name);
  const exp = await (await t.fetch("/api/admin/export?format=json", { as: t.admin })).json();
  assert.ok(exp.reservation_audit.some((x) => x.reservation_id === id));
});

test("own cancel stays simple (no body) and is audited as 'cancel'; an admin's own booking too", async () => {
  const { id } = await (await book(t.member, day(9), 1)).json();
  assert.equal((await t.fetch(`/api/reservations/${id}`, { method: "DELETE", as: t.member })).status, 200);
  const [a] = await audit(id);
  assert.equal(a.action, "cancel");
  assert.equal(a.reason, null);
  const { id: id2 } = await (await book(t.admin, day(9), 1)).json();
  assert.equal((await t.fetch(`/api/reservations/${id2}`, { method: "DELETE", as: t.admin })).status, 200);
  assert.equal((await audit(id2))[0].action, "cancel");
});

test("cannot cancel a started reservation", async () => {
  const now = Date.now();
  const s = Math.floor(now / H) * H - H;
  const { lastInsertRowid } = await t.db.execute({
    sql: "INSERT INTO reservations (booker_id, start_ms, end_ms) VALUES (?,?,?)", args: [t.member.id, s, s + 2 * H],
  });
  assert.equal((await t.fetch(`/api/reservations/${lastInsertRowid}`, { method: "DELETE", as: t.member })).status, 409);
});

test("past reservations: admin may cancel (gated, audited, unpaid charge voided); members may not", async () => {
  const s = Math.floor(Date.now() / H) * H - 3 * H;
  const mk = async (booker) => {
    const { lastInsertRowid: id } = await t.db.execute({
      sql: "INSERT INTO reservations (booker_id, start_ms, end_ms) VALUES (?,?,?)", args: [booker.id, s, s + H],
    });
    return Number(id);
  };
  const del = (id, as, body) => t.fetch(`/api/reservations/${id}`, { method: "DELETE", as, body });
  const id = await mk(t.member);
  await t.db.execute({ sql: "INSERT INTO charges (user_id, month, kind, amount_try, reservation_id) VALUES (?,?, 'booking', 100, ?)", args: [t.member.id, currentMonth(), id] });
  const first = t.member.name.split(" ")[0];
  const ok = { confirm: first, reason: "geçmiş kayıt hatalı" };
  // member: own past -> 409, others' past -> 403
  assert.equal((await del(id, t.member)).status, 409);
  assert.equal((await del(id, t.member2, ok)).status, 403);
  // admin: validation gate still applies
  assert.equal((await del(id, t.admin)).status, 400);
  assert.equal((await del(id, t.admin, { confirm: first, reason: "yok" })).status, 400);
  assert.equal(await cancelledAt(id), null);
  // admin passes the gate
  assert.equal((await del(id, t.admin, ok)).status, 200);
  assert.ok((await cancelledAt(id)) > 0);
  const [a] = await audit(id);
  assert.equal(a.action, "admin_cancel");
  assert.equal(a.actor_id, t.admin.id);
  assert.equal(a.reason, "geçmiş kayıt hatalı");
  const ch = (await t.db.execute({ sql: "SELECT voided_at FROM charges WHERE reservation_id = ?", args: [id] })).rows[0];
  assert.ok(ch.voided_at > 0);
  // paid charge stays when the past booking is cancelled
  const id2 = await mk(t.member);
  const rc = (await t.db.execute({ sql: "INSERT INTO receipts (user_id, month, sha256, status, uploaded_at) VALUES (?,?,?, 'ok', 1)", args: [t.member.id, currentMonth(), `past-${id2}`] }));
  await t.db.execute({ sql: "INSERT INTO charges (user_id, month, kind, amount_try, reservation_id, paid_receipt_id, paid_by) VALUES (?,?, 'booking', 100, ?, ?, 'admin')", args: [t.member.id, currentMonth(), id2, Number(rc.lastInsertRowid)] });
  assert.equal((await del(id2, t.admin, ok)).status, 200);
  assert.equal((await t.db.execute({ sql: "SELECT voided_at FROM charges WHERE reservation_id = ?", args: [id2] })).rows[0].voided_at, null);
});

test("back-filling past hours: booked + charged in that month, overlap/limit enforced, no joined_month limit, only admin cancels", async () => {
  const D = 24 * H;
  const mkOld = async (name) => { // joined long ago, so past months are theirs
    const { lastInsertRowid } = await t.db.execute({
      sql: "INSERT INTO users (name, role, invite_token, joined_month, created_at) VALUES (?, 'member', ?, '2000-01', ?)",
      args: [name, newToken(), Date.now()],
    });
    return (await t.db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [lastInsertRowid] })).rows[0];
  };
  const u = await mkOld("Geçmiş Deneme"), u2 = await mkOld("Eski Üye");
  const cfg = await (await t.fetch("/api/reservations/config", { as: u })).json();
  assert.equal(cfg.earliest_ms, EARLIEST_MS);
  assert.equal(cfg.earliest_date, "2025-01-01");

  const s = at10(Date.now() - 60 * D); // a whole hour two months back
  assert.equal((await t.fetch("/api/holds", { method: "POST", as: u, body: { start_ms: s, hours: 2 } })).status, 200); // sheet's hold works in the past
  const r = await book(u, s, 2, { people: 2 });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.booker_id, u.id);
  const ch = (await t.db.execute({ sql: "SELECT month, amount_try FROM charges WHERE reservation_id = ?", args: [c.id] })).rows;
  assert.equal(ch.length, 1);
  assert.equal(ch[0].month, monthOf(s)); // charge lands in the reservation's (past) month

  assert.equal((await book(u2, s + H, 1)).status, 409); // overlap still checked in the past
  assert.equal((await book(u, EARLIEST_MS - H, 1)).status, 400); // before the floor
  assert.equal((await t.fetch("/api/holds", { method: "POST", as: u, body: { start_ms: EARLIEST_MS - H, hours: 1 } })).status, 400);
  assert.equal((await book(u, EARLIEST_MS, 1)).status, 201); // the floor itself, ~1.5y back, is fine
  assert.equal((await t.fetch("/api/reservations?from=" + EARLIEST_MS + "&to=" + (EARLIEST_MS + 400 * D), { as: u })).status, 200);
  assert.equal((await book(u, s + 30 * 60_000, 1)).status, 400); // still whole-hour aligned

  // before the booker's joined_month is fine now (existing members are back-filled)
  await t.db.execute({ sql: "UPDATE users SET joined_month = ? WHERE id = ?", args: [currentMonth(), u.id] });
  assert.equal((await book(u, s + 3 * H, 1)).status, 201);

  // the booker can't undo a past booking themselves; an admin can (gated)
  assert.equal((await t.fetch(`/api/reservations/${c.id}`, { method: "DELETE", as: u })).status, 409);
});

test("'listener' role: can't book or hold, but sees reservations and appears in /members", async () => {
  const { lastInsertRowid } = await t.db.execute({
    sql: "INSERT INTO users (name, role, invite_token, joined_month, created_at) VALUES ('Dinleyici Deneme', 'listener', ?, ?, ?)",
    args: [newToken(), currentMonth(), Date.now()],
  });
  const listener = (await t.db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [lastInsertRowid] })).rows[0];

  const s = day(10);
  const r = await book(listener, s, 1);
  assert.equal(r.status, 403);

  assert.equal((await t.fetch("/api/holds", { method: "POST", as: listener, body: { start_ms: s, hours: 1 } })).status, 403);

  // still a normal, visible member: shows up in /members and can see the calendar
  const members = await (await t.fetch("/api/members", { as: t.member })).json();
  assert.ok(members.some((m) => m.id === listener.id));
  const { id } = await (await book(t.member, s, 1)).json();
  const list = await (await t.fetch(`/api/reservations?from=${s - H}&to=${s + H}`, { as: listener })).json();
  assert.ok(list.some((x) => x.id === id));
});

test("GET /reservations/mine: own only, newest first, cancelled marked, auth required", async () => {
  assert.equal((await t.fetch("/api/reservations/mine")).status, 401);
  const a = await (await book(t.member, day(20), 1, { people: 3 })).json();
  const b = await (await book(t.member, day(21), 1)).json();
  const o = await (await book(t.member2, day(22), 1)).json();
  assert.equal((await t.fetch(`/api/reservations/${b.id}`, { method: "DELETE", as: t.member })).status, 200);
  const mine = await (await t.fetch("/api/reservations/mine", { as: t.member })).json();
  const ids = mine.map((x) => x.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id) && !ids.includes(o.id));
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id));
  assert.ok(mine.find((x) => x.id === b.id).cancelled_at);
  assert.equal(mine.find((x) => x.id === a.id).people, 3);
  assert.ok("charge_try" in mine[0]);
});

test("PATCH /reservations/:id: owner edits time/people/note, charge re-priced, overlap + authz + validation, paid split in /mine", async () => {
  const s = day(77);
  const a = await (await book(t.member, s, 1, { people: 1 })).json();
  const other = await (await book(t.member2, s + 3 * H, 1)).json();
  const patch = (id, body, as = t.member) => t.fetch(`/api/reservations/${id}`, { method: "PATCH", as, body });
  assert.equal((await patch(a.id, { start_ms: s + H, hours: 2, people: 3, note: "yeni" })).status, 200);
  const mine = await (await t.fetch("/api/reservations/mine", { as: t.member })).json();
  const m = mine.find((x) => x.id === a.id);
  assert.equal(m.start_ms, s + H); assert.equal(m.end_ms, s + 3 * H); assert.equal(m.people, 3); assert.equal(m.note, "yeni");
  assert.equal(m.month, monthOf(s));
  if (m.charge_try != null) assert.equal(m.unpaid_try, m.charge_try);
  assert.equal(m.paid_try, 0);
  assert.equal((await patch(a.id, { start_ms: s + 3 * H, hours: 1 })).status, 409); // clashes with other
  assert.equal((await patch(a.id, { start_ms: s + H, hours: 1 }, t.member2)).status, 403); // not the booker
  assert.equal((await patch(a.id, { start_ms: s + H + 1, hours: 1 })).status, 400);
  assert.equal((await patch(a.id, { start_ms: s + H, hours: 1, people: 99 })).status, 400);
  assert.equal((await patch(a.id, { start_ms: s + 11 * H, hours: 2 })).status, 400); // curfew
  assert.equal((await patch(999999, { start_ms: s, hours: 1 })).status, 404);
  assert.equal((await t.fetch(`/api/reservations/${a.id}`, { method: "PATCH", body: {} })).status, 401);
});

test("members lock out 1 h before start (edit + cancel); outside the window ok; admin unaffected", async () => {
  const { updateReservation, cancelReservation, EDIT_CUTOFF_MS } = await import("./lib/reservations.mjs");
  assert.equal(EDIT_CUTOFF_MS, H);
  const s = day(91);
  const a = await (await book(t.member, s, 1)).json();
  const patch = (id, as, body) => t.fetch(`/api/reservations/${id}`, { method: "PATCH", as, body });
  // exactly 1 h before start: still allowed (edit); 59 min before: blocked
  await updateReservation(t.db, a.id, t.member, { startMs: s, hours: 1, note: "x", now: s - H });
  await assert.rejects(updateReservation(t.db, a.id, t.member, { startMs: s, hours: 1, now: s - H + 60_000 }), (e) => e.status === 409);
  await assert.rejects(cancelReservation(t.db, a.id, t.member, { now: s - H + 60_000 }), (e) => e.status === 409);
  // admin edit/cancel inside the window still works
  await updateReservation(t.db, a.id, t.admin, { startMs: s, hours: 1, now: s - 60_000 }).catch((e) => assert.equal(e.status, 403)); // not booker: 403 (unchanged)
  const b = await (await book(t.member, s + 3 * H, 1)).json();
  await cancelReservation(t.db, b.id, t.admin, { reason: "iptal nedeni", confirm: t.member.name.split(" ")[0], now: s + 3 * H - 60_000 });
  // member cancel at exactly the cutoff works
  await cancelReservation(t.db, a.id, t.member, { now: s - H });
  assert.equal((await patch(a.id, t.member, { start_ms: s, hours: 1 })).status, 404);
});
