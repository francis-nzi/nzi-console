"use client";

// Shared gated-primary-button primitive (WCAG 4.1.2 / the gated-action
// pattern). A `disabled` attribute removes the control from the tab order, so
// a keyboard / screen-reader user can neither reach it NOR hear why it is
// blocked. Instead:
//   - `aria-disabled="true"` while blocked (keeps it focusable);
//   - the onClick is guarded (no-op while blocked);
//   - `aria-describedby` points at the reason text, so a keyboard/SR user
//     reaches the button and hears "N gaps to resolve · M rows unapproved".
// The visual dimmed state is CSS on `[aria-disabled="true"]`, unchanged.
//
// Use this for a PERSISTENT gate (a reason the user can act on), not a
// transient loading state — for "…saving" a plain `disabled` is fine.
import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";

export function GatedButton({
  blocked, blockedReason, onClick, children, className, reasonClassName, ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "aria-disabled"> & {
  blocked: boolean;
  /** Shown next to the button AND announced via aria-describedby while blocked. */
  blockedReason?: ReactNode;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  className?: string;
  reasonClassName?: string;
}) {
  const reasonId = useId();
  const showReason = blocked && blockedReason != null && blockedReason !== "";
  return (
    <>
      <button
        type="button"
        className={className}
        aria-disabled={blocked || undefined}
        aria-describedby={showReason ? reasonId : undefined}
        onClick={(event) => {
          if (blocked) { event.preventDefault(); return; }
          onClick?.(event);
        }}
        {...rest}
      >
        {children}
      </button>
      {showReason && <span id={reasonId} className={reasonClassName ?? "nz-gated-reason"}>{blockedReason}</span>}
    </>
  );
}
