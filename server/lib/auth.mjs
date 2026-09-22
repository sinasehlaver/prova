import { randomBytes } from "node:crypto";

export const COOKIE = "prova_session";
export const newToken = () => randomBytes(24).toString("base64url");

const readCookie = (req, name) => {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

/** Session cookie == the user's invite_token; regenerating the token logs the old device out. */
export const authMiddleware = (db) => async (req, _res, next) => {
  const token = readCookie(req, COOKIE);
  req.user = null;
  if (token) {
    // active accounts + self-signed-up ones awaiting approval (status 'pending', active 0: they may only see /me)
    const { rows } = await db.execute({ sql: "SELECT * FROM users WHERE invite_token = ? AND (active = 1 OR status = 'pending')", args: [token] });
    if (rows[0]) req.user = rows[0];
  }
  next();
};

export const isPending = (u) => u?.status === "pending";

/** Any valid session, including a pending (not yet approved) account. Only /me uses this. */
export const requireSession = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: "Giriş gerekli" });

/** A logged-in, APPROVED user. Pending accounts get 403 on everything that uses this. */
export const requireAuth = (req, res, next) =>
  !req.user ? res.status(401).json({ error: "Giriş gerekli" })
    : isPending(req.user) ? res.status(403).json({ error: "Hesabın yönetici onayı bekliyor", pending: true })
    : next();

export const requireAdmin = (req, res, next) =>
  !req.user ? res.status(401).json({ error: "Giriş gerekli" })
    : req.user.role !== "admin" || isPending(req.user) ? res.status(403).json({ error: "Yönetici yetkisi gerekli" })
    : next();

export const clearSessionCookie = (req, res) =>
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: "lax", secure: req.secure, path: "/" });

export const setSessionCookie =(req, res, token) =>
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 400 * 24 * 3600_000, path: "/" });
