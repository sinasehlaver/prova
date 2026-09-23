import { Router } from "express";
import { bootstrapId, requireAdmin, newToken, setSessionCookie, normEmail } from "../lib/auth.mjs";
import { currentMonth } from "../lib/tz.mjs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The list never carries invite_token (= the session secret; the UI no longer hands out links). Only the one-shot
// responses of "create member" / "regenerate" include it, so an admin-created member (or a script) can still get a /i/ link.
const adminUser = ({ id, name, phone, email, role, active, status, joined_month, invite_token }, withToken = false) =>
  ({ id, name, phone, email, role, active: !!active, status, pending: status === "pending", joined_month, ...(withToken ? { invite_token } : {}) });

export default ({ db }) => {
  const r = Router();
  r.use("/users", requireAdmin);
  // The bootstrap admin is invisible to every OTHER admin here too: a lookup of its id by someone else is a 404, so a
  // later-promoted admin can't demote / deactivate it or (worse) regenerate its invite token = take over its session.
  const byId = async (id, req) => {
    const u = (await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [id] })).rows[0];
    if (u && req && u.id !== req.user.id && u.id === (await bootstrapId(db))) return undefined;
    return u;
  };

  // The bootstrap admin (lowest id, created by seed.mjs at first boot) is hidden from the Üyeler list for every OTHER
  // user (member or admin) — they still see themselves when they view the list. Their own /me, login, requireAdmin,
  // etc. are untouched.
  r.get("/users", async (req, res) => {
    const bid = await bootstrapId(db);
    const self = req.user.id === bid;
    const { rows } = await db.execute({
      sql: "SELECT * FROM users" + (self ? "" : " WHERE id <> ?") +
        " ORDER BY (status = 'pending') DESC, active DESC, role, name COLLATE NOCASE",
      args: self ? [] : [bid],
    });
    res.json(rows.map((u) => adminUser(u)));
  });

  r.post("/users", async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "İsim gerekli" });
    const role = req.body?.role === "admin" ? "admin" : "member";
    const phone = String(req.body?.phone ?? "").trim() || null;
    const email = req.body?.email ? normEmail(req.body.email) : null;
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "Geçersiz e-posta" });
    if (email) {
      const existing = (await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] })).rows[0];
      if (existing) return res.status(409).json({ error: "Bu e-posta zaten kayıtlı" });
    }
    const joined = /^\d{4}-\d{2}$/.test(req.body?.joined_month) ? req.body.joined_month : currentMonth();
    const { lastInsertRowid } = await db.execute({
      sql: "INSERT INTO users (name, phone, email, role, invite_token, joined_month, created_at) VALUES (?,?,?,?,?,?,?)",
      args: [name, phone, email, role, newToken(), joined, Date.now()],
    });
    res.status(201).json(adminUser(await byId(lastInsertRowid), true));
  });

  r.post("/users/:id/regenerate-invite", async (req, res) => {
    const u = await byId(req.params.id, req);
    if (!u) return res.status(404).json({ error: "Bulunamadı" });
    await db.execute({ sql: "UPDATE users SET invite_token = ? WHERE id = ?", args: [newToken(), u.id] });
    const n = await byId(u.id);
    if (u.id === req.user.id) setSessionCookie(req, res, n.invite_token); // regenerating your own token must not log you out
    res.json(adminUser(n, true));
  });

  // Self-signup queue: approve = becomes a normal active member (joined this month); reject = the pending account is deleted
  // (it can't own any data: every app API is 403 for it).
  r.post("/users/:id/approve", async (req, res) => {
    const u = await byId(req.params.id, req);
    if (!u) return res.status(404).json({ error: "Bulunamadı" });
    if (u.status !== "pending") return res.status(409).json({ error: "Bu hesap onay bekleyen bir kayıt değil" });
    await db.execute({ sql: "UPDATE users SET status = 'approved', active = 1, joined_month = ? WHERE id = ?", args: [currentMonth(), u.id] });
    res.json(adminUser(await byId(u.id)));
  });

  r.post("/users/:id/reject", async (req, res) => {
    const u = await byId(req.params.id, req);
    if (!u) return res.status(404).json({ error: "Bulunamadı" });
    if (u.status !== "pending") return res.status(409).json({ error: "Bu hesap onay bekleyen bir kayıt değil" });
    await db.execute({ sql: "DELETE FROM users WHERE id = ? AND status = 'pending'", args: [u.id] });
    res.json({ ok: true });
  });

  r.patch("/users/:id", async (req, res) => {
    const u = await byId(req.params.id, req);
    if (!u) return res.status(404).json({ error: "Bulunamadı" });
    const b = req.body ?? {};
    if (u.status === "pending") return res.status(409).json({ error: "Önce onayla ya da reddet" });
    if (b.active === false && u.id === req.user.id) return res.status(400).json({ error: "Kendini pasifleştiremezsin" });

    // Allow role change (admin can promote/demote)
    let newRole = u.role;
    if (b.role === "admin" || b.role === "member") {
      if (u.id === req.user.id && b.role !== "admin") return res.status(400).json({ error: "Kendini adminlikten kaldıramazsın" });
      newRole = b.role;
    }

    // Allow email change (with uniqueness check)
    let newEmail = u.email;
    if (b.email !== undefined) {
      const email = b.email ? normEmail(b.email) : null;
      if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "Geçersiz e-posta" });
      if (email && email !== u.email) {
        const existing = (await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] })).rows[0];
        if (existing) return res.status(409).json({ error: "Bu e-posta zaten kayıtlı" });
      }
      newEmail = email;
    }

    await db.execute({
      sql: "UPDATE users SET active = ?, name = ?, phone = ?, role = ?, email = ? WHERE id = ?",
      args: [
        b.active === undefined ? u.active : b.active ? 1 : 0,
        b.name?.trim() || u.name,
        b.phone === undefined ? u.phone : String(b.phone).trim() || null,
        newRole,
        newEmail,
        u.id,
      ],
    });
    res.json(adminUser(await byId(u.id)));
  });

  return r;
};