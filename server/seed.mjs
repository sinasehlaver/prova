// Idempotent seed: runs only into an empty users table.
import { newToken } from "./lib/auth.mjs";
import { currentMonth } from "./lib/tz.mjs";

const ALERT_KINDS = [
  ["galos", "Galoş yok", "Galoş aldım", "👟"],
  ["tuvalet-kagidi", "Tuvalet kağıdı yok", "Tuvalet kağıdı aldım", "🧻"],
  ["cop", "Çöp dolu", "Çöpü çıkardım", "🗑️"],
  ["sabun", "Sabun / el temizleyici bitti", "Sabun aldım", "🧼"],
  ["klima", "Klima / ısıtma çalışmıyor", "Düzeldi", "❄️"],
  ["isik", "Işık yanmıyor", "Düzeldi", "💡"],
  ["kablo-jak", "Kablo / jak arızalı", "Düzeldi", "🔌"],
  ["zemin", "Zemin kirli (süpürülmeli)", "Süpürdüm", "🧹"],
  ["anahtar-kapi", "Anahtar / kapı sorunu", "Düzeldi", "🔑"],
  ["havalandirma", "Havalandırma / koku sorunu", "Düzeldi", "🌬️"],
];

const SETTINGS = { community_iban: "", community_holder: "", max_reservation_hours: "4", receipt_require_recipient: "0" };

/** opts: { demo: add sample members, adminToken: fixed admin invite token (else random), adminName } */
export async function seed(db, { demo = false, adminToken, adminName = "Yönetici" } = {}) {
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM users");
  if (rows[0].n > 0) return null;
  const month = currentMonth();
  const token = adminToken || newToken();
  const add = (name, role, tok) =>
    db.execute({
      sql: "INSERT INTO users (name, phone, email, password_hash, role, invite_token, joined_month, created_at) VALUES (?,?,?,?,?,?,?,?)",
      args: [name, null, null, null, role, tok, month, Date.now()],
    });
  await add(adminName, "admin", token);
  if (demo) for (const n of ["Ali Yılmaz", "Zeynep Kaya", "Can Demir"]) await add(n, "member", newToken());
  await db.execute({ sql: "INSERT INTO fees (effective_from, subscription_try, booking_try) VALUES ('2000-01', 1500, 500)", args: [] });
  await db.batch(ALERT_KINDS.map(([key, p, r, icon], i) => ({
    sql: "INSERT INTO alert_kinds (key,label_problem,label_resolved,icon,sort) VALUES (?,?,?,?,?)", args: [key, p, r, icon, i],
  })));
  await db.batch(Object.entries(SETTINGS).map(([k, v]) => ({ sql: "INSERT INTO settings (key,value) VALUES (?,?)", args: [k, v] })));
  return token;
}
