import React, { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Skeleton } from "./States.jsx";
import { hashParts, go, closeDetail } from "./nav.js";
import { tr } from "./tr.js";
import Members from "./Members.jsx";
import Economics from "./Economics.jsx";
import { Fees, PaySettings, Payments, UserDetail } from "./AdminBilling.jsx";

const SECTIONS = ["members", "receipts", "fees", "economics", "settings"];

/** Admin area: section tabs. `extra` renders under Members (other admin blocks, e.g. alert kinds). */
export default function Admin({ me, extra, pendingCount = 0, receiptCount = 0 }) {
  // route lives in the URL hash: #admin/<section>[/user/<id>]
  const read = () => { const p = hashParts(); return { section: SECTIONS.includes(p[1]) ? p[1] : "members", id: p[0] === "admin" && p[2] === "user" && /^\d+$/.test(p[3] || "") ? Number(p[3]) : null }; };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const { section, id } = route;
  const users = useRef({});
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (id == null) { setDetail(null); return; }
    if (users.current[id]) { setDetail(users.current[id]); return; }
    let live = true;
    api("GET", "/users").then((l) => { const u = l.find((x) => x.id === id); if (live) { if (u) { users.current[id] = u; setDetail(u); } else go(`admin/${section}`, { replace: true }); } }, () => {});
    return () => { live = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = (u) => { users.current[u.id] = u; go(`admin/${section}/user/${u.id}`, { detail: true }); };
  const back = () => closeDetail(`admin/${section}`);
  const shown = id != null ? (detail && detail.id === id ? detail : undefined) : null; // undefined = loading
  const detailView = (label) => shown ? <UserDetail key={shown.id} user={shown} onBack={back} backLabel={label} /> : <Skeleton rows={3} />;
  return (
    <>
      <div className="subtabs" role="tablist" aria-label={tr.tabs.admin}>
        {SECTIONS.map((s) => (
          <button key={s} role="tab" aria-selected={section === s} onClick={(e) => { go(`admin/${s}`); e.currentTarget.scrollIntoView?.({ inline: "center", block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }}>
            {tr.admin.sections[s]}
            {s === "receipts" && receiptCount > 0 && (
              <span className="count-badge is-accent" data-count={receiptCount > 99 ? "99+" : receiptCount} role="status" aria-label={tr.members.pendingReceipts(receiptCount)} />
            )}
            {s === "members" && pendingCount > 0 && (
              <span className="count-badge" data-count={pendingCount > 99 ? "99+" : pendingCount} role="status" aria-label={tr.members.pendingCount(pendingCount)} />
            )}
          </button>
        ))}
      </div>
      {section === "members" && (id != null ? detailView() : <><Members me={me} onDetail={open} />{extra}</>)}
      {/* Ödemeler: everyone + their outstanding by default; a row opens the same per-user drill-down as Üyeler. */}
      {section === "receipts" && (id != null ? detailView(tr.admin.backPayments) : <Payments onDetail={open} />)}
      {section === "fees" && <Fees />}
      {section === "economics" && <Economics />}
      {section === "settings" && <PaySettings />}
    </>
  );
}
