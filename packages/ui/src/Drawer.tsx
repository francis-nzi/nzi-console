"use client";

// Shared dismissible-overlay drawer primitive (WCAG 2.1.2 "no keyboard trap"
// done RIGHT — a deliberate, escapable trap; 2.4.3 focus order; 4.1.2 name/
// role). For a fixed overlay panel that can be closed:
//   - role="dialog" + aria-modal + an accessible name;
//   - on open, focus moves into the drawer;
//   - Escape closes it; on close, focus returns to whatever opened it;
//   - Tab / Shift+Tab cycle within the drawer while it is open;
//   - the caller supplies a keyboard-reachable close control inside `children`
//     (or uses the default one via `renderClose`).
//
// This is for the DISMISSIBLE overlay kind (the assurance drawer). The
// always-visible side panel (`EvidenceDrawer`) is a `complementary` region,
// not a modal, and does not use this.
import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "textarea:not([disabled])",
  "input:not([disabled])", "select:not([disabled])", '[tabindex]:not([tabindex="-1"])',
].join(",");

export function Drawer({ open, onClose, ariaLabel, children, className, dismissOnOutsideClick }: {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  /** For a centered modal whose root element is also the backdrop: a pointer-down
   *  directly on the root (not a child) closes it. Escape always closes. */
  dismissOnOutsideClick?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = (document.activeElement instanceof HTMLElement) ? document.activeElement : null;
    const node = ref.current;
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null);
    (focusables()[0] ?? node)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (!node) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) { event.preventDefault(); node.focus(); return; }
      const first = items[0]!, last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!node.contains(active)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const opener = openerRef.current;
      // Only restore if the opener is still in the document — a conditionally
      // rendered toggle may have unmounted, in which case the caller restores.
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      className={className}
      onMouseDown={dismissOnOutsideClick ? (event) => { if (event.target === event.currentTarget) onClose(); } : undefined}
    >
      {children}
    </div>
  );
}
