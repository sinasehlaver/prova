import { Router } from "express";
import { COVERED_SQL } from "../lib/billing.mjs";
import { BOOTSTRAP_ID_SQL, OBSERVER_NAME, isBootstrap, requireAdmin, requireAuth } from "../lib/auth.mjs";
import { EARLIEST_DATE, EARLIEST_MS, monthOf } from "../lib/tz.mjs";
import { createDeletionRequest, listPendingRequests, resolveRequest } from "../lib/deletion-requests.mjs";
import { listHolds, releaseHold, setHold } from "../lib/holds.mjs";
import { LISTENER_NO_BOOKING, MAX_PEOPLE, OBSERVER_NO_BOOKING, cancelReservation, createReservation, listReservations, updateReservation } from "../lib/reservations.mjs";

const DAY = 86_400_000;

export default ({ db }) => {
  const r = Router();
  r.use(["/reservations", "/members", "/holds", "/deletion-requests"], requireAuth);
  // domain errors carry .status; anything else -> global 500 handler
  const guard = (fn) => async (req, res, next) => {
    try { await fn(req, res); } catch (e) { e.status ? res.status(e.status).json({ error: e.message }) : next(e); }
  };

  // Non-admin member picker: id + name only. The bootstrap admin is hidden from everyone but themselves (like GET /users).
  r.get("/members", guard(async (req, res) => {
    const { rows } = await db.execute({
      sql: `SELECT id, name FROM users WHERE active = 1 AND (id <> ${BOOTSTRAP_ID_SQL} OR id = ?) ORDER BY name COLLATE NOCASE`,
      args: [req.user.id],
    });
    res.json(rows.map(({ id, name }) => ({ id, name })));
  }));

  r.get("/reservations/config", guard(async (_req, res) => res.json({ max_people: MAX_PEOPLE, earliest_ms: EARLIEST_MS, earliest_date: EARLIEST_DATE })));

  r.get("/reservations", guard(async (req, res) => {
    const from = req.query.from === undefined ? Date.now() - 7 * DAY : Number(req.query.from);
    const to = req.query.to === undefined ? from + 60 * DAY : Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > 400 * DAY) return res.status(400).json({ error: "Geçersiz tarih aralığı" });
    res.json(await listReservations(db, from, to));
  }));

  // Own reservations only (no id param): newest first, with the booking charge's SNAPSHOT amount (null = fee was 0) and its
  // paid / unpaid split (voided + waived count as neither; part-payments count as paid). `month` = Istanbul month of the start.
  r.get("/reservations/mine", guard(async (req, res) => {
    const { rows } = await db.execute({
      sql: `SELECT r.id, r.start_ms, r.end_ms, r.note, r.people, r.cancelled_at, c.amount_try AS charge_try,
              c.voided_at, c.waived_at, c.paid_receipt_id, ${COVERED_SQL} AS covered,
              (SELECT d.status FROM deletion_requests d WHERE d.reservation_id = r.id ORDER BY d.id DESC LIMIT 1) AS del_req
            FROM reservations r LEFT JOIN charges c ON c.reservation_id = r.id AND c.kind = 'booking'
            WHERE r.booker_id = ? ORDER BY r.start_ms DESC LIMIT 200`,
      args: [req.user.id],
    });
    res.json(rows.map(({ voided_at, waived_at, paid_receipt_id, covered, ...r }) => {
      const amt = r.charge_try ?? 0;
      const open = !voided_at && !waived_at;
      const paid = !open ? 0 : paid_receipt_id ? amt : Math.min(Number(covered), amt);
      return { ...r, month: monthOf(r.start_ms), paid_try: paid, unpaid_try: open && !r.cancelled_at ? amt - paid : 0 };
    }));
  }));

  r.post("/reservations", guard(async (req, res) => {
    const b = req.body ?? {};
    const id = await createReservation(db, {
      bookerId: req.user.id, bookerRole: req.user.role, startMs: b.start_ms, hours: b.hours, note: b.note, people: b.people ?? 0,
    });
    const [created] = await listReservations(db, b.start_ms, b.start_ms + 1);
    res.status(201).json(created ?? { id });
  }));

  r.patch("/reservations/:id", guard(async (req, res) => {
    const b = req.body ?? {};
    const diff = await updateReservation(db, Number(req.params.id), req.user, { startMs: b.start_ms, hours: b.hours, note: b.note, people: b.people ?? 0 });
    res.json({ ok: true, ...diff });
  }));

  r.delete("/reservations/:id", guard(async (req, res) => {
    // body (admin cancelling someone else's booking only): { confirm: <booker's first name>, reason: <>= 5 chars> }
    const b = req.body ?? {};
    await cancelReservation(db, Number(req.params.id), req.user, { reason: b.reason, confirm: b.confirm });
    res.json({ ok: true });
  }));

  // Past-reservation deletion requests: member asks, admins approve (= cancelReservation as admin) or reject.
  r.post("/reservations/:id/deletion-request", guard(async (req, res) => {
    const id = await createDeletionRequest(db, req.user, Number(req.params.id), req.body?.reason);
    res.status(201).json({ id });
  }));
  r.get("/deletion-requests", requireAdmin, guard(async (_req, res) => res.json(await listPendingRequests(db))));
  r.get("/deletion-requests/count", requireAdmin, guard(async (_req, res) => res.json({ count: (await listPendingRequests(db)).length })));
  for (const [verb, approve] of [["approve", true], ["reject", false]]) {
    r.post(`/deletion-requests/:id/${verb}`, requireAdmin, guard(async (req, res) => {
      await resolveRequest(db, req.user, Number(req.params.id), approve);
      res.json({ ok: true });
    }));
  }

  // Soft holds ("X is choosing these hours"): UX layer above the DB overlap check. One live hold per user, ~2 min TTL.
  r.get("/holds", guard(async (req, res) => res.json(await listHolds(db, req.user.id))));
  r.post("/holds", guard(async (req, res) => {
    if (req.user.role === "listener") return res.status(403).json({ error: LISTENER_NO_BOOKING });
    if (await isBootstrap(db, req.user)) return res.status(403).json({ error: OBSERVER_NO_BOOKING });
    const b = req.body ?? {};
    res.json(await setHold(db, { userId: req.user.id, startMs: b.start_ms, hours: b.hours }));
  }));
  r.delete("/holds", guard(async (req, res) => { await releaseHold(db, req.user.id); res.json({ ok: true }); }));

  // Admin-only audit trail of cancellations (who, whose booking, why). Members see nothing here.
  r.get("/reservations/audit", requireAdmin, guard(async (_req, res) => {
    const { rows } = await db.execute(`SELECT a.*, CASE WHEN a.actor_id = ${BOOTSTRAP_ID_SQL} THEN '${OBSERVER_NAME}' ELSE actor.name END AS actor_name, booker.name AS booker_name
      FROM reservation_audit a JOIN users actor ON actor.id = a.actor_id JOIN users booker ON booker.id = a.booker_id
      ORDER BY a.id DESC LIMIT 200`);
    res.json(rows);
  }));

  return r;
};
