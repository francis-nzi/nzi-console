import { ChartProof } from "../charts/ChartProof";
import {
  EmissionsByActivity,
  EmissionsScopeDonut,
  EmissionsSiteDonut,
  IntensityPathway,
  ManifestChartSet,
  PurchasedGoodsBreakdown,
  ReductionPathway,
  ScopeYearOnYearBar,
  crpProfessionalManifest,
  emissionsByActivitySample,
  emissionsSiteDonutSample,
  intensityPathwaySample,
  purchasedGoodsBreakdownSample,
  reductionPathwaySample,
  resolveCrpCoreCharts,
  scopeDonutSample,
  scopeYearOnYearSample,
} from "@nzi/charts";
import { loadFixtureScreen } from "@nzi/api-client";
import type { ReviewedCrpSnapshotReadModel } from "@nzi/contracts";
import type { EmissionsByActivityData,IntensityPathwayData,PurchasedGoodsBreakdownData,ReductionPathwayData,ScopeDonutData,ScopeYearOnYearData,SiteDonutData } from "@nzi/charts";
import { ScreenState } from "../lib/ScreenState";
import { loadScreen } from "../lib/loadScreen";
import {validateManifest} from "@nzi/charts";
import {ReportValidationAction} from "./ReportValidationAction";

export default async function ReportPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ jobId?: string }>;
}) {
  const { jobId } = await searchParams;
  if (jobId) {
    const result = await loadScreen<{
      snapshots: ReviewedCrpSnapshotReadModel[];
    }>(
      "reviewedSnapshots",
      { snapshots: [] },
      `jobs/${jobId}/reviewed-snapshots`,
    );
    return (
      <ScreenState result={result}>
        {(data) => data.snapshots[0] ? <LiveSnapshotPreview snapshot={data.snapshots[0]} /> : <PreviewEmpty jobId={jobId} />}
      </ScreenState>
    );
  }
  const result = loadFixtureScreen("report", {
    report: {
      id: "CRP-J000712-preview",
      reviewedSnapshotId: "reviewed-crp-J000712-v1",
    },
  });
  return (
    <ScreenState result={result}>
      {() => (
        <main className="nz-preview-canvas">
          <section className="nz-preview-sheet">
            <header className="nz-preview-head"><span className="nz-eyebrow">NZI Professional Report · J000712</span><h1>Carbon performance</h1><p>Print/PDF preview · same reviewed chart objects</p><span className="nz-st est">Fixture preview</span></header>
            <ChartProof target="print" label="Print and PDF" />
            <section className="nz-preview-review"><div className="nz-section-intro"><div><span className="nz-eyebrow">Large-format chart review</span><h2>Full-width report graphics</h2><p>The same chart components and reviewed data, each shown in its own larger container.</p></div></div><div className="nz-preview-stack"><EmissionsScopeDonut data={scopeDonutSample}/><ReductionPathway data={reductionPathwaySample}/><ScopeYearOnYearBar data={scopeYearOnYearSample}/><EmissionsByActivity data={emissionsByActivitySample}/><EmissionsSiteDonut data={emissionsSiteDonutSample}/><IntensityPathway data={intensityPathwaySample}/><PurchasedGoodsBreakdown data={purchasedGoodsBreakdownSample}/></div></section>
          </section>
        </main>
      )}
    </ScreenState>
  );
}

function LiveSnapshotPreview({
  snapshot,
}: {
  snapshot: ReviewedCrpSnapshotReadModel;
}) {
  const charts = resolveCrpCoreCharts({
    id: snapshot.id,
    jobId: snapshot.jobId,
    jobNumber: snapshot.jobNumber,
    client: snapshot.client,
    reportingYear: snapshot.reportingYear,
    generatedAt: snapshot.createdAt,
    dataHash: snapshot.dataHash,
    target: snapshot.target,
    intensityTarget:snapshot.intensityTarget,
    annualComparison:snapshot.annualComparison,
    measurements: snapshot.measurements.map((row) => ({
      rowId: row.rowId,
      scope: row.scope,
      sourceLabel: row.sourceLabel,
      tco2e: row.tco2e,
      factorSet: row.factorSet,
      siteId:row.siteId,
      siteLabel:row.siteLabel,
      scopeCode:row.scopeCode,
      purchasedGoodsCategoryId:row.purchasedGoodsCategoryId,
      purchasedGoodsCategoryLabel:row.purchasedGoodsCategoryLabel,
    })),
  });
  const scope=charts.find(chart=>chart.spec.type==="emissions_scope_donut") as ScopeDonutData;
  const activities=charts.find(chart=>chart.spec.type==="emissions_by_activity") as EmissionsByActivityData;
  const pathway=charts.find(chart=>chart.spec.type==="reduction_pathway") as ReductionPathwayData|undefined;
  const annual=charts.find(chart=>chart.spec.type==="scope_year_on_year_bar") as ScopeYearOnYearData|undefined;
  const sites=charts.find(chart=>chart.spec.type==="emissions_site_donut") as SiteDonutData|undefined;
  const intensity=charts.find(chart=>chart.spec.type==="intensity_pathway") as IntensityPathwayData|undefined;
  const purchasedGoods=charts.find(chart=>chart.spec.type==="purchased_goods_breakdown") as PurchasedGoodsBreakdownData|undefined;
  const validation=validateManifest(crpProfessionalManifest,charts,snapshot.id);
  return (
    <main className="nz-preview-canvas">
      <section className="nz-preview-sheet">
        <header className="nz-preview-head"><span className="nz-eyebrow">Database-backed reviewed snapshot · {snapshot.jobNumber}</span><h1>{snapshot.reportingYear} Carbon performance</h1><p>Snapshot v{snapshot.version} · created {snapshot.createdAt}</p><span className={`nz-st ${validation.valid?"done":"nof"}`}>{validation.valid?"Manifest ready":"Validation blocked"}</span><div className="nz-preview-hash"><span>Evidence hash</span><b className="num">{snapshot.dataHash}</b></div></header>
        <div className="nz-banner warn">
          <div>
            <b>Preview only — publication remains controlled.</b>
            <div>
              These graphics resolve from canonical reviewed rows.
              The remaining blockers are shown below. Annual comparison appears automatically once this client has reviewed snapshots for at least two reporting years.
            </div>
          </div>
        </div>
        <div className="nz-preview-grid">
          <EmissionsScopeDonut data={scope} />
          {pathway&&<ReductionPathway data={pathway}/>}
          {annual&&<ScopeYearOnYearBar data={annual}/>}
          <EmissionsByActivity data={activities} />
          {sites&&<EmissionsSiteDonut data={sites}/>}
          {intensity&&<IntensityPathway data={intensity}/>}
          {purchasedGoods&&<PurchasedGoodsBreakdown data={purchasedGoods}/>}
        </div>
        <div className="nz-section-intro"><div><span className="nz-eyebrow">Controlled release</span><h2>Professional manifest validation</h2><p>The validator creates an immutable version before any client publication can occur.</p></div></div>
        <ReportValidationAction snapshotId={snapshot.id} manifestVersion={crpProfessionalManifest.version} ready={validation.valid}/>
        <ManifestChartSet
          manifest={crpProfessionalManifest}
          charts={charts}
          reviewedSnapshotId={snapshot.id}
        />
      </section>
    </main>
  );
}

function PreviewEmpty({jobId}:{jobId:string}){return <main className="nz-preview-canvas"><section className="nz-preview-empty"><span className="nz-state-icon">!</span><div><span className="nz-eyebrow">Report preparation</span><h1>No reviewed snapshot available</h1><p>Job {jobId} cannot be previewed or published until its emissions rows have passed review and a governed snapshot has been created.</p><a className="nz-btn pri" href={`/jobs/${jobId}`}>Return to job review</a></div></section></main>}
