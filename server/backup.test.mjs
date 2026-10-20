import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { makeTestApp } from "./test-helpers.mjs";
import { openDb } from "./lib/db.mjs";
import { dumpDb, seal, unseal, restoreDb, parseKey } from "./lib/backup.mjs";

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
