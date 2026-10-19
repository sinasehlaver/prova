// Response hardening: no caching of API data (IBAN, billing), no indexing, no framing, strict CSP for the app shell.
export const securityHeaders = (scriptHashes = []) => {
  const csp = [
    "default-src 'self'",
    `script-src 'self'${scriptHashes.map((h) => ` 'sha256-${h}'`).join("")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'self'", "frame-src 'self'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
  return (req, res, next) => {
    res.set({
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow, noarchive",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "cross-origin-opener-policy": "same-origin",
    });
    if (req.secure) res.set("strict-transport-security", "max-age=31536000");
    if (req.path.startsWith("/api") || req.path.startsWith("/i/")) res.set("cache-control", "no-store"); // routes may override (receipt pdf: private)
    else res.set("content-security-policy", csp); // not on API/PDF responses (breaks Chrome's PDF viewer)
    if (req.path === "/robots.txt") return res.type("text/plain").send("User-agent: *\nDisallow: /\n");
    next();
  };
};
