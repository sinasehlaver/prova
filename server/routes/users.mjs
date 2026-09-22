import { Router } from "express";
import { requireAdmin, newToken, setSessionCookie } from "../lib/auth.mjs";
import { currentMonth } from "../lib/tz.mjs";

// The list never carries invite_token (= the session secret; the UI no longer hands out links). Only the one-shot
// responses of "create member" / "regenerate" include it, so an admin-created member (or a script) can still get a /i/ link.
const adminUser = ({ id, name, phone, role, active, status, joined_month, invite_token }, withToken = false) =>
  ({ id, name, phone, role, active: !!active, status, pending: status === "pending", joined_month, ...(withToken ? { invite_token } : {}) });

export default ({ db }) => {
  const r = Router();
  r.use("/users", requireAdmin);
  const byId = async (id) => (await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [id] })).rows[0];

  r.get("/users", async (_req, res) => {
    const { rows } = await db.execute("SELECT * FROM users ORDER BY (status = 'pending') DESC, active DESC, role, name COLLATE NOCASE");
    res.json(rows.map((u) => adminUser(u)));
  });

  r.post("/users", async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "İsim gerekli" });
    const role = req.body?.role === "admin" ? "admin" : "member";
    const phone = String(req.body?.phone ?? "").trim() || null;
    const joined = /^\d{4}-\d{2}$/.test(req.body?.joined_month) ? req.body.joined_month : currentMonth();
    const { lastInsertRowid } = await db.execute({
      sql: "INSERT INTO users (name, phone, role, invite_token, joined_month, created_at) VALUES (?,?,?,?,?,?)",
      args: [name, phone, role, newToken(), joined, Date.now()],
    });
    res.status(201).json(adminUser(await byId(lastInsertRowid), true));
  });

  r.post("/users/:id/regenerate-invite", async (req, res) => {
    const u = await byId(req.params.id);
    if (!u) return res.status(404).json({ error: "Bulunamadı" });
    await db.execute({ sql: "UPDATE users SET invite_token = ? WHERE id = ?", args: [newToken(), u.id] });
    const n = await byId(u.id);
    if (u.id === req.user.id) setSessionCookie(req, res, n.invite_token); // regenerating your own token must not log you out
    res.json(adminUser(n, true));
  });

  // Self-signup queue: approve = becomes a normal active member (joined this month); reject = the pending account is deleted
  // (it can't own any data: every app API is 403 for it).
  r.post("/users/:id/approve", async (req, res) => {
    const u = await byId(req.params.id);
    if (!u) return res.status(404).json({ error: "Bulunamadı" });
    if (u.status !== "pending") return res.status(409).json({ error: "Bu hesap onay bekleyen bir kayıt değil" });
    await db.execute({ sql: "UPDATE users SET status = 'approved', active = 1, joined_month = ? WHERE id = ?", args: [currentMonth(), u.id] });
    res.json(adminUser(await byId(u.id)));
  });

  r.post("/users/:id/reject", async (req, res) => {
    const u = await byId(req.params.id);
    if (!u) return res.status(404).json({ error: "Bulunamadı" });
    if (u.status !== "pending") return res.status(409).json({ error: "Bu hesap onay bekleyen bir kayıt değil" });
    await db.execute({ sql: "DELETE FROM users WHERE id = ? AND status = 'pending'", args: [u.id] });
    res.json({ ok: true });
  });

  r.patch("/users/:id", async (req, res) => {
    const u = await byId(req.params.id);
    if (!u) return res.status(404).json({ error: "Bulunamadı" });
    const b = req.body ?? {};
    if (u.status === "pending") return res.status(409).json({ error: "Önce onayla ya da reddet" });
    if (b.active === false && u.id === req.user.id) return res.status(400).json({ error: "Kendini pasifleştiremezsin" });
    await db.execute({
      sql: "UPDATE users SET active = ?, name = ?, phone = ? WHERE id = ?",
      args: [b.active === undefined ? u.active : b.active ? 1 : 0, b.name?.trim() || u.name, b.phone === undefined ? u.phone : String(b.phone).trim() || null, u.id],
    });
    res.json(adminUser(await byId(u.id)));
  });

  return r;
};
