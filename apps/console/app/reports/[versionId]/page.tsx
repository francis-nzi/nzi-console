import {ManifestChartSet,crpProfessionalManifest,resolveCrpCoreCharts,validateManifest,verifyChartsAgainstSnapshot,type ChartVerification} from "@nzi/charts";
import {buildReportAuditRows,buildReportSiteBreakdown,renderReportSectionBody,verifyReportSectionTokens,type CrpReportVersionReadModel,type ReportSectionReadModel,type SectionTokenVerification} from "@nzi/contracts";
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

const SOURCE_PILL={default:"Default template",ai:"AI-drafted","client-edited":"Edited by client"} as const;

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
  const tokenSnapshot={measurements:snapshot.measurements,target:snapshot.target,intensityTarget:snapshot.intensityTarget,reportingYear:snapshot.reportingYear};

  // R1 (NZC-050) print-safe charts + R3 (NZC-049) data-bound figure tokens. Each
  // behind its own flag; with both off the report renders exactly as before.
  const r1=reportFeatureEnabled("report-svg-charts");
  const r3=reportFeatureEnabled("report-tokens");
  // R5a (NZC-051) — the audit appendices, sourced from the same frozen
  // measurements the tables/charts already read. No new backend.
  const r5=reportFeatureEnabled("report-paged");
  const auditRows=r5?buildReportAuditRows(snapshot.measurements):[];
  const siteBreakdown=r5?buildReportSiteBreakdown(snapshot.measurements):[];
  const manifestValid=validateManifest(crpProfessionalManifest,charts,snapshot.id).valid;
  const chartVerification=r1?verifyChartsAgainstSnapshot(tokenSnapshot,charts):null;
  const tokenVerification=r3?verifyReportSectionTokens(snapshot.sections,tokenSnapshot):null;
  // The single deterministic render-complete signal the PDF/print step waits on:
  // the whole tree is in this server-rendered HTML, the manifest validates, every
  // chart figure reconciles, and every figure token resolves against Outputs.
  const reportReady=(r1||r3)
    ? (manifestValid && (chartVerification?.ok ?? true) && (tokenVerification?.ok ?? true))
    : null;

  return <main className="report-canvas">
    <style>{PRINT_CSS}</style>
    <div className="report-toolbar">
      <a href="/reports">← Publication studio</a>
      <div><b>{version.reportVersionId}</b><span>Immutable {version.status} version</span></div>
      <span className={`nz-st ${version.status==="published"?"done":"est"}`}>Manifest v{version.manifestVersion}</span>
      <PrintButton/>
    </div>
    <article className="report-sheet" {...((r1||r3)?{"data-report-ready":reportReady?"true":"false"}:{})}>
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
        <h2>Reviewed footprint</h2>
        <p>{snapshot.client} · {snapshot.jobNumber} · reviewed snapshot {snapshot.id}.</p>
        <div className="report-metrics">{([["Total",total],["Scope 1",scopeTotal("1")],["Scope 2",scopeTotal("2")],["Scope 3",scopeTotal("3")]] as const).map(([label,value])=><div key={label}><span>{label}</span><b>{Number(value).toLocaleString("en-GB",{maximumFractionDigits:2})} tCO₂e</b></div>)}</div>
      </section>
      {(r1||r3)&&<IntegrityBanner chart={chartVerification} tokens={tokenVerification} manifestValid={manifestValid}/>}
      {r3
        ? <ReportSections sections={snapshot.sections} snapshot={tokenSnapshot}/>
        : <section className="report-summary"><h2>Executive summary</h2><p>{snapshot.client} recorded a reviewed {snapshot.reportingYear} footprint of {total.toLocaleString("en-GB",{maximumFractionDigits:2})} tCO₂e. This immutable report version is assembled only from snapshot {snapshot.id}.</p></section>}
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
      {r5&&<ReportAppendices auditRows={auditRows} sites={siteBreakdown}/>}
    </article>
  </main>;
}

/**
 * R5a (NZC-051) — Appendix 1 (Full Emissions Audit, one row per measurement)
 * and Appendix 2 (Emissions by Site, Scope & Category). Long tables, so they
 * carry the repeating-header / row-atomic print CSS (`PRINT_CSS` below):
 * `thead{display:table-header-group}` + `tr{break-inside:avoid}` — a
 * standards-compliant paged-media table, correctly repaginated by the
 * browser's own print engine (`window.print()` / Save as PDF), no extra
 * pagination library needed for this part of the paged-output problem.
 */
function ReportAppendices({auditRows,sites}:{auditRows:ReturnType<typeof buildReportAuditRows>;sites:ReturnType<typeof buildReportSiteBreakdown>}){
  return <section className="report-appendix" aria-label="Report appendices">
    <div className="report-appendix-h">
      <span className="nz-eyebrow">Appendix 1</span>
      <h2>Full Emissions Audit <span className="report-thead-note">header repeats on every printed page</span></h2>
    </div>
    <div className="report-appendix-scroll">
      <table className="nz-tbl report-audit-table">
        <thead><tr><th>Category</th><th>Activity / source</th><th className="num">Activity data</th><th>Factor</th><th>Quality</th><th>Site</th><th className="num">tCO₂e</th></tr></thead>
        <tbody>
          {auditRows.map(row=><tr key={row.rowId}><td>{row.category}</td><td>{row.sourceLabel}</td><td className="num">{row.quantityLabel}</td><td>{row.factorSet}</td><td>{row.qualityTier}</td><td>{row.siteLabel}</td><td className="num">{row.tco2e.toLocaleString("en-GB",{maximumFractionDigits:2})}</td></tr>)}
          {auditRows.length===0&&<tr><td colSpan={7} className="nz-table-empty">No enabled rows in this reviewed snapshot.</td></tr>}
        </tbody>
      </table>
    </div>
    <div className="report-appendix-h">
      <span className="nz-eyebrow">Appendix 2</span>
      <h2>Emissions by Site, Scope &amp; Category</h2>
    </div>
    {sites.map(site=><div className="report-appendix-scroll" key={site.siteLabel}>
      <table className="nz-tbl report-audit-table">
        <thead><tr><th>{site.siteLabel}</th><th className="num">tCO₂e</th></tr></thead>
        <tbody>
          {site.byScope.map(scope=><FragmentRows key={scope.scope}>
            <tr className="sub"><td>Scope {scope.scope}</td><td className="num">{scope.total.toLocaleString("en-GB",{maximumFractionDigits:2})}</td></tr>
            {scope.categories.map(category=><tr key={category.scopeCode}><td>{category.category}</td><td className="num">{category.tco2e.toLocaleString("en-GB",{maximumFractionDigits:2})}</td></tr>)}
          </FragmentRows>)}
          <tr className="total"><td>Total</td><td className="num">{site.total.toLocaleString("en-GB",{maximumFractionDigits:2})}</td></tr>
        </tbody>
      </table>
    </div>)}
    {sites.length===0&&<p className="muted">No enabled rows in this reviewed snapshot.</p>}
  </section>;
}

function FragmentRows({children}:{children:React.ReactNode}){return <>{children}</>;}

type TokenSnapshot=Parameters<typeof verifyReportSectionTokens>[1];

/**
 * R3 (NZC-049) — the ordered report narrative. Each section's figures are
 * data-bound tokens resolved from the reviewed snapshot at render time and shown
 * as locked chips; the prose around them is the frozen section text. Read-only
 * in R3 — the in-place editor is R4.
 */
function ReportSections({sections,snapshot}:{sections:readonly ReportSectionReadModel[];snapshot:TokenSnapshot}){
  return <section className="report-sections">
    {sections.map(section=><article className="nz-report-section" key={section.key} id={`section-${section.key}`}>
      <div className="nz-report-section-h">
        <h2>{section.title}</h2>
        <span className={`nz-section-source ${section.contentSource}`}>{SOURCE_PILL[section.contentSource]}</span>
      </div>
      <div className="nz-report-section-body" dangerouslySetInnerHTML={{__html:renderReportSectionBody(section.bodyHtml,snapshot)}}/>
    </article>)}
  </section>;
}

/**
 * Report data-integrity banner (R1 charts / R3 figure tokens). Extends the
 * "totals, categories and rows match Outputs" guarantee to charts and to every
 * figure embedded in the narrative. A failed check is never rendered as a pass.
 */
function IntegrityBanner({chart,tokens,manifestValid}:{chart:ChartVerification|null;tokens:SectionTokenVerification|null;manifestValid:boolean}){
  const chartMismatches=chart?chart.checks.filter(c=>!c.ok):[];
  const tokenMismatches=tokens?tokens.tokens.filter(t=>!t.ok):[];
  const chartsOk=!chart||(chart.ok&&manifestValid);
  const tokensOk=!tokens||tokens.ok;
  if(chartsOk&&tokensOk){
    const parts:string[]=[];
    if(chart)parts.push(`every chart figure (${chart.checks.length})`);
    if(tokens)parts.push(`every narrative figure (${tokens.tokens.length})`);
    return <div className="nz-report-integrity" role="status">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
      <span>Data integrity check passed — {parts.join(" and ")} matches Outputs. Figures are bound to the reviewed snapshot and cannot drift.</span>
    </div>;
  }
  return <div className="nz-report-integrity fail" role="alert">
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
    <div>
      <b>Data integrity check failed — {[!manifestValid?"report graphics failed manifest validation":null,chartMismatches.length?`${chartMismatches.length} chart figure${chartMismatches.length===1?"":"s"}`:null,tokenMismatches.length?`${tokenMismatches.length} narrative figure${tokenMismatches.length===1?"":"s"}`:null].filter(Boolean).join(", ")} do not reconcile to Outputs.</b>
      {chartMismatches.length>0&&<ul>{chartMismatches.map((check,index)=><li key={`c-${check.chartId}-${index}`}>{check.label}: chart shows {check.actual.toLocaleString("en-GB",{maximumFractionDigits:2})}, Outputs {check.expected.toLocaleString("en-GB",{maximumFractionDigits:2})}</li>)}</ul>}
      {tokenMismatches.length>0&&<ul>{tokenMismatches.map((token,index)=><li key={`t-${token.sectionKey}-${index}`}>{token.sectionKey} · {token.label}: {token.detail}</li>)}</ul>}
    </div>
  </div>;
}

const PRINT_CSS=`@page{size:A4 portrait;margin:14mm 12mm}@media print{html,body{background:white!important}.report-canvas{background:white!important;padding:0!important}.report-toolbar{display:none!important}.report-sheet{border:0!important;border-radius:0!important;box-shadow:none!important;max-width:none!important;margin:0!important;padding:0!important}figure,[data-chart]{break-inside:avoid;page-break-inside:avoid}.nz-report-section{break-inside:avoid}.nzc-print-safe,.nz-report-integrity,.nz-section-source,.report-thead-note{display:none!important}.nz-fig-token{background:none!important;border:0!important;padding:0!important;color:inherit!important;font-weight:inherit!important}.report-appendix{break-before:page}.report-appendix-scroll{overflow:visible!important}.report-audit-table thead{display:table-header-group}.report-audit-table tr{break-inside:avoid;page-break-inside:avoid}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;
