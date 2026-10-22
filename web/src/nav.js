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
