import React, { useEffect, useState } from "react";
import { tr } from "./tr.js";

/** Loading placeholder: shimmering cards (aria-busy, one live label). */
export function Skeleton({ rows = 3, tall = false }) {
  return (
    <div className="skel-list" role="status" aria-busy="true" aria-label={tr.loading}>
      {Array.from({ length: rows }, (_, i) => <div key={i} className={"card skel" + (tall ? " tall" : "")} />)}
    </div>
  );
}

/** Failed load: says so in words and offers a retry (never a blank page). */
export function ErrorState({ message, onRetry }) {
  return (
    <div className="card state-card" role="alert">
      <h3>{tr.err.loadTitle}</h3>
      <p className="muted">{message || tr.err.load}</p>
      {onRetry && <button className="btn" onClick={onRetry}>{tr.err.retry}</button>}
    </div>
  );
}

/** Nothing here yet. Optional action node (e.g. a button). */
export function EmptyState({ title, body, children }) {
  return (
    <div className="card state-card empty-state">
      <h3>{title}</h3>
      {body && <p className="muted">{body}</p>}
      {children}
    </div>
  );
}

/** Cold-start splash for the first /api/me (Render free spins down after 15 min idle; wake-up ~1 min). */
export function Boot() {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 4000); return () => clearTimeout(t); }, []);
  return (
    <div className="boot" role="status" aria-busy="true">
      <div className="boot-card">
        <div className="logo boot-logo" aria-hidden="true">P</div>
        <p className="boot-title">{tr.loading}</p>
        <div className="skel boot-bar" aria-hidden="true" />
        <p className="muted small boot-hint" aria-live="polite">{slow ? tr.bootSlow : " "}</p>
      </div>
    </div>
  );
}
