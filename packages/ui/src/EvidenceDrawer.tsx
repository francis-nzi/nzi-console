"use client";

import { useEffect, type ReactNode } from "react";

/**
 * The docked detail panel (a selected row's evidence). Not a modal, so it has no scrim; but when the host says what closing
 * means (`onClose` - usually "no row selected"), it carries a visible close × top-right and closes on Escape, like every
 * other drawer. Escape is taken in the bubble phase and only if nothing else has handled it, so an overlay drawer opened over
 * it (which handles Escape first and stops it) closes alone.
 */
export function EvidenceDrawer({
  kicker, title, subtitle, children, actions, onClose,
}: { kicker: string; title: string; subtitle: string; children: ReactNode; actions?: ReactNode; onClose?: () => void }) {
  useEffect(() => {
    if (!onClose) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <aside className="nz-drawer" aria-label={`${kicker}: ${title}`}>
      <div className={onClose ? "nz-dh has-close" : "nz-dh"}>
        <div className="kick">{kicker}</div>
        <h3>{title}</h3>
        <div className="m">{subtitle}</div>
        {onClose ? <button type="button" className="x" data-drawer-close aria-label={`Close ${title}`} onClick={onClose}>×</button> : null}
      </div>
      <div className="nz-dbody" tabIndex={0}>{children}</div>
      {actions && <div className="nz-dact">{actions}</div>}
    </aside>
  );
}
