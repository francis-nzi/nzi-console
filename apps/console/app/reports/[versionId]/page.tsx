import { ManifestChartSet, crpChartSamples, crpProfessionalManifest } from "@nzi/charts";
import { findReportVersion, reportVersions } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { notFound } from "next/navigation";
import { ScreenState } from "../../lib/ScreenState";
import { PrintButton } from "./PrintButton";

export function generateStaticParams() { return reportVersions.map((version) => ({ versionId: version.id })); }
export default async function ReportVersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const version = findReportVersion(versionId);
  if (!version) notFound();
  const result = loadFixtureScreen<{ report: typeof version }>("report", { report: version });
  return <ScreenState result={result}>{(data) => <ReportVersion version={data.report} />}</ScreenState>;
}
function ReportVersion({ version }: { version: NonNullable<ReturnType<typeof findReportVersion>> }) {
  return <main className="report-canvas">
    <style>{`@page{size:A4 portrait;margin:14mm 12mm}@media print{html,body{background:white!important}.report-canvas{background:white!important;padding:0!important}.report-toolbar{display:none!important}.report-sheet{border:0!important;border-radius:0!important;box-shadow:none!important;max-width:none!important;margin:0!important;padding:0!important}.report-sheet>header{break-after:avoid}.report-sheet>section:last-child{break-inside:avoid}[data-report-manifest]>section>div{grid-template-columns:1fr!important}figure,[data-chart]{break-inside:avoid;page-break-inside:avoid}section{break-inside:auto}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`}</style>
    <div className="report-toolbar"><a href="/reports">← Publication studio</a><div><b>{version.id}</b><span>Immutable {version.status} version</span></div><span className="nz-st done">Manifest v{version.manifestVersion}</span><PrintButton /></div>
    <article className="report-sheet">
      <header className="report-cover"><div className="report-brand"><div className="report-mark">N</div><div><b>NZI Pro</b><span>Verified carbon report</span></div><div className="report-version"><b>{version.id}</b><span>Manifest v{version.manifestVersion}</span></div></div><h1>2024 Carbon Reduction Plan</h1><p>{version.client} · {version.jobNumber}</p></header>
      <section className="report-summary"><h2>Executive summary</h2><p>Bushy Tails Ltd recorded a reviewed 2024 footprint of 1,418 tCO₂e. Scope 3 remains the largest source of emissions, led by purchased goods and upstream freight. This immutable report version is assembled from the reviewed job snapshot and its versioned chart manifest.</p><div className="report-metrics">{[["Total", "1,418 tCO₂e"], ["Scope 1", "146 tCO₂e"], ["Scope 2", "96 tCO₂e"], ["Scope 3", "1,176 tCO₂e"]].map(([label,value])=><div key={label}><span>{label}</span><b>{value}</b></div>)}</div></section>
      <ManifestChartSet manifest={crpProfessionalManifest} charts={crpChartSamples} reviewedSnapshotId={version.reviewedSnapshotId} />
      <section className="report-evidence"><div><span className="nz-eyebrow">Assurance record</span><h2>Evidence and version record</h2><p>This record binds the rendered report to the exact reviewed evidence used at creation.</p></div><dl><div><dt>Reviewed snapshot</dt><dd>{version.reviewedSnapshotId}</dd></div><div><dt>Data hash</dt><dd className="num">{version.dataHash}</dd></div><div><dt>Template</dt><dd>{version.templateId} · v{version.templateVersion}</dd></div><div><dt>Created by</dt><dd>{version.createdBy} · {version.createdAt}</dd></div><div><dt>Version status</dt><dd><span className="nz-st done">{version.status}</span></dd></div></dl></section>
    </article>
  </main>;
}
