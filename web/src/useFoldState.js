import { useCallback, useState } from "react";

const KEY = "prova.folds";
const MAX = 500;

function read() {
  try {
    const m = JSON.parse(localStorage.getItem(KEY));
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  } catch { return {}; }
}

/** Stored state for `key`, or undefined when never toggled. For folds rendered in loops where a hook can't be used. */
export function foldGet(key) {
  const v = read()[key];
  return typeof v === "boolean" ? v : undefined;
}

export function foldSet(key, v) {
  try {
    const m = read();
    delete m[key];
    m[key] = v;
    const ks = Object.keys(m);
    for (const k of ks.slice(0, Math.max(0, ks.length - MAX))) delete m[k];
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch { /* storage full/blocked: state still works for this visit */ }
}

/**
 * Remembered open/closed state of a collapsible, persisted in localStorage under one JSON map `prova.folds`.
 * `key` = stable semantic id, per-item folds include the item id (`admin.user.<id>.receipts`, `billing.month.<YYYY-MM>`).
 * Unset key (or no key) -> `defaultOpen`, so changed defaults still apply to folds never toggled.
 * The map keeps the newest ~500 toggles (insertion order; a toggle moves the key to the end). Corrupt JSON -> ignored.
 */
export default function useFoldState(key, defaultOpen) {
  const [open, setOpenState] = useState(() => {
    const v = key ? foldGet(key) : undefined;
    return v ?? defaultOpen;
  });
  const setOpen = useCallback((next) => {
    setOpenState((cur) => {
      const v = typeof next === "function" ? next(cur) : next;
      if (key) foldSet(key, v);
      return v;
    });
  }, [key]);
  return [open, setOpen];
}
