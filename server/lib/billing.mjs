// Billing engine: fee history, charge materialisation, month view. Money = whole TRY ints; every charge stores its own
// amount (snapshot), so a fee change only affects charges created after it.
// addBookingCharges / voidBookingCharges / ensureMonthRaw take a db OR a tx and never lock; the exported write helpers
// (ensureMonth, waiveCharge, addAdjustment, setFee) are wrapped in serial() - don't call those from inside serial().
import { serial } from "./serial.mjs";
import { currentMonth, monthOf } from "./tz.mjs";
import { BOOTSTRAP_ID_SQL, isBootstrap } from "./auth.mjs";

export const fail = (status, error) => Object.assign(new Error(error), { status });
export const isMonth = (m) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
export const nextMonth = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
};
/** 'YYYY-MM' list from..to inclusive (empty if from > to). */
export const monthRange = (from, to) => {
  const out = [];
  for (let m = from; m <= to && out.length < 240; m = nextMonth(m)) out.push(m);
  return out;
};

/** Fee row in force for `month`: latest effective_from <= month. */
export async function feeFor(db, month) {
  const r = (await db.execute({
    sql: "SELECT * FROM fees WHERE effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1", args: [month],
  })).rows[0];
  return r ?? { effective_from: null, subscription_try: 0, booking_try: 0 };
}

/** Inside the reservation-create tx: ONE booking charge on the booker = people x per-person fee (snapshot of the reservation month's fee). */
export async function addBookingCharges(tx, reservationId, bookerId, people, startMs) {
  const month = monthOf(startMs);
  const { booking_try } = await feeFor(tx, month);
  if (!(booking_try > 0) || !(people > 0)) return; // people 0 = free reservation, no charge
  await tx.execute({
    sql: "INSERT INTO charges (user_id, month, kind, amount_try, reservation_id) VALUES (?,?, 'booking', ?, ?)",
    args: [bookerId, month, booking_try * people, reservationId],
  });
}

/**
 * Raw (tx): give a live charge a new amount and fix its paid state from coverage (ADR 0001 #9 / #11): paid but now
 * short -> unpaid again for the rest; unpaid but now fully covered -> paid by its latest covering ok receipt
 * (paid_by 'admin'). Coverage above the new amount is alacak by itself (creditRaw's over-coverage term).
 * `c` = charge row with `covered`.
 */
export async function setAmountRaw(tx, c, newTry) {
  const cov = Number(c.covered);
  await tx.execute({ sql: "UPDATE charges SET amount_try = ? WHERE id = ?", args: [newTry, c.id] });
  if (c.paid_receipt_id && newTry > cov)
    await tx.execute({ sql: "UPDATE charges SET paid_receipt_id = NULL, paid_by = NULL WHERE id = ?", args: [c.id] });
  else if (!c.paid_receipt_id && cov > 0 && cov >= newTry) {
    const rid = (await tx.execute({
      sql: `SELECT MAX(rc.receipt_id) AS id FROM receipt_charges rc JOIN receipts rr ON rr.id = rc.receipt_id
            WHERE rc.charge_id = ? AND rr.status = 'ok'`, args: [c.id],
    })).rows[0].id;
    await tx.execute({ sql: "UPDATE charges SET paid_receipt_id = ?, paid_by = 'admin' WHERE id = ?", args: [rid, c.id] });
  }
}

/**
 * Inside the reservation-edit tx: re-price the booking charge to people x the NEW month's fee (ADR 0001 #11: paid
 * bookings can be edited too). Paid / part-paid: cheaper -> the paid difference becomes alacak, dearer -> the same
 * item is unpaid again for the difference (user's pick 2026-10-24, not a second charge); 0 people -> voided, all
 * paid money -> alacak. Waived stays waived. Returns { debt_try, credit_try } = what the edit changed for a charge
 * that had money on it (both 0 otherwise), for the member's toast.
 */
export async function repriceBookingCharge(tx, reservationId, bookerId, people, startMs) {
  const none = { debt_try: 0, credit_try: 0 };
  const month = monthOf(startMs);
  const c = (await tx.execute({
    sql: `SELECT c.*, ${COVERED_SQL} AS covered FROM charges c WHERE c.reservation_id = ? AND c.kind = 'booking' AND c.voided_at IS NULL`,
    args: [reservationId],
  })).rows[0];
  if (!c) { await addBookingCharges(tx, reservationId, bookerId, people, startMs); return none; }
  const { booking_try } = await feeFor(tx, month);
  const amount = booking_try * people, cov = Number(c.covered), old = c.amount_try;
  if (amount === 0) await tx.execute({ sql: "UPDATE charges SET voided_at = ? WHERE id = ?", args: [Date.now(), c.id] });
  else {
    if (c.month !== month) await tx.execute({ sql: "UPDATE charges SET month = ? WHERE id = ?", args: [month, c.id] });
    if (amount !== old) {
      if (c.waived_at) await tx.execute({ sql: "UPDATE charges SET amount_try = ? WHERE id = ?", args: [amount, c.id] });
      else await setAmountRaw(tx, c, amount);
    }
  }
  if (!(cov > 0) || c.waived_at || amount === old) return none;
  // a dearer edit of an item whose earlier price-down alacak was spent -> "Harcanan alacak" (#8). Lazy: cycle.
  await (await import("./credits.mjs")).absorbSpentCreditRaw(tx, c.user_id, "rezervasyon değişti");
  return {
    debt_try: Math.max(amount - cov, 0) - Math.max(old - cov, 0),
    credit_try: (amount === 0 ? cov : Math.max(cov - amount, 0)) - Math.max(cov - old, 0),
  };
}

/** Inside the reservation-cancel tx: void the booking charges, paid or not (ADR 0001 #1). Whatever was paid on them
 *  turns into alacak by itself (creditBalance counts applied money on voided charges). */
export const voidBookingCharges = (tx, reservationId, now) =>
  tx.execute({
    sql: "UPDATE charges SET voided_at = ? WHERE reservation_id = ? AND voided_at IS NULL",
    args: [now, reservationId],
  });

/** Idempotent (unique index): the month's subscription charge for an active member, from joined_month on.
 *  Never for the bootstrap admin (observer account, not billed) - the WHERE makes that a no-op insert. */
export async function ensureMonthRaw(db, user, month) {
  if (!user.active || user.joined_month > month) return;
  const { subscription_try } = await feeFor(db, month);
  await db.execute({
    sql: `INSERT OR IGNORE INTO charges (user_id, month, kind, amount_try) SELECT ?1, ?2, 'subscription', ?3 WHERE ?1 <> ${BOOTSTRAP_ID_SQL}`,
    args: [user.id, month, subscription_try],
  });
}
export const ensureMonth = (db, user, month) => serial(() => ensureMonthRaw(db, user, month));

/** ensureMonthRaw for many months: 1 read when all exist (the usual case), else + fees read + ONE insert. Was 2 round trips
 *  per month on every billing read (~0.7-1.5 s per month switch on Turso, 2026-10-22). Same rules: active, >= joined_month,
 *  never the bootstrap admin, fee = row in force for that month (feeFor order), uq_charges_subscription makes it idempotent. */
export async function ensureMonthsRaw(db, user, months) {
  months = months.filter((m) => m >= user.joined_month);
  if (!user.active || !months.length) return;
  const have = new Set((await db.execute({
    sql: "SELECT month FROM charges WHERE user_id = ? AND kind = 'subscription' AND month BETWEEN ? AND ?",
    args: [user.id, months.reduce((a, m) => (m < a ? m : a)), months.reduce((a, m) => (m > a ? m : a))],
  })).rows.map((r) => r.month));
  const missing = months.filter((m) => !have.has(m));
  if (!missing.length) return;
  const fees = (await db.execute("SELECT effective_from, subscription_try FROM fees ORDER BY effective_from, id")).rows;
  const fee = (m) => fees.reduce((a, f) => (f.effective_from <= m ? f.subscription_try : a), 0);
  await db.execute({
    sql: `INSERT OR IGNORE INTO charges (user_id, month, kind, amount_try)
          SELECT ?1, json_extract(j.value, '$[0]'), 'subscription', json_extract(j.value, '$[1]') FROM json_each(?2) j WHERE ?1 <> ${BOOTSTRAP_ID_SQL}`,
    args: [user.id, JSON.stringify(missing.map((m) => [m, fee(m)]))],
  });
}
export const ensureMonths = (db, user, months) => serial(() => ensureMonthsRaw(db, user, months));

/** How far ahead a month can be browsed / prepaid (decided 2026-09-23): current + 12. */
export const MAX_AHEAD = 12;
export const maxMonth = () => {
  let m = currentMonth();
  for (let i = 0; i < MAX_AHEAD; i++) m = nextMonth(m);
  return m;
};
/** Months a member can browse: joined_month .. current + MAX_AHEAD (newest last). Future months are read-only
 *  projections - see billingPayload: a READ never materialises a future month's subscription charge. */
export const browsableMonths = async (db, user) => monthRange(await browseFrom(db, user), maxMonth());
export const canBrowse = async (db, user, month) => isMonth(month) && month >= (await browseFrom(db, user)) && month <= maxMonth();
/** Lower browse bound: the earlier of joined_month and the user's oldest non-voided charge month (a back-filled booking
 *  from before joining must stay reachable/payable; no subscription charge is ever made for those months). */
export async function browseFrom(db, user) {
  const r = (await db.execute({ sql: "SELECT MIN(month) AS m FROM charges WHERE user_id = ? AND voided_at IS NULL", args: [user.id] })).rows[0];
  return r?.m && r.m < user.joined_month ? r.m : user.joined_month;
}

/**
 * Display-only "planned rent" for a FUTURE month that has no subscription charge yet: the fee in force for that month
 * as of today. Never inserted by a read (a later setFee for that month must still apply - charges are snapshots);
 * it becomes a real charge only when the month turns current (ensureMonth) or an admin explicitly prepays it
 * (payment token `sub:YYYY-MM`, see lib/payments.mjs). null when not applicable.
 */
export async function projectedSub(db, user, month) {
  if (!user.active || month <= currentMonth() || month < user.joined_month || month > maxMonth()) return null;
  if (await isBootstrap(db, user)) return null; // observer account: never billed, no planned rent either
  const has = (await db.execute({ sql: "SELECT 1 FROM charges WHERE user_id = ? AND month = ? AND kind = 'subscription'", args: [user.id, month] })).rows[0];
  if (has) return null;
  const { subscription_try } = await feeFor(db, month);
  if (!(subscription_try > 0)) return null;
  return {
    id: null, key: `sub:${month}`, month, kind: "subscription", amount_try: subscription_try, status: "upcoming", paid_by: null, note: null,
    paid_try: 0, remaining_try: subscription_try, flag: null, reservation: null,
  };
}

/** SQL expr (alias `c` = charges): whole TRY already covered by ok receipts (part-payments). A charge turns 'paid' only once fully covered. */
export const COVERED_SQL = `COALESCE((SELECT SUM(rc.applied_try) FROM receipt_charges rc JOIN receipts rr ON rr.id = rc.receipt_id
  WHERE rc.charge_id = c.id AND rr.status = 'ok'), 0)`;

const statusOf = (c) => (c.voided_at ? "voided" : c.waived_at ? "waived" : c.paid_receipt_id ? "paid" : "unpaid");

const ITEM_SQL = `SELECT c.*, ${COVERED_SQL} AS covered, r.start_ms, r.end_ms, r.note AS r_note, r.people AS r_people, r.cancelled_at AS r_cancelled
          FROM charges c LEFT JOIN reservations r ON r.id = c.reservation_id`;
const toItem = (c, flag = null) => {
  const status = statusOf(c);
  const rest = status === "waived" && c.waive_kind === "rest"; // "Kalanı sil": the paid part still counts as paid
  const covered = status === "unpaid" || rest ? Math.min(Number(c.covered), c.amount_try) : 0;
  return {
    id: c.id, key: String(c.id), month: c.month, kind: c.kind, amount_try: c.amount_try, status, paid_by: c.paid_by, note: c.note,
    waive_kind: rest ? "rest" : null, void_kind: status === "voided" ? c.void_kind ?? null : null, covered_try: Math.min(Number(c.covered), c.amount_try),
    paid_try: status === "paid" ? c.amount_try : covered, remaining_try: status === "unpaid" ? c.amount_try - covered : 0,
    flag: status === "unpaid" ? flag : null,
    reservation: c.reservation_id ? { id: c.reservation_id, start_ms: c.start_ms, end_ms: c.end_ms, note: c.r_note, people: c.r_people, cancelled: !!c.r_cancelled } : null,
  };
};

/**
 * Still-open items of the user in OTHER months than `month` (older debt + already-created future charges, oldest month
 * first), plus next month's planned rent when `month` isn't next month itself. Feeds the admin payment composer so ONE
 * payment can cover items across months (e.g. this month's booking + next month's rent).
 */
export async function openElsewhere(db, user, month) {
  const { rows } = await db.execute({
    sql: `${ITEM_SQL} WHERE c.user_id = ? AND c.month <> ? AND c.month <= ?
            AND c.voided_at IS NULL AND c.waived_at IS NULL AND c.paid_receipt_id IS NULL
          ORDER BY c.month, CASE c.kind WHEN 'subscription' THEN 0 WHEN 'booking' THEN 1 ELSE 2 END, COALESCE(r.start_ms, 0), c.id`,
    args: [user.id, month, maxMonth()],
  });
  const items = rows.map((c) => toItem(c)).filter((i) => i.remaining_try > 0);
  const next = nextMonth(currentMonth());
  const planned = next !== month ? await projectedSub(db, user, next) : null;
  if (planned) {
    const at = items.findIndex((i) => i.month >= next); // rent first within its month, like monthView's order
    items.splice(at < 0 ? items.length : at, 0, planned);
  }
  return items;
}

/** Items of one user+month with per-item status, plus kalan (= sum of unpaid). */
export async function monthView(db, userId, month) {
  const { rows } = await db.execute({
    sql: `${ITEM_SQL} WHERE c.user_id = ? AND c.month = ?
          ORDER BY CASE c.kind WHEN 'subscription' THEN 0 WHEN 'booking' THEN 1 ELSE 2 END, COALESCE(r.start_ms, 0), c.id`,
    args: [userId, month],
  });
  // "!" flag: latest non-ok, not-admin-rejected receipt that covers an unpaid charge (mismatch / unreadable / duplicate).
  const flags = new Map();
  if (rows.length) {
    const ids = rows.map((c) => c.id);
    const f = (await db.execute({
      sql: `SELECT rc.charge_id, r.status FROM receipt_charges rc JOIN receipts r ON r.id = rc.receipt_id
            WHERE rc.charge_id IN (${ids.map(() => "?").join(",")}) AND r.status <> 'ok' AND r.admin_note IS NULL ORDER BY r.id`,
      args: ids,
    })).rows;
    for (const x of f) flags.set(x.charge_id, x.status);
  }
  // kalan = what is still owed: unpaid charges minus part-payments already applied to them (paid + kalan = total).
  let kalan = 0, total = 0, paid = 0;
  const items = rows.map((c) => {
    const it = toItem(c, flags.get(c.id) ?? null);
    if (it.status === "unpaid") { kalan += it.remaining_try; paid += it.paid_try; }
    if (it.status === "paid") paid += c.amount_try;
    if (it.waive_kind === "rest") { paid += it.paid_try; total += it.paid_try; }
    if (it.status === "unpaid" || it.status === "paid") total += c.amount_try;
    return it;
  });
  return { month, items, kalan, total, paid };
}

/**
 * One user's cumulative unpaid: everything still owed across ALL months up to the current one (never future), per month.
 * Same invariant as outstandingOverview's debt_try (MAX(amount - COVERED_SQL, 0) over non-voided/waived/fully-paid
 * charges), so the member page, UserDetail and the Ödemeler table always agree. Bootstrap observer: always 0.
 */
export async function userDebt(db, userId) {
  const { rows } = await db.execute({
    sql: `SELECT c.month, SUM(MAX(c.amount_try - ${COVERED_SQL}, 0)) AS owed FROM charges c
          WHERE c.user_id = ? AND c.user_id <> ${BOOTSTRAP_ID_SQL} AND c.month <= ?
            AND c.voided_at IS NULL AND c.waived_at IS NULL AND c.paid_receipt_id IS NULL
          GROUP BY c.month HAVING owed > 0 ORDER BY c.month`,
    args: [userId, currentMonth()],
  });
  const months = rows.map((r) => ({ month: r.month, remaining_try: Number(r.owed) }));
  return { debt_try: months.reduce((s, m) => s + m.remaining_try, 0), debt_months: months };
}

/**
 * Admin overview: EVERY member with what they still owe, in ONE aggregate query (no N per-user round trips).
 * Outstanding of a charge = amount - already applied (COVERED_SQL), same invariant `monthView` uses; voided / waived /
 * fully-paid (`paid_receipt_id`) charges are excluded, so the two never double-count.
 *   outstanding_try = the selected month only   |   debt_try = every month up to the current one (debt carries over:
 * charges stay in the month they were created in, nothing rolls them forward).
 * Members are active ones + anyone deactivated who still owes something (otherwise the grand total would lie).
 * The bootstrap admin (lowest id, created by seed.mjs at first boot) is excluded here too, same as GET /users -
 * it's a deploy-time secret account, not a real member, and shouldn't show up (or count toward the totals) on the
 * admin-facing Ödemeler screen.
 */
export async function outstandingOverview(db, month) {
  const owed = `MAX(c.amount_try - ${COVERED_SQL}, 0)`;
  const { rows } = await db.execute({
    sql: `SELECT u.id, u.name, u.active,
            COALESCE(SUM(CASE WHEN c.month = ?1 THEN ${owed} ELSE 0 END), 0) AS outstanding_try,
            COALESCE(SUM(CASE WHEN c.month <= ?3 THEN ${owed} ELSE 0 END), 0) AS debt_try
          FROM users u
          LEFT JOIN charges c ON c.user_id = u.id AND c.month <= ?2
            AND c.voided_at IS NULL AND c.waived_at IS NULL AND c.paid_receipt_id IS NULL
          WHERE u.status <> 'pending' AND u.id <> ${BOOTSTRAP_ID_SQL}
          GROUP BY u.id, u.name, u.active
          HAVING u.active = 1 OR debt_try > 0
          ORDER BY debt_try DESC, u.id`,
    // ?2 = join bound (a FUTURE month's own charges must reach outstanding_try), ?3 = debt is never counted past today
    args: [month, currentMonth() > month ? currentMonth() : month, currentMonth()],
  });
  const users = rows
    .map((r) => ({ id: r.id, name: r.name, active: !!r.active, outstanding_try: Number(r.outstanding_try), debt_try: Number(r.debt_try) }))
    .sort((a, b) => b.debt_try - a.debt_try || a.name.localeCompare(b.name, "tr"));
  return {
    month,
    users,
    total_outstanding_try: users.reduce((s, u) => s + u.outstanding_try, 0),
    total_debt_try: users.reduce((s, u) => s + u.debt_try, 0),
    owing_count: users.filter((u) => u.debt_try > 0).length,
  };
}

/**
 * Admin: waive (or un-waive) an unpaid, non-void charge. On a part-paid charge `mode` picks (ADR 0001 #2):
 * 'rest' = "Kalanı sil" (only the remainder is forgiven, the paid part stays a payment) or 'all' = "Tamamını iptal et"
 * (default; the paid part becomes alacak). An uncovered charge ignores `mode`.
 */
export const waiveCharge = (db, chargeId, waived, now = Date.now(), mode = "all") => serial(async () => {
  if (mode !== "all" && mode !== "rest") throw fail(400, "Geçersiz muafiyet türü");
  const c = (await db.execute({ sql: `SELECT c.*, ${COVERED_SQL} AS covered FROM charges c WHERE c.id = ?`, args: [chargeId] })).rows[0];
  if (!c) throw fail(404, "Kalem bulunamadı");
  if (c.voided_at) throw fail(409, "İptal edilmiş kalem");
  if (c.paid_receipt_id) throw fail(409, "Ödenmiş kalem muaf tutulamaz");
  const kind = waived && mode === "rest" && Number(c.covered) > 0 ? "rest" : null;
  await db.execute({ sql: "UPDATE charges SET waived_at = ?, waive_kind = ? WHERE id = ?", args: [waived ? now : null, kind, chargeId] });
  // unwaive takes back the alacak its part-payment had become; if that was spent -> "Harcanan alacak" (ADR 0001 #8).
  // Lazy import: credits.mjs imports billing.mjs.
  if (!waived) await (await import("./credits.mjs")).absorbSpentCreditRaw(db, c.user_id);
});

/** Admin: extra positive charge with a label (e.g. lost key). Whole TRY. */
export const addAdjustment = (db, { userId, month, amountTry, note }) => serial(async () => {
  if (!isMonth(month)) throw fail(400, "Geçersiz ay");
  if (!Number.isInteger(amountTry) || amountTry <= 0) throw fail(400, "Tutar pozitif tam sayı olmalı");
  const label = String(note ?? "").trim().slice(0, 120);
  if (!label) throw fail(400, "Açıklama gerekli");
  const u = (await db.execute({ sql: "SELECT id FROM users WHERE id = ?", args: [userId] })).rows[0];
  if (!u) throw fail(404, "Üye bulunamadı");
  if (await isBootstrap(db, u)) throw fail(409, "Gözlemci yönetici hesabına ücret eklenemez");
  const { lastInsertRowid } = await db.execute({
    sql: "INSERT INTO charges (user_id, month, kind, amount_try, note) VALUES (?,?, 'adjustment', ?, ?)",
    args: [userId, month, amountTry, label],
  });
  return Number(lastInsertRowid);
});

export const listFees = async (db) =>
  (await db.execute("SELECT id, effective_from, subscription_try, booking_try FROM fees ORDER BY effective_from DESC, id DESC")).rows;

/** Earliest month the fee editor accepts. */
export const FEE_MIN_MONTH = "2025-01";

/**
 * Admin fee editor (decided 2026-10-18): set the fees of ONE month, any month >= FEE_MIN_MONTH (past, current, future).
 * Model stays effective_from: a month override = upsert the row for `month` PLUS, if the next month has no row of its own,
 * a row for next month carrying the fee that was in force for `month` before the edit - so other months never change.
 * (Rows therefore accumulate, one per edited month; harmless, feeFor takes the latest <= month.)
 * Existing charges keep their amount: each subscription / booking of that month (paid ones too) whose price under the new
 * fee differs gets an open fee review (ADR 0001 #9, "Etkilenen kalemler"). Returns the number of open reviews for the month.
 * Whole TRY, multiples of 50, 0..100000.
 */
export const setFee = (db, { effectiveFrom: month, subscriptionTry, bookingTry }) => serial(async () => {
  if (!isMonth(month) || month < FEE_MIN_MONTH) throw fail(400, "Geçersiz ay");
  for (const n of [subscriptionTry, bookingTry])
    if (!Number.isInteger(n) || n < 0 || n > 100_000 || n % 50) throw fail(400, "Ücretler 0 ile 100.000 arasında, 50'nin katı tam sayı olmalı");
  const old = await feeFor(db, month);
  const next = nextMonth(month);
  const nextRow = (await db.execute({ sql: "SELECT id FROM fees WHERE effective_from = ?", args: [next] })).rows[0];
  if (!nextRow) await db.execute({ sql: "INSERT INTO fees (effective_from, subscription_try, booking_try) VALUES (?,?,?)", args: [next, old.subscription_try, old.booking_try] });
  const same = (await db.execute({ sql: "SELECT id FROM fees WHERE effective_from = ?", args: [month] })).rows[0];
  if (same) await db.execute({ sql: "UPDATE fees SET subscription_try = ?, booking_try = ? WHERE id = ?", args: [subscriptionTry, bookingTry, same.id] });
  else await db.execute({ sql: "INSERT INTO fees (effective_from, subscription_try, booking_try) VALUES (?,?,?)", args: [month, subscriptionTry, bookingTry] });
  // ADR 0001 #9: no silent re-price - every affected item of the month waits for the admin (lib/fee-reviews.mjs).
  // Lazy import: fee-reviews.mjs imports billing.mjs.
  return (await import("./fee-reviews.mjs")).syncReviewsRaw(db, month);
});
