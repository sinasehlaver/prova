import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeTestApp } from "./test-helpers.mjs";
import { ago, severity } from "../web/src/ago.js";

const t = await makeTestApp();
after(() => t.close());
const J = async (path, opt) => { const r = await t.fetch(path, opt); return [r.status, await r.json()]; };
const kindId = async (key) => (await t.db.execute({ sql: "SELECT id FROM alert_kinds WHERE key = ?", args: [key] })).rows[0].id;

test("requires login", async () => {
  assert.equal((await t.fetch("/api/alerts")).status, 401);
});

test("raise is idempotent, close reopens the slot, history records who/when", async () => {
  const k = await kindId("galos");
  const [s1, a1] = await J("/api/alerts", { as: t.member, method: "POST", body: { kind_id: k } });
  assert.equal(s1, 201);
  assert.equal(a1.raised_by_name, t.member.name);
  const [s2, a2] = await J("/api/alerts", { as: t.member2, method: "POST", body: { kind_id: k } });
  assert.equal(s2, 200);
  assert.equal(a2.id, a1.id);
  assert.equal(a2.raised_by_name, t.member.name); // first reporter kept

  const [, open] = await J("/api/alerts", { as: t.member2 });
  assert.equal(open.length, 1);
  assert.equal(open[0].label_resolved, "Galoş aldım");

  const [sc, closed] = await J(`/api/alerts/${a1.id}/close`, { as: t.member2, method: "POST" });
  assert.equal(sc, 200);
  assert.equal(closed.closed_by_name, t.member2.name);
  assert.ok(closed.closed_at);
  const [, again] = await J(`/api/alerts/${a1.id}/close`, { as: t.member, method: "POST" });
  assert.equal(again.closed_by, t.member2.id); // second close doesn't overwrite
  assert.equal((await J("/api/alerts", { as: t.member }))[1].length, 0);

  const [s3, a3] = await J("/api/alerts", { as: t.member, method: "POST", body: { kind_id: k } });
  assert.equal(s3, 201);
  assert.notEqual(a3.id, a1.id);
  const [, hist] = await J("/api/alerts/history?limit=1", { as: t.member });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].id, a3.id);
  const [, page2] = await J(`/api/alerts/history?before=${a3.id}`, { as: t.member });
  assert.equal(page2[0].id, a1.id);
  assert.equal(page2[0].closed_by_name, t.member2.name);
  await J(`/api/alerts/${a3.id}/close`, { as: t.member, method: "POST" });
});

test("concurrent double-raise -> exactly one open alert", async () => {
  const k = await kindId("cop");
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    t.fetch("/api/alerts", { as: i % 2 ? t.member : t.member2, method: "POST", body: { kind_id: k } })));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 201));
  const ids = new Set((await Promise.all(rs.map((r) => r.json()))).map((a) => a.id));
  assert.equal(ids.size, 1);
  const n = (await t.db.execute({ sql: "SELECT COUNT(*) n FROM alerts WHERE kind_id = ? AND closed_at IS NULL", args: [k] })).rows[0].n;
  assert.equal(n, 1);
});

test("unknown kind 404, unknown alert close 404", async () => {
  assert.equal((await t.fetch("/api/alerts", { as: t.member, method: "POST", body: { kind_id: 99999 } })).status, 404);
  assert.equal((await t.fetch("/api/alerts/99999/close", { as: t.member, method: "POST" })).status, 404);
});

test("kind admin routes: member 403, admin add/edit/reorder/delete", async () => {
  for (const [method, path, body] of [["POST", "/api/alerts/kinds", { label_problem: "x", label_resolved: "y", icon: "z" }], ["PATCH", "/api/alerts/kinds/1", {}], ["DELETE", "/api/alerts/kinds/1"], ["POST", "/api/alerts/kinds/reorder", { ids: [] }]])
    assert.equal((await t.fetch(path, { as: t.member, method, body })).status, 403, method + path);

  const [sc, k] = await J("/api/alerts/kinds", { as: t.admin, method: "POST", body: { label_problem: "Çay bitti", label_resolved: "Çay aldım", icon: "🍵" } });
  assert.equal(sc, 201);
  assert.equal(k.key, "cay-bitti");
  assert.equal((await J("/api/alerts/kinds", { as: t.admin, method: "POST", body: { label_problem: "Çay bitti", label_resolved: "a", icon: "b" } }))[1].key, "cay-bitti-2");
  assert.equal((await t.fetch("/api/alerts/kinds", { as: t.admin, method: "POST", body: { label_problem: "" } })).status, 400);

  const [, ed] = await J(`/api/alerts/kinds/${k.id}`, { as: t.admin, method: "PATCH", body: { label_problem: "Çay yok" } });
  assert.equal(ed.label_problem, "Çay yok");
  assert.equal(ed.label_resolved, "Çay aldım");

  const [, kinds] = await J("/api/alerts/kinds", { as: t.member });
  const ids = kinds.map((x) => x.id).reverse();
  const [, re] = await J("/api/alerts/kinds/reorder", { as: t.admin, method: "POST", body: { ids } });
  assert.deepEqual(re.map((x) => x.id), ids);

  // history blocks delete; unused kind deletes
  const galos = await kindId("galos");
  assert.equal((await t.fetch(`/api/alerts/kinds/${galos}`, { as: t.admin, method: "DELETE" })).status, 409);
  assert.equal((await t.fetch(`/api/alerts/kinds/${k.id}`, { as: t.admin, method: "DELETE" })).status, 200);
});

test("banner age helpers", () => {
  const now = 1e12, H = 3600_000;
  assert.equal(severity(now - 47 * H, now), "warn");
  assert.equal(severity(now - 49 * H, now), "urgent");
  assert.deepEqual(ago(now - 30_000, now), { n: 0, unit: "now" });
  assert.deepEqual(ago(now - 5 * 60_000, now), { n: 5, unit: "min" });
  assert.deepEqual(ago(now - 2 * H, now), { n: 2, unit: "hour" });
  assert.deepEqual(ago(now - 72 * H, now), { n: 3, unit: "day" });
});
