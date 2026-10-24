// Reservation write path. Phase 4 (billing) hooks into createReservation / cancelReservation at the
// marked HOOK points, inside the same write transaction, so booking + charges commit or roll back together.
import { serial } from "./serial.mjs";
import { addBookingCharges, repriceBookingCharge, voidBookingCharges } from "./billing.mjs";
import { dropHoldRaw, foreignHoldRaw } from "./holds.mjs";
import { CURFEW_MSG, EARLIEST_DATE, EARLIEST_MS, endsByCurfew } from "./tz.mjs";
import { bootstrapId } from "./auth.mjs";
export const HOUR = 3600_000;
/** Members may edit/cancel their own booking only while now <= start - EDIT_CUTOFF_MS (admins: always). Mirrored in web/src/time.js. */
export const EDIT_CUTOFF_MS = HOUR;
export const LOCKED_EDIT_MSG = "Başlamasına 1 saatten az kalan rezervasyon düzenlenemez";
export const LOCKED_CANCEL_MSG = "Başlamasına 1 saatten az kalan rezervasyon iptal edilemez";
/** The bootstrap admin is an observer account (not a member): it can't book or hold a slot. */
export const OBSERVER_NO_BOOKING = "Gözlemci yönetici hesabı rezervasyon yapamaz";
/** A 'listener' pays the monthly fee like any member but can't book or hold a slot - it can only see the calendar. */
export const LISTENER_NO_BOOKING = "Üye hesabı rezervasyon yapamaz";
export const MAX_PEOPLE = 20;

const fail = (status, error) => Object.assign(new Error(error), { status });



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
 * Create a booking. Throws Error with .status (400 validation, 403 bootstrap/observer admin, 409 overlap).
 * startMs must be whole-hour aligned; past starts are allowed (back-filling) back to EARLIEST_MS (also before the
 * booker's joined_month: existing members are back-filled; billing browse then reaches that month, see browseFrom); hours >=1 ending by 22:00 Istanbul; people 0..MAX_PEOPLE (0 = free rehearsal covered by the monthly fee, still a normal reservation) (guests need not be members,
 * the booker pays people x per-person fee).
 */
export function createReservation(db, { bookerId, bookerRole, startMs, hours, note = null, people = 0, now = Date.now() }) {
  return serial(async () => {
    if (!Number.isSafeInteger(startMs) || startMs % HOUR !== 0) throw fail(400, "Başlangıç tam saat olmalı");
    if (!Number.isInteger(hours) || hours < 1) throw fail(400, "En az 1 saat seçmelisin");
    if (startMs < EARLIEST_MS) throw fail(400, `En erken ${EARLIEST_DATE} tarihine rezervasyon eklenebilir`);
    const endMs = startMs + hours * HOUR;
    if (!endsByCurfew(startMs, endMs)) throw fail(400, CURFEW_MSG);
    if (!Number.isInteger(people) || people < 0 || people > MAX_PEOPLE) throw fail(400, `Kişi sayısı 1-${MAX_PEOPLE} olmalı`);
    if (bookerRole === "listener") throw fail(403, LISTENER_NO_BOOKING);
    if (bookerId === (await bootstrapId(db))) throw fail(403, OBSERVER_NO_BOOKING);
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

/**
 * Edit own booking (start / hours / note / people). Same validation + overlap + soft-hold rules as createReservation (own row excluded
 * from the overlap check); the booking charge is re-priced in the same tx (paid ones too, see repriceBookingCharge).
 * Returns { debt_try, credit_try }: what the edit changed on money already paid (0/0 when nothing was paid).
 * Only the booker; within the last hour before start (or started/past) it is admin-only to edit (same as cancel). Throws with .status.
 */
export function updateReservation(db, id, user, { startMs, hours, note = null, people = 0, now = Date.now() }) {
  return serial(async () => {
    if (!Number.isSafeInteger(startMs) || startMs % HOUR !== 0) throw fail(400, "Başlangıç tam saat olmalı");
    if (!Number.isInteger(hours) || hours < 1) throw fail(400, "En az 1 saat seçmelisin");
    if (startMs < EARLIEST_MS) throw fail(400, `En erken ${EARLIEST_DATE} tarihine rezervasyon eklenebilir`);
    const endMs = startMs + hours * HOUR;
    if (!endsByCurfew(startMs, endMs)) throw fail(400, CURFEW_MSG);
    if (!Number.isInteger(people) || people < 0 || people > MAX_PEOPLE) throw fail(400, `Kişi sayısı 1-${MAX_PEOPLE} olmalı`);
    const cleanNote = String(note ?? "").trim().slice(0, 200) || null;
    const tx = await db.transaction("write");
    try {
      const r = (await tx.execute({ sql: "SELECT * FROM reservations WHERE id = ?", args: [id] })).rows[0];
      if (!r || r.cancelled_at) throw fail(404, "Rezervasyon bulunamadı");
      if (r.booker_id !== user.id) throw fail(403, "Bu rezervasyonu sadece oluşturan düzenleyebilir");
      if (r.start_ms - EDIT_CUTOFF_MS < now && user.role !== "admin") throw fail(409, LOCKED_EDIT_MSG);
      const clash = (await tx.execute({
        sql: "SELECT 1 FROM reservations WHERE cancelled_at IS NULL AND id <> ? AND start_ms < ? AND end_ms > ? LIMIT 1",
        args: [id, endMs, startMs],
      })).rows[0];
      if (clash) throw fail(409, "Bu saat aralığı dolu. Başka bir saat seç.");
      const held = await foreignHoldRaw(tx, user.id, startMs, endMs, now);
      if (held) throw fail(409, `Bu saat az önce başkası (${held.user_name}) tarafından ayrıldı. Birazdan tekrar dene ya da başka bir saat seç.`);
      await tx.execute({ sql: "UPDATE reservations SET start_ms = ?, end_ms = ?, note = ?, people = ? WHERE id = ?", args: [startMs, endMs, cleanNote, people, id] });
      const diff = await repriceBookingCharge(tx, id, user.id, people, startMs);
      await dropHoldRaw(tx, user.id);
      await tx.commit();
      return diff;
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
 * Cancel until 1 h before start (admins may also cancel started/past ones; unpaid charges are voided, paid stay). The booker cancels their own booking with no extra ceremony. An admin cancelling ANOTHER member's
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
      if (r.start_ms - EDIT_CUTOFF_MS < now && user.role !== "admin") throw fail(409, LOCKED_CANCEL_MSG); // admins may also clear past ones
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
      await voidBookingCharges(tx, id, now); // paid or not: the paid part becomes alacak (ADR 0001 #1)
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    } finally {
      tx.close();
    }
  });
}
