import {ManifestChartSet,crpProfessionalManifest,resolveCrpCoreCharts,validateManifest,verifyChartsAgainstSnapshot,type ChartVerification} from "@nzi/charts";
import type {CrpReportVersionReadModel} from "@nzi/contracts";
import {loadScreen} from "../../lib/loadScreen";
import {ScreenState} from "../../lib/ScreenState";
import {reportFeatureEnabled} from "../../lib/reportFlags";
import {PrintButton} from "./PrintButton";

export const dynamic="force-dynamic";

export default async function ReportVersionPage({params}:{params:Promise<{versionId:string}>}){
  const {versionId}=await params;
  const result=await loadScreen<{report:CrpReportVersionReadModel|null}>("report",{report:null},`report-versions/${versionId}`);
  return <ScreenState result={result}>{data=>data.report
    ?<ReportVersion version={data.report}/>
    :<main className="report-canvas"><section className="nz-empty"><h1>Live report version unavailable</h1><p>Connect this console to the isolated backend to open immutable report evidence.</p><a className="nz-btn" href="/reports">Return to publication studio</a></section></main>}</ScreenState>;
}

function ReportVersion({version}:{version:CrpReportVersionReadModel}){
  const snapshot=version.snapshot;
  const total=snapshot.measurements.reduce((sum,row)=>sum+row.tco2e,0);
  const scopeTotal=(scope:string)=>snapshot.measurements.filter(row=>row.scope===scope).reduce((sum,row)=>sum+row.tco2e,0);

  const core={
    id:snapshot.id,jobId:snapshot.jobId,jobNumber:snapshot.jobNumber,client:snapshot.client,reportingYear:snapshot.reportingYear,
    generatedAt:snapshot.createdAt,dataHash:snapshot.dataHash,target:snapshot.target,intensityTarget:snapshot.intensityTarget,
    annualComparison:snapshot.annualComparison,
    measurements:snapshot.measurements.map(row=>({rowId:row.rowId,scope:row.scope,scopeCode:row.scopeCode,sourceLabel:row.sourceLabel,siteId:row.siteId,siteLabel:row.siteLabel,purchasedGoodsCategoryId:row.purchasedGoodsCategoryId,purchasedGoodsCategoryLabel:row.purchasedGoodsCategoryLabel,tco2e:row.tco2e,factorSet:row.factorSet})),
  };
  const charts=resolveCrpCoreCharts(core);

  // R1 — print-safe chart pack (NZC-050). Behind `report-svg-charts`. When off,
  // the report renders exactly as before.
  const r1=reportFeatureEnabled("report-svg-charts");
  const manifestValid=validateManifest(crpProfessionalManifest,charts,snapshot.id).valid;
  const verification=r1?verifyChartsAgainstSnapshot({measurements:snapshot.measurements,target:snapshot.target,intensityTarget:snapshot.intensityTarget},charts):null;
  // The single deterministic render-complete signal the PDF/print step waits on:
  // the whole tree (sections + every SVG) is in this server-rendered HTML, the
  // manifest validates, and every chart figure reconciles to Outputs.
  const reportReady=r1?(manifestValid&&(verification?.ok??false)):null;

  return <main className="report-canvas">
    <style>{PRINT_CSS}</style>
    <div className="report-toolbar">
      <a href="/reports">← Publication studio</a>
      <div><b>{version.reportVersionId}</b><span>Immutable {version.status} version</span></div>
      <span className={`nz-st ${version.status==="published"?"done":"est"}`}>Manifest v{version.manifestVersion}</span>
      <PrintButton/>
    </div>
    <article className="report-sheet" {...(r1?{"data-report-ready":reportReady?"true":"false"}:{})}>
      <header className="report-cover">
        <div className="report-brand">
          <div className="report-mark">N</div>
          <div><b>NZI Pro</b><span>Verified carbon report</span></div>
          <div className="report-version"><b>{version.reportVersionId}</b><span>Manifest v{version.manifestVersion}</span></div>
        </div>
        <h1>{snapshot.reportingYear} Carbon Reduction Plan</h1>
        <p>{snapshot.client} · {snapshot.jobNumber}</p>
      </header>
      <section className="report-summary">
        <h2>Executive summary</h2>
        <p>{snapshot.client} recorded a reviewed {snapshot.reportingYear} footprint of {total.toLocaleString("en-GB",{maximumFractionDigits:2})} tCO₂e. This immutable report version is assembled only from snapshot {snapshot.id}.</p>
        <div className="report-metrics">{([["Total",total],["Scope 1",scopeTotal("1")],["Scope 2",scopeTotal("2")],["Scope 3",scopeTotal("3")]] as const).map(([label,value])=><div key={label}><span>{label}</span><b>{Number(value).toLocaleString("en-GB",{maximumFractionDigits:2})} tCO₂e</b></div>)}</div>
      </section>
      {r1&&<IntegrityBanner verification={verification!} manifestValid={manifestValid}/>}
      <ManifestChartSet manifest={crpProfessionalManifest} charts={charts} reviewedSnapshotId={snapshot.id} printSafe={r1}/>
      <section className="report-evidence">
        <div>
          <span className="nz-eyebrow">Assurance record</span>
          <h2>Evidence and version record</h2>
          <p>This rendered record is bound to the exact reviewed evidence used at creation.</p>
        </div>
        <dl>
          <div><dt>Reviewed snapshot</dt><dd>{snapshot.id}</dd></div>
          <div><dt>Data hash</dt><dd className="num">{version.dataHash}</dd></div>
          <div><dt>Created by</dt><dd>{snapshot.createdBy} · {new Date(snapshot.createdAt).toLocaleString("en-GB")}</dd></div>
          <div><dt>Publication</dt><dd>{version.publishedAt?new Date(version.publishedAt).toLocaleString("en-GB"):"Validated, not yet published"}</dd></div>
          <div><dt>Version status</dt><dd><span className={`nz-st ${version.status==="published"?"done":"est"}`}>{version.status}</span></dd></div>
        </dl>
      </section>
    </article>
  </main>;
}

/**
 * R1 data-integrity banner. Extends the "totals, categories and rows match
 * Outputs" guarantee to cover charts: every chart figure is recomputed from the
 * reviewed snapshot and reconciled to what the chart carries. A failed check is
 * never rendered as a pass (five explicit states).
 */
function IntegrityBanner({verification,manifestValid}:{verification:ChartVerification;manifestValid:boolean}){
  const mismatches=verification.checks.filter(check=>!check.ok);
  const passed=manifestValid&&verification.ok;
  if(passed){
    return <div className="nz-report-integrity" role="status">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
      <span>Data integrity check passed — every chart figure matches Outputs ({verification.checks.length} check{verification.checks.length===1?"":"s"}). Charts render as print-safe SVG from the reviewed snapshot.</span>
    </div>;
  }
  return <div className="nz-report-integrity fail" role="alert">
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
    <div>
      <b>{!manifestValid?"Report graphics failed manifest validation.":`Data integrity check failed — ${mismatches.length} chart figure${mismatches.length===1?"":"s"} do not match Outputs.`}</b>
      {mismatches.length>0&&<ul>{mismatches.map((check,index)=><li key={`${check.chartId}-${index}`}>{check.label}: chart shows {check.actual.toLocaleString("en-GB",{maximumFractionDigits:2})}, Outputs {check.expected.toLocaleString("en-GB",{maximumFractionDigits:2})}</li>)}</ul>}
    </div>
  </div>;
}

const PRINT_CSS=`@page{size:A4 portrait;margin:14mm 12mm}@media print{html,body{background:white!important}.report-canvas{background:white!important;padding:0!important}.report-toolbar{display:none!important}.report-sheet{border:0!important;border-radius:0!important;box-shadow:none!important;max-width:none!important;margin:0!important;padding:0!important}figure,[data-chart]{break-inside:avoid;page-break-inside:avoid}.nzc-print-safe,.nz-report-integrity{display:none!important}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;
