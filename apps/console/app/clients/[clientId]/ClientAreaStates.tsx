"use client";

import Link from "next/link";
import { CLIENT_AREA_LABELS, type ClientAreaId } from "./clientAreas";

/**
 * Truth before apparent availability: an area whose backend is not built says so, in its
 * own words, and says where the work stands. It never renders an empty table that reads
 * like "this client has nothing".
 */

const NOT_YET: Partial<Record<ClientAreaId, { what: string; when: string }>> = {
  reporting: { what: "the report list with per-report open, version and PDF", when: "the next phase of this rebuild — the report evidence itself is already live under Reports." },
  actions: { what: "the qualitative action tracker", when: "the next phase; the action-lever library it will eventually read is a separate piece of work." },
  srs: { what: "the SRS readiness summary", when: "the next phase of this rebuild." },
  tasks: { what: "client-scoped tasks", when: "the next phase, wired to its backend when one exists." },
  notes: { what: "client notes", when: "the next phase, wired to its backend when one exists." },
  files: { what: "the client files list", when: "the next phase, wired to its backend when one exists." },
  comms: { what: "client communications", when: "the next phase, wired to its backend when one exists." },
  profile: { what: "the company profile screen", when: "the next phase. Its fields are editable now through the identity, address and compliance drawers on Overview." },
  ai: { what: "the grounded advisory context", when: "the next phase, kept clearly separate from the evidence base." },
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
