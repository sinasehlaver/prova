// Member credit = money the community owes the member back. Never stored as a balance - derived from receipts:
//   owed = overpayments on ok receipts + part-payments sitting on charges that were later voided/waived - admin settlements.
// A rejected receipt (status no longer 'ok') drops out by itself. Whole TRY.
import { COVERED_SQL, fail, monthRange, nextMonth, projectedSub } from "./billing.mjs";
import { serial } from "./serial.mjs";
import { currentMonth } from "./tz.mjs";

/**
 * DISPLAY-ONLY forward look (decided 2026-09-23): how much of `month`'s still-open amount (`needTry` = kalan + planned
 * rent) the member's current credit would cover, if the credit were spent oldest-first on everything owed BEFORE
 * this month (older debt + earlier future months' open charges and planned rents). Nothing is applied or stored -
 * credit stays manual (admin "Alacaktan öde" / "Alacağı kapat"). null for past months or when there is no credit.
 */
export async function creditOutlook(db, user, month, needTry, balanceTry) {
  if (!(balanceTry > 0) || month < currentMonth()) return null;
  const prior = Number((await db.execute({
    sql: `SELECT COALESCE(SUM(MAX(c.amount_try - ${COVERED_SQL}, 0)), 0) AS owed FROM charges c
          WHERE c.user_id = ? AND c.month < ? AND c.voided_at IS NULL AND c.waived_at IS NULL AND c.paid_receipt_id IS NULL`,
    args: [user.id, month],
  })).rows[0].owed);
  let planned = 0;
  for (const m of monthRange(nextMonth(currentMonth()), month)) {
    if (m === month) break;
    planned += (await projectedSub(db, user, m))?.amount_try ?? 0;
  }
  const available = Math.max(0, balanceTry - prior - planned);
  return { need_try: needTry, prior_try: prior + planned, available_try: available, covered_try: Math.min(available, needTry) };
}

export async function creditBalance(db, userId) {
  const r = (await db.execute({
    sql: `SELECT
      (SELECT COALESCE(SUM(overpaid_try), 0) FROM receipts WHERE user_id = ?1 AND status = 'ok')
      + (SELECT COALESCE(SUM(rc.applied_try), 0) FROM receipt_charges rc
           JOIN receipts r ON r.id = rc.receipt_id JOIN charges c ON c.id = rc.charge_id
           WHERE r.user_id = ?1 AND r.status = 'ok' AND (c.voided_at IS NOT NULL OR c.waived_at IS NOT NULL))
      - (SELECT COALESCE(SUM(amount_try), 0) FROM credit_settlements WHERE user_id = ?1) AS owed`,
    args: [userId],
  })).rows[0];
  return Math.max(0, Number(r.owed));
}

export async function creditSettlements(db, userId) {
  return (await db.execute({
    sql: "SELECT id, amount_try, note, created_at FROM credit_settlements WHERE user_id = ? ORDER BY id DESC LIMIT 50", args: [userId],
  })).rows.map((r) => ({ ...r }));
}

/** { balance_try, settlements } for the member page / admin per-user view. */
export async function creditPayload(db, userId) {
  const [balance_try, settlements] = await Promise.all([creditBalance(db, userId), creditSettlements(db, userId)]);
  return { balance_try, settlements };
}

/** Admin: record that (part of) the owed credit was paid back / settled by hand. amountTry omitted = the whole balance. */
export const settleCredit = (db, userId, { amountTry, note, now = Date.now() } = {}) => serial(async () => {
  const u = (await db.execute({ sql: "SELECT id FROM users WHERE id = ?", args: [userId] })).rows[0];
  if (!u) throw fail(404, "Üye bulunamadı");
  const balance = await creditBalance(db, userId);
  if (balance <= 0) throw fail(409, "Kapatılacak alacak yok");
  const amount = amountTry == null || amountTry === "" ? balance : amountTry;
  if (!Number.isInteger(amount) || amount <= 0) throw fail(400, "Tutar pozitif tam sayı olmalı");
  if (amount > balance) throw fail(400, "Tutar mevcut alacaktan fazla olamaz");
  await db.execute({
    sql: "INSERT INTO credit_settlements (user_id, amount_try, note, created_at) VALUES (?,?,?,?)",
    args: [userId, amount, String(note ?? "").trim().slice(0, 200) || null, now],
  });
  return amount;
});
