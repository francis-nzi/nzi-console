"use client";

// Lean collapsed-by-default section — the "lead with the data, help on demand"
// pattern from the data-entry UX review (item 2 / item 6). A plain
// disclosure: a header button carrying `aria-expanded` + `aria-controls`, a
// region that is `hidden` when closed. Uncontrolled by default; pass `open` +
// `onOpenChange` to drive it (e.g. a "History" action that opens one section).
//
// Distinct from `StageSection` (numbered workflow stage with status) — this is
// for the many small sections inside a panel or drawer.
import { useId, useState, type ReactNode } from "react";

export function Collapsible({
  title, count, defaultOpen = false, open: openProp, onOpenChange, children, className, headingClassName,
}: {
  title: ReactNode;
  /** Optional badge (e.g. a field count) shown in the header. */
  count?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  headingClassName?: string;
}) {
  const [openInternal, setOpenInternal] = useState(defaultOpen);
  const open = openProp ?? openInternal;
  const panelId = useId();
  const toggle = () => {
    const next = !open;
    setOpenInternal(next);
    onOpenChange?.(next);
  };
  return (
    <div className={`nz-collapsible${open ? " open" : ""}${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className={`nz-collapsible-h${headingClassName ? ` ${headingClassName}` : ""}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        <svg className="nz-collapsible-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        <span className="t">{title}</span>
        {count != null && count !== "" ? <span className="c">{count}</span> : null}
      </button>
      <div id={panelId} className="nz-collapsible-b" hidden={!open}>{open ? children : null}</div>
    </div>
  );
}
