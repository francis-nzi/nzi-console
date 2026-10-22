"use client";

import { Collapsible } from "@nzi/ui";
import { formatDateTime } from "../lib/formatDate";

/**
 * A scope row's History, in its own container (portal data-entry phase 2, BUILD §4) — shared by the CRM row drawer and the
 * client's. It used to sit inside Evidence & provenance, which the client's profile hides by default, so a client would have
 * had no History at all; and History is the one thing a client always sees (RULING-portal-dataentry-01, decision 2). Its
 * substance is unchanged: the row's audit events (`listScopeRowAuditEvents`). Loading, failed and empty are three states,
 * never an empty list standing in for a failure.
 */
export type RowHistoryEntry = { id: string; at: string; action: string; by: string; detail?: string };
export type RowHistoryState = "loading" | "ready" | "failed";

export function RowHistory({ state, entries, open, onOpenChange }: { state: RowHistoryState; entries: RowHistoryEntry[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Collapsible title="History" open={open} onOpenChange={onOpenChange}>
      <div data-row-history="">
        {state === "loading" ? <p className="muted" role="status">Loading the row&apos;s history…</p>
          : state === "failed" ? <div className="nz-banner warn" role="alert">The row&apos;s history is unavailable. No events have been inferred.</div>
          : entries.length === 0 ? <p className="muted">No events are recorded for this row yet.</p>
          : <div>{entries.map((entry) => <div className="nz-lin" key={entry.id}><div className="stepl"><b>{entry.action}</b><small>{formatDateTime(entry.at)} · {entry.by}</small>{entry.detail ? <small className="num">{entry.detail}</small> : null}</div></div>)}</div>}
      </div>
    </Collapsible>
  );
}
