"use client";

// Shared info tooltip - one i that reveals its help text on demand, replacing the standing instruction paragraphs across data entry (data-entry UX
// review item 3). A real <button>: keyboard-reachable, toggles on click / Enter / Space, dismisses on Escape or an outside tap / click / focus.
//
// **Where the popover lives.** It used to be positioned *inside* the wrapper, so any ancestor with `overflow: hidden | auto | clip` (the accordion's
// category cards, panels, drawers' scrollers) cut it off and it could not be read. The visible popover is now drawn in a portal on <body>, fixed to
// the viewport and placed from the trigger's own rectangle: nothing between the button and the page can clip it, it sits above its siblings and the
// drawer, and it takes no space in the flow (no layout shift). It flips above the button when there is no room below and is kept inside the viewport.
//
// **Accessibility.** The text stays in the DOM beside the button at all times (visually hidden) so `aria-describedby` works without opening
// anything; the floating copy is `aria-hidden` so a screen reader does not read it twice.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The gap between the button and the popover, and the margin kept to the viewport's edges, in px. */
export const INFOTIP_GAP = 6;
export const INFOTIP_MARGIN = 8;

type Box = { top: number; left: number; right: number; bottom: number; width: number; height: number };

/**
 * Where the popover goes, as viewport coordinates. Below the trigger, left-aligned to it, unless it would run off the bottom and there is room above
 * (then above); shifted left to stay inside the right edge, and never past the left. Pure, so it is tested without a browser.
 */
export function placeInfoTip(trigger: Box, pop: { width: number; height: number }, viewport: { width: number; height: number }): { top: number; left: number; placement: "below" | "above"; arrowLeft: number } {
  const roomBelow = viewport.height - trigger.bottom - INFOTIP_GAP - INFOTIP_MARGIN;
  const roomAbove = trigger.top - INFOTIP_GAP - INFOTIP_MARGIN;
  const placement = pop.height > roomBelow && roomAbove > roomBelow ? "above" : "below";
  const maxLeft = Math.max(INFOTIP_MARGIN, viewport.width - pop.width - INFOTIP_MARGIN);
  const left = Math.min(Math.max(trigger.left, INFOTIP_MARGIN), maxLeft);
  const top = placement === "below" ? trigger.bottom + INFOTIP_GAP : Math.max(INFOTIP_MARGIN, trigger.top - INFOTIP_GAP - pop.height);
  // The arrow points at the middle of the button, wherever the popover had to shift to.
  const arrowLeft = Math.min(Math.max(trigger.left + trigger.width / 2 - left - 5, 6), Math.max(6, pop.width - 16));
  return { top, left, placement, arrowLeft };
}

export function InfoTip({ label, children, className }: {
  /** What the icon is about - used for its accessible name ("About <label>"). */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const [placement, setPlacement] = useState<"below" | "above">("below");
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const floatRef = useRef<HTMLSpanElement | null>(null);
  const tipId = useId();

  const place = useCallback(() => {
    const button = btnRef.current, pop = floatRef.current;
    if (!button || !pop) return;
    const trigger = button.getBoundingClientRect();
    const spot = placeInfoTip(trigger, { width: pop.offsetWidth, height: pop.offsetHeight }, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
    setPlacement(spot.placement);
    setStyle({ top: spot.top, left: spot.left, ["--arrow-left" as string]: `${spot.arrowLeft}px` });
  }, []);

  // Measured before paint, so the popover never flashes at the wrong place.
  useLayoutEffect(() => { if (open) place(); else setStyle(null); }, [open, place]);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(event: Event) {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || floatRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.stopPropagation(); setOpen(false); btnRef.current?.focus(); }
    }
    // Anything that moves the button moves the popover with it: a scroll in any ancestor (capture), a resize, or the keyboard opening on a phone.
    const follow = () => place();
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("focusin", onDocPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    window.visualViewport?.addEventListener("resize", follow);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer, true);
      document.removeEventListener("focusin", onDocPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      window.visualViewport?.removeEventListener("resize", follow);
    };
  }, [open, place]);

  return (
    <span className={`nz-infotip${open ? " open" : ""}${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className="nz-infotip-btn"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-describedby={tipId}
        onClick={() => setOpen((value) => !value)}
      >
        i
      </button>
      {/* Always in the DOM and the a11y tree (so `aria-describedby` works without opening); clipped out of sight - the visible copy is the portal below. */}
      <span id={tipId} role="tooltip" className="nz-infotip-pop">{children}</span>
      {open && typeof document !== "undefined" ? createPortal(
        <span ref={floatRef} aria-hidden="true" className={`nz-infotip-float ${placement}`} style={style ?? { visibility: "hidden", top: 0, left: 0 }}>{children}</span>,
        document.body,
      ) : null}
    </span>
  );
}
