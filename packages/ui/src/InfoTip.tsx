"use client";

// Shared info tooltip — one ⓘ that reveals its help text on demand, replacing
// the standing instruction paragraphs across data entry (data-entry UX review
// item 3). Keyboard-reachable (a real <button>), toggles on click/Enter/Space,
// dismisses on Escape or an outside click/focus. The text is rendered in the
// DOM at all times (visually hidden when closed) so a screen reader can reach
// it via `aria-describedby` without opening anything.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export function InfoTip({ label, children, className }: {
  /** What the icon is about — used for its accessible name ("About <label>"). */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const tipId = useId();

  useEffect(() => {
    if (!open) return;
    function onDocPointer(event: Event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
    }
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("focusin", onDocPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer, true);
      document.removeEventListener("focusin", onDocPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <span className={`nz-infotip${open ? " open" : ""}${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="nz-infotip-btn"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-describedby={tipId}
        onClick={() => setOpen((value) => !value)}
      >
        i
      </button>
      {/* Always in the DOM + a11y tree (so `aria-describedby` works without
          opening); CSS clips it out of view until `.open`. */}
      <span id={tipId} role="tooltip" className="nz-infotip-pop">{children}</span>
    </span>
  );
}
