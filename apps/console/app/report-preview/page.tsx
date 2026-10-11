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
  resolveCrpCoreCharts,
} from "@nzi/charts";
import { reportScopeChoices, type ReviewedCrpSnapshotReadModel } from "@nzi/contracts";
import type { EmissionsByActivityData,IntensityPathwayData,PurchasedGoodsBreakdownData,ReductionPathwayData,ScopeDonutData,ScopeYearOnYearData,SiteDonutData } from "@nzi/charts";
import { ScreenState } from "../lib/ScreenState";
import { loadScreen } from "../lib/loadScreen";
import { formatDateTime } from "../lib/formatDate";
import {validateManifest} from "@nzi/charts";
import {ReportValidationAction} from "./ReportValidationAction";
import {PreviewEmpty} from "./PreviewEmpty";
import {ReportRegisterView} from "../reports/ReportRegisterView";

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
    // A4: no snapshot is this page's own case, not a generic "nothing here" — PreviewEmpty says why (imported v7, or awaiting
    // evidence). ScreenState still carries loading and a failed read.
    if (result.state === "empty") return <PreviewEmpty jobId={jobId} />;
    return (
      <ScreenState result={result}>
        {(data) => data.snapshots[0] ? <LiveSnapshotPreview snapshot={data.snapshots[0]} /> : <PreviewEmpty jobId={jobId} />}
      </ScreenState>
    );
  }
  return <PreviewJobSelection />;
}

/**
 * A2/A3: the picker is the Reports register — the same rows, filters and link logic — so a job is found by client, consultant,
 * stage, year or search instead of a flat scroll, and an imported job says it is awaiting re-compose before anyone opens it.
 */
function PreviewJobSelection(){return <main className="nz-preview-canvas"><section className="nz-preview-picker"><div className="nz-section-intro"><div><span className="nz-eyebrow">Governed report preparation</span><h1>Choose a CRP job to prepare</h1><p>A report is assembled from a job's reviewed snapshot. Jobs ready to prepare say <b>Prepare report</b>; imported v7 history is marked as awaiting re-compose.</p></div><a className="nz-btn" href="/reports">Return to publication studio</a></div><ReportRegisterView mode="picker"/></section></main>}

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
        <header className="nz-preview-head"><span className="nz-eyebrow">Database-backed reviewed snapshot · {snapshot.jobNumber}</span><h1>{snapshot.reportingYear} Carbon performance</h1><p>Snapshot v{snapshot.version} · created {formatDateTime(snapshot.createdAt)}</p><span className={`nz-st ${validation.valid?"done":"nof"}`}>{validation.valid?"Manifest ready":"Validation blocked"}</span><div className="nz-preview-hash"><span>Evidence hash</span><b className="num">{snapshot.dataHash}</b></div></header>
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
        <ReportValidationAction snapshotId={snapshot.id} manifestVersion={crpProfessionalManifest.version} ready={validation.valid} choices={reportScopeChoices(snapshot)}/>
        <ManifestChartSet
          manifest={crpProfessionalManifest}
          charts={charts}
          reviewedSnapshotId={snapshot.id}
        />
      </section>
    </main>
  );
}
