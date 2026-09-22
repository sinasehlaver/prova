// Reservation write path. Phase 4 (billing) hooks into createReservation / cancelReservation at the
// marked HOOK points, inside the same write transaction, so booking + charges commit or roll back together.
import { serial } from "./serial.mjs";
import { addBookingCharges, voidBookingCharges } from "./billing.mjs";
import { dropHoldRaw, foreignHoldRaw } from "./holds.mjs";
export const HOUR = 3600_000;
export const DEFAULT_MAX_HOURS = 4;
export const MAX_PEOPLE = 20;

const fail = (status, error) => Object.assign(new Error(error), { status });

export async function maxHours(db) {
  const { rows } = await db.execute("SELECT value FROM settings WHERE key = 'max_reservation_hours'");
  const n = Number(rows[0]?.value);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_HOURS;
}


/** Full reservation objects (with booker name + people count) overlapping [from, to), non-cancelled. */
export async function listReservations(db, from, to) {
  const { rows } = await db.execute({
    sql: `SELECT r.id, r.booker_id, u.name AS booker_name, r.start_ms, r.end_ms, r.note, r.people
          FROM reservations r JOIN users u ON u.id = r.booker_id
          WHERE r.cancelled_at IS NULL AND r.start_ms < ? AND r.end_ms > ? ORDER BY r.start_ms`,
    args: [to, from],
  });
  return rows;
}

/**
 * Create a booking. Throws Error with .status (400 validation, 409 overlap).
 * startMs must be whole-hour aligned and in the future; hours 1..max; people 1..MAX_PEOPLE (guests need not be members,
 * the booker pays people x per-person fee).
 */
export function createReservation(db, { bookerId, startMs, hours, note = null, people = 1, now = Date.now() }) {
  return serial(async () => {
    if (!Number.isSafeInteger(startMs) || startMs % HOUR !== 0) throw fail(400, "Başlangıç tam saat olmalı");
    if (!Number.isInteger(hours) || hours < 1) throw fail(400, "En az 1 saat seçmelisin");
    const max = await maxHours(db);
    if (hours > max) throw fail(400, `En fazla ${max} saat rezerve edilebilir`);
    if (startMs <= now) throw fail(400, "Geçmiş bir saate rezervasyon yapılamaz");
    const endMs = startMs + hours * HOUR;
    if (!Number.isInteger(people) || people < 1 || people > MAX_PEOPLE) throw fail(400, `Kişi sayısı 1-${MAX_PEOPLE} olmalı`);
    const cleanNote = String(note ?? "").trim().slice(0, 200) || null;

    const tx = await db.transaction("write");
    try {
      const clash = (await tx.execute({
        sql: "SELECT 1 FROM reservations WHERE cancelled_at IS NULL AND start_ms < ? AND end_ms > ? LIMIT 1",
        args: [endMs, startMs],
      })).rows[0];
      if (clash) throw fail(409, "Bu saat aralığı dolu. Başka bir saat seç.");
      // soft hold: someone else opened the booking sheet on these hours first. Own hold never blocks the owner.
      const held = await foreignHoldRaw(tx, bookerId, startMs, endMs, now);
      if (held) throw fail(409, `Bu saat az önce başkası (${held.user_name}) tarafından ayrıldı. Birazdan tekrar dene ya da başka bir saat seç.`);
      const { lastInsertRowid } = await tx.execute({
        sql: "INSERT INTO reservations (booker_id, start_ms, end_ms, note, people) VALUES (?,?,?,?,?)",
        args: [bookerId, startMs, endMs, cleanNote, people],
      });
      const id = Number(lastInsertRowid);
      await addBookingCharges(tx, id, bookerId, people, startMs); // one charge on the booker = people x fee (snapshot of the reservation's month)
      await dropHoldRaw(tx, bookerId); // the booker's own hold is consumed
      await tx.commit();
      return id;
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    } finally {
      tx.close();
    }
  });
}

export const MIN_REASON = 5;
/** First word of a name, folded (lower-case, ı->i, diacritics dropped: "ŞULE"/"sule" both match "Şule") — what the admin types to confirm.
 *  Mirrored in web/src/Calendar.jsx. */
export const firstName = (name) =>
  String(name ?? "").trim().split(/\s+/)[0].toLocaleLowerCase("tr").replace(/ı/g, "i").normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Cancel until start. The booker cancels their own booking with no extra ceremony. An admin cancelling ANOTHER member's
 * booking passes a hard gate: `confirm` must equal the booker's first name (case-insensitive) and `reason` must be
 * >= MIN_REASON chars; both are checked here (not only in the UI), and the acting admin + reason are written to
 * `reservation_audit` in the same tx. Throws with .status (404/403/409, 400 when the gate is not passed).
 */
export function cancelReservation(db, id, user, { reason, confirm, now = Date.now() } = {}) {
  return serial(async () => {
    const tx = await db.transaction("write");
    try {
      const r = (await tx.execute({
        sql: "SELECT r.*, u.name AS booker_name FROM reservations r JOIN users u ON u.id = r.booker_id WHERE r.id = ?", args: [id],
      })).rows[0];
      if (!r || r.cancelled_at) throw fail(404, "Rezervasyon bulunamadı");
      const own = r.booker_id === user.id;
      if (!own && user.role !== "admin") throw fail(403, "Bu rezervasyonu sadece oluşturan iptal edebilir");
      if (r.start_ms <= now) throw fail(409, "Başlamış rezervasyon iptal edilemez");
      let why = null;
      if (!own) { // hard gate: an admin acting on someone else's booking
        why = String(reason ?? "").trim();
        if (why.length < MIN_REASON) throw fail(400, `Başkasının rezervasyonunu iptal etmek için en az ${MIN_REASON} karakterlik bir neden yazmalısın`);
        if (firstName(confirm) !== firstName(r.booker_name)) throw fail(400, "Onay için rezervasyon sahibinin adını yazmalısın");
        why = why.slice(0, 300);
      }
      await tx.execute({ sql: "UPDATE reservations SET cancelled_at = ? WHERE id = ?", args: [now, id] });
      await tx.execute({
        sql: "INSERT INTO reservation_audit (reservation_id, action, actor_id, booker_id, reason, start_ms, end_ms, created_at) VALUES (?,?,?,?,?,?,?,?)",
        args: [id, own ? "cancel" : "admin_cancel", user.id, r.booker_id, why, r.start_ms, r.end_ms, now],
      });
      await voidBookingCharges(tx, id, now); // unpaid ones only; paid stay (admin adjusts by hand)
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    } finally {
      tx.close();
    }
  });
}
