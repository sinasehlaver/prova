import { Router } from "express";
import { clearSessionCookie, isBootstrap, newToken, requireAuth, requireSession, setSessionCookie, hashPassword, verifyPassword, normEmail } from "../lib/auth.mjs";
import { currentMonth } from "../lib/tz.mjs";

export const publicUser = ({ id, name, phone, role, active, status, joined_month, email }) => ({ id, name, phone, role, active: !!active, status: status ?? "approved", joined_month, email });

const SIGNUP_WINDOW = 10 * 60_000, SIGNUP_PER_IP = 5, MAX_PENDING = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Shared name/phone validation (own profile + signup). Returns { error } or { name, phone }. */
export const cleanProfile = (b) => {
  const name = String(b?.name ?? "").trim();
  const phone = String(b?.phone ?? "").trim();
  if (!name) return { error: "İsim gerekli" };
  if (name.length > 80) return { error: "İsim çok uzun" };
  if (phone.length > 30 || /[^\d+()\s.-]/.test(phone)) return { error: "Geçersiz telefon" };
  return { name, phone: phone || null };
};

/** Validate signup body: name, email, password, optional phone. Returns { error } or { name, email, password, phone }. */
export const cleanSignup = (b) => {
  const profile = cleanProfile(b);
  if (profile.error) return { error: profile.error };
  const email = normEmail(b?.email);
  if (!email || !EMAIL_RE.test(email)) return { error: "Geçerli bir e-posta gerekli" };
  const password = String(b?.password ?? "");
  if (password.length < 8) return { error: "Şifre en az 8 karakter olmalı" };
  if (password.length > 128) return { error: "Şifre çok uzun" };
  return { name: profile.name, email, password, phone: profile.phone };
};

/** Validate login body: email, password. Returns { error } or { email, password }. */
export const cleanLogin = (b) => {
  const email = normEmail(b?.email);
  if (!email || !EMAIL_RE.test(email)) return { error: "Geçerli bir e-posta gerekli" };
  const password = String(b?.password ?? "");
  if (!password) return { error: "Şifre gerekli" };
  return { email, password };
};

export default ({ db }) => {
  const r = Router();

  // /me also answers for a pending (unapproved) account - that is how the web shows "Onay bekleniyor".
  // observer = "you are the bootstrap admin" (can't book, not billed). Only ever in the caller's OWN /me.
  r.get("/me", requireSession, async (req, res) => res.json({ ...publicUser(req.user), observer: await isBootstrap(db, req.user) }));

  // Public self-signup: creates a PENDING account (active 0 until an admin approves) and logs the browser in with it.
  // Requires: name, email, password, optional phone.
  // Light abuse guard: 5 signups / 10 min / IP (in-memory, per process) and at most 50 accounts waiting at once.
  const hits = new Map();
  r.post("/signup", async (req, res) => {
    if (req.user) return res.status(409).json({ error: "Zaten giriş yaptın" });
    const now = Date.now();
    const recent = (hits.get(req.ip) || []).filter((t) => now - t < SIGNUP_WINDOW);
    if (recent.length >= SIGNUP_PER_IP) return res.status(429).json({ error: "Çok fazla deneme. Biraz sonra tekrar dene." });
    const c = cleanSignup(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    const waiting = (await db.execute("SELECT COUNT(*) n FROM users WHERE status = 'pending'")).rows[0].n;
    if (waiting >= MAX_PENDING) return res.status(429).json({ error: "Şu an yeni kayıt alınamıyor. Yöneticiyle iletişime geç." });
    // Check email uniqueness among pending/approved
    const existing = (await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [c.email] })).rows[0];
    if (existing) return res.status(409).json({ error: "Bu e-posta zaten kayıtlı" });
    hits.set(req.ip, [...recent, now]);
    const token = newToken();
    const passwordHash = await hashPassword(c.password);
    const { lastInsertRowid } = await db.execute({
      sql: "INSERT INTO users (name, phone, email, password_hash, role, invite_token, active, status, joined_month, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [c.name, c.phone, c.email, passwordHash, "member", token, 0, "pending", currentMonth(), now],
    });
    setSessionCookie(req, res, token);
    const u = (await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [lastInsertRowid] })).rows[0];
    res.status(201).json(publicUser(u));
  });

  // Credential login: email + password -> sets session cookie (invite_token)
  // Works for approved users only. Pending users cannot log in with credentials (they use the session from signup).
  r.post("/login", async (req, res) => {
    if (req.user) return res.status(409).json({ error: "Zaten giriş yaptın" });
    const c = cleanLogin(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    const { rows } = await db.execute({ sql: "SELECT * FROM users WHERE email = ? AND active = 1 AND status = 'approved'", args: [c.email] });
    const user = rows[0];
    if (!user || !user.password_hash) return res.status(401).json({ error: "E-posta veya şifre yanlış" });
    const ok = await verifyPassword(c.password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "E-posta veya şifre yanlış" });
    setSessionCookie(req, res, user.invite_token);
    res.json({ ...publicUser(user), observer: await isBootstrap(db, user) }); // same shape as /me (own account)
  });

  // own profile only: name (required) + phone. Role / active / joined_month / email / password are never client-settable here.
  r.patch("/me", requireAuth, async (req, res) => {
    const c = cleanProfile(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    await db.execute({ sql: "UPDATE users SET name = ?, phone = ? WHERE id = ?", args: [c.name, c.phone, req.user.id] });
    res.json(publicUser({ ...req.user, name: c.name, phone: c.phone }));
  });

  // Change own password (requires current password)
  r.post("/me/password", requireAuth, async (req, res) => {
    const current = String(req.body?.current_password ?? "");
    const next = String(req.body?.new_password ?? "");
    if (!current || !next) return res.status(400).json({ error: "Mevcut ve yeni şifre gerekli" });
    if (next.length < 8) return res.status(400).json({ error: "Yeni şifre en az 8 karakter olmalı" });
    const { rows } = await db.execute({ sql: "SELECT password_hash FROM users WHERE id = ?", args: [req.user.id] });
    if (!rows[0]?.password_hash) return res.status(400).json({ error: "Bu hesap şifre ile giriş yapmıyor" });
    const ok = await verifyPassword(current, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: "Mevcut şifre yanlış" });
    const hash = await hashPassword(next);
    await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [hash, req.user.id] });
    res.json({ ok: true });
  });

  // The cookie IS users.invite_token: logging out only drops the cookie, the token (= the /i/ link) stays valid.
  r.post("/logout", (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  return r;
};