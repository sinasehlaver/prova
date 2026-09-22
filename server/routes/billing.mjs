// Member billing (own data only - there is no user_id parameter here) + receipt PDF download (owner or admin).
// Admin billing endpoints live in billing-admin.mjs and are mounted from here (keeps ROUTES to one line).
import express, { Router } from "express";
import { requireAuth } from "../lib/auth.mjs";
import { browsableMonths, ensureMonth, fail, isMonth, monthView } from "../lib/billing.mjs";
import { creditPayload } from "../lib/credits.mjs";
import { getSettings, listReceipts, MAX_PDF } from "../lib/payments.mjs";
import { currentMonth } from "../lib/tz.mjs";
import billingAdmin from "./billing-admin.mjs";

// domain errors carry .status; anything else -> global 500 handler
export const guard = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { e.status ? res.status(e.status).json({ error: e.message }) : next(e); }
};

/** Month view + where to pay + this month's receipts for one user. Shared with the admin per-user view. */
export async function billingPayload(db, user, month) {
  await ensureMonth(db, user, month);
  const [view, receipts, cfg, credit] = await Promise.all([monthView(db, user.id, month), listReceipts(db, { userId: user.id, month }), getSettings(db), creditPayload(db, user.id)]);
  return { ...view, months: browsableMonths(user), receipts, pay_to: { iban: cfg.iban, holder: cfg.holder }, credit }; // credit = what the community owes the member (all months)
}

export const pickMonth = (q, user) => {
  const month = q ?? currentMonth();
  if (!isMonth(month)) throw fail(400, "Geçersiz ay");
  if (month > currentMonth() || month < user.joined_month) throw fail(400, "Bu ay için ödeme kalemi yok");
  return month;
};

/** Raw PDF body (no multer): the whole request body IS the file. Used by the admin upload routes. */
export const rawPdf = (req, res, next) =>
  express.raw({ type: () => true, limit: MAX_PDF })(req, res, (err) =>
    err ? res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? "Dosya çok büyük (en fazla 5 MB)" : "Dosya okunamadı" }) : next());

export const bodyBuf = (req) => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

export default ({ db }) => {
  const r = Router();

  r.get("/billing", requireAuth, guard(async (req, res) => {
    res.json(await billingPayload(db, req.user, pickMonth(req.query.month, req.user)));
  }));

  // Self-serve member upload is SWITCHED OFF (2026-09-22): payments are recorded by an admin
  // (POST /api/admin/users/:id/receipts). Kept as an explicit gate so old clients get a Turkish reason, not a 404.
  r.post("/billing/receipts", requireAuth, guard(async () => {
    throw fail(403, "Dekont yükleme kapatıldı. Dekontunu yöneticine ilet, ödemeni o kaydeder.");
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
