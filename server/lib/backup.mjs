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

// Never merged: migrations are owned by the live code, holds are 2-minute ephemera.
const NO_MERGE = new Set(["schema_migrations", "slot_holds"]);
const CAP = 200;

/**
 * Additive restore into a LIVE database: inserts backup rows whose primary key is missing, never updates or
 * deletes anything. Rows present in both but different are kept as live and reported. One transaction;
 * apply=false runs the same statements (so constraint/FK problems show up) and rolls back.
 * Report holds table names + ids only: it is printed in a public repo's Actions log.
 */
export async function mergeDb(db, dump, { apply = false } = {}) {
  const live = await dumpDb(db);
  const tables = {}, stmts = [], owners = [];
  for (const [name, bt] of Object.entries(dump.tables)) {
    if (NO_MERGE.has(name)) continue;
    const lt = live.tables[name];
    if (!lt) { tables[name] = { skipped: "table missing in live DB (the app creates it on next boot)" }; continue; }
    const cols = bt.columns.filter((c) => lt.columns.includes(c));
    const pk = (await db.execute(`PRAGMA table_info(${q(name)})`)).rows.filter((r) => r.pk > 0).sort((a, b) => a.pk - b.pk).map((r) => r.name).filter((c) => cols.includes(c));
    const idCols = pk.length ? pk : cols;
    const pick = (t, r, cs) => cs.map((c) => r[t.columns.indexOf(c)]);
    const liveRows = new Map(lt.rows.map((r) => [JSON.stringify(pick(lt, r, idCols)), r]));
    const sql = `INSERT OR IGNORE INTO ${q(name)} (${cols.map(q).join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
    const t = tables[name] = { backup: bt.rows.length, live: lt.rows.length, same: 0, added: 0, added_ids: [], differs: [], ignored: 0 };
    for (const r of bt.rows) {
      const key = JSON.stringify(pick(bt, r, idCols)), mine = liveRows.get(key);
      if (!mine) { stmts.push({ sql, args: pick(bt, r, cols).map(dec) }); owners.push({ t, label: pick(bt, r, idCols).map((v) => (v && typeof v === "object" ? "·" : v)).join("/") }); continue; }
      const bad = cols.filter((c) => JSON.stringify(r[bt.columns.indexOf(c)]) !== JSON.stringify(mine[lt.columns.indexOf(c)]));
      if (!bad.length) t.same++; else t.differs.push({ id: pick(bt, r, idCols).join("/"), columns: bad });
    }
  }
  const tx = await db.transaction("write");
  try {
    await tx.execute("PRAGMA defer_foreign_keys = ON");
    const res = stmts.length ? await tx.batch(stmts) : [];
    res.forEach((rs, i) => {
      const { t, label } = owners[i];
      if (rs.rowsAffected) { t.added++; t.added_ids.push(label); } else t.ignored++; // ignored = unique clash with a live row
    });
    const fk = (await tx.execute("PRAGMA foreign_key_check")).rows.length;
    if (fk) throw new Error(`restore would leave ${fk} broken foreign-key reference(s); nothing was changed`);
    if (apply) await tx.commit(); else await tx.rollback();
  } catch (e) { await tx.rollback().catch(() => {}); throw e; } finally { tx.close(); }
  return { backup_at: dump.created_at, applied: apply, tables };
}

export function formatReport(rep) {
  const L = [`### ${rep.applied ? "Restore APPLIED" : "Restore DRY RUN (nothing changed)"} · backup from ${rep.backup_at}`, "", "| table | in backup | in live | identical | " + (rep.applied ? "restored" : "would restore") + " | differs (live kept) | clashed (skipped) |", "|---|--:|--:|--:|--:|--:|--:|"];
  for (const [n, t] of Object.entries(rep.tables)) L.push(t.skipped ? `| ${n} | | | | | | ${t.skipped} |` : `| ${n} | ${t.backup} | ${t.live} | ${t.same} | ${t.added} | ${t.differs.length} | ${t.ignored} |`);
  const total = Object.values(rep.tables).reduce((s, t) => s + (t.added || 0), 0);
  L.push("", total ? `**${total} row(s) ${rep.applied ? "restored" : "would be restored"}.**` : "**Nothing to restore: the live database already has everything in this backup.**");
  for (const [n, t] of Object.entries(rep.tables)) {
    if (t.added) L.push("", `Restored rows, \`${n}\` ids (remove any you had deleted on purpose): ${t.added_ids.slice(0, CAP).join(", ")}${t.added > CAP ? ", …" : ""}`);
    if (t.differs.length) L.push("", `Kept live version, \`${n}\` differs: ${t.differs.slice(0, CAP).map((d) => `#${d.id} (${d.columns.join(",")})`).join(", ")}${t.differs.length > CAP ? ", …" : ""}`);
  }
  return L.join("\n");
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
