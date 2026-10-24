// Times GET /billing's payload (billingPayload) per month switch on a COPY of dev.db. No server, no port.
// Usage: node scripts/bench-billing.mjs [rttMs=30]   (rttMs = simulated per-query round trip, e.g. Render -> Turso)
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../server/lib/db.mjs";
import { billingPayload } from "../server/routes/billing.mjs";
import { browsableMonths } from "../server/lib/billing.mjs";

const rtt = Number(process.argv[2] ?? 30);
const dir = mkdtempSync(join(tmpdir(), "prova-bench-"));
copyFileSync(new URL("../dev.db", import.meta.url), join(dir, "b.db"));
const raw = openDb(`file:${join(dir, "b.db")}`);
await migrate(raw);
let calls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = new Proxy(raw, { get: (t, k) => k === "execute" ? async (...a) => { calls++; await sleep(rtt); return t.execute(...a); } : t[k]?.bind?.(t) ?? t[k] });
const user = (await raw.execute("SELECT * FROM users WHERE active = 1 AND role <> 'listener' ORDER BY id DESC LIMIT 1")).rows[0];
const months = await browsableMonths(raw, user);
const pick = [months[0], months[Math.floor(months.length / 2)], months.at(-1)];
console.log(`user ${user.id} joined ${user.joined_month}, ${months.length} browsable months, rtt ${rtt} ms`);
for (const m of pick) {
  calls = 0; const t = performance.now();
  await billingPayload(db, user, m);
  console.log(`${m}: ${(performance.now() - t).toFixed(0)} ms, ${calls} queries`);
}
