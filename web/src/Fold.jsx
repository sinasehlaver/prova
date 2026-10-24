import { useId } from "react";
import useFoldState from "./useFoldState.js";

/**
 * Collapsible section: chevron header (with an optional `sum` in <small>) + body that stays mounted via `hidden`.
 * tag: heading element ("h3" sec-title look, "h2" page-head look); actions: buttons shown right of the header;
 * foldKey: stable semantic key that remembers open/closed across reloads (localStorage `prova.folds`, see useFoldState.js);
 * ALWAYS pass it, include the item id for per-item folds (`admin.user.<id>.receipts`, `billing.month.<YYYY-MM>`). Never toggled -> defaultOpen.
 */
export default function Fold({ title, sum, defaultOpen = true, foldKey, tag = "h3", actions, className = "", children }) {
  const [open, setOpen] = useFoldState(foldKey, defaultOpen);
  const id = useId();
  const H = tag;
  const head = (
    <H className={(tag === "h3" ? "sec-title " : "") + "fold-h"}>
      <button type="button" className="fold-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <svg className="mr-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : undefined }}><path d="M9 6l6 6-6 6" /></svg>
        {title}{sum != null && <small>{sum}</small>}
      </button>
    </H>
  );
  return (
    <section className={"fold " + className}>
      {actions ? <div className="page-head">{head}{actions}</div> : head}
      <div id={id} hidden={!open}>{children}</div>
    </section>
  );
}
