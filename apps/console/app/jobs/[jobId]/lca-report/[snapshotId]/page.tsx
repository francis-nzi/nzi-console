import { ManifestChartSet, lcaProfessionalManifest, pcfProfessionalManifest, resolveLcaCharts, validateManifest, verifyLcaChartsAgainstSnapshot, type ReviewedLcaSnapshot } from "@nzi/charts";
import type { LcaReportReadModel } from "@nzi/isolated-backend";
import { loadScreen } from "../../../../lib/loadScreen";
import { ScreenState } from "../../../../lib/ScreenState";
import { jobModuleEnabled } from "../../../../lib/jobModuleFlags";
import { PrintButton } from "../../../../reports/[versionId]/PrintButton";
import { ReportPagedView } from "../../../../reports/[versionId]/ReportPagedView";
import { REPORT_PAGED_MEDIA_RULES } from "../../../../reports/[versionId]/reportPrintRules";
import { formatDateTime } from "../../../../lib/formatDate";

export const dynamic = "force-dynamic";

const MODULE_LABEL: Record<string, string> = {
  A1: "A1 · Raw material supply", A2: "A2 · Transport to manufacturer", A3: "A3 · Manufacturing",
  A4: "A4 · Transport to site/user", A5: "A5 · Construction / installation",
  B1: "B1 · Use", B2: "B2 · Maintenance", B3: "B3 · Repair", B4: "B4 · Replacement", B5: "B5 · Refurbishment",
  B6: "B6 · Operational energy", B7: "B7 · Operational water",
  C1: "C1 · Deconstruction", C2: "C2 · Transport to waste", C3: "C3 · Waste processing", C4: "C4 · Disposal",
  D: "D · Beyond the boundary",
};

export default async function LcaReportPage({ params }: { params: Promise<{ jobId: string; snapshotId: string }> }) {
  const { jobId, snapshotId } = await params;
  if (!jobModuleEnabled("job-module-lca")) {
    return <main className="report-canvas"><section className="nz-empty"><h1>LCA report unavailable</h1><p>The LCA/PCF job-family module is not enabled on this environment.</p><a className="nz-btn" href={`/jobs/${jobId}`}>Back to the job</a></section></main>;
  }
  const result = await loadScreen<{ report: LcaReportReadModel | null }>("lcaReport", { report: null }, `jobs/${jobId}/lca-report/${snapshotId}`);
  return <ScreenState result={result}>{(data) => data.report
    ? <LcaReport report={data.report} />
    : <main className="report-canvas"><section className="nz-empty"><h1>Frozen result snapshot not found</h1><p>An LCA/PCF report is built only from a signed-off, frozen result snapshot.</p><a className="nz-btn" href={`/jobs/${jobId}`}>Back to the job</a></section></main>}</ScreenState>;
}

const PRINT_CSS = `@page{size:A4 portrait;margin:14mm 12mm}@media print{${REPORT_PAGED_MEDIA_RULES}}`;

function LcaReport({ report }: { report: LcaReportReadModel }) {
  const { snapshot } = report;
  const noun = report.isPcf ? "Product Carbon Footprint" : "Life-cycle Assessment";
  const standardNote = report.isPcf ? "ISO 14067" : report.standard;
  const perFu = report.functionalUnitValue > 0 ? snapshot.totalTco2e / report.functionalUnitValue : 0;

  const reviewed: ReviewedLcaSnapshot = {
    id: snapshot.id, jobId: report.jobId, jobNumber: report.jobNumber, client: report.client,
    assessmentName: report.assessmentName, functionalUnit: report.functionalUnitUnit, standard: report.standard,
    isPcf: report.isPcf, generatedAt: report.calculatedAt, dataHash: snapshot.dataHash,
    factorSets: snapshot.factorSets.map((f) => `${f.label} · ${f.dataset}${f.version && f.version !== "—" ? ` ${f.version}` : ""}`),
    totalTco2e: snapshot.totalTco2e, moduleBreakdown: snapshot.moduleBreakdown,
    hotspots: snapshot.hotspots.map((h) => ({ lineItemId: h.lineItemId, label: h.label, tco2e: h.tco2e, sharePct: h.sharePct, moduleCode: h.moduleCode })),
  };
  const charts = resolveLcaCharts(reviewed);
  const manifest = report.isPcf ? pcfProfessionalManifest : lcaProfessionalManifest;
  const manifestValid = validateManifest(manifest, charts, snapshot.id).valid;
  const figures = verifyLcaChartsAgainstSnapshot({ totalTco2e: snapshot.totalTco2e, moduleBreakdown: snapshot.moduleBreakdown }, charts);
  const reportReady = manifestValid && figures.ok;

  const article = (
    <article className="report-sheet" data-report-ready={reportReady ? "true" : "false"}>
      <header className="report-cover">
        <div className="report-brand">
          <div className="report-mark">N</div>
          <div><b>NZI Pro</b><span>{noun}</span></div>
          <div className="report-version"><b>{snapshot.id.slice(0, 8)}</b><span>Assessment v{snapshot.assessmentVersion}</span></div>
        </div>
        <h1>{noun} — {report.assessmentName}</h1>
        <p>{report.client} · {report.jobNumber} · {standardNote}{report.geography ? ` · ${report.geography}` : ""}{report.referenceYear ? ` · reference year ${report.referenceYear}` : ""}</p>
      </header>

      <section className="report-summary">
        <h2>Reviewed footprint</h2>
        <p>Functional unit: {report.functionalUnitValue.toLocaleString("en-GB")} {report.functionalUnitUnit} · boundary {report.lifecycleBoundary.replaceAll("_", " ")} · reviewed snapshot {snapshot.id}.</p>
        <div className="report-metrics">
          <div><span>Total</span><b>{snapshot.totalTco2e.toLocaleString("en-GB", { maximumFractionDigits: 4 })} tCO₂e</b></div>
          <div><span>Per {report.functionalUnitUnit}</span><b>{perFu.toLocaleString("en-GB", { maximumFractionDigits: 6 })} tCO₂e</b></div>
          <div><span>Modules with data</span><b>{snapshot.moduleBreakdown.length}</b></div>
          <div><span>Mass reconciliation</span><b>{snapshot.massReconciliation.deltaPct == null ? "n/a" : `${snapshot.massReconciliation.deltaPct > 0 ? "+" : ""}${snapshot.massReconciliation.deltaPct.toFixed(1)}%`}</b></div>
        </div>
      </section>

      <div className={`nz-report-integrity${reportReady ? "" : " fail"}`} role={reportReady ? "status" : "alert"}>
        <span>{reportReady
          ? `Data integrity check passed — every chart figure (${figures.checks.length}) matches the reviewed snapshot. Figures are bound to ${snapshot.dataHash.slice(0, 22)}… and cannot drift.`
          : "Data integrity check failed — a chart figure does not reconcile to the reviewed snapshot. Publication is blocked."}</span>
      </div>

      <ManifestChartSet manifest={manifest} charts={charts} reviewedSnapshotId={snapshot.id} printSafe />

      <section className="report-sections">
        <article className="nz-report-section">
          <div className="nz-report-section-h"><h2>Emissions by life-cycle module</h2></div>
          <div className="report-appendix-scroll">
            <table className="nz-tbl report-audit-table">
              <thead><tr><th>EN 15804 module</th><th className="num">tCO₂e</th><th className="num">Share</th></tr></thead>
              <tbody>
                {snapshot.moduleBreakdown.map((entry) => (
                  <tr key={entry.moduleCode}>
                    <td>{MODULE_LABEL[entry.moduleCode] ?? entry.moduleCode}</td>
                    <td className="num">{entry.tco2e.toLocaleString("en-GB", { maximumFractionDigits: 4 })}</td>
                    <td className="num">{snapshot.totalTco2e > 0 ? `${((entry.tco2e / snapshot.totalTco2e) * 100).toFixed(1)}%` : "—"}</td>
                  </tr>
                ))}
                <tr className="total"><td>Total</td><td className="num">{snapshot.totalTco2e.toLocaleString("en-GB", { maximumFractionDigits: 4 })}</td><td className="num">100%</td></tr>
              </tbody>
            </table>
          </div>
        </article>

        <article className="nz-report-section">
          <div className="nz-report-section-h"><h2>Emission hotspots</h2></div>
          <div className="report-appendix-scroll">
            <table className="nz-tbl report-audit-table">
              <thead><tr><th>Line item</th><th>Module</th><th className="num">tCO₂e</th><th className="num">Share of total</th></tr></thead>
              <tbody>
                {snapshot.hotspots.map((h) => (
                  <tr key={h.lineItemId}><td>{h.label}</td><td>{h.moduleCode}</td><td className="num">{h.tco2e.toLocaleString("en-GB", { maximumFractionDigits: 4 })}</td><td className="num">{h.sharePct.toFixed(0)}%</td></tr>
                ))}
                {snapshot.hotspots.length === 0 && <tr><td colSpan={4} className="nz-table-empty">No calculated contributors in the reviewed snapshot.</td></tr>}
              </tbody>
            </table>
          </div>
        </article>

        <article className="nz-report-section">
          <div className="nz-report-section-h"><h2>Mass reconciliation</h2></div>
          <p>
            Confirmed product mass {snapshot.massReconciliation.confirmedMassKg == null ? "not stated" : `${snapshot.massReconciliation.confirmedMassKg.toLocaleString("en-GB", { maximumFractionDigits: 2 })} kg`};
            captured (A1 raw-material inventory) {snapshot.massReconciliation.capturedMassKg.toLocaleString("en-GB", { maximumFractionDigits: 2 })} kg
            {snapshot.massReconciliation.deltaPct != null && ` — a ${snapshot.massReconciliation.deltaPct > 0 ? "+" : ""}${snapshot.massReconciliation.deltaPct.toFixed(1)}% difference`}.
          </p>
        </article>
      </section>

      <section className="report-appendix" aria-label="Emission factor citation">
        <div className="report-appendix-h">
          <span className="nz-eyebrow">Appendix</span>
          <h2>Emission factors used <span className="report-thead-note">frozen at sign-off</span></h2>
        </div>
        <div className="report-appendix-scroll">
          <table className="nz-tbl report-audit-table">
            <thead><tr><th>Factor</th><th>Dataset</th><th>Version</th><th>Reference</th></tr></thead>
            <tbody>
              {snapshot.factorSets.map((f, i) => (
                <tr key={`${f.originalId}-${i}`}><td>{f.label}</td><td>{f.dataset}</td><td>{f.version}</td><td className="num">{f.originalId}</td></tr>
              ))}
              {snapshot.factorSets.length === 0 && <tr><td colSpan={4} className="nz-table-empty">No mapped factors in this reviewed snapshot.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="report-evidence">
        <div>
          <span className="nz-eyebrow">Assurance record</span>
          <h2>Evidence and version record</h2>
          <p>This rendered {noun.toLowerCase()} report is bound to the exact frozen result snapshot signed off at review. The factor citation above is what was used at sign-off, not the current mapping.</p>
        </div>
        <dl>
          <div><dt>Reviewed snapshot</dt><dd>{snapshot.id}</dd></div>
          <div><dt>Data hash</dt><dd className="num">{snapshot.dataHash}</dd></div>
          <div><dt>Assessment version</dt><dd>v{snapshot.assessmentVersion}</dd></div>
          <div><dt>Calculated by</dt><dd>{report.calculatedBy} · {formatDateTime(report.calculatedAt)}</dd></div>
          <div><dt>Standard</dt><dd>{standardNote}</dd></div>
        </dl>
      </section>
    </article>
  );

  return (
    <main className="report-canvas">
      <style>{PRINT_CSS}</style>
      <div className="report-toolbar">
        <a href={`/jobs/${report.jobId}`}>← Back to the job</a>
        <div><b>{noun}</b><span>{report.assessmentName} · frozen snapshot</span></div>
        <PrintButton />
      </div>
      <ReportPagedView meta={{ client: report.client, jobNumber: report.jobNumber, reportingYear: report.referenceYear ?? new Date().getUTCFullYear(), documentTitle: `${noun} · ${report.assessmentName}` }}>
        {article}
      </ReportPagedView>
    </main>
  );
}
