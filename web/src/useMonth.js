import { useRef, useState } from "react";
import { kvGet, kvSet } from "./nav.js";

/** Month-switch loader for the billing views (member Billing, admin UserDetail). `fetchMonth(month?)` -> payload with
 *  `.month`. The MonthNav shows the picked month at once (`shown`), the page dims while it loads (`pending`), a month
 *  seen before renders from cache while it refreshes, and a slower older response never overwrites a newer pick.
 *  `fresh(d)` = poll guard: true only if `d` is for the month currently wanted. */
export default function useMonth(fetchMonth, key) {
  // `key` = remember the picked month across tab switches / reloads (nav.js kv). A remembered month that fails to load is dropped.
  const [data, setData] = useState(null);
  const [pending, setPending] = useState(null);
  const seq = useRef(0), want = useRef(null), cache = useRef(new Map());
  const keep = (d) => { cache.current.set(d.month, d); setData(d); if (key) kvSet(key, d.month); };
  const load = async (month) => {
    const first = month == null && key && !seq.current ? kvGet(key) : null;
    if (first && /^\d{4}-\d{2}$/.test(first)) {
      try { return await load(first); } catch { kvSet(key, null); }
    }
    const id = ++seq.current;
    want.current = month ?? null;
    if (month) { setPending(month); const c = cache.current.get(month); if (c) setData(c); }
    try {
      const d = await fetchMonth(month);
      if (id === seq.current) { want.current = d.month; keep(d); }
      return d;
    } finally { if (id === seq.current) setPending(null); }
  };
  const fresh = (d) => !want.current || d.month === want.current;
  // dim only while the page still shows ANOTHER month (a cached hit refreshes silently)
  return { data, setData: keep, load, dim: !!pending && data?.month !== pending, shown: pending ?? data?.month, fresh };
}
