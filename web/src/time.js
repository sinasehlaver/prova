// Client-side Istanbul time (fixed UTC+3, mirrors server/lib/tz.mjs). All instants are UTC ms.
export const H = 3600_000;
export const D = 24 * H;
const OFF = 3 * H;
const f = (o) => new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", ...o });
const F = {
  time: f({ hour: "2-digit", minute: "2-digit", hour12: false }),
  wd: f({ weekday: "short" }),
  day: f({ day: "numeric" }),
  long: f({ weekday: "long", day: "numeric", month: "long" }),
  short: f({ day: "numeric", month: "short" }),
};
export const dayStart = (ms) => Math.floor((ms + OFF) / D) * D - OFF;
/** Monday 00:00 (Istanbul) of the week containing ms. */
export const weekStart = (ms) => dayStart(ms) - ((new Date(dayStart(ms) + OFF).getUTCDay() + 6) % 7) * D;
export const fmtTime = (ms) => F.time.format(ms);
export const fmtWd = (ms) => F.wd.format(ms);
export const fmtDay = (ms) => F.day.format(ms);
export const fmtLong = (ms) => F.long.format(ms);
export const fmtShort = (ms) => F.short.format(ms);
export const hourLabel = (h) => String(h).padStart(2, "0") + ":00";
