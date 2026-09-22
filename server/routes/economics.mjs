// Admin economics: monthly costs + templates, income-vs-cost summary with fee suggestion, apply-from-next-month.
import { Router } from "express";
import { requireAdmin } from "../lib/auth.mjs";
import { fail } from "../lib/billing.mjs";
import { addCost, applySuggestion, deleteCost, deleteTemplate, DEFAULT_CATEGORIES, economicsSummary, listCosts, listTemplates, putTemplate, updateCost } from "../lib/economics.mjs";
import { currentMonth } from "../lib/tz.mjs";
import { guard } from "./billing.mjs";

export default ({ db }) => {
  const r = Router();
  r.use("/admin/economics", requireAdmin);
  r.use("/admin/costs", requireAdmin);
  r.use("/admin/cost-templates", requireAdmin);
  const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n)) throw fail(400, "Geçersiz kayıt"); return n; };

  r.get("/admin/economics", guard(async (_req, res) => res.json({ ...(await economicsSummary(db)), categories: DEFAULT_CATEGORIES })));
  r.post("/admin/economics/apply", guard(async (req, res) => res.json({ ...(await applySuggestion(db, req.body?.which)), categories: DEFAULT_CATEGORIES })));

  r.get("/admin/costs", guard(async (req, res) => res.json(await listCosts(db, req.query.month ?? currentMonth()))));
  r.post("/admin/costs", guard(async (req, res) => {
    const b = req.body ?? {};
    res.status(201).json({ id: await addCost(db, { month: b.month, category: b.category, amountTry: b.amount_try, note: b.note }) });
  }));
  r.patch("/admin/costs/:id", guard(async (req, res) => { await updateCost(db, id(req), req.body ?? {}); res.json({ ok: true }); }));
  r.delete("/admin/costs/:id", guard(async (req, res) => { await deleteCost(db, id(req)); res.json({ ok: true }); }));

  r.get("/admin/cost-templates", guard(async (_req, res) => res.json(await listTemplates(db))));
  r.put("/admin/cost-templates/:category", guard(async (req, res) => {
    await putTemplate(db, req.params.category, req.body?.amount_try);
    res.json(await listTemplates(db));
  }));
  r.delete("/admin/cost-templates/:category", guard(async (req, res) => { await deleteTemplate(db, req.params.category); res.json(await listTemplates(db)); }));

  return r;
};
