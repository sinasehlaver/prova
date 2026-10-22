import React, { useEffect, useRef, useState } from "react";
import { copyText } from "./Billing.jsx";
import { CheckIcon, CopyIcon } from "./icons.jsx";
import { tr } from "./tr.js";

/** Copy button, "Icon turns into ✓" look (ui-picker pick for Copy feedback): icon swaps to a green check for 1.4 s. */
export default function CopyBtn({ text, label = tr.cal.copyText, onCopied }) {
  const [ok, setOk] = useState(false);
  const t = useRef(null);
  useEffect(() => () => clearTimeout(t.current), []);
  const go = async () => {
    if (ok) return;
    await copyText(text);
    setOk(true);
    onCopied?.();
    t.current = setTimeout(() => setOk(false), 1400);
  };
  return (
    <button type="button" className={"icon-btn copy-btn" + (ok ? " ok" : "")} aria-label={ok ? tr.cal.copied : label} title={ok ? tr.cal.copied : label} onClick={go}>
      {ok ? <CheckIcon width="16" height="16" /> : <CopyIcon width="16" height="16" />}
    </button>
  );
}
