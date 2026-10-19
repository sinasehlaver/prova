// In-memory sliding-window limiter (per process, like the signup guard). Fine for one Render instance.
const buckets = new Map();
let lastSweep = 0;
const sweep = (now) => {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (!b.some((t) => now - t < b.windowMs)) buckets.delete(k);
};

/** Count one hit for `key`; returns true when it is over `max` within `windowMs`. */
export function hit(key, { max, windowMs }) {
  const now = Date.now();
  sweep(now);
  const b = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  b.windowMs = windowMs;
  if (b.length >= max) { buckets.set(key, b); return true; }
  b.push(now);
  buckets.set(key, b);
  return false;
}

/** Non-counting check (used for failed-login limiting: count only failures). */
export const isLimited = (key, { max, windowMs }) => {
  const now = Date.now();
  return (buckets.get(key) ?? []).filter((t) => now - t < windowMs).length >= max;
};
export const record = (key, windowMs) => {
  const b = (buckets.get(key) ?? []).filter((t) => Date.now() - t < windowMs);
  b.windowMs = windowMs;
  b.push(Date.now());
  buckets.set(key, b);
};
export const clear = (key) => buckets.delete(key);

export const rateLimit = ({ max, windowMs, key }) => (req, res, next) =>
  hit(key(req), { max, windowMs }) ? res.status(429).json({ error: "Çok fazla istek. Biraz sonra tekrar dene." }) : next();
