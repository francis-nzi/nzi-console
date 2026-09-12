"use client";

// The client-level area navigation (client workspace v10): a second, narrower column
// between the global WorkspaceRail and the content. The rail says which workspace you are
// in; this says which area of *this client* you are looking at.
//
// Areas are grouped — Client (what the engagement produces), Manage (how it is run),
// Record (what the client is) — and each carries an optional count, and an optional
// "unavailable" marker for an area whose backend is not built yet. An area that cannot
// show anything truthful says so here rather than looking like an empty one.
import type { ReactNode } from "react";

export type ClientAreaItem = {
  id: string;
  label: string;
  /** A short glyph, in the prototype's visual language. */
  icon: ReactNode;
  /** A count shown on the right — omit when there is nothing to count. */
  count?: number | string | null;
  /** Marks an area that is not yet available, so the nav does not promise a screen that cannot be honest. */
  unavailable?: boolean;
};
export type ClientAreaGroup = { id: string; label: string; items: ClientAreaItem[] };

export function ClientWorkspaceNav({
  groups, activeId, onSelect, ariaLabel = "Client areas",
}: {
  groups: ClientAreaGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  ariaLabel?: string;
}) {
  return (
    <nav className="nz-subnav" aria-label={ariaLabel}>
      {groups.map((group) => (
        <div key={group.id} className="nz-subnav-group">
          <div className="nz-subnav-grp" id={`nz-subnav-${group.id}`}>{group.label}</div>
          <ul aria-labelledby={`nz-subnav-${group.id}`}>
            {group.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`nz-subnav-item${item.id === activeId ? " on" : ""}${item.unavailable ? " off" : ""}`}
                  aria-current={item.id === activeId ? "page" : undefined}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="ic" aria-hidden="true">{item.icon}</span>
                  <span className="t">{item.label}</span>
                  {item.count != null && item.count !== "" ? <span className="ct">{item.count}</span> : null}
                  {item.unavailable ? <span className="ct" title="Not available yet">—</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
