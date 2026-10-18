// Europe/Istanbul is fixed UTC+3 (no DST since 2016). Store UTC ms; format with Intl.
export const TZ = "Europe/Istanbul";
export const OFFSET_MS = 3 * 3600_000;
/** Earliest instant anything can be booked/held/browsed: 2025-01-01 00:00 Istanbul. Web reads it from /reservations/config (earliest_ms). */
export const EARLIEST_MS = Date.UTC(2025, 0, 1) - OFFSET_MS;
export const EARLIEST_DATE = "2025-01-01";
/** No reservation may end after 22:00 Istanbul (noise). */
export const LAST_END_HOUR = 22;
/** True when [startMs, startMs + hours h) ends by 22:00 Istanbul on the start's day. */
export const endsByCurfew = (startMs, endMs) => {
  const dayStart = Math.floor((startMs + OFFSET_MS) / 86400_000) * 86400_000 - OFFSET_MS;
  return endMs <= dayStart + LAST_END_HOUR * 3600_000;
};
export const CURFEW_MSG = `Saat ${LAST_END_HOUR}:00'den sonra rezervasyon yapılamaz (gürültü nedeniyle)`;
const fmt = (opts) => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, ...opts });
export const fmtDateTime = (ms) => fmt({ dateStyle: "medium", timeStyle: "short" }).format(ms);
/** 'YYYY-MM' of a UTC-ms instant in Istanbul time. */
export const monthOf = (ms) => new Date(ms + OFFSET_MS).toISOString().slice(0, 7);
export const currentMonth = () => monthOf(Date.now());
