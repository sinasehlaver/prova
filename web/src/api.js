import { tr } from "./tr.js";

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// fetch() rejects with an English TypeError when the network / a sleeping server is unreachable -> Turkish ApiError(0)
const send = (url, init) => fetch(url, init).catch(() => { throw new ApiError(0, tr.err.load); });

/** The session cookie is shared by every tab of the browser (another member's /i/ link swaps it), so any 401/403 means
 *  "the identity this tab shows may be stale": tell App to re-check /me. (/me itself and login/logout calls are excluded.) */
export const AUTH_EVENT = "prova:auth";
const NO_RECHECK = new Set(["/me", "/signup", "/logout"]);
const check = (r, j, path) => {
  if (r.ok) return j;
  if ((r.status === 401 || r.status === 403) && !NO_RECHECK.has(path)) window.dispatchEvent(new Event(AUTH_EVENT));
  throw new ApiError(r.status, j.error || r.statusText);
};

export async function api(method, path, body) {
  const r = await send("/api" + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return check(r, await r.json().catch(() => ({})), path);
}

/** Raw PDF upload (server reads the body as-is, cap 5 MB). `file` may be null: an empty body = "no dekont". */
export async function apiUpload(path, file) {
  const r = await send("/api" + path, { method: "POST", headers: { "content-type": "application/pdf" }, body: file || undefined });
  return check(r, await r.json().catch(() => ({})), path);
}
