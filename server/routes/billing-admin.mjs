// Admin billing: receipts review, per-user views, waive/adjust, fee editor, payment settings. All under /api/admin.
import { Router } from "express";
import { BOOTSTRAP_ID_SQL, bootstrapId, requireAdmin } from "../lib/auth.mjs";
import { addAdjustment, canBrowse, ensureMonth, fail, isMonth, listFees, maxMonth, monthRange, outstandingOverview, setFee, waiveCharge } from "../lib/billing.mjs";
import { creditBalance, creditPayload, settleCredit } from "../lib/credits.mjs";
import { listReviews, resolveReviews } from "../lib/fee-reviews.mjs";
import { deleteReceipt, getSettings, listReceipts, parseReceipt, parseTokens, payFromCredit, recordPayment, reviewReceipt, undoApproval } from "../lib/payments.mjs";
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
    const first = (await db.execute(`SELECT MIN(month) AS m FROM charges WHERE voided_at IS NULL AND user_id <> ${BOOTSTRAP_ID_SQL}`)).rows[0]?.m;
    let joined = users.reduce((a, u) => (a && a < u.joined_month ? a : u.joined_month), null) ?? currentMonth();
    if (first && first < joined) joined = first;
    const ov = await outstandingOverview(db, month);
    // credit_try per row: drives the per-row "Alacaktan öde" button (ADR 0001 #4); only rows with debt need it
    for (const u of ov.users) u.credit_try = u.debt_try > 0 ? await creditBalance(db, u.id) : 0;
    // a passive member stays listed while they still have alacak (ADR 0001 #7; debt is covered by outstandingOverview)
    const listed = new Set(ov.users.map((u) => u.id));
    const passive = (await db.execute(`SELECT id, name FROM users WHERE active = 0 AND status <> 'pending' AND id <> ${BOOTSTRAP_ID_SQL}`)).rows;
    for (const p of passive) {
      if (listed.has(p.id)) continue;
      const credit = await creditBalance(db, p.id);
      if (credit !== 0) ov.users.push({ id: p.id, name: p.name, active: false, outstanding_try: 0, debt_try: 0, credit_try: credit });
    }
    res.json({ ...ov, months: monthRange(joined < month ? joined : month, maxMonth()) });
  }));

  // ---- receipts
  // cheap COUNT for the admin badge (GET only; the :id routes below are POST/DELETE, so no clash)
  r.get("/admin/receipts/pending-count", guard(async (req, res) => {
    res.json({ count: Number((await db.execute("SELECT COUNT(*) AS n FROM receipts WHERE status = 'pending'")).rows[0].n) });
  }));
  r.get("/admin/receipts", guard(async (req, res) => {
    const { month, user_id, status } = req.query;
    if (month && !isMonth(month)) throw fail(400, "Geçersiz ay");
    if (status && !STATUSES.includes(status)) throw fail(400, "Geçersiz durum");
    res.json(await listReceipts(db, { month, userId: user_id ? Number(user_id) : undefined, status, viewer: "admin" }));
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
      await reviewReceipt(db, Number(req.params.id), action, b.note, { month: b.month, chargeIds, paidTry: b.amount_try != null ? Number(b.amount_try) : undefined, creditTry: b.credit_try != null ? Number(b.credit_try) : 0 });
      res.json((await listReceipts(db, { id: Number(req.params.id) }))[0]);
    }));

  // Take back an approval: ok -> pending (admin only via the /admin guard), see undoApproval.
  r.post("/admin/receipts/:id/undo-approval", guard(async (req, res) => {
    await undoApproval(db, Number(req.params.id));
    res.json((await listReceipts(db, { id: Number(req.params.id) }))[0]);
  }));

  r.delete("/admin/receipts/:id", guard(async (req, res) => {
    await deleteReceipt(db, Number(req.params.id));
    res.json({ ok: true });
  }));

  // ---- per-user views
  r.get("/admin/users/:id/billing", guard(async (req, res) => {
    const u = await userOf(req.params.id, req);
    const month = req.query.month ?? currentMonth();
    if (!(await canBrowse(db, u, month))) throw fail(400, "Geçersiz ay");
    res.json(await billingPayload(db, u, month, { admin: true }));
  }));
  r.get("/admin/users/:id/receipts", guard(async (req, res) => {
    res.json(await listReceipts(db, { userId: (await userOf(req.params.id, req)).id, viewer: "admin" }));
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
  // &credit_try=N = also spend N of the member's credit on the picked items (cash amount_try may then be 0; N <= credit, <= picked total).
  // &from_credit=1 (legacy) = no new money: spend the member's existing credit on the picked items (no PDF allowed).
  r.post("/admin/users/:id/receipts", rawPdf, guard(async (req, res) => {
    const u = await userOf(req.params.id, req);
    const month = req.query.month ?? currentMonth();
    if (!(await canBrowse(db, u, month))) throw fail(400, "Geçersiz ay");
    const chargeIds = req.query.charges === undefined ? null : parseTokens(req.query.charges);
    const { id, duplicate } = await recordPayment(db, u, {
      month, chargeIds, paidTry: req.query.amount_try === undefined ? 0 : Number(req.query.amount_try),
      creditTry: req.query.credit_try === undefined ? 0 : Number(req.query.credit_try), buffer: bodyBuf(req),
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
  // "Geri ödendi" (kind refund, default) / "Alacağı sil" (kind forfeit). amount_try omitted = all of it.
  r.post("/admin/users/:id/credit/settle", guard(async (req, res) => {
    const u = await userOf(req.params.id, req);
    const b = req.body ?? {};
    const amount = await settleCredit(db, u.id, { amountTry: b.amount_try, note: b.note, kind: b.kind ?? "refund" });
    res.json({ settled_try: amount, credit: await creditPayload(db, u.id) });
  }));
  // "Alacaktan öde" (ADR 0001 #4): the member's alacak pays their oldest open debt. 409 when there's no alacak or no debt.
  r.post("/admin/users/:id/credit/pay", guard(async (req, res) => {
    const u = await userOf(req.params.id, req);
    const { paid_try } = await payFromCredit(db, u);
    res.json({ paid_try, credit: await creditPayload(db, u.id) });
  }));
  // mode: 'all' (default, "Tamamını iptal et") | 'rest' ("Kalanı sil", part-paid charges only)
  r.post("/admin/charges/:id/waive", guard(async (req, res) => {
    await waiveCharge(db, Number(req.params.id), req.body?.waived !== false, Date.now(), req.body?.mode ?? "all");
    res.json({ ok: true });
  }));

  // ---- fee editor: any month >= 2025-01; affected items of that month get fee reviews (see setFee). requireAdmin via the /admin mount.
  r.get("/admin/fees", guard(async (_req, res) => res.json(await listFees(db))));
  r.post("/admin/fees", guard(async (req, res) => {
    const b = req.body ?? {};
    const reviews = await setFee(db, { effectiveFrom: b.effective_from, subscriptionTry: b.subscription_try, bookingTry: b.booking_try });
    res.status(201).json({ fees: await listFees(db), reviews });
  }));
  // ADR 0001 #9 "Etkilenen kalemler": open per-item price decisions; decision 'apply' | 'keep' on up to 1000 ids
  r.get("/admin/fee-reviews", guard(async (_req, res) => res.json(await listReviews(db))));
  r.post("/admin/fee-reviews/resolve", guard(async (req, res) => {
    const resolved = await resolveReviews(db, req.body?.ids, req.body?.decision);
    res.json({ resolved, open: await listReviews(db) });
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
