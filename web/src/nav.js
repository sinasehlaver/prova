// History-aware navigation over the URL hash: "#<tab>" or "#admin/<section>[/user/<id>]".
// Every in-app move is a pushState (Back steps through them); hashchange is dispatched by hand because pushState is silent.
let pushedDetail = false; // the current user-detail entry was pushed by this page load (so history.back() returns to the list)

export const hashParts = () => location.hash.slice(1).split("/").filter(Boolean);
export const tabOf = () => hashParts()[0] || "calendar";

export function go(hash, { replace = false, detail = false } = {}) {
  if (location.hash.slice(1) === hash) return;
  history[replace ? "replaceState" : "pushState"]({ app: 1 }, "", "#" + hash);
  pushedDetail = !replace && detail;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Leave the user detail: real Back when the app pushed it, else replace the entry with the list route. */
export function closeDetail(listHash) {
  if (pushedDetail) { pushedDetail = false; history.back(); } else go(listHash, { replace: true });
}

// ---- remembered view state (per logged-in user, localStorage `prova.nav.<uid>`) ----
// { last: <tab>, hash: {<tab>: "<hash>"}, scroll: {<tab>: y}, kv: {<key>: string} }. Stale entries are harmless: views fall back on 404/invalid.
let uid = null, mem = { last: null, hash: {}, scroll: {}, kv: {} };
const NAV_KEY = () => `prova.nav.${uid}`;
const persist = () => { try { localStorage.setItem(NAV_KEY(), JSON.stringify(mem)); } catch {} };
export function navUser(id) {
  if (uid === id) return;
  uid = id;
  try { const o = JSON.parse(localStorage.getItem(NAV_KEY()) || "null"); mem = { last: null, hash: {}, scroll: {}, kv: {}, ...(o && typeof o === "object" ? o : {}) }; } catch { mem = { last: null, hash: {}, scroll: {}, kv: {} }; }
}
export const remembered = () => mem;
/** Call on every hash change of a rendered tab: remember its sub-view. */
export function noteView(tab) { mem.last = tab; if (location.hash.slice(1) === tab) delete mem.hash[tab]; else mem.hash[tab] = location.hash.slice(1); persist(); }
export function noteScroll(tab, y) { mem.scroll[tab] = Math.round(y); persist(); }
/** Hash to open when a tab button is tapped: its remembered sub-view, or the tab root. */
export const tabTarget = (tab) => (mem.hash[tab] && mem.hash[tab].split("/")[0] === tab ? mem.hash[tab] : tab);
export const forgetTab = (tab) => { delete mem.hash[tab]; delete mem.scroll[tab]; persist(); };
export const kvGet = (k) => mem.kv[k] ?? null;
export function kvSet(k, v) { if (v == null) delete mem.kv[k]; else mem.kv[k] = String(v); persist(); }
