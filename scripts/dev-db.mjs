// Local dev DB for ./start.sh: migrate + demo seed + one test user per role, then print each user's login link.
// Only ever touches prova/dev.db (gitignored, demo data) — never prova.db or a remote DB.
// Usage: node scripts/dev-db.mjs <web-origin>   -> lines "label<TAB>url", first line = the one to open.
import { fileURLToPath } from "node:url";
import { openDb, migrate } from "../server/lib/db.mjs";
import { seed } from "../server/seed.mjs";
import { newToken, BOOTSTRAP_ID_SQL } from "../server/lib/auth.mjs";
import { currentMonth } from "../server/lib/tz.mjs";

export const DEV_DB_URL = "file:" + fileURLToPath(new URL("../dev.db", import.meta.url));

// Seed's first user is the hidden observer (can't book), so add a real admin and a listener to test those roles.
const EXTRA = [["Yönetici Deneme", "admin"], ["Üye Deneme", "listener"]];

/** Migrate, seed demo data into an empty DB, add the EXTRA users if missing. Returns [{label, token}], open-first. */
export async function prepareDevDb(url = DEV_DB_URL) {
  const db = openDb(url);
  try {
    await migrate(db);
    await seed(db, { demo: true });
    for (const [name, role] of EXTRA) {
      const { rows } = await db.execute({ sql: "SELECT 1 FROM users WHERE name = ?", args: [name] });
      if (rows[0]) continue;
      await db.execute({
        sql: "INSERT INTO users (name, role, invite_token, joined_month, created_at) VALUES (?,?,?,?,?)",
        args: [name, role, newToken(), currentMonth(), Date.now()],
      });
    }
    const pick = async (sql, args = []) => (await db.execute({ sql, args })).rows[0]?.invite_token;
    const active = "active = 1 AND status = 'approved'";
    const links = [
      ["Yönetici (rezervasyon yapabilir)", await pick(`SELECT invite_token FROM users WHERE role = 'admin' AND ${active} AND id <> ${BOOTSTRAP_ID_SQL} ORDER BY id`)],
      ["Aktif Üye", await pick(`SELECT invite_token FROM users WHERE role = 'member' AND ${active} ORDER BY id`)],
      ["Üye (rezervasyon yapamaz)", await pick(`SELECT invite_token FROM users WHERE role = 'listener' AND ${active} ORDER BY id`)],
      ["Gözlemci yönetici (ilk hesap)", await pick(`SELECT invite_token FROM users WHERE id = ${BOOTSTRAP_ID_SQL}`)],
    ];
    return links.filter(([, t]) => t).map(([label, token]) => ({ label, token }));
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const origin = (process.argv[2] || "http://localhost:4601").replace(/\/$/, "");
  for (const { label, token } of await prepareDevDb()) console.log(`${label}\t${origin}/i/${token}`);
}
