// Going passive / active again (ADR 0001 #6, #7, #10). Day-15 cutoff (Istanbul):
//   join / reactivate on day 1-15 -> that month's aidat applies; day 16+ -> aidat starts next month.
//   made passive on day 1-15     -> that month's aidat is removed (paid -> alacak); day 16+ -> charged in full.
// A month without aidat is a VOIDED subscription row with void_kind='passive' ("Aidat · Pasif"): visible, blocks
// re-creation (uq_charges_subscription), and money already applied on it turns into alacak by itself (creditBalance).
// The *Raw helpers never lock; the exported ones are serial() - don't call them from inside serial().
import { serial } from "./serial.mjs";
import { monthOf, OFFSET_MS } from "./tz.mjs";
import { BOOTSTRAP_ID_SQL } from "./auth.mjs";
import { ensureMonthsRaw, fail, feeFor, isMonth, monthRange, nextMonth, userDebt } from "./billing.mjs";
import { absorbSpentCreditRaw, creditBalance } from "./credits.mjs";

export const CUTOFF_DAY = 15;
/** Clock for the day-15 side. Tests pin it (test-helpers: day 10 of the real month) so the suite doesn't depend on today. */
export const clock = { now: () => Date.now() };
/** Day 1-15 of the month in Istanbul. */
export const isEarly = (now = clock.now()) => new Date(now + OFFSET_MS).getUTCDate() <= CUTOFF_DAY;
const prevMonth = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
};

/** Insert the month's "Aidat · Pasif" row unless a subscription row exists already. */
async function skipMonthRaw(db, userId, month, now) {
  const { subscription_try } = await feeFor(db, month);
  await db.execute({
    sql: `INSERT OR IGNORE INTO charges (user_id, month, kind, amount_try, voided_at, void_kind)
          SELECT ?1, ?2, 'subscription', ?3, ?4, 'passive' WHERE ?1 <> ${BOOTSTRAP_ID_SQL}`,
    args: [userId, month, subscription_try, now],
  });
}

/** New member / approved signup: on day 16+ this month gets an "Aidat · Pasif" row (aidat starts next month). */
export const startBilling = (db, userId, month, now = clock.now()) => serial(async () => {
  if (month === monthOf(now) && !isEarly(now)) await skipMonthRaw(db, userId, month, now);
  return { early: isEarly(now) };
});

/** Past months of the current passive stretch the admin may bill on reactivation: no subscription row yet, or an
 *  "Aidat · Pasif" one. Never the current month (that one follows the day-15 rule). Legacy members (passive_from NULL)
 *  fall back to joined_month: their passive months were never materialised. */
async function gapMonths(db, user, now) {
  const last = prevMonth(monthOf(now));
  const from = user.passive_from && user.passive_from > user.joined_month ? user.passive_from : user.joined_month;
  const range = monthRange(from, last);
  if (!range.length) return [];
  const have = new Map((await db.execute({
    sql: "SELECT month, void_kind FROM charges WHERE user_id = ? AND kind = 'subscription' AND month BETWEEN ? AND ?",
    args: [user.id, from, last],
  })).rows.map((r) => [r.month, r.void_kind]));
  return range.filter((m) => !have.has(m) || have.get(m) === "passive");
}

/** What the admin sees before toggling: balance (#7 warning), the day-15 side, and (passive members) the gap months. */
export async function statusPreview(db, user, now = clock.now()) {
  const [{ debt_try }, credit_try] = await Promise.all([userDebt(db, user.id), creditBalance(db, user.id)]);
  return { active: !!user.active, early: isEarly(now), debt_try, credit_try, months: user.active ? [] : await gapMonths(db, user, now) };
}

async function deactivateRaw(db, user, now) {
  const month = monthOf(now), early = isEarly(now);
  const from = early ? month : nextMonth(month);
  // ensureMonths only runs on billing reads: materialise every month still billed before the passive stretch starts
  await ensureMonthsRaw(db, user, monthRange(user.joined_month, prevMonth(from)));
  // this month (day 1-15) and any already-created future rent turn "Aidat · Pasif"; a paid one becomes alacak
  await db.execute({
    sql: `UPDATE charges SET voided_at = ?, void_kind = 'passive'
          WHERE user_id = ? AND kind = 'subscription' AND month >= ? AND voided_at IS NULL AND waived_at IS NULL`,
    args: [now, user.id, from],
  });
  if (early) await skipMonthRaw(db, user.id, month, now);
  await db.execute({ sql: "UPDATE users SET active = 0, passive_from = ? WHERE id = ?", args: [from, user.id] });
}

async function activateRaw(db, user, billMonths, now) {
  const month = monthOf(now), early = isEarly(now);
  const gap = await gapMonths(db, user, now);
  if (!Array.isArray(billMonths) || billMonths.some((m) => !isMonth(m) || !gap.includes(m)))
    throw fail(400, "Geçersiz ay seçimi");
  const bill = new Set(billMonths);
  const from = early ? month : nextMonth(month); // first month billed again
  for (const m of gap) if (!bill.has(m)) await skipMonthRaw(db, user.id, m, now);
  if (!early) await skipMonthRaw(db, user.id, month, now); // an existing (charged-in-full) row stays as it is
  await db.execute({
    sql: `UPDATE charges SET voided_at = NULL, void_kind = NULL WHERE user_id = ? AND kind = 'subscription' AND void_kind = 'passive'
            AND (month >= ? OR month IN (SELECT value FROM json_each(?)))`,
    args: [user.id, from, JSON.stringify([...bill])],
  });
  await db.execute({ sql: "UPDATE users SET active = 1, passive_from = NULL WHERE id = ?", args: [user.id] });
  await ensureMonthsRaw(db, { ...user, active: 1 }, [...bill, ...(early ? [month] : [])]);
  await absorbSpentCreditRaw(db, user.id); // a billed-again passive month takes back its alacak (ADR 0001 #8)
}

/** PATCH /users active toggle. billMonths = gap months to bill on reactivation (the rest get "Aidat · Pasif"). */
export const setActive = (db, user, active, { billMonths = [], now = clock.now() } = {}) => serial(async () => {
  user = (await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [user.id] })).rows[0];
  if (!!user.active === active) return;
  if (active) await activateRaw(db, user, billMonths, now);
  else await deactivateRaw(db, user, now);
});
