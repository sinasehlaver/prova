import { Router } from "express";
import { clearSessionCookie, newToken, requireAuth, requireSession, setSessionCookie } from "../lib/auth.mjs";
import { currentMonth } from "../lib/tz.mjs";

export const publicUser = ({ id, name, phone, role, active, status, joined_month }) => ({ id, name, phone, role, active: !!active, status: status ?? "approved", joined_month });

const SIGNUP_WINDOW = 10 * 60_000, SIGNUP_PER_IP = 5, MAX_PENDING = 50;

/** Shared name/phone validation (own profile + signup). Returns { error } or { name, phone }. */
export const cleanProfile = (b) => {
  const name = String(b?.name ?? "").trim();
  const phone = String(b?.phone ?? "").trim();
  if (!name) return { error: "İsim gerekli" };
  if (name.length > 80) return { error: "İsim çok uzun" };
  if (phone.length > 30 || /[^\d+()\s.-]/.test(phone)) return { error: "Geçersiz telefon" };
  return { name, phone: phone || null };
};

export default ({ db }) => {
  const r = Router();
  // /me also answers for a pending (unapproved) account - that is how the web shows "Onay bekleniyor".
  r.get("/me", requireSession, (req, res) => res.json(publicUser(req.user)));

  // Public self-signup: creates a PENDING account (active 0 until an admin approves) and logs the browser in with it.
  // Light abuse guard: 5 signups / 10 min / IP (in-memory, per process) and at most 50 accounts waiting at once.
  const hits = new Map();
  r.post("/signup", async (req, res) => {
    if (req.user) return res.status(409).json({ error: "Zaten giriş yaptın" });
    const now = Date.now();
    const recent = (hits.get(req.ip) || []).filter((t) => now - t < SIGNUP_WINDOW);
    if (recent.length >= SIGNUP_PER_IP) return res.status(429).json({ error: "Çok fazla deneme. Biraz sonra tekrar dene." });
    const c = cleanProfile(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    const waiting = (await db.execute("SELECT COUNT(*) n FROM users WHERE status = 'pending'")).rows[0].n;
    if (waiting >= MAX_PENDING) return res.status(429).json({ error: "Şu an yeni kayıt alınamıyor. Yöneticiyle iletişime geç." });
    hits.set(req.ip, [...recent, now]);
    const token = newToken();
    const { lastInsertRowid } = await db.execute({
      sql: "INSERT INTO users (name, phone, role, invite_token, active, status, joined_month, created_at) VALUES (?,?,?,?,?,?,?,?)",
      args: [c.name, c.phone, "member", token, 0, "pending", currentMonth(), now],
    });
    setSessionCookie(req, res, token);
    const u = (await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [lastInsertRowid] })).rows[0];
    res.status(201).json(publicUser(u));
  });

  // own profile only: name (required) + phone. Role / active / joined_month are never client-settable here.
  r.patch("/me", requireAuth, async (req, res) => {
    const c = cleanProfile(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    await db.execute({ sql: "UPDATE users SET name = ?, phone = ? WHERE id = ?", args: [c.name, c.phone, req.user.id] });
    res.json(publicUser({ ...req.user, name: c.name, phone: c.phone }));
  });

  // The cookie IS users.invite_token: logging out only drops the cookie, the token (= the /i/ link) stays valid.
  r.post("/logout", (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });
  return r;
};
