import type { SrsReportReadModel } from "@nzi/isolated-backend";
import { loadScreen } from "../../../lib/loadScreen";
import { ScreenState } from "../../../lib/ScreenState";
import { SrsReportDocument } from "./SrsReportDocument";
import { SrsReportPrint } from "./SrsReportPrint";
import "./srs-report.css";

export const dynamic = "force-dynamic";

/**
 * SRS S3 — a client's UK SRS readiness report, ready to print or save as a PDF (srs.manage on the client). The template
 * (`?template=`, UK SRS by default) decides the sections; the latest completed assessment is drawn unless `?assessment=`
 * names another completed one.
 */
export default async function SrsReportPage({ params, searchParams }: {
  params: Promise<{ clientId: string }>; searchParams: Promise<{ assessment?: string; template?: string }>;
}) {
  const { clientId } = await params;
  const { assessment, template } = await searchParams;
  const query = new URLSearchParams({ ...(assessment ? { assessment } : {}), template: template ?? "uk-srs" });
  const result = await loadScreen<SrsReportReadModel>("srsReport", { state: "none", reason: "Connect this console to the isolated backend to draw a report." },
    `clients/${encodeURIComponent(clientId)}/srs-report?${query.toString()}`);
  return <ScreenState result={result}>{(report) => report.state === "none"
    ? <main className="nzsr-page"><section className="nz-empty"><h1>No readiness report to draw</h1><p>{report.reason}</p>
      <a className="nz-btn" href={`/clients/${encodeURIComponent(clientId)}?area=srs`}>Back to UK SRS Readiness</a></section></main>
    : <main className="nzsr-page">
      <div className="nzsr-toolbar">
        <a className="nz-btn" href={`/clients/${encodeURIComponent(clientId)}?area=srs`}>Back to the client</a>
        <span className="sp" />
        <SrsReportPrint assessmentId={report.assessment.id} templateKey={report.template.key} />
      </div>
      <SrsReportDocument report={report} />
    </main>}</ScreenState>;
}
