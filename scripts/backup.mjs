// Usage: BACKUP_KEY=... DATABASE_URL=... [DATABASE_AUTH_TOKEN=...] node scripts/backup.mjs [out-file]
// Writes an encrypted full dump (default prova-YYYY-MM-DD.bak.enc) and prints its path + row counts.
import { writeFileSync } from "node:fs";
import { openDb } from "../server/lib/db.mjs";
import { dumpDb, seal, parseKey } from "../server/lib/backup.mjs";

const key = parseKey(process.env.BACKUP_KEY);
const dump = await dumpDb(openDb());
const out = process.argv[2] ?? `prova-${new Date().toISOString().slice(0, 10)}.bak.enc`;
writeFileSync(out, seal(dump, key), { mode: 0o600 });
console.log(out, Object.fromEntries(Object.entries(dump.tables).map(([n, t]) => [n, t.rows.length])));
