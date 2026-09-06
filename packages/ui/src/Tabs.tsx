"use client";

// Shared tablist primitive — the WAI-ARIA "tabs with automatic activation"
// pattern (WCAG 2.1.1 / ARIA). Roving tabindex: the selected tab is the only
// tab stop (tabIndex 0), the rest are -1, so Tab moves OUT of the tablist,
// not between tabs. ArrowLeft/Right (and Up/Down) move focus AND activate,
// wrapping; Home/End jump to the first/last enabled tab.
//
// Built after the Data Assurance human pass found this missing on the
// assurance tablist and again on the report Continuous/Page-view toggle — a
// tablist is a recurring pattern, so it lives here once.
import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

export type TabDescriptor = { id: string; label: ReactNode; disabled?: boolean };

export function Tabs({ items, value, onChange, ariaLabel, idBase, className }: {
  items: readonly TabDescriptor[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  /** Stable prefix shared with the matching <TabPanel idBase> so `id` / `aria-controls` / `aria-labelledby` line up. */
  idBase: string;
  className?: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const enabled = items.filter((t) => !t.disabled);

  function go(target: "next" | "prev" | "first" | "last") {
    if (enabled.length === 0) return;
    const here = Math.max(0, enabled.findIndex((t) => t.id === value));
    const pick =
      target === "first" ? enabled[0]
      : target === "last" ? enabled[enabled.length - 1]
      : enabled[(here + (target === "next" ? 1 : enabled.length - 1)) % enabled.length];
    if (!pick) return;
    if (pick.id !== value) onChange(pick.id);
    refs.current[pick.id]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowRight": case "ArrowDown": event.preventDefault(); go("next"); break;
      case "ArrowLeft": case "ArrowUp": event.preventDefault(); go("prev"); break;
      case "Home": event.preventDefault(); go("first"); break;
      case "End": event.preventDefault(); go("last"); break;
      default: break;
    }
  }

  return (
    <div role="tablist" aria-label={ariaLabel} className={className} onKeyDown={onKeyDown}>
      {items.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => { refs.current[tab.id] = el; }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${tab.id}`}
            aria-controls={`${idBase}-panel-${tab.id}`}
            aria-selected={selected}
            aria-disabled={tab.disabled || undefined}
            tabIndex={selected ? 0 : -1}
            className={selected ? "on" : undefined}
            onClick={() => { if (!tab.disabled) onChange(tab.id); }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** The panel a <Tabs> tab controls. Focusable so a keyboard user lands on the content after activating a tab. */
export function TabPanel({ id, idBase, active, ariaLabel, children, className, style }: {
  id: string;
  idBase: string;
  active: boolean;
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idBase}-panel-${id}`}
      aria-labelledby={`${idBase}-tab-${id}`}
      aria-label={ariaLabel}
      tabIndex={0}
      hidden={!active}
      className={className}
      style={style}
    >
      {active ? children : null}
    </div>
  );
}
