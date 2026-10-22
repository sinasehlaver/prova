import { useEffect, useRef } from "react";
import { writes } from "./api.js";
import { RECEIPTS_EVENT } from "./useReceiptCount.js";

/** Silent background refresh. Re-runs `load(ok)` every 30s while the tab is visible, on visibilitychange->visible and on
 *  RECEIPTS_EVENT. `load` must return a promise and apply its result only if `ok()` is still true (it is false when the
 *  view unmounted, a newer poll started, or a write happened meanwhile); it must NOT set loading/error state. Errors are
 *  swallowed here. A tick is skipped while a write is in flight, a sheet is open, or the previous poll is unfinished.
 *  Pass `deps` (like useEffect) when `load` closes over filters; the latest `load` is always used. */
export default function usePoll(load, { enabled = true } = {}) {
  const fn = useRef(load);
  fn.current = load;
  useEffect(() => {
    if (!enabled) return;
    let live = true, busy = false, seq = 0, last = 0;
    const run = () => {
      if (!live || busy || document.visibilityState !== "visible" || writes.inflight > 0) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (Date.now() - last < 1000) return; // collapse event + visibility bursts
      last = Date.now();
      const id = ++seq, epoch = writes.epoch;
      const ok = () => live && id === seq && epoch === writes.epoch && writes.inflight === 0;
      busy = true;
      Promise.resolve().then(() => fn.current(ok)).catch(() => {}).finally(() => { busy = false; });
    };
    const onEvt = () => setTimeout(run, 50); // the event fires inside the write, before it settles
    const iv = setInterval(run, 30_000);
    document.addEventListener("visibilitychange", run);
    window.addEventListener(RECEIPTS_EVENT, onEvt);
    return () => { live = false; clearInterval(iv); document.removeEventListener("visibilitychange", run); window.removeEventListener(RECEIPTS_EVENT, onEvt); };
  }, [enabled]);
}
