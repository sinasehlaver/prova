// Soft holds: "X is choosing these hours" while the booking sheet is open (migration 005 `slot_holds`).
// A hold is UX only - the overlap check in createReservation stays the real guarantee. At most ONE live hold per user
// (setting a new one replaces the old); expired rows are ignored everywhere (`expires_at > now`) and pruned on write.
// Writes go through serial() like every other write; the `*Raw` helpers take a tx and never lock (createReservation
// calls them inside its own serial() - never nest serial).
import { serial } from "./serial.mjs";

export const HOUR = 3600_000;
export const HOLD_TTL_MS = 120_000;
/** TTL used when the caller does not pass one: env PROVA_HOLD_TTL_MS (tests / tuning) else 2 minutes. */
export const holdTtl = () => {
  const n = Number(process.env.PROVA_HOLD_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : HOLD_TTL_MS;
};

const fail = (status, error) => Object.assign(new Error(error), { status });

/** Another user's live hold overlapping [startMs, endMs), or undefined. `tx` may be a client or a transaction. */
export async function foreignHoldRaw(tx, userId, startMs, endMs, now) {
  return (await tx.execute({
    sql: `SELECT h.*, u.name AS user_name FROM slot_holds h JOIN users u ON u.id = h.user_id
          WHERE h.user_id != ? AND h.expires_at > ? AND h.start_ms < ? AND h.end_ms > ? LIMIT 1`,
    args: [userId, now, endMs, startMs],
  })).rows[0];
}

export const dropHoldRaw = (tx, userId) => tx.execute({ sql: "DELETE FROM slot_holds WHERE user_id = ?", args: [userId] });

/** Live holds of everyone EXCEPT `userId` (the caller sees their own selection in their own sheet). */
export async function listHolds(db, userId, now = Date.now()) {
  const { rows } = await db.execute({
    sql: `SELECT h.id, h.user_id, u.name AS user_name, h.start_ms, h.end_ms, h.expires_at
          FROM slot_holds h JOIN users u ON u.id = h.user_id WHERE h.user_id != ? AND h.expires_at > ? ORDER BY h.start_ms`,
    args: [userId, now],
  });
  return rows;
}

/**
 * Create or refresh the caller's hold on [startMs, startMs + hours h). 400 validation, 409 when a booking or another
 * user's live hold overlaps. Returns { start_ms, end_ms, expires_at }.
 */
export function setHold(db, { userId, startMs, hours, maxHours, now = Date.now(), ttlMs = holdTtl() }) {
  return serial(async () => {
    if (!Number.isSafeInteger(startMs) || startMs % HOUR !== 0) throw fail(400, "Başlangıç tam saat olmalı");
    if (!Number.isInteger(hours) || hours < 1 || hours > maxHours) throw fail(400, `1-${maxHours} saat seçmelisin`);
    if (startMs <= now) throw fail(400, "Geçmiş bir saat seçilemez");
    const endMs = startMs + hours * HOUR;
    const tx = await db.transaction("write");
    try {
      await tx.execute({ sql: "DELETE FROM slot_holds WHERE expires_at <= ?", args: [now] });
      const booked = (await tx.execute({
        sql: "SELECT 1 FROM reservations WHERE cancelled_at IS NULL AND start_ms < ? AND end_ms > ? LIMIT 1", args: [endMs, startMs],
      })).rows[0];
      if (booked) throw fail(409, "Bu saat aralığı dolu. Başka bir saat seç.");
      const other = await foreignHoldRaw(tx, userId, startMs, endMs, now);
      if (other) throw fail(409, `${other.user_name} şu anda bu saatleri seçiyor. Birazdan tekrar dene ya da başka bir saat seç.`);
      const expires = now + ttlMs;
      await tx.execute({
        sql: `INSERT INTO slot_holds (user_id, start_ms, end_ms, expires_at) VALUES (?,?,?,?)
              ON CONFLICT(user_id) DO UPDATE SET start_ms = excluded.start_ms, end_ms = excluded.end_ms, expires_at = excluded.expires_at`,
        args: [userId, startMs, endMs, expires],
      });
      await tx.commit();
      return { start_ms: startMs, end_ms: endMs, expires_at: expires };
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    } finally {
      tx.close();
    }
  });
}

/** Release the caller's hold (no-op when there is none). */
export const releaseHold = (db, userId) => serial(async () => { await dropHoldRaw(db, userId); });
