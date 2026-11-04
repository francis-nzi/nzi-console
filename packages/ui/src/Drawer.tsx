"use client";

// Shared dismissible-overlay drawer primitive (WCAG 2.1.2 "no keyboard trap"
// done RIGHT — a deliberate, escapable trap; 2.4.3 focus order; 4.1.2 name/
// role). For a fixed overlay panel that can be closed:
//   - role="dialog" + aria-modal + an accessible name;
//   - on open, focus moves into the drawer;
//   - EVERY drawer can be closed three ways, from here, so no caller has to remember to build them:
//       Escape; a click on the scrim; and a visible close X, top-right;
//   - on close, focus returns to whatever opened it;
//   - Tab / Shift+Tab cycle within the drawer while it is open.
//
// The close X is this component's: a drawer whose content already carries a close control (a header's own ×, an
// `aria-label="Close …"` button, `data-drawer-close`) keeps it and gets no second one — see `hasOwnCloseControl` — and a
// drawer that must not be dismissed (a terms gate, an idle warning) says so with `dismissible={false}`.
//
// This is for the DISMISSIBLE overlay kind. The always-visible side panel (`EvidenceDrawer`) is a `complementary` region,
// not a modal; it takes an optional `onClose` of its own.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "textarea:not([disabled])",
  "input:not([disabled])", "select:not([disabled])", '[tabindex]:not([tabindex="-1"])',
].join(",");

/** A close control the content already supplies: the marker, a header's `.x` / `.close`, or the admin editor's icon button. Never the one this component adds. */
export const OWN_CLOSE_SELECTOR = [
  "[data-drawer-close]:not([data-drawer-auto])", "button.x", "button.close", '.nz-a-icon-btn[aria-label^="Close"]',
].join(",");

export const hasOwnCloseControl = (root: { querySelector(selector: string): unknown } | null | undefined): boolean =>
  root ? root.querySelector(OWN_CLOSE_SELECTOR) !== null : false;

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function Drawer({ open, onClose, ariaLabel, children, className, dismissOnOutsideClick = true, dismissible = true, addScrim = false }: {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  /** A pointer-down on the scrim closes it. The scrim is the root element itself (a panel's full-screen `::before`, or a
   *  centered modal's backdrop), so a pointer-down directly on the root — not on a child — is a click on the scrim. On by
   *  default; ignored when `addScrim` is set (the scrim is then its own element). Escape always closes. */
  dismissOnOutsideClick?: boolean;
  /** False for a gate that must be answered rather than dismissed: no close X, no scrim click. Escape still calls `onClose`, which is that gate's own answer. */
  dismissible?: boolean;
  /** For a panel whose class draws no scrim of its own: render one behind it, closing on click. */
  addScrim?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [ownClose, setOwnClose] = useState(false);

  // Look after every render, not just the first: content can arrive after a fetch. A same-value set is not a re-render.
  useIsomorphicLayoutEffect(() => {
    if (open) setOwnClose(hasOwnCloseControl(ref.current));
  });

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
  const scrimClick = dismissible && dismissOnOutsideClick && !addScrim;
  const dialog = (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      className={className}
      onMouseDown={scrimClick ? (event) => { if (event.target === event.currentTarget) onClose(); } : undefined}
    >
      {children}
      {dismissible && !ownClose ? (
        <button type="button" className="nz-drawer-close" data-drawer-close data-drawer-auto aria-label={`Close ${ariaLabel}`} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      ) : null}
    </div>
  );
  if (!addScrim || !dismissible) return dialog;
  return <>
    <div className="nz-drawer-scrim" aria-hidden="true" data-drawer-scrim onMouseDown={onClose} />
    {dialog}
  </>;
}
