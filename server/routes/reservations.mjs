import { Router } from "express";
import { requireAdmin, requireAuth } from "../lib/auth.mjs";
import { listHolds, releaseHold, setHold } from "../lib/holds.mjs";
import { MAX_PEOPLE, cancelReservation, createReservation, listReservations, maxHours } from "../lib/reservations.mjs";

const DAY = 86_400_000;

export default ({ db }) => {
  const r = Router();
  r.use(["/reservations", "/members", "/holds"], requireAuth);
  // domain errors carry .status; anything else -> global 500 handler
  const guard = (fn) => async (req, res, next) => {
    try { await fn(req, res); } catch (e) { e.status ? res.status(e.status).json({ error: e.message }) : next(e); }
  };

  // Non-admin member picker: id + name only.
  r.get("/members", guard(async (_req, res) => {
    const { rows } = await db.execute("SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE");
    res.json(rows.map(({ id, name }) => ({ id, name })));
  }));

  r.get("/reservations/config", guard(async (_req, res) => res.json({ max_hours: await maxHours(db), max_people: MAX_PEOPLE })));

  r.get("/reservations", guard(async (req, res) => {
    const from = req.query.from === undefined ? Date.now() - 7 * DAY : Number(req.query.from);
    const to = req.query.to === undefined ? from + 60 * DAY : Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > 400 * DAY) return res.status(400).json({ error: "Geçersiz tarih aralığı" });
    res.json(await listReservations(db, from, to));
  }));

  r.post("/reservations", guard(async (req, res) => {
    const b = req.body ?? {};
    const id = await createReservation(db, {
      bookerId: req.user.id, startMs: b.start_ms, hours: b.hours, note: b.note, people: b.people ?? 1,
    });
    const [created] = await listReservations(db, b.start_ms, b.start_ms + 1);
    res.status(201).json(created ?? { id });
  }));

  r.delete("/reservations/:id", guard(async (req, res) => {
    // body (admin cancelling someone else's booking only): { confirm: <booker's first name>, reason: <>= 5 chars> }
    const b = req.body ?? {};
    await cancelReservation(db, Number(req.params.id), req.user, { reason: b.reason, confirm: b.confirm });
    res.json({ ok: true });
  }));

  // Soft holds ("X is choosing these hours"): UX layer above the DB overlap check. One live hold per user, ~2 min TTL.
  r.get("/holds", guard(async (req, res) => res.json(await listHolds(db, req.user.id))));
  r.post("/holds", guard(async (req, res) => {
    const b = req.body ?? {};
    res.json(await setHold(db, { userId: req.user.id, startMs: b.start_ms, hours: b.hours, maxHours: await maxHours(db) }));
  }));
  r.delete("/holds", guard(async (req, res) => { await releaseHold(db, req.user.id); res.json({ ok: true }); }));

  // Admin-only audit trail of cancellations (who, whose booking, why). Members see nothing here.
  r.get("/reservations/audit", requireAdmin, guard(async (_req, res) => {
    const { rows } = await db.execute(`SELECT a.*, actor.name AS actor_name, booker.name AS booker_name
      FROM reservation_audit a JOIN users actor ON actor.id = a.actor_id JOIN users booker ON booker.id = a.booker_id
      ORDER BY a.id DESC LIMIT 200`);
    res.json(rows);
  }));

  return r;
};
