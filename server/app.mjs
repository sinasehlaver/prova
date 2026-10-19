import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { authMiddleware, setSessionCookie } from "./lib/auth.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerRoutes } from "./routes/index.mjs";
import { securityHeaders } from "./lib/security.mjs";

const DIST = join(fileURLToPath(new URL(".", import.meta.url)), "..", "web", "dist");

// CSP needs the sha256 of index.html's inline theme script (everything else is same-origin).
function inlineScriptHashes() {
  try {
    const html = readFileSync(join(DIST, "index.html"), "utf8");
    return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => createHash("sha256").update(m[1]).digest("base64"));
  } catch { return []; }
}

export function createApp({ db }) {
  const app = express();
  app.set("trust proxy", 1); // Render/Fly terminate TLS; keeps req.secure right for the cookie
  app.disable("x-powered-by");
  app.use(securityHeaders(inlineScriptHashes()));
  app.use(express.json({ limit: "1mb" }));
  app.use(authMiddleware(db));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // Invite-link login: /i/:token -> long-lived cookie -> app.
  app.get("/i/:token", async (req, res) => {
    const { rows } = await db.execute({ sql: "SELECT invite_token FROM users WHERE invite_token = ? AND (active = 1 OR status = 'pending')", args: [req.params.token] });
    if (!rows[0]) return res.redirect("/?davet=gecersiz");
    setSessionCookie(req, res, rows[0].invite_token);
    res.redirect("/");
  });

  registerRoutes(app, { db });
  app.use("/api", (_req, res) => res.status(404).json({ error: "Bulunamadı" }));

  if (existsSync(DIST)) {
    app.use(express.static(DIST));
    app.use((_req, res) => res.sendFile(join(DIST, "index.html")));
  }
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Sunucu hatası" });
  });
  return app;
}
