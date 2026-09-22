// Europe/Istanbul is fixed UTC+3 (no DST since 2016). Store UTC ms; format with Intl.
export const TZ = "Europe/Istanbul";
export const OFFSET_MS = 3 * 3600_000;
const fmt = (opts) => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, ...opts });
export const fmtDateTime = (ms) => fmt({ dateStyle: "medium", timeStyle: "short" }).format(ms);
/** 'YYYY-MM' of a UTC-ms instant in Istanbul time. */
export const monthOf = (ms) => new Date(ms + OFFSET_MS).toISOString().slice(0, 7);
export const currentMonth = () => monthOf(Date.now());
