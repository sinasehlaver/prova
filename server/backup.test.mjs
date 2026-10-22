import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { makeTestApp } from "./test-helpers.mjs";
import { openDb } from "./lib/db.mjs";
import { dumpDb, seal, unseal, restoreDb, mergeDb, formatReport, parseKey } from "./lib/backup.mjs";

test("backup round-trips every table incl. BLOBs and secrets into an empty DB", async () => {
  const t = await makeTestApp();
  try {
    const u = (await t.db.execute("SELECT id FROM users LIMIT 1")).rows[0].id;
    await t.db.execute({ sql: "INSERT INTO receipts (user_id, month, filename, pdf, sha256, text, status, uploaded_at) VALUES (?, '2026-10', 'a.pdf', ?, 'h', 't', 'pending', 1)", args: [u, Buffer.from([0, 255, 7, 1])] });
    const key = parseKey(randomBytes(32).toString("base64"));
    const sealed = seal(await dumpDb(t.db), key);
    assert.ok(!sealed.includes("invite_token"), "ciphertext must not leak plaintext");
    const target = openDb("file:" + join(mkdtempSync(join(tmpdir(), "prova-restore-")), "r.db"));
    await restoreDb(target, unseal(sealed, key));
    for (const tb of ["users", "reservations", "charges", "receipts", "schema_migrations"]) {
      const sql = `SELECT * FROM ${tb} ORDER BY 1`;
      assert.deepEqual((await target.execute(sql)).rows.map((r) => ({ ...r })), (await t.db.execute(sql)).rows.map((r) => ({ ...r })), tb);
    }
    assert.deepEqual(Buffer.from((await target.execute("SELECT pdf FROM receipts")).rows[0].pdf), Buffer.from([0, 255, 7, 1]));
    await assert.rejects(restoreDb(target, unseal(sealed, key)), /not empty/);
    assert.throws(() => unseal(sealed, parseKey(randomBytes(32).toString("base64"))), /cannot decrypt/);
    assert.throws(() => parseKey("short"), /32 random bytes/);
  } finally { await t.close(); }
});

test("merge restore is additive: re-adds lost rows, keeps newer and edited live rows, is idempotent", async () => {
  const t = await makeTestApp();
  try {
    const { db } = t;
    const u = (await db.execute("SELECT id FROM users LIMIT 1")).rows[0].id;
    const rcpt = (n) => db.execute({ sql: "INSERT INTO receipts (user_id, month, filename, pdf, sha256, text, status, uploaded_at) VALUES (?, '2026-10', ?, ?, ?, 't', 'pending', 1)", args: [u, n, Buffer.from([1, 2, 3]), "sha-" + n] });
    await rcpt("kept"); await rcpt("lost");
    await db.execute("INSERT INTO settings (key, value) VALUES ('a', 'backup-value')");
    const snap = await dumpDb(db);
    // after the backup: a row is lost, a new one appears, one is edited
    await db.execute("DELETE FROM receipts WHERE filename = 'lost'");
    await rcpt("newer");
    await db.execute("UPDATE settings SET value = 'live-edit' WHERE key = 'a'");
    const snapshot = async () => JSON.stringify([(await db.execute("SELECT filename FROM receipts ORDER BY id")).rows.map((r) => r.filename), (await db.execute("SELECT value FROM settings WHERE key='a'")).rows[0].value]);
    const before = await snapshot();

    const dry = await mergeDb(db, snap);
    assert.equal(dry.tables.receipts.added, 1);
    assert.equal(dry.tables.settings.differs.length, 1);
    assert.equal(await snapshot(), before, "dry run must not change anything");
    assert.ok(formatReport(dry).includes("DRY RUN"));
    assert.ok(!formatReport(dry).includes("backup-value"), "report must not print row contents");

    await mergeDb(db, snap, { apply: true });
    assert.equal(await snapshot(), JSON.stringify([["kept", "lost", "newer"], "live-edit"]));
    assert.deepEqual(Buffer.from((await db.execute("SELECT pdf FROM receipts WHERE filename='lost'")).rows[0].pdf), Buffer.from([1, 2, 3]));
    const again = await mergeDb(db, snap, { apply: true });
    assert.equal(Object.values(again.tables).reduce((s, x) => s + x.added, 0), 0, "second run is a no-op");
  } finally { await t.close(); }
});
