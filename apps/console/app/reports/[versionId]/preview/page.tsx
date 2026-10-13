import type { ReportComposition } from "@nzi/contracts";
import { loadScreen } from "../../../lib/loadScreen";
import { ScreenState } from "../../../lib/ScreenState";
import { formatDateTime } from "../../../lib/formatDate";
import { ReportComposedView } from "../ReportComposedView";
import "../report-composed.css";

export const dynamic = "force-dynamic";

/**
 * B0 (RULING-report-studio-consolidation) — the composed preview of a validated report version: exactly what publish would
 * freeze (the same composition, from the same snapshot and plan), composed now and stored nowhere, under a band that says so.
 * It is how the composed report is reviewed before anything is issued. A published version is shown from its frozen
 * composition at /reports/[versionId], never here.
 */
export default async function ReportCompositionPreviewPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const result = await loadScreen<{ preview: { composition: ReportComposition; previewedAt: string } | null }>(
    "reportCompositionPreview", { preview: null }, `report-versions/${versionId}/composition/preview`);
  return <ScreenState result={result}>{(data) => data.preview
    ? <>
      <div className="report-preview-band" role="note" data-report-preview="not-issued">
        <b>Preview — not issued.</b> Composed {formatDateTime(data.preview.previewedAt)} from this version&rsquo;s frozen snapshot and section plan, exactly as publishing
        would issue it. Nothing here is stored or sent; publishing freezes the report.
      </div>
      <ReportComposedView composition={data.preview.composition} />
    </>
    : <main className="report-canvas"><section className="nz-empty"><h1>Nothing to preview</h1>
      <p>Only a validated report version has a composed preview. A published version is the issued report itself.</p>
      <a className="nz-btn" href={`/reports/${encodeURIComponent(versionId)}`}>Open this report version</a></section></main>}</ScreenState>;
}
