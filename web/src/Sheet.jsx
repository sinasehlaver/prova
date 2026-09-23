import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons.jsx";
import { tr } from "./tr.js";

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/** Hand-built modal: bottom sheet on phones, centred dialog on wide screens. Esc / backdrop close, focus trap, focus restore.
 * Portals to document.body so `position: fixed` always covers the full viewport regardless of where the caller
 * mounts it — an ancestor with `backdrop-filter`/`transform`/`will-change` (e.g. `.topbar`) creates a containing
 * block that traps an un-portalled fixed element inside that ancestor's box instead. */
export default function Sheet({ title, onClose, children }) {
  const ref = useRef();
  useEffect(() => {
    const prev = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current.querySelector("[data-autofocus]")?.focus() ?? ref.current.querySelector(FOCUSABLE)?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab") return;
      const els = [...ref.current.querySelectorAll(FOCUSABLE)];
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="sheet-grab" aria-hidden="true" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={tr.cal.close}><CloseIcon /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}
