// Pure alert-age helpers (tested from server/alerts.test.mjs). Colors are never the only signal: banner also shows icon + text.
export const ESCALATE_MS = 48 * 3600_000;
/** 'warn' (amber) until an alert has been open >48h, then 'urgent' (red). */
export const severity = (raisedAt, now = Date.now()) => (now - raisedAt > ESCALATE_MS ? "urgent" : "warn");
/** { n, unit } with unit in now|min|hour|day, for tr.alerts.ago. */
export function ago(raisedAt, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - raisedAt) / 60_000));
  if (m < 1) return { n: 0, unit: "now" };
  if (m < 60) return { n: m, unit: "min" };
  if (m < 48 * 60) return { n: Math.floor(m / 60), unit: "hour" };
  return { n: Math.floor(m / 1440), unit: "day" };
}
