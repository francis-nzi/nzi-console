"use client";

import { createContext, useContext } from "react";

/**
 * The seam between the design system and the app's help system.
 *
 * `TopBar` is rendered by seventeen pages, so the affordance has to come from inside it —
 * asking every page to pass one would guarantee that some page eventually doesn't have it,
 * which is the one thing "on every page" cannot tolerate.
 *
 * The context is declared here so both halves import the same object: `@nzi/ui` owns the
 * button, the app owns the drawer and provides the opener. Nothing about the help system's
 * content leaks into the design system.
 *
 * With no provider the button simply does not render — a page outside the app shell is not
 * broken by its absence.
 */

export type HelpControl = {
  open: () => void;
  /** So the button can say "close" while the drawer is open, rather than lying. */
  isOpen: boolean;
  /**
   * What the button announces. Supplied by the app, because what help *contains* is the
   * app's business — hard-coding "tours and the knowledge library" here would put product
   * features inside the design system, where they would then have to be kept in step.
   */
  label?: string;
};

export const HelpContext = createContext<HelpControl | null>(null);

export function useHelpControl(): HelpControl | null {
  return useContext(HelpContext);
}

/**
 * The `?` in the top bar. Always in the same place, keyboard-reachable, and labelled by what
 * it does rather than by its glyph.
 */
export function HelpAffordance() {
  const help = useHelpControl();
  if (help === null) return null;
  return (
    <button
      type="button"
      className={help.isOpen ? "nz-help-btn open" : "nz-help-btn"}
      onClick={help.open}
      aria-expanded={help.isOpen}
      aria-haspopup="dialog"
      aria-label={help.isOpen ? "Close help" : help.label ?? "Help"}
      title="Help"
    >
      <span aria-hidden="true">?</span>
    </button>
  );
}
