// DB + numbered-migration runner. DATABASE_URL: `file:...` (default) or a Turso libsql:// URL.
import { createClient } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const MIG_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "migrations");

/** Pure env -> libSQL client options (unit-tested; can't be exercised against Turso here). Remote URLs need a token;
 *  on Render (env RENDER=true, ephemeral disk) a file: DB would silently lose every booking on the next spin-down. */
export function dbConfig(env = process.env, url) {
  url = (url ?? env.DATABASE_URL ?? "").trim() || "file:prova.db";
  const authToken = (env.DATABASE_AUTH_TOKEN ?? "").trim() || undefined;
  const remote = /^(libsql|https?|wss?):/.test(url);
  if (remote && !authToken) throw new Error("DATABASE_AUTH_TOKEN is required for a remote (libsql://) DATABASE_URL");
  if (!remote && env.RENDER && env.ALLOW_EPHEMERAL_DB !== "1") throw new Error("Refusing to use a file: database on Render (ephemeral disk). Set DATABASE_URL to the Turso libsql:// URL.");
  return remote ? { url, authToken } : { url };
}

export function openDb(url) {
  return createClient(dbConfig(process.env, url));
}

/** Apply every server/migrations/NNN_*.sql not yet recorded. Idempotent. Add schema changes as a NEW file. */
export async function migrate(db) {
  await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set((await db.execute("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(MIG_DIR, f), "utf8");
    await db.executeMultiple(sql);
    await db.execute({ sql: "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", args: [f, Date.now()] });
  }
}
