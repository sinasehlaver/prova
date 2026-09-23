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
  if (!(booking_try > 0)) return;
  await tx.execute({
    sql: "INSERT INTO charges (user_id, month, kind, amount_try, reservation_id) VALUES (?,?, 'booking', ?, ?)",
    args: [bookerId, month, booking_try * people, reservationId],
  });
}

/** Inside the reservation-cancel tx: void the unpaid booking charges (paid ones stay). */
export const voidBookingCharges = (tx, reservationId, now) =>
  tx.execute({
    sql: "UPDATE charges SET voided_at = ? WHERE reservation_id = ? AND paid_receipt_id IS NULL AND voided_at IS NULL",
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

/** How far ahead a month can be browsed / prepaid (decided 2026-09-23): current + 12. */
export const MAX_AHEAD = 12;
export const maxMonth = () => {
  let m = currentMonth();
  for (let i = 0; i < MAX_AHEAD; i++) m = nextMonth(m);
  return m;
};
/** Months a member can browse: joined_month .. current + MAX_AHEAD (newest last). Future months are read-only
 *  projections - see billingPayload: a READ never materialises a future month's subscription charge. */
export const browsableMonths = (user) => monthRange(user.joined_month, maxMonth());
export const canBrowse = (user, month) => isMonth(month) && month >= user.joined_month && month <= maxMonth();

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
  const covered = status === "unpaid" ? Math.min(Number(c.covered), c.amount_try) : 0;
  return {
    id: c.id, key: String(c.id), month: c.month, kind: c.kind, amount_try: c.amount_try, status, paid_by: c.paid_by, note: c.note,
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
    if (it.status === "unpaid" || it.status === "paid") total += c.amount_try;
    return it;
  });
  return { month, items, kalan, total, paid };
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

/** Admin: waive (or un-waive) an unpaid, non-void charge. */
export const waiveCharge = (db, chargeId, waived, now = Date.now()) => serial(async () => {
  const c = (await db.execute({ sql: "SELECT * FROM charges WHERE id = ?", args: [chargeId] })).rows[0];
  if (!c) throw fail(404, "Kalem bulunamadı");
  if (c.voided_at) throw fail(409, "İptal edilmiş kalem");
  if (c.paid_receipt_id) throw fail(409, "Ödenmiş kalem muaf tutulamaz");
  await db.execute({ sql: "UPDATE charges SET waived_at = ? WHERE id = ?", args: [waived ? now : null, chargeId] });
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

/** Admin fee editor: new fee in force from `effectiveFrom` (must be a FUTURE month - existing charges keep their snapshot). */
export const setFee = (db, { effectiveFrom, subscriptionTry, bookingTry, now = Date.now() }) => serial(async () => {
  if (!isMonth(effectiveFrom)) throw fail(400, "Geçersiz ay");
  if (effectiveFrom <= monthOf(now)) throw fail(400, "Yeni ücret en erken gelecek aydan itibaren geçerli olabilir");
  for (const n of [subscriptionTry, bookingTry])
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw fail(400, "Ücretler 0 veya pozitif tam sayı olmalı");
  const same = (await db.execute({ sql: "SELECT id FROM fees WHERE effective_from = ?", args: [effectiveFrom] })).rows[0];
  if (same) await db.execute({ sql: "UPDATE fees SET subscription_try = ?, booking_try = ? WHERE id = ?", args: [subscriptionTry, bookingTry, same.id] });
  else await db.execute({ sql: "INSERT INTO fees (effective_from, subscription_try, booking_try) VALUES (?,?,?)", args: [effectiveFrom, subscriptionTry, bookingTry] });
});
