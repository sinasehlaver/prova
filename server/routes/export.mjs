// GET /api/admin/export?format=json|csv[&pdf=1] — admin-only backup download (attachment).
import { Router } from "express";
import { requireAdmin } from "../lib/auth.mjs";
import { buildExport, chargesCsv } from "../lib/export.mjs";

export default ({ db }) => {
  const r = Router();
  r.get("/admin/export", requireAdmin, async (req, res) => {
    const data = await buildExport(db, { includePdf: req.query.pdf === "1" });
    const stamp = data.exported_at.slice(0, 10);
    res.set("cache-control", "no-store");
    if (req.query.format === "csv") {
      res.set({ "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="prova-odemeler-${stamp}.csv"` });
      return res.send(chargesCsv(data));
    }
    res.set({ "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="prova-yedek-${stamp}.json"` });
    res.send(JSON.stringify(data, null, 2));
  });
  return r;
};
