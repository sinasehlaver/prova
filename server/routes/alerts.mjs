import { Router } from "express";
import { BOOTSTRAP_ID_SQL, OBSERVER_NAME, requireAdmin, requireAuth } from "../lib/auth.mjs";

// The bootstrap (observer) admin stays anonymous: its name is shown as "Yönetici" to everyone.
const nameOf = (col, alias) => `CASE WHEN ${col} = ${BOOTSTRAP_ID_SQL} THEN '${OBSERVER_NAME}' ELSE ${alias}.name END`;
const SELECT = `SELECT a.id, a.kind_id, k.key, k.label_problem, k.label_resolved, k.icon,
  a.raised_by, ${nameOf("a.raised_by", "ru")} AS raised_by_name, a.raised_at, a.closed_by, ${nameOf("a.closed_by", "cu")} AS closed_by_name, a.closed_at
  FROM alerts a JOIN alert_kinds k ON k.id = a.kind_id JOIN users ru ON ru.id = a.raised_by LEFT JOIN users cu ON cu.id = a.closed_by`;

const slug = (s) => s.toLocaleLowerCase("tr").replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "tur";
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });
const text = (v) => (typeof v === "string" ? v.trim() : "");

export default ({ db }) => {
  const r = Router();
  r.use("/alerts", requireAuth);
  const one = async (sql, args = []) => (await db.execute({ sql, args })).rows[0];
  const alertById = (id) => one(`${SELECT} WHERE a.id = ?`, [id]);
  const openOf = (kindId) => one(`${SELECT} WHERE a.kind_id = ? AND a.closed_at IS NULL`, [kindId]);

  r.get("/alerts", async (_req, res) => {
    res.json((await db.execute(`${SELECT} WHERE a.closed_at IS NULL ORDER BY a.raised_at`)).rows);
  });

  r.get("/alerts/kinds", async (_req, res) => {
    res.json((await db.execute("SELECT id, key, label_problem, label_resolved, icon, sort FROM alert_kinds ORDER BY sort, id")).rows);
  });

  r.get("/alerts/history", async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const before = parseInt(req.query.before) || Number.MAX_SAFE_INTEGER; // cursor: last id of previous page
    res.json((await db.execute({ sql: `${SELECT} WHERE a.id < ? ORDER BY a.id DESC LIMIT ?`, args: [before, limit] })).rows);
  });

  // Idempotent: an already-open alert of that kind is returned as-is (200). Race: the partial unique index rejects the loser's insert.
  r.post("/alerts", async (req, res) => {
    const kindId = Number(req.body?.kind_id);
    if (!(await one("SELECT 1 FROM alert_kinds WHERE id = ?", [kindId]))) return bad(res, "Uyarı türü bulunamadı", 404);
    const existing = await openOf(kindId);
    if (existing) return res.json(existing);
    try {
      const { lastInsertRowid } = await db.execute({ sql: "INSERT INTO alerts (kind_id, raised_by, raised_at) VALUES (?,?,?)", args: [kindId, req.user.id, Date.now()] });
      res.status(201).json(await alertById(lastInsertRowid));
    } catch (e) {
      const other = /UNIQUE|constraint/i.test(String(e?.message)) && (await openOf(kindId));
      if (!other) throw e;
      res.json(other);
    }
  });

  r.post("/alerts/:id/close", async (req, res) => {
    const id = Number(req.params.id);
    if (!(await alertById(id))) return bad(res, "Bulunamadı", 404);
    await db.execute({ sql: "UPDATE alerts SET closed_by = ?, closed_at = ? WHERE id = ? AND closed_at IS NULL", args: [req.user.id, Date.now(), id] });
    res.json(await alertById(id)); // already closed by someone else -> unchanged, still 200
  });

  // ---- admin: kinds ----
  const kindById = (id) => one("SELECT id, key, label_problem, label_resolved, icon, sort FROM alert_kinds WHERE id = ?", [id]);

  r.post("/alerts/kinds", requireAdmin, async (req, res) => {
    const b = req.body ?? {};
    const [p, ok, icon] = [text(b.label_problem), text(b.label_resolved), text(b.icon)];
    if (!p || !ok || !icon) return bad(res, "Ad, çözüm metni ve simge gerekli");
    const { rows } = await db.execute("SELECT key, sort FROM alert_kinds");
    const keys = new Set(rows.map((x) => x.key));
    let key = slug(p);
    for (let i = 2; keys.has(key); i++) key = `${slug(p)}-${i}`;
    const { lastInsertRowid } = await db.execute({
      sql: "INSERT INTO alert_kinds (key,label_problem,label_resolved,icon,sort) VALUES (?,?,?,?,?)",
      args: [key, p, ok, icon, Math.max(-1, ...rows.map((x) => x.sort)) + 1],
    });
    res.status(201).json(await kindById(lastInsertRowid));
  });

  r.post("/alerts/kinds/reorder", requireAdmin, async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every(Number.isInteger)) return bad(res, "Geçersiz sıra");
    await db.batch(ids.map((id, i) => ({ sql: "UPDATE alert_kinds SET sort = ? WHERE id = ?", args: [i, id] })));
    res.json((await db.execute("SELECT id, key, label_problem, label_resolved, icon, sort FROM alert_kinds ORDER BY sort, id")).rows);
  });

  r.patch("/alerts/kinds/:id", requireAdmin, async (req, res) => {
    const k = await kindById(Number(req.params.id));
    if (!k) return bad(res, "Bulunamadı", 404);
    const b = req.body ?? {};
    await db.execute({
      sql: "UPDATE alert_kinds SET label_problem = ?, label_resolved = ?, icon = ? WHERE id = ?",
      args: [text(b.label_problem) || k.label_problem, text(b.label_resolved) || k.label_resolved, text(b.icon) || k.icon, k.id],
    });
    res.json(await kindById(k.id));
  });

  // No `active` column (schema stays as-is): kinds with history can't be removed, only renamed.
  r.delete("/alerts/kinds/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!(await kindById(id))) return bad(res, "Bulunamadı", 404);
    if (await one("SELECT 1 FROM alerts WHERE kind_id = ?", [id])) return bad(res, "Geçmişi olan tür silinemez; adını düzenleyebilirsin", 409);
    await db.execute({ sql: "DELETE FROM alert_kinds WHERE id = ?", args: [id] });
    res.json({ ok: true });
  });

  return r;
};
