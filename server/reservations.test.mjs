import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeTestApp } from "./test-helpers.mjs";

const H = 3600_000;
const t = await makeTestApp();
after(() => t.close());

// whole-hour instants in the future; each test uses its own day so bookings never collide
const day = (n) => Math.ceil((Date.now() + 2 * H) / H) * H + n * 24 * H;
const book = (as, start_ms, hours = 1, extra = {}) =>
  t.fetch("/api/reservations", { method: "POST", as, body: { start_ms, hours, ...extra } });

test("auth required; members list is id+name only, active only", async () => {
  assert.equal((await t.fetch("/api/reservations")).status, 401);
  assert.equal((await t.fetch("/api/members")).status, 401);
  const m = await (await t.fetch("/api/members", { as: t.member })).json();
  assert.equal(m.length, 4);
  assert.deepEqual(Object.keys(m[0]).sort(), ["id", "name"]);
});

test("create + everyone lists it with booker name and people count (default 1)", async () => {
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
  assert.equal((await book(t.member, day(5), 5)).status, 400); // > default max 4
  assert.equal((await book(t.member, day(5), 0)).status, 400);
  assert.equal((await book(t.member, day(5), 1.5)).status, 400);
  assert.equal((await book(t.member, day(5) + 30 * 60_000, 1)).status, 400);
  assert.equal((await book(t.member, Math.floor(Date.now() / H) * H - H, 1)).status, 400); // past
  for (const people of [0, -1, 2.5, 21, "3"]) assert.equal((await book(t.member, day(5), 1, { people })).status, 400, `people=${people}`);
  assert.equal((await book(t.member, undefined, 1)).status, 400);
});

test("max hours comes from settings", async () => {
  await t.db.execute("UPDATE settings SET value='2' WHERE key='max_reservation_hours'");
  assert.equal((await book(t.member, day(6), 3)).status, 400);
  assert.equal((await book(t.member, day(6), 2)).status, 201);
  await t.db.execute("UPDATE settings SET value='4' WHERE key='max_reservation_hours'");
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
