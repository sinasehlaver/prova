// Member billing (own data only - there is no user_id parameter here) + receipt PDF download (owner or admin).
// Admin billing endpoints live in billing-admin.mjs and are mounted from here (keeps ROUTES to one line).
import express, { Router } from "express";
import { requireAuth } from "../lib/auth.mjs";
import { rateLimit } from "../lib/ratelimit.mjs";
import { browsableMonths, canBrowse, ensureMonths, fail, isMonth, monthRange, monthView, openElsewhere, projectedSub, userDebt } from "../lib/billing.mjs";
import { creditOutlook, creditPayload } from "../lib/credits.mjs";
import { deleteReceipt, getSettings, listReceipts, MAX_PDF, payFromCredit, resubmitReceipt, submitReceipt } from "../lib/payments.mjs";
import { currentMonth } from "../lib/tz.mjs";
import billingAdmin from "./billing-admin.mjs";

// domain errors carry .status; anything else -> global 500 handler
export const guard = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { e.status ? res.status(e.status).json({ error: e.message }) : next(e); }
};

/** Month view + where to pay + this month's receipts for one user. Shared with the admin per-user view. */
// A FUTURE month is never materialised by a read (its rent would snapshot today's fee and a later setFee for that month
// would miss it) - it shows its real charges (bookings already made) plus a display-only `upcoming` planned rent.
// credit_cover = creditOutlook (display-only: how much of this month the existing credit would cover; nothing applied).
export async function billingPayload(db, user, month, { admin = false } = {}) {
  const future = month > currentMonth();
  // Viewed month (if not future) + past months nobody opened (so past unpaid aidat shows in the composer's "other months"),
  // batched: the old one-month-at-a-time loop made every month switch slow.
  await ensureMonths(db, user, monthRange(user.joined_month, currentMonth()));
  const [view, receipts, cfg, credit, planned, other_open, debt, months] = await Promise.all([
    monthView(db, user.id, month), listReceipts(db, { userId: user.id, month, viewer: admin ? "admin" : "member" }), getSettings(db), creditPayload(db, user.id),
    projectedSub(db, user, month), openElsewhere(db, user, month), userDebt(db, user.id), browsableMonths(db, user),
  ]);
  const projected_try = planned?.amount_try ?? 0;
  const credit_cover = await creditOutlook(db, user, month, view.kalan + projected_try, credit.balance_try);
  // The IBAN is only shown to a member who actually owes something (kalan / past debt / a real unpaid item); admins always see it.
  const owes = view.kalan > 0 || debt.debt_try > 0 || (other_open ?? []).some((i) => i.id != null);
  const pay_to = admin || owes ? { iban: cfg.iban, holder: cfg.holder } : { iban: "", holder: "", hidden: true };
  return {
    ...view, items: planned ? [planned, ...view.items] : view.items, projected_try, future, other_open,
    months, receipts, pay_to,
    ...debt, // debt_try + debt_months = cumulative unpaid over all months <= current (unpaid stays in its own month)
    credit, credit_cover, // credit = what the community owes the member (all months)
  };
}

export const pickMonth = async (db, q, user) => {
  const month = q ?? currentMonth();
  if (!isMonth(month)) throw fail(400, "Geçersiz ay");
  if (!(await canBrowse(db, user, month))) throw fail(400, "Bu ay görüntülenemez");
  return month;
};

/** Raw PDF body (no multer): the whole request body IS the file. Used by the admin upload routes. */
export const rawPdf = (req, res, next) =>
  express.raw({ type: () => true, limit: MAX_PDF })(req, res, (err) =>
    err ? res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? "Dosya çok büyük (en fazla 5 MB)" : "Dosya okunamadı" }) : next());

export const bodyBuf = (req) => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

export default ({ db }) => {
  const r = Router();

  r.get("/billing", requireAuth, rateLimit({ max: 60, windowMs: 60_000, key: (req) => `billing:${req.user.id}` }), guard(async (req, res) => {
    res.json(await billingPayload(db, req.user, await pickMonth(db, req.query.month, req.user)));
  }));

  // Member self-serve upload (re-enabled 2026-09-22, admin-approval-only): a raw PDF body, no amount, no charge
  // selection. Lands as status='pending' - it affects no balance until an admin approves (POST
  // /api/admin/receipts/:id/approve, which now also accepts a pending receipt) or rejects it. Nothing automatic.
  r.post("/billing/receipts", requireAuth, rawPdf, guard(async (req, res) => {
    const month = await pickMonth(db, req.query.month, req.user); // the month being viewed (default current); bad/out of range = 400
    const id = await submitReceipt(db, req.user, { buffer: bodyBuf(req), filename: req.query.filename, month });
    res.status(201).json((await listReceipts(db, { id }))[0]);
  }));

  // "Alacaktan öde" on the member's own page (ADR 0001 #4): own alacak -> own oldest debt. No input; 409 if nothing to do.
  r.post("/billing/credit/pay", requireAuth, rateLimit({ max: 10, windowMs: 60_000, key: (req) => `creditpay:${req.user.id}` }), guard(async (req, res) => {
    const { paid_try } = await payFromCredit(db, req.user, { byMember: true });
    res.json({ paid_try });
  }));

  r.delete("/billing/receipts/:id", requireAuth, guard(async (req, res) => {
    await deleteReceipt(db, Number(req.params.id), { userId: req.user.id });
    res.json({ ok: true });
  }));

  // Member edits a rejected own upload and sends it back to review: optional new PDF body, ?message=
  r.post("/billing/receipts/:id/resubmit", requireAuth, rawPdf, guard(async (req, res) => {
    const id = Number(req.params.id);
    await resubmitReceipt(db, req.user, id, { buffer: bodyBuf(req), filename: req.query.filename, message: req.query.message });
    res.json((await listReceipts(db, { id }))[0]);
  }));

  r.get("/receipts/:id/pdf", requireAuth, guard(async (req, res) => {
    const row = (await db.execute({ sql: "SELECT user_id, pdf, filename FROM receipts WHERE id = ?", args: [Number(req.params.id)] })).rows[0];
    if (!row || !row.pdf || (row.user_id !== req.user.id && req.user.role !== "admin")) throw fail(404, "Dekont bulunamadı");
    res.set({ "content-type": "application/pdf", "content-disposition": "inline", "x-content-type-options": "nosniff", "cache-control": "private, max-age=300" });
    res.send(Buffer.from(row.pdf));
  }));

  r.use(billingAdmin({ db }));
  return r;
};
