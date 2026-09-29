"use client";

import type { ReactNode } from "react";
import { Drawer } from "../Drawer";

/**
 * The admin side-panel editor (docs/design/admin-design-notes.md): every admin entity is operated through
 * list → this drawer → audit.
 *
 * Built on the shared `Drawer`, so it inherits its accessibility rather than re-implementing it: a named modal dialog,
 * focus moved in on open, Tab kept inside, Escape to close, focus returned to what opened it. A pointer-down on the
 * scrim closes it too.
 *
 * The footer carries the audit line and the actions the caller passes — Save, and Deactivate or Reinstate. There is
 * deliberately no delete affordance in this component: admin records are deactivated, never deleted (R3).
 */
export function DrawerEditor({ open, onClose, eyebrow, title, children, audit, actions }: {
  open: boolean;
  onClose: () => void;
  /** The entity, above the title (e.g. "Industries"). */
  eyebrow: string;
  title: string;
  children: ReactNode;
  /** The footer's audit line (`<AuditLine version={n} />`). */
  audit?: ReactNode;
  /** The footer's buttons. */
  actions?: ReactNode;
}) {
  return <Drawer open={open} onClose={onClose} ariaLabel={`${eyebrow}: ${title}`} className="nz-a-scrim" dismissOnOutsideClick>
    <aside className="nz-a-drawer">
      <div className="nz-a-drawer-head">
        <div><div className="nz-a-eyebrow">{eyebrow}</div><h2>{title}</h2></div>
        <button type="button" className="nz-a-icon-btn" onClick={onClose} aria-label={`Close ${title}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <div className="nz-a-drawer-body">{children}</div>
      {audit || actions ? <div className="nz-a-drawer-foot">{audit}{actions ? <div className="nz-a-foot-btns">{actions}</div> : null}</div> : null}
    </aside>
  </Drawer>;
}
