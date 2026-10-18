// Default "saving…" state for every button that triggers a write: the button pressed (click / Enter-submit) is marked
// aria-busy (CSS draws a spinner) and further presses are swallowed until the request(s) it started have settled.
// No per-call wiring: api() calls track(). Reads (GET) never mark a button.
const WINDOW_MS = 1500;
let last = null; // { el, at }
const pending = new WeakMap(); // button -> in-flight request count

const remember = (el) => { if (el?.isConnected && !el.disabled) last = { el, at: Date.now() }; };
const isBusy = (el) => el?.getAttribute("aria-busy") === "true";

if (typeof document !== "undefined") {
  const press = (e) => remember(e.target.closest?.("button"));
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("button");
    if (b && isBusy(b)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    remember(b);
  }, true);
  document.addEventListener("submit", (e) => {
    if (isBusy(e.submitter)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    remember(e.submitter);
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Enter") press(e); }, true);
}

/** Called by api() around a request; returns a release() to call when it settles. */
export function track(method) {
  if (method === "GET" || !last || Date.now() - last.at > WINDOW_MS || !last.el.isConnected) return () => {};
  const el = last.el;
  last = null;
  pending.set(el, (pending.get(el) || 0) + 1);
  el.setAttribute("aria-busy", "true");
  return () => {
    const n = (pending.get(el) || 1) - 1;
    pending.set(el, n);
    if (n <= 0) el.removeAttribute("aria-busy");
  };
}
