// Member -> admin requests to delete a PAST reservation. Approval cancels through cancelReservation (voids unpaid charges, audit row).
import { cancelReservation } from "./reservations.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const one = async (db, sql, args = []) => (await db.execute({ sql, args })).rows[0];
const MAX_REASON = 300;

export async function createDeletionRequest(db, user, reservationId, reason, now = Date.now()) {
  const r = await one(db, "SELECT * FROM reservations WHERE id = ?", [reservationId]);
  if (!r || r.cancelled_at || r.booker_id !== user.id) throw fail(404, "Rezervasyon bulunamadı");
  if (r.start_ms > now) throw fail(409, "Gelecekteki rezervasyonu doğrudan iptal edebilirsin");
  const why = typeof reason === "string" ? reason.trim().slice(0, MAX_REASON) : "";
  try {
    const { lastInsertRowid } = await db.execute({
      sql: "INSERT INTO deletion_requests (reservation_id, requester_id, reason, created_at) VALUES (?,?,?,?)",
      args: [reservationId, user.id, why || null, now],
    });
    return Number(lastInsertRowid);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e?.message))) throw fail(409, "Bu rezervasyon için zaten bekleyen bir talep var");
    throw e;
  }
}

export async function listPendingRequests(db) {
  return (await db.execute(`SELECT d.id, d.reservation_id, d.reason, d.created_at, u.name AS requester_name, r.start_ms, r.end_ms, r.note, r.people
    FROM deletion_requests d JOIN reservations r ON r.id = d.reservation_id JOIN users u ON u.id = d.requester_id
    WHERE d.status = 'pending' ORDER BY d.created_at`)).rows;
}

export async function resolveRequest(db, admin, id, approve, now = Date.now()) {
  const d = await one(db, "SELECT d.*, u.name AS requester_name FROM deletion_requests d JOIN users u ON u.id = d.requester_id WHERE d.id = ?", [id]);
  if (!d) throw fail(404, "Talep bulunamadı");
  if (d.status !== "pending") throw fail(409, "Bu talep zaten sonuçlandı");
  if (approve) {
    try {
      await cancelReservation(db, d.reservation_id, admin, {
        reason: `Silme talebi onaylandı${d.reason ? `: ${d.reason}` : ""}`, confirm: d.requester_name, now,
      });
    } catch (e) { if (e.status !== 404) throw e; } // already cancelled elsewhere: still close the request
  }
  await db.execute({
    sql: "UPDATE deletion_requests SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
    args: [approve ? "approved" : "rejected", admin.id, now, id],
  });
}
