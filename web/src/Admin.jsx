import React, { useState } from "react";
import { tr } from "./tr.js";
import Members from "./Members.jsx";
import Economics from "./Economics.jsx";
import { Fees, PaySettings, Payments, UserDetail } from "./AdminBilling.jsx";

const SECTIONS = ["members", "receipts", "fees", "economics", "settings"];

/** Admin area: section tabs. `extra` renders under Members (other admin blocks, e.g. alert kinds). */
export default function Admin({ me, extra, pendingCount = 0 }) {
  const [section, setSection] = useState("members");
  const [detail, setDetail] = useState(null);
  return (
    <>
      <div className="subtabs" role="tablist" aria-label={tr.tabs.admin}>
        {SECTIONS.map((s) => (
          <button key={s} role="tab" aria-selected={section === s} onClick={(e) => { setSection(s); setDetail(null); e.currentTarget.scrollIntoView?.({ inline: "center", block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }}>
            {tr.admin.sections[s]}
            {s === "members" && pendingCount > 0 && (
              <span className="count-badge" data-count={pendingCount > 99 ? "99+" : pendingCount} role="status" aria-label={tr.members.pendingCount(pendingCount)} />
            )}
          </button>
        ))}
      </div>
      {section === "members" && (detail ? <UserDetail user={detail} onBack={() => setDetail(null)} /> : <><Members me={me} onDetail={setDetail} />{extra}</>)}
      {/* Ödemeler: everyone + their outstanding by default; a row opens the same per-user drill-down as Üyeler. */}
      {section === "receipts" && (detail ? <UserDetail user={detail} onBack={() => setDetail(null)} /> : <Payments onDetail={setDetail} />)}
      {section === "fees" && <Fees />}
      {section === "economics" && <Economics />}
      {section === "settings" && <PaySettings />}
    </>
  );
}
