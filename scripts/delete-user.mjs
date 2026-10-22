// Usage: DATABASE_URL=libsql://... DATABASE_AUTH_TOKEN=... node scripts/delete-user.mjs <user-id> [--apply]
// Hard-deletes one user and everything hanging off them (reservations they booked, charges, receipts, credits,
// holds, audit rows, alerts). Dry run (counts only) unless --apply. All deletes run in ONE transaction.
// Take a backup first: BACKUP_KEY=... node scripts/backup.mjs
import { openDb } from "../server/lib/db.mjs";

const id = Number(process.argv[2]);
const apply = process.argv.includes("--apply");
if (!Number.isInteger(id) || id <= 0) {
  console.error("Usage: node scripts/delete-user.mjs <user-id> [--apply]");
  process.exit(1);
}

const db = openDb();
const one = async (sql, args = []) => (await db.execute({ sql, args })).rows;

const [user] = await one("SELECT id, name, email, role, active FROM users WHERE id = ?", [id]);
if (!user) { console.error(`No user with id ${id}`); process.exit(1); }
const [{ n: admins }] = await one("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND id <> ?", [id]);
if (user.role === "admin" && admins === 0) { console.error("Refusing: this is the only admin"); process.exit(1); }
const [{ m: firstId }] = await one("SELECT MIN(id) m FROM users");
if (id === firstId) { console.error("Refusing: lowest id is the hidden bootstrap observer (see BOOTSTRAP-ADMIN.md)"); process.exit(1); }
console.log("User:", { ...user });

const RES = "(SELECT id FROM reservations WHERE booker_id = ?1)";
const CHG = `(SELECT id FROM charges WHERE user_id = ?1 OR reservation_id IN ${RES})`;
const RCP = "(SELECT id FROM receipts WHERE user_id = ?1)";

// Other people's charges paid by this user's receipts would lose their paid state: stop and let a human decide.
const [{ n: foreign }] = await one(`SELECT COUNT(*) n FROM charges WHERE paid_receipt_id IN ${RCP.replace("?1", "?")} AND user_id <> ? AND reservation_id IS NULL`, [id, id]);
if (foreign) { console.error(`Refusing: ${foreign} charge(s) of other users are paid by this user's receipts`); process.exit(1); }

// Order matters (children first); FK enforcement may be on.
const steps = [
  ["receipt_charges", `DELETE FROM receipt_charges WHERE receipt_id IN ${RCP} OR charge_id IN ${CHG}`],
  ["charges", `DELETE FROM charges WHERE id IN ${CHG}`],
  ["receipts", `DELETE FROM receipts WHERE user_id = ?1`],
  ["credit_settlements", `DELETE FROM credit_settlements WHERE user_id = ?1`],
  ["reservation_audit", `DELETE FROM reservation_audit WHERE actor_id = ?1 OR booker_id = ?1 OR reservation_id IN ${RES}`],
  ["reservation_attendees", `DELETE FROM reservation_attendees WHERE user_id = ?1 OR reservation_id IN ${RES}`],
  ["slot_holds", `DELETE FROM slot_holds WHERE user_id = ?1`],
  ["reservations", `DELETE FROM reservations WHERE booker_id = ?1`],
  ["alerts (closed_by cleared)", `UPDATE alerts SET closed_by = NULL WHERE closed_by = ?1 AND raised_by <> ?1`],
  ["alerts", `DELETE FROM alerts WHERE raised_by = ?1`],
  ["users", `DELETE FROM users WHERE id = ?1`],
];

if (!apply) {
  for (const [name, sql] of steps) {
    const sel = sql.startsWith("DELETE FROM") ? sql.replace(/^DELETE FROM (\w+)/, "SELECT COUNT(*) n FROM $1") : null;
    if (sel) console.log(name.padEnd(24), (await one(sel, [id]))[0].n);
  }
  console.log("\nDry run. Re-run with --apply to delete.");
  process.exit(0);
}

const res = await db.batch(steps.map(([, sql]) => ({ sql, args: [id] })), "write");
steps.forEach(([name], i) => console.log(name.padEnd(24), res[i].rowsAffected));
console.log("Done.");
