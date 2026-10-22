// Usage: BACKUP_KEY=... DATABASE_URL=... [DATABASE_AUTH_TOKEN=...] node scripts/restore.mjs <file.bak.enc> [--apply]
// Additive and non-destructive: only rows MISSING from the live DB are added; existing rows are never changed.
// Without --apply it is a dry run (same statements, rolled back) and prints what would be restored.
// Empty target (no tables, e.g. a brand-new Turso DB) = full restore. See DEPLOY.md "Backups" / the `restore` workflow.
import { appendFileSync, readFileSync } from "node:fs";
import { openDb } from "../server/lib/db.mjs";
import { restoreDb, mergeDb, formatReport, unseal, parseKey } from "../server/lib/backup.mjs";

const [file, ...flags] = process.argv.slice(2);
if (!file) { console.error("usage: node scripts/restore.mjs <file.bak.enc> [--apply]"); process.exit(2); }
const apply = flags.includes("--apply");
const dump = unseal(readFileSync(file), parseKey(process.env.BACKUP_KEY));
const db = openDb();
const tables = (await db.execute("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0].n;

let out;
if (!tables) {
  const counts = Object.fromEntries(Object.entries(dump.tables).map(([n, t]) => [n, t.rows.length]));
  if (apply) await restoreDb(db, dump);
  out = `### ${apply ? "Restore APPLIED" : "Restore DRY RUN (nothing changed)"} · backup from ${dump.created_at}\n\nTarget database is empty: full restore.\n\n` +
    Object.entries(counts).map(([n, c]) => `- ${n}: ${c} row(s)`).join("\n");
} else out = formatReport(await mergeDb(db, dump, { apply }));
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + "\n");
if (!apply) console.log("\nDry run only. Re-run with --apply to restore.");
