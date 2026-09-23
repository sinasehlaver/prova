import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { subtle } from "node:crypto";

export const COOKIE = "prova_session";
export const newToken = () => randomBytes(24).toString("base64url");

const readCookie = (req, name) => {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

/** Hash a password using PBKDF2 (Web Crypto API, no deps). Returns "pbkdf2$iterations$salt$hash" (base64url). */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const iterations = 120_000;
  const key = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  const hash = Buffer.from(bits).toString("base64url");
  return `pbkdf2$${iterations}$${Buffer.from(salt).toString("base64url")}$${hash}`;
}

/** Verify a password against a stored hash. Returns true/false. */
export async function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.startsWith("pbkdf2$")) return false;
  const parts = storedHash.split("$");
  if (parts.length !== 4) return false;
  const [, iterationsStr, saltB64, hashB64] = parts;
  const iterations = Number(iterationsStr);
  if (!iterations || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, "base64url");
  const expectedHash = Buffer.from(hashB64, "base64url");
  try {
    const key = await subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );
    const bits = await subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      key,
      256
    );
    const actualHash = Buffer.from(bits);
    return timingSafeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
}

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

export const setSessionCookie = (req, res, token) =>
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 400 * 24 * 3600_000, path: "/" });

/**
 * Bootstrap admin = the very first user ever created (lowest id, inserted by seed.mjs at first boot; its /i/ link is
 * logged once). It is an OBSERVER account, not a member: hidden from everyone else's lists, never billed (no rent,
 * excluded from every money aggregate), can't reserve/hold, but has full admin read access and can promote others.
 * Identity is "lowest id", so it depends on which row the seed inserted first - see BOOTSTRAP-ADMIN.md.
 */
export const BOOTSTRAP_ID_SQL = "(SELECT MIN(id) FROM users)";
export const bootstrapId = async (db) => (await db.execute(`SELECT ${BOOTSTRAP_ID_SQL} AS id`)).rows[0]?.id ?? null;
export const isBootstrap = async (db, user) => user?.id != null && user.id === (await bootstrapId(db));
/** What others see instead of the bootstrap admin's name where it can surface as an actor (alerts, cancel audit). */
export const OBSERVER_NAME = "Yönetici";

/** Normalize email for case-insensitive comparison. */
export const normEmail = (e) => String(e ?? "").trim().toLowerCase();