// Admin billing: receipts review, per-user views, waive/adjust, fee editor, payment settings. All under /api/admin.
import { Router } from "express";
import { BOOTSTRAP_ID_SQL, bootstrapId, requireAdmin } from "../lib/auth.mjs";
import { addAdjustment, canBrowse, ensureMonth, fail, isMonth, listFees, maxMonth, monthRange, outstandingOverview, setFee, waiveCharge } from "../lib/billing.mjs";
import { creditPayload, settleCredit } from "../lib/credits.mjs";
import { getSettings, listReceipts, parseReceipt, parseTokens, recordPayment, reviewReceipt } from "../lib/payments.mjs";
import { currentMonth } from "../lib/tz.mjs";
import { billingPayload, bodyBuf, guard, rawPdf } from "./billing.mjs";

const STATUSES = ["ok", "mismatch", "unreadable", "duplicate", "pending"];

export default ({ db }) => {
  const r = Router();
  r.use("/admin", requireAdmin);

  // The bootstrap admin's own per-user pages are theirs only: to any other admin that id doesn't exist (404).
  const userOf = async (id, req) => {
    const u = (await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [Number(id)] })).rows[0];
    if (!u || (u.id !== req.user.id && u.id === (await bootstrapId(db)))) throw fail(404, "Üye bulunamadı");
    return u;
  };

  // ---- overview: everyone at a glance (default view of the Ödemeler screen = current month, all members)
  r.get("/admin/billing/overview", guard(async (req, res) => {
    const month = req.query.month ?? currentMonth();
    if (!isMonth(month) || month > maxMonth()) throw fail(400, "Geçersiz ay");
    // materialise the current month's subscription charges first, like economicsSummary does - otherwise a member who
    // never opened their own page would show 0 owed. (ensureMonth serialises per user; past months are left as they are.)
    // Bootstrap admin excluded here too - outstandingOverview hides it, so there's no point ensuring its charge.
    const users = (await db.execute(`SELECT * FROM users WHERE active = 1 AND id <> ${BOOTSTRAP_ID_SQL}`)).rows;
    if (month === currentMonth()) for (const u of users) await ensureMonth(db, u, month);
    const joined = users.reduce((a, u) => (a && a < u.joined_month ? a : u.joined_month), null) ?? currentMonth();
    res.json({ ...(await outstandingOverview(db, month)), months: monthRange(joined < month ? joined : month, maxMonth()) });
  }));

  // ---- receipts
  r.get("/admin/receipts", guard(async (req, res) => {
    const { month, user_id, status } = req.query;
    if (month && !isMonth(month)) throw fail(400, "Geçersiz ay");
    if (status && !STATUSES.includes(status)) throw fail(400, "Geçersiz durum");
    res.json(await listReceipts(db, { month, userId: user_id ? Number(user_id) : undefined, status }));
  }));
  // Aid only: parse a dekont PDF and say what it looks like. Stores nothing - the admin confirms the amount.
  // Raw PDF body; ?expected_try=<outstanding of the selected items>
  r.post("/admin/receipts/parse", rawPdf, guard(async (req, res) => {
    res.json(await parseReceipt(db, { buffer: bodyBuf(req), expectedTry: Number(req.query.expected_try) || 0 }));
  }));
  // extra.month/chargeIds/paidTry only matter for a PENDING (member-uploaded) receipt's approve - ignored otherwise.
  for (const action of ["approve", "reject"])
    r.post(`/admin/receipts/:id/${action}`, guard(async (req, res) => {
      const b = req.body ?? {};
      const chargeIds = b.charges == null ? null : parseTokens(b.charges);
      await reviewReceipt(db, Number(req.params.id), action, b.note, { month: b.month, chargeIds, paidTry: b.amount_try != null ? Number(b.amount_try) : undefined });
      res.json((await listReceipts(db, { id: Number(req.params.id) }))[0]);
    }));

  // ---- per-user views
  r.get("/admin/users/:id/billing", guard(async (req, res) => {
    const u = await userOf(req.params.id, req);
    const month = req.query.month ?? currentMonth();
    if (!canBrowse(u, month)) throw fail(400, "Geçersiz ay");
    res.json(await billingPayload(db, u, month));
  }));
  r.get("/admin/users/:id/receipts", guard(async (req, res) => {
    res.json(await listReceipts(db, { userId: (await userOf(req.params.id, req)).id }));
  }));
  // people + the booking charge's own SNAPSHOT amount (not a recomputed current fee - see lib/billing.mjs on charge
  // snapshots). At most one 'booking' charge per reservation (addBookingCharges inserts exactly one); charge_try is
  // null when the fee was 0 at booking time (no charge was ever inserted).
  r.get("/admin/users/:id/reservations", guard(async (req, res) => {
    const u = await userOf(req.params.id, req);
    const { rows } = await db.execute({
      sql: `SELECT r.id, r.start_ms, r.end_ms, r.note, r.people, r.cancelled_at, b.name AS booker_name, c.amount_try AS charge_try
            FROM reservations r JOIN users b ON b.id = r.booker_id
            LEFT JOIN charges c ON c.reservation_id = r.id AND c.kind = 'booking'
            WHERE r.booker_id = ? ORDER BY r.start_ms DESC LIMIT 100`,
      args: [u.id],
    });
    res.json(rows);
  }));
  // Manual payment recording (replaces the member's self-serve upload). Raw PDF body (optional - a payment with no
  // dekont is still recordable); ?month=&charges=1,2,sub:YYYY-MM (omit = all unpaid of the month; ids may be from ANY
  // month of the user, sub:YYYY-MM = prepay a future month's planned rent)&amount_try=&filename=&note=
  // &from_credit=1 = no new money: spend the member's existing credit on the picked items (no PDF allowed).
  r.post("/admin/users/:id/receipts", rawPdf, guard(async (req, res) => {
    const u = await userOf(req.params.id, req);
    const month = req.query.month ?? currentMonth();
    if (!canBrowse(u, month)) throw fail(400, "Geçersiz ay");
    const chargeIds = req.query.charges === undefined ? null : parseTokens(req.query.charges);
    const { id, duplicate } = await recordPayment(db, u, {
      month, chargeIds, paidTry: Number(req.query.amount_try), buffer: bodyBuf(req),
      filename: req.query.filename, note: req.query.note, fromCredit: req.query.from_credit === "1",
    });
    res.status(201).json({ ...(await listReceipts(db, { id }))[0], duplicate });
  }));
  r.post("/admin/users/:id/charges", guard(async (req, res) => {
    const u = await userOf(req.params.id, req);
    const b = req.body ?? {};
    const id = await addAdjustment(db, { userId: u.id, month: b.month, amountTry: b.amount_try, note: b.note });
    res.status(201).json({ id });
  }));
  // "Alacağı kapat": the community paid the member's overpayment back (or settled it by hand). amount_try omitted = all of it.
  r.post("/admin/users/:id/credit/settle", guard(async (req, res) => {
    const u = await userOf(req.params.id, req);
    const b = req.body ?? {};
    const amount = await settleCredit(db, u.id, { amountTry: b.amount_try, note: b.note });
    res.json({ settled_try: amount, credit: await creditPayload(db, u.id) });
  }));
  r.post("/admin/charges/:id/waive", guard(async (req, res) => {
    await waiveCharge(db, Number(req.params.id), req.body?.waived !== false);
    res.json({ ok: true });
  }));

  // ---- fee editor (new row from a FUTURE month; existing charges keep their snapshot)
  r.get("/admin/fees", guard(async (_req, res) => res.json(await listFees(db))));
  r.post("/admin/fees", guard(async (req, res) => {
    const b = req.body ?? {};
    await setFee(db, { effectiveFrom: b.effective_from, subscriptionTry: b.subscription_try, bookingTry: b.booking_try });
    res.status(201).json(await listFees(db));
  }));

  // ---- payment settings
  r.get("/admin/settings", guard(async (_req, res) => res.json(await getSettings(db))));
  r.put("/admin/settings", guard(async (req, res) => {
    const b = req.body ?? {};
    const iban = String(b.iban ?? "").replace(/\s+/g, "").toUpperCase();
    const holder = String(b.holder ?? "").trim().slice(0, 100);
    if (iban && !/^TR\d{24}$/.test(iban)) throw fail(400, "IBAN 'TR' + 24 rakam olmalı");
    const requireRecipient = !!b.requireRecipient;
    if (requireRecipient && !iban && !holder) throw fail(400, "Alıcı kontrolü için IBAN ya da hesap sahibi adı gir");
    await db.batch([
      ["community_iban", iban], ["community_holder", holder], ["receipt_require_recipient", requireRecipient ? "1" : "0"],
    ].map(([k, v]) => ({ sql: "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [k, v] })), "write");
    res.json(await getSettings(db));
  }));

  return r;
};
