import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeTestApp } from "./test-helpers.mjs";
import { setHold, listHolds } from "./lib/holds.mjs";

const H = 3600_000;
const t = await makeTestApp();
after(() => t.close());

// each test owns a day, far from reservations.test.mjs (separate DB anyway)
const day = (n) => Math.ceil((Date.now() + 2 * H) / H) * H + n * 24 * H;
const hold = (as, start_ms, hours = 1) => t.fetch("/api/holds", { method: "POST", as, body: { start_ms, hours } });
const book = (as, start_ms, hours = 1) => t.fetch("/api/reservations", { method: "POST", as, body: { start_ms, hours } });
const release = (as) => t.fetch("/api/holds", { method: "DELETE", as });
const holds = async (as) => (await t.fetch("/api/holds", { as })).json();
const dbHolds = async () => (await t.db.execute("SELECT * FROM slot_holds")).rows;

test("auth required; a hold is visible to OTHERS only, with name + expiry", async () => {
  assert.equal((await t.fetch("/api/holds")).status, 401);
  assert.equal((await t.fetch("/api/holds", { method: "POST", body: {} })).status, 401);
  const s = day(1);
  const r = await hold(t.member, s, 2);
  assert.equal(r.status, 200);
  const h = await r.json();
  assert.equal(h.end_ms - h.start_ms, 2 * H);
  assert.ok(h.expires_at > Date.now() && h.expires_at <= Date.now() + 130_000, "~2 min TTL");
  assert.equal((await holds(t.member)).length, 0, "own hold is not listed");
  const seen = await holds(t.member2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].user_name, t.member.name);
  assert.equal(seen[0].start_ms, s);
  await release(t.member);
  assert.equal((await holds(t.member2)).length, 0);
});

test("A holds -> B's hold and B's booking on overlap are 409, A's own booking works and consumes the hold", async () => {
  const s = day(2);
  assert.equal((await hold(t.member, s, 2)).status, 200); // [s, s+2h)
  for (const [start, hours] of [[s, 1], [s + H, 1], [s - H, 2], [s + H, 3]]) {
    const h = await hold(t.member2, start, hours);
    assert.equal(h.status, 409, `hold ${start - s}/${hours}`);
    assert.match((await h.json()).error, new RegExp(t.member.name));
    const b = await book(t.member2, start, hours);
    assert.equal(b.status, 409, `book ${start - s}/${hours}`);
    assert.match((await b.json()).error, /az önce başkası/);
  }
  // adjacent hours are free for B (end == start)
  assert.equal((await book(t.member2, s + 2 * H, 1)).status, 201);
  assert.equal((await book(t.member2, s - H, 1)).status, 201);
  // A books through their own hold
  assert.equal((await book(t.member, s, 2)).status, 201);
  assert.equal((await dbHolds()).filter((x) => x.user_id === t.member.id).length, 0, "hold consumed");
  // now it is simply booked: a hold there says "dolu"
  const late = await hold(t.member2, s, 1);
  assert.equal(late.status, 409);
  assert.match((await late.json()).error, /dolu/);
});

test("expiry frees the slot (TTL injectable; expired rows never block)", async () => {
  const s = day(3);
  // lib level: 50 ms TTL from a fake clock
  const now = Date.now();
  await setHold(t.db, { userId: t.member.id, startMs: s, hours: 1, maxHours: 4, now, ttlMs: 50 });
  assert.equal((await listHolds(t.db, t.member2.id, now + 10)).length, 1);
  assert.equal((await listHolds(t.db, t.member2.id, now + 60)).length, 0, "expired -> not listed");
  // HTTP level: age the row in the DB instead of sleeping
  assert.equal((await hold(t.member, s, 1)).status, 200);
  assert.equal((await hold(t.member2, s, 1)).status, 409);
  await t.db.execute({ sql: "UPDATE slot_holds SET expires_at = ? WHERE user_id = ?", args: [Date.now() - 1, t.member.id] });
  assert.equal((await holds(t.member2)).length, 0);
  assert.equal((await hold(t.member2, s, 1)).status, 200, "B can now hold it (A's stale row is replaced/pruned)");
  assert.equal((await dbHolds()).some((x) => x.user_id === t.member.id), false, "expired row pruned on write");
  assert.equal((await book(t.member, s, 1)).status, 409, "and A is now the one blocked");
  await release(t.member2);
  assert.equal((await book(t.member, s, 1)).status, 201);
});

test("one hold per user: a new hold replaces the old; refresh extends; release frees", async () => {
  const s = day(4);
  await hold(t.member, s, 1);
  const first = (await dbHolds()).find((x) => x.user_id === t.member.id).expires_at;
  await hold(t.member, s + 5 * H, 2); // moves the hold
  const mine = (await dbHolds()).filter((x) => x.user_id === t.member.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].start_ms, s + 5 * H);
  assert.equal((await hold(t.member2, s, 1)).status, 200, "old range is free again");
  await hold(t.member2, s, 1); // refresh same range: no self-conflict
  assert.ok((await dbHolds()).find((x) => x.user_id === t.member2.id).expires_at >= first);
  await release(t.member); await release(t.member2);
  assert.equal((await dbHolds()).length, 0);
  assert.equal((await release(t.member)).status, 200, "release without a hold is a no-op");
});

test("hold validation: hour-aligned, future, 1..max hours", async () => {
  const s = day(5);
  for (const body of [{}, { start_ms: s + 1800_000, hours: 1 }, { start_ms: s, hours: 0 }, { start_ms: s, hours: 5 }, { start_ms: s, hours: 1.5 }, { start_ms: Math.floor(Date.now() / H) * H - H, hours: 1 }]) {
    assert.equal((await t.fetch("/api/holds", { method: "POST", as: t.member, body })).status, 400, JSON.stringify(body));
  }
});

test("concurrent holds on the same slot: exactly one user wins", async () => {
  const s = day(6);
  const who = [t.member, t.member2, t.admin];
  const res = await Promise.all(Array.from({ length: 9 }, (_, i) => hold(who[i % 3], s, 1)));
  const codes = res.map((r) => r.status);
  const winners = new Set(res.map((r, i) => (r.status === 200 ? who[i % 3].id : null)).filter(Boolean));
  assert.equal(winners.size, 1, codes.join());
  assert.equal((await dbHolds()).filter((x) => x.start_ms === s).length, 1);
  for (const u of who) await release(u);
});

test("holds are not in the export (ephemeral)", async () => {
  const exp = await (await t.fetch("/api/admin/export?format=json", { as: t.admin })).json();
  assert.equal("slot_holds" in exp, false);
});
