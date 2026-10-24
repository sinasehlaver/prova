// ADR 0001 #9: a fee change opens a per-item review ("Etkilenen kalemler") instead of re-pricing silently.
// Open row = (charge, new_try) with resolved_at NULL; undecided rows keep the old price and wait. Every non-voided,
// non-waived subscription / booking charge of the month is in scope, paid ones too: applying a new price to a paid
// item leaves the difference as debt (up: the charge is unpaid again for the rest) or alacak (down: creditRaw's
// over-coverage term). The target price is re-read live (fee in force for the month x people), so a booking edited
// since the fee change, or a second fee change, never applies a stale number.
import { COVERED_SQL, fail, feeFor, setAmountRaw } from "./billing.mjs";
import { absorbSpentCreditRaw } from "./credits.mjs";
import { serial } from "./serial.mjs";

const SCOPE_SQL = `SELECT c.id, c.user_id, c.month, c.kind, c.amount_try, c.paid_receipt_id, c.voided_at, c.waived_at,
    ${COVERED_SQL} AS covered, r.people, r.start_ms
  FROM charges c LEFT JOIN reservations r ON r.id = c.reservation_id`;
const live = (c) => !c.voided_at && !c.waived_at && (c.kind === "subscription" || (c.kind === "booking" && c.people != null));
const target = (c, fee) => (c.kind === "subscription" ? fee.subscription_try : fee.booking_try * c.people);

/** Raw (inside setFee's serial): rebuild the open reviews of `month` from the fee now in force. Returns the open count. */
export async function syncReviewsRaw(db, month, now = Date.now()) {
  const fee = await feeFor(db, month);
  await db.execute({
    sql: "DELETE FROM fee_reviews WHERE resolved_at IS NULL AND charge_id IN (SELECT id FROM charges WHERE month = ?)", args: [month],
  });
  const rows = (await db.execute({ sql: `${SCOPE_SQL} WHERE c.month = ? AND c.kind IN ('subscription', 'booking')`, args: [month] })).rows;
  let n = 0;
  for (const c of rows) {
    if (!live(c) || target(c, fee) === c.amount_try) continue;
    await db.execute({ sql: "INSERT INTO fee_reviews (charge_id, new_try, created_at) VALUES (?, ?, ?)", args: [c.id, target(c, fee), now] });
    n++;
  }
  return n;
}

/** What applying `newTry` would do: debt_try = change of what's left to pay, credit_try = change of alacak. */
const effect = (c, newTry) => {
  const cov = Number(c.covered), old = c.amount_try;
  return {
    debt_try: Math.max(newTry - cov, 0) - Math.max(old - cov, 0),
    credit_try: Math.max(cov - newTry, 0) - Math.max(cov - old, 0),
  };
};

/** Open reviews with live numbers. Rows that went stale (voided / waived / already at the target) are left out. */
export async function listReviews(db) {
  const rows = (await db.execute(`SELECT f.id AS review_id, f.created_at, u.name AS user_name, c.*
    FROM fee_reviews f JOIN (${SCOPE_SQL}) c ON c.id = f.charge_id JOIN users u ON u.id = c.user_id
    WHERE f.resolved_at IS NULL ORDER BY c.month DESC, u.name COLLATE NOCASE, c.kind DESC, c.start_ms`)).rows;
  const fees = new Map(), out = [];
  for (const r of rows) {
    if (!fees.has(r.month)) fees.set(r.month, await feeFor(db, r.month));
    const newTry = target(r, fees.get(r.month));
    if (!live(r) || newTry === r.amount_try) continue;
    out.push({
      id: r.review_id, charge_id: r.id, user_id: r.user_id, user_name: r.user_name, month: r.month, kind: r.kind,
      start_ms: r.start_ms ?? null, people: r.people ?? null, old_try: r.amount_try, new_try: newTry,
      covered_try: Number(r.covered), status: r.paid_receipt_id ? "paid" : "unpaid", ...effect(r, newTry),
    });
  }
  return out;
}

/**
 * Admin: resolve open reviews. 'apply' = "Yeni fiyatı uygula" (amount -> live target; paid but now short -> unpaid
 * again; unpaid but now fully covered -> paid by its latest covering receipt), 'keep' = "Eski fiyat kalsın".
 * Stale rows resolve as keep. ids not open are ignored. Returns the number resolved.
 */
export const resolveReviews = (db, ids, decision, now = Date.now()) => serial(async () => {
  if (decision !== "apply" && decision !== "keep") throw fail(400, "Geçersiz karar");
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every((x) => Number.isInteger(x) && x > 0))
    throw fail(400, "Geçersiz kalem listesi");
  const tx = await db.transaction("write");
  try {
    let n = 0;
    const users = new Set();
    for (const id of new Set(ids)) {
      const f = (await tx.execute({ sql: "SELECT * FROM fee_reviews WHERE id = ? AND resolved_at IS NULL", args: [id] })).rows[0];
      if (!f) continue;
      const c = (await tx.execute({ sql: `${SCOPE_SQL} WHERE c.id = ?`, args: [f.charge_id] })).rows[0];
      let done = "keep";
      if (decision === "apply" && c && live(c)) {
        const newTry = target(c, await feeFor(tx, c.month));
        if (newTry !== c.amount_try) {
          await setAmountRaw(tx, c, newTry);
          users.add(c.user_id);
          done = "apply";
        }
      }
      await tx.execute({ sql: "UPDATE fee_reviews SET resolved_at = ?, decision = ? WHERE id = ?", args: [now, done, id] });
      n++;
    }
    // a price-up on an over-covered item can take back alacak that was already spent (ADR 0001 #8)
    for (const u of users) await absorbSpentCreditRaw(tx, u, "fiyat değişti");
    await tx.commit();
    return n;
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  } finally {
    tx.close();
  }
});
