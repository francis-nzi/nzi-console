import { PRE_COMPOSITION_LABEL } from "../../portal/portalReportView";

/** A version that was issued (published, or published and since superseded) has been sent to the client; a draft or validated one has not. */
export function wasIssued(status: string | undefined): boolean {
  return status === "published" || status === "superseded";
}

/**
 * What the staff report page says when a version has no frozen composition. A version issued before compositions were frozen
 * (pre-0077, ruling D1) is issued — it never gets one, and is labelled as the portal labels it. Only a version never issued
 * reads "not been issued"; when its status is unknown that is the wording kept (the page's behaviour before this).
 */
export function NoCompositionNotice({ versionId, status }: { versionId: string; status?: string }) {
  if (wasIssued(status)) {
    return <main className="report-canvas"><section className="nz-empty"><h1>{PRE_COMPOSITION_LABEL}</h1><p>This version was issued before reports were frozen in full, so no frozen copy of it was stored and none will be made. The measurement it rests on is its reviewed snapshot; the live figures are on the client workspace.</p><a className="nz-btn" href="/reports">Return to publication studio</a></section></main>;
  }
  return <main className="report-canvas"><section className="nz-empty"><h1>This report version has not been issued</h1><p>A report freezes what it says at the moment it is issued. Until then there is nothing fixed to show — the live figures are on the client workspace.</p><p>A validated version can be previewed as it would issue: composed from its frozen snapshot and plan, stored nowhere.</p><a className="nz-btn pri" href={`/reports/${encodeURIComponent(versionId)}/preview`}>Open the composed preview</a> <a className="nz-btn" href="/reports">Return to publication studio</a></section></main>;
}
