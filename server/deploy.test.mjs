import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dbConfig } from "./lib/db.mjs";
import { makeTestApp } from "./test-helpers.mjs";

// ---- DB URL / token wiring (Turso can't be reached from tests: check what we would hand to createClient)
test("dbConfig: default is a local file, no token option", () => {
  assert.deepEqual(dbConfig({}), { url: "file:prova.db" });
  assert.deepEqual(dbConfig({ DATABASE_URL: "file:/tmp/x.db", DATABASE_AUTH_TOKEN: "ignored" }), { url: "file:/tmp/x.db" });
});

test("dbConfig: libsql:// url + token pass through (trimmed); token is mandatory", () => {
  assert.deepEqual(dbConfig({ DATABASE_URL: " libsql://prova-me.turso.io ", DATABASE_AUTH_TOKEN: " tok\n" }), { url: "libsql://prova-me.turso.io", authToken: "tok" });
  assert.throws(() => dbConfig({ DATABASE_URL: "libsql://prova-me.turso.io" }), /DATABASE_AUTH_TOKEN/);
});

test("dbConfig: refuses a file: DB on Render (ephemeral disk) unless explicitly allowed", () => {
  assert.throws(() => dbConfig({ RENDER: "true" }), /Turso/);
  assert.deepEqual(dbConfig({ RENDER: "true", ALLOW_EPHEMERAL_DB: "1" }), { url: "file:prova.db" });
  assert.equal(dbConfig({ RENDER: "true", DATABASE_URL: "libsql://a.turso.io", DATABASE_AUTH_TOKEN: "t" }).authToken, "t");
});

// ---- PWA manifest (static file, served from web/dist by express.static; verify.sh checks the served copy)
test("manifest: Turkish, standalone, 192/512 + maskable icons that exist on disk", () => {
  const m = JSON.parse(readFileSync(new URL("../web/public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(m.lang, "tr");
  assert.equal(m.display, "standalone");
  assert.ok(m.theme_color && m.background_color && m.start_url === "/");
  const has = (sz, purpose) => m.icons.some((i) => i.sizes === sz && i.purpose === purpose && i.type === "image/png");
  assert.ok(has("192x192", "any") && has("512x512", "any") && has("512x512", "maskable"));
  for (const i of m.icons) assert.ok(existsSync(new URL("../web/public" + i.src, import.meta.url)), i.src);
});

// ---- export
const t = await makeTestApp();
after(() => t.close());

test("export: 401 anonymous, 403 member", async () => {
  assert.equal((await t.fetch("/api/admin/export")).status, 401);
  assert.equal((await t.fetch("/api/admin/export", { as: t.member })).status, 403);
  assert.equal((await t.fetch("/api/admin/export?format=csv", { as: t.member })).status, 403);
});

test("export json: attachment, all money tables, no secrets, no pdf by default", async () => {
  await t.fetch("/api/billing", { as: t.member }); // materialise a subscription charge
  const r = await t.fetch("/api/admin/export", { as: t.admin });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="prova-yedek-\d{4}-\d{2}-\d{2}\.json"$/);
  const j = await r.json();
  for (const k of ["users", "fees", "reservations", "reservation_attendees", "charges", "receipts", "receipt_charges", "costs", "cost_templates", "settings", "alert_kinds", "alerts"]) assert.ok(Array.isArray(j[k]), k);
  assert.equal(j.users.length, 4);
  assert.ok(j.users.every((u) => !("invite_token" in u)), "invite tokens are session secrets");
  assert.ok(!JSON.stringify(j).includes(t.admin.invite_token));
  assert.ok(j.charges.some((c) => c.kind === "subscription" && c.user_id === t.member.id));
  assert.equal(j.includes_pdf, false);
  assert.ok(j.settings.some((s) => s.key === "community_iban"));
});

test("export json: receipt metadata only unless pdf=1 (then base64)", async () => {
  const pdf = readFileSync(new URL("../fixtures/receipts/enpara-1500.pdf", import.meta.url));
  // the member self-serve upload is off: an admin records the payment (raw PDF body)
  const up = await fetch(`${t.base}/api/admin/users/${t.member.id}/receipts?filename=a.pdf&amount_try=1500`, { method: "POST", headers: { "content-type": "application/pdf", cookie: `prova_session=${t.admin.invite_token}` }, body: pdf });
  assert.equal(up.status, 201);
  const plain = await (await t.fetch("/api/admin/export", { as: t.admin })).json();
  assert.equal(plain.receipts.length, 1);
  assert.ok(!("pdf" in plain.receipts[0]) && !("pdf_base64" in plain.receipts[0]) && !("text" in plain.receipts[0]));
  assert.equal(plain.receipts[0].filename, "a.pdf");
  assert.equal(plain.receipts[0].applied_try, 1500); // part-payment / overpayment columns + settlements are exported
  assert.equal(plain.receipts[0].overpaid_try, 0);
  assert.ok(Array.isArray(plain.credit_settlements));
  const full = await (await t.fetch("/api/admin/export?pdf=1", { as: t.admin })).json();
  assert.equal(full.includes_pdf, true);
  assert.deepEqual(Buffer.from(full.receipts[0].pdf_base64, "base64"), pdf);
});

test("export csv: BOM, ; separated, header + one row per charge with receipt columns", async () => {
  const r = await t.fetch("/api/admin/export?format=csv", { as: t.admin });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM (r.text() would strip it)");
  const text = buf.toString("utf8").replace(/^﻿/, "");
  assert.ok(text.startsWith("charge_id;ay;uye;tur;tutar_try;durum;"));
  const lines = text.trim().split("\r\n");
  const j = await (await t.fetch("/api/admin/export", { as: t.admin })).json();
  assert.equal(lines.length, 1 + j.charges.length);
  assert.ok(lines.some((l) => l.includes(";subscription;1500;odendi;") && l.includes(t.member.name)), "paid subscription row");
});
