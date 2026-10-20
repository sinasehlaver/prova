// Full-fidelity DB backup: every table (schema + all rows, BLOBs and secrets included) -> gzip -> AES-256-GCM.
// The file is the only copy of invite tokens/dekont PDFs outside the DB, so it is ALWAYS encrypted (BACKUP_KEY).
// Restore is schema-version independent: it replays the dumped CREATE statements, not the migration files.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

const MAGIC = Buffer.from("PRBK1");
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const enc = (v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? { $b64: Buffer.from(v instanceof ArrayBuffer ? v : v.buffer, v.byteOffset ?? 0, v.byteLength).toString("base64") } : typeof v === "bigint" ? { $int: v.toString() } : v);
const dec = (v) => (v && typeof v === "object" ? ("$b64" in v ? Buffer.from(v.$b64, "base64") : BigInt(v.$int)) : v);

export function parseKey(b64) {
  const k = Buffer.from(String(b64 ?? "").trim(), "base64");
  if (k.length !== 32) throw new Error("BACKUP_KEY must be 32 random bytes, base64 (node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\")");
  return k;
}

/** Consistent snapshot (one read batch) of every user table + index/trigger/view DDL. */
export async function dumpDb(db) {
  const objs = (await db.execute("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")).rows.map((r) => ({ ...r }));
  const tables = objs.filter((o) => o.type === "table");
  const res = await db.batch(tables.map((t) => `SELECT * FROM ${q(t.name)}`), "read");
  return {
    version: 1, created_at: new Date().toISOString(),
    schema: objs,
    tables: Object.fromEntries(tables.map((t, i) => [t.name, { columns: res[i].columns, rows: res[i].rows.map((r) => res[i].columns.map((_, c) => enc(r[c]))) }])),
  };
}

export function seal(dump, key) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(gzipSync(JSON.stringify(dump))), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function unseal(buf, key) {
  if (buf.length < 33 || !buf.subarray(0, 5).equals(MAGIC)) throw new Error("not a prova backup file");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(5, 17));
  d.setAuthTag(buf.subarray(17, 33));
  try { return JSON.parse(gunzipSync(Buffer.concat([d.update(buf.subarray(33)), d.final()]))); }
  catch { throw new Error("cannot decrypt backup (wrong BACKUP_KEY or corrupted file)"); }
}

/** Replay a dump into an EMPTY database, atomically (one transaction; FK checks deferred to commit). */
export async function restoreDb(db, dump) {
  const existing = (await db.execute("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0].n;
  if (existing) throw new Error(`target database is not empty (${existing} tables); restore into a fresh DB`);
  const stmts = ["PRAGMA defer_foreign_keys = ON"];
  for (const o of dump.schema.filter((o) => o.type === "table")) stmts.push(o.sql);
  for (const [name, t] of Object.entries(dump.tables)) {
    const sql = `INSERT INTO ${q(name)} (${t.columns.map(q).join(",")}) VALUES (${t.columns.map(() => "?").join(",")})`;
    for (const r of t.rows) stmts.push({ sql, args: r.map(dec) });
  }
  for (const o of dump.schema.filter((o) => o.type !== "table")) stmts.push(o.sql);
  await db.batch(stmts, "write");
  return Object.fromEntries(Object.entries(dump.tables).map(([n, t]) => [n, t.rows.length]));
}
