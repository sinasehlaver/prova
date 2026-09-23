import React, { useCallback, useEffect, useState } from "react";
import { api, AUTH_EVENT } from "./api.js";
import { tr } from "./tr.js";
import { BellIcon, CalendarIcon, MoonIcon, ShieldIcon, SunIcon, WalletIcon } from "./icons.jsx";
import Admin from "./Admin.jsx";
import Billing from "./Billing.jsx";
import Calendar from "./Calendar.jsx";
import Alerts, { AlertBadges } from "./Alerts.jsx";
import AlertKinds from "./AlertKinds.jsx";
import Profile from "./Profile.jsx";
import { Boot, ErrorState, Skeleton } from "./States.jsx";

const TABS = [
  { id: "calendar", Icon: CalendarIcon },
  { id: "payments", Icon: WalletIcon },
  { id: "alerts", Icon: BellIcon },
  { id: "admin", Icon: ShieldIcon, admin: true },
];

const currentTheme = () =>
  document.documentElement.getAttribute("data-theme") ||
  (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

/** Pending self-signup count for the admin red bubble. One GET /api/users, refreshed every 60s / on focus / on `prova:users`. */
function usePendingCount(enabled) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) { setN(0); return; }
    let live = true;
    const load = () => api("GET", "/users").then((us) => { if (live) setN(us.filter((u) => u.pending).length); }, () => {});
    load();
    const iv = setInterval(load, 60_000);
    const vis = () => document.visibilityState === "visible" && load();
    window.addEventListener("focus", load);
    window.addEventListener("prova:users", load);
    document.addEventListener("visibilitychange", vis);
    return () => {
      live = false;
      clearInterval(iv);
      window.removeEventListener("focus", load);
      window.removeEventListener("prova:users", load);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [enabled]);
  return n;
}

function Placeholder({ id }) {
  const [title, body] = tr.placeholder[id];
  return (
    <section className="empty card">
      <h2>{title}</h2>
      <p className="muted">{body}</p>
    </section>
  );
}

function SignupForm({ onDone, onBack }) {
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { onDone(await api("POST", "/signup", form)); }
    catch (err) { setError(err.message || tr.err.generic); setBusy(false); }
  };
  return (
    <form className="sheet-form signup-form" onSubmit={submit}>
      <label className="field">
        <span>{tr.signup.name}</span>
        <input autoFocus required maxLength={80} autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <label className="field">
        <span>{tr.signup.email} <span className="muted small">({tr.signup.emailHint})</span></span>
        <input required type="email" maxLength={254} autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </label>
      <label className="field">
        <span>{tr.signup.password} <span className="muted small">({tr.signup.passwordHint})</span></span>
        <input required type="password" minLength={8} maxLength={128} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      </label>
      <label className="field">
        <span>{tr.signup.phone} <span className="muted small">({tr.signup.phoneHint})</span></span>
        <input inputMode="tel" maxLength={30} autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      </label>
      <p className="muted small">{tr.signup.hint}</p>
      {error && <p className="notice bad" role="alert">{error}</p>}
      <div className="row end">
        <button type="button" className="btn ghost" onClick={onBack}>{tr.signup.back}</button>
        <button className="btn primary" disabled={busy || !form.name.trim() || !form.email || !form.password}>{tr.signup.submit}</button>
      </div>
    </form>
  );
}

function Login({ invalid, onSignedUp }) {
  const [signup, setSignup] = useState(false);
  const [form, setForm] = useState({ email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const user = await api("POST", "/login", form);
      onSignedUp(user);
    } catch (err) {
      setError(err.message || tr.err.generic);
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login-card card">
        <div className="logo" aria-hidden="true">P</div>
        <h1>{tr.login.title}</h1>
        {signup ? <SignupForm onDone={onSignedUp} onBack={() => setSignup(false)} /> : (
          <>
            <p className="muted">{tr.login.body}</p>
            {invalid && <p className="notice bad" role="alert">{tr.login.invalid}</p>}
            {error && <p className="notice bad" role="alert">{error}</p>}
            <form className="sheet-form" onSubmit={submit}>
              <label className="field">
                <span>{tr.login.email}</span>
                <input autoFocus required type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </label>
              <label className="field">
                <span>{tr.login.password}</span>
                <input required type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </label>
              <div className="row end">
                <button className="btn primary" disabled={busy || !form.email || !form.password}>{tr.login.submit}</button>
              </div>
            </form>
            <p className="muted small"><button className="link" onClick={() => setSignup(true)}>{tr.login.signupLink}</button></p>
            <p className="muted small">{tr.login.lost}</p>
          </>
        )}
      </div>
    </main>
  );
}

/** Signed up but not approved yet: nothing else is reachable (the API answers 403 for every other route). */
function Pending({ me, recheck, onLogout }) {
  const [msg, setMsg] = useState("");
  useEffect(() => { const t = setInterval(recheck, 15000); return () => clearInterval(t); }, [recheck]);
  const check = async () => { setMsg(""); await recheck(); setMsg(tr.pending.stillWaiting); };
  const logout = async () => { try { await api("POST", "/logout"); } catch {} onLogout(); };
  return (
    <main className="login">
      <div className="login-card card">
        <div className="logo" aria-hidden="true">P</div>
        <h1>{tr.pending.title}</h1>
        <p className="muted">{tr.pending.body(me.name)}</p>
        {msg && <p className="notice" role="status">{msg}</p>}
        <div className="row login-actions">
          <button className="btn" onClick={check}>{tr.pending.check}</button>
          <button className="btn ghost" onClick={logout}>{tr.profile.logout}</button>
        </div>
      </div>
    </main>
  );
}

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = logged out
  const [tab, setTab] = useState(() => location.hash.slice(1) || "calendar");
  const [theme, setTheme] = useState(currentTheme);

  const [bootErr, setBootErr] = useState(false);
  const boot = useCallback(() => {
    setBootErr(false);
    // only a real 401 means "logged out"; a network/5xx failure (cold start) must not look like a lost session
    api("GET", "/me").then(setMe, (e) => (e.status === 401 ? setMe(null) : setBootErr(true)));
  }, []);
  useEffect(boot, [boot]);

  // The cookie is shared by all tabs of this browser: re-validate the identity on focus and after any 401/403.
  const recheck = useCallback(() =>
    api("GET", "/me").then(
      (n) => setMe((o) => (o && o.id === n.id && o.role === n.role && o.name === n.name && o.phone === n.phone && o.status === n.status && o.observer === n.observer ? o : n)),
      (e) => { if (e.status === 401) setMe(null); }), []);
  useEffect(() => {
    let last = 0;
    const go = () => { if (Date.now() - last > 1000) { last = Date.now(); recheck(); } };
    const vis = () => { if (document.visibilityState === "visible") go(); };
    window.addEventListener("focus", go);
    window.addEventListener(AUTH_EVENT, go);
    document.addEventListener("visibilitychange", vis);
    return () => { window.removeEventListener("focus", go); window.removeEventListener(AUTH_EVENT, go); document.removeEventListener("visibilitychange", vis); };
  }, [recheck]);
  useEffect(() => {
    const onHash = () => setTab(location.hash.slice(1) || "calendar");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("prova.theme", next); } catch {}
    setTheme(next);
  }, [theme]);

  if (me === undefined && bootErr) return <main className="boot"><div className="boot-card"><ErrorState message={tr.err.boot} onRetry={boot} /></div></main>;
  if (me === undefined) return <Boot />;
  if (me === null) return <Login invalid={new URLSearchParams(location.search).get("davet") === "gecersiz"} onSignedUp={setMe} />;
  if (me.status === "pending") return <Pending me={me} recheck={recheck} onLogout={() => setMe(null)} />;

  return <Shell me={me} setMe={setMe} tab={tab} setTab={setTab} theme={theme} toggleTheme={toggleTheme} recheck={recheck} />;
}

/** Admin area is rendered only after a fresh /me confirms this cookie is an admin (never from a possibly stale `me`). */
function AdminGate({ me, recheck, children }) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    setOk(false);
    api("GET", "/me").then((n) => { if (live) { n.role === "admin" && n.id === me.id ? setOk(true) : recheck(); } }, () => {});
    return () => { live = false; };
  }, [me.id, me.role]); // eslint-disable-line react-hooks/exhaustive-deps
  return ok ? children : <Skeleton rows={3} />;
}

function Shell({ me, setMe, tab, setTab, theme, toggleTheme, recheck }) {
  const [profile, setProfile] = useState(false);
  const tabs = TABS.filter((t) => !t.admin || me.role === "admin");
  const active = tabs.find((t) => t.id === tab) ? tab : "calendar";
  const pendingCount = usePendingCount(me.role === "admin");
  // the URL hash always names the tab that is actually rendered (no #admin for a non-admin)
  useEffect(() => { if (location.hash.slice(1) !== active) history.replaceState(null, "", "#" + active); }, [active]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand-row">
          <h1 className="brand">{tr.app}</h1>
          <AlertBadges />
        </div>
        <button className="who-btn" onClick={() => setProfile(true)} aria-label={`${tr.profile.open}: ${me.name}`} aria-haspopup="dialog">
          <span className="who-avatar" aria-hidden="true">{me.name.slice(0, 1).toLocaleUpperCase("tr")}</span>
          <span>{me.name}</span>
        </button>
        <button className="icon-btn" onClick={toggleTheme} aria-label={theme === "dark" ? tr.theme.toLight : tr.theme.toDark}>
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </header>
      <main className="page" key={`${me.id}:${me.role}`}>
        {active === "admin" ? <AdminGate me={me} recheck={recheck}><Admin me={me} extra={<AlertKinds />} pendingCount={pendingCount} /></AdminGate> : active === "payments" ? <Billing /> : active === "alerts" ? <Alerts /> : active === "calendar" ? <Calendar me={me} /> : <Placeholder id={active} />}
      </main>
      <nav className="tabbar" aria-label="Ana menü">
        {tabs.map(({ id, Icon }) => (
          <button key={id} className="tab" aria-current={active === id ? "page" : undefined} onClick={() => setTab(id)}>
            <span className="tab-icon">
              <Icon />
              {id === "admin" && pendingCount > 0 && (
                <span className="count-badge" data-count={pendingCount > 99 ? "99+" : pendingCount} role="status" aria-label={tr.members.pendingCount(pendingCount)} />
              )}
            </span>
            <span>{tr.tabs[id]}</span>
          </button>
        ))}
      </nav>
      {profile && <Profile me={me} onClose={() => setProfile(false)} onSaved={(n) => setMe((o) => ({ ...o, ...n }))} onLogout={() => setMe(null)} />}
    </div>
  );
}
