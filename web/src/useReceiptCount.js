import { useEffect, useState } from "react";
import { api } from "./api.js";

export const RECEIPTS_EVENT = "prova:receipts-changed";

/** Admin-only count of pending dekonts. Loads once, polls every 30s while the tab is visible, and refreshes on
 *  visibilitychange->visible and on RECEIPTS_EVENT (api.js fires it after any successful receipt write). */
export default function useReceiptCount(enabled) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) { setN(0); return; }
    let live = true;
    const load = () => api("GET", "/admin/receipts/pending-count").then((r) => { if (live) setN(r.count | 0); }, () => {});
    const tick = () => document.visibilityState === "visible" && load();
    load();
    const iv = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener(RECEIPTS_EVENT, load);
    return () => {
      live = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener(RECEIPTS_EVENT, load);
    };
  }, [enabled]);
  return n;
}
