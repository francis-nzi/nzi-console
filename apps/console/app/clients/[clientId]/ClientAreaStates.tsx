"use client";

import Link from "next/link";
import { CLIENT_AREA_LABELS, type ClientAreaId } from "./clientAreas";

/**
 * Truth before apparent availability: an area whose backend is not built says so, in its
 * own words, and says where the work stands. It never renders an empty table that reads
 * like "this client has nothing".
 */

const NOT_YET: Partial<Record<ClientAreaId, { what: string; when: string }>> = {
  actions: { what: "the client's decarbonisation plan, assembled from the action-lever catalogue", when: "the action-lever library, which is its own piece of work and in progress now." },
  // No table, no route, no commands — nothing to wire. Saying so beats an empty list that
  // reads as "this client has no tasks" when the truth is that tasks are not built.
  tasks: { what: "client-scoped tasks with an owner and a due date", when: "a task store — there is no tasks table, route or command in this platform yet, so nothing can be shown." },
  notes: { what: "client notes", when: "a notes store — notes exist today only on a job's scope rows and stage changes, never against the client itself." },
};

export function UnavailableArea({ area, clientId }: { area: ClientAreaId; clientId: string }) {
  const detail = NOT_YET[area];
  return <section className="nz-panel" aria-labelledby={`area-${area}`}>
    <div className="nz-card-h"><span className="eyebrow">Not available yet</span><h2 id={`area-${area}`}>{CLIENT_AREA_LABELS[area]}</h2></div>
    <div className="nz-card-b">
      <p className="sub" style={{ margin: "8px 0" }}>
        {detail ? <>This area will show <b>{detail.what}</b>. It arrives with {detail.when}</> : <>This area is part of the approved workspace design and has not been built yet.</>}
      </p>
      <p className="nz-maps">Nothing is shown here rather than a placeholder that could be mistaken for real client data.</p>
      <Link className="nz-btn" href={`/clients/${encodeURIComponent(clientId)}`}>Back to overview</Link>
    </div>
  </section>;
}

/** The commercial ledger is held (NZC-069) — this says that, rather than showing the unreviewed one. */
export function FinancialsHeldArea() {
  return <section className="nz-panel" aria-labelledby="area-financials">
    <div className="nz-card-h"><span className="eyebrow">Held</span><h2 id="area-financials">Financials</h2><span className="sp" /><span className="nz-st need">On hold</span></div>
    <div className="nz-card-b">
      <p className="sub" style={{ margin: "8px 0" }}>The commercial ledger — quotes, invoices, credit notes and their Xero projection — arrives with the dedicated quotes/invoices exercise (<b>NZC-069</b>). It is built on its own branch and is not merged.</p>
      <p className="nz-maps">No ledger figures are shown here. An unreviewed one would read as this client&apos;s commercial position, and it has not been through that review.</p>
    </div>
  </section>;
}

/** A card-sized version of the same truth, for the Overview right column. */
export function FinancialStatusCard() {
  return <div className="nz-card-b">
    <p className="sub" style={{ margin: "6px 0" }}>Quotes, invoices and outstanding balance arrive with the quotes/invoices work (NZC-069). Nothing is shown until that lands.</p>
  </div>;
}
