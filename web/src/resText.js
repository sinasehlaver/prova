// Shareable one-line text for a reservation, Istanbul time: "4 Kasım Çarşamba 18.00 - 22.00 <Not> +2".
const f = (o) => new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", ...o });
const F = { day: f({ day: "numeric" }), month: f({ month: "long" }), wd: f({ weekday: "long" }), time: f({ hour: "2-digit", minute: "2-digit", hour12: false }) };
const hm = (ms) => F.time.format(ms).replace(":", ".");
export function reservationText({ start_ms, end_ms, note, people }) {
  const parts = [F.day.format(start_ms), F.month.format(start_ms), F.wd.format(start_ms), `${hm(start_ms)} - ${hm(end_ms)}`];
  if (note && note.trim()) parts.push(note.trim());
  if (people > 0) parts.push(`+${people}`);
  return parts.join(" ");
}
