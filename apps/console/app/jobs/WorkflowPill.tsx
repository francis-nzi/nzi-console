import type { MouseEvent } from "react";

/**
 * The "WF" pill on a scope or category header. It is a link, not a disclosure control: it opens the workflow doc in a new tab and
 * must never toggle the accordion, so its click stops at the pill. No href, no pill — an unmapped header carries nothing.
 */
export function WorkflowPill({ href, label }: { href: string | null; label: string }) {
  if (href === null) return null;
  return (
    <a className="nz-wf" href={href} target="_blank" rel="noopener" aria-label={`${label} workflow (opens in a new tab)`} title={`${label} workflow`}
      onClick={(event: MouseEvent) => event.stopPropagation()}>WF</a>
  );
}
