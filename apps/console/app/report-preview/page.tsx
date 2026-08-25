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
        {(data) => <LiveSnapshotPreview snapshot={data.snapshots[0]!} />}
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
        <main
          style={{
            background: "#eef2f0",
            minHeight: "100vh",
            padding: 32,
            fontFamily: "var(--font-inter), Inter, sans-serif",
          }}
        >
          <section
            style={{
              background: "white",
              maxWidth: 1180,
              margin: "0 auto",
              padding: 28,
              boxShadow: "0 4px 24px rgba(11,27,43,.08)",
            }}
          >
            <div
              style={{
                color: "#0BA75E",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: ".12em",
                textTransform: "uppercase",
              }}
            >
              NZI Professional Report · J000712
            </div>
            <h1 style={{ color: "#0B1B2B", margin: "8px 0 4px" }}>
              Carbon performance
            </h1>
            <p style={{ color: "#51605A", margin: "0 0 22px" }}>
              Print/PDF preview · same reviewed chart objects
            </p>
            <ChartProof target="print" label="Print and PDF" />

            <div
              style={{
                marginTop: 42,
                paddingTop: 28,
                borderTop: "1px solid #E4EAE7",
              }}
            >
              <div
                style={{
                  color: "#0BA75E",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: ".12em",
                  textTransform: "uppercase",
                }}
              >
                Large-format chart review
              </div>
              <h2
                style={{ color: "#0B1B2B", margin: "8px 0 4px", fontSize: 24 }}
              >
                Full-width report graphics
              </h2>
              <p style={{ color: "#51605A", margin: "0 0 22px" }}>
                The same chart components and reviewed data, each shown in its
                own larger container.
              </p>
              <div style={{ display: "grid", gap: 26 }}>
                <div style={{ width: "100%" }}>
                  <EmissionsScopeDonut data={scopeDonutSample} />
                </div>
                <div style={{ width: "100%" }}>
                  <ReductionPathway data={reductionPathwaySample} />
                </div>
                <div style={{ width: "100%" }}>
                  <ScopeYearOnYearBar data={scopeYearOnYearSample} />
                </div>
                <div style={{ width: "100%" }}>
                  <EmissionsByActivity data={emissionsByActivitySample} />
                </div>
                <div style={{ width: "100%" }}>
                  <EmissionsSiteDonut data={emissionsSiteDonutSample} />
                </div>
                <div style={{ width: "100%" }}>
                  <IntensityPathway data={intensityPathwaySample} />
                </div>
                <div style={{ width: "100%" }}>
                  <PurchasedGoodsBreakdown
                    data={purchasedGoodsBreakdownSample}
                  />
                </div>
              </div>
            </div>
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
    <main
      style={{
        background: "#eef2f0",
        minHeight: "100vh",
        padding: 32,
        fontFamily: "var(--font-inter), Inter, sans-serif",
      }}
    >
      <section
        style={{
          background: "white",
          maxWidth: 1180,
          margin: "0 auto",
          padding: 28,
        }}
      >
        <div
          style={{
            color: "#0BA75E",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".12em",
          }}
        >
          DATABASE-BACKED REVIEWED SNAPSHOT · {snapshot.jobNumber}
        </div>
        <h1 style={{ color: "#0B1B2B" }}>
          {snapshot.reportingYear} Carbon performance
        </h1>
        <p style={{ color: "#51605A" }}>
          Snapshot v{snapshot.version} · {snapshot.dataHash} · created{" "}
          {snapshot.createdAt}
        </p>
        <div className="nz-banner warn">
          <div>
            <b>Preview only—publication remains blocked.</b>
            <div style={{ marginTop: 4 }}>
              These graphics resolve from canonical reviewed rows. The
              The remaining blockers are shown below. Annual comparison appears automatically once this client has reviewed snapshots for at least two reporting years.
            </div>
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2,minmax(360px,1fr))",
            gap: 18,
            margin: "22px 0",
          }}
        >
          <EmissionsScopeDonut data={scope} />
          {pathway&&<ReductionPathway data={pathway}/>}
          {annual&&<ScopeYearOnYearBar data={annual}/>}
          <EmissionsByActivity data={activities} />
          {sites&&<EmissionsSiteDonut data={sites}/>}
          {intensity&&<IntensityPathway data={intensity}/>}
          {purchasedGoods&&<PurchasedGoodsBreakdown data={purchasedGoods}/>}
        </div>
        <h2 style={{ color: "#0B1B2B" }}>Professional manifest validation</h2>
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
