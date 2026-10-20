// Usage: BACKUP_KEY=... DATABASE_URL=<EMPTY target> [DATABASE_AUTH_TOKEN=...] node scripts/restore.mjs <file.bak.enc>
// Refuses a non-empty target. Fresh Turso DB: `turso db create prova2`, point DATABASE_URL at it, run this, then
// point the Render service's DATABASE_URL/DATABASE_AUTH_TOKEN at the new DB (see DEPLOY.md "Backups").
import { readFileSync } from "node:fs";
import { openDb } from "../server/lib/db.mjs";
import { restoreDb, unseal, parseKey } from "../server/lib/backup.mjs";

if (!process.argv[2]) { console.error("usage: node scripts/restore.mjs <file.bak.enc>"); process.exit(2); }
const dump = unseal(readFileSync(process.argv[2]), parseKey(process.env.BACKUP_KEY));
console.log("backup from", dump.created_at);
console.log("restored rows:", await restoreDb(openDb(), dump));
