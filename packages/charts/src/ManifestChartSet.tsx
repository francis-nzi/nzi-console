import type { CSSProperties, ReactNode } from "react";
import { EmissionsByActivity } from "./EmissionsByActivity";
import { EmissionsScopeDonut } from "./EmissionsScopeDonut";
import { ReductionPathway } from "./ReductionPathway";
import { ScopeYearOnYearBar } from "./ScopeYearOnYearBar";
import { EmissionsSiteDonut } from "./EmissionsSiteDonut";
import { IntensityPathway } from "./IntensityPathway";
import { PurchasedGoodsBreakdown } from "./PurchasedGoodsBreakdown";
import { LcaStageBar } from "./LcaStageBar";
import { TrainingAttendance } from "./TrainingAttendance";
import { validateManifest, type ReportManifest } from "./manifest";
import { tokens } from "./tokens";
import type { AnyChartData, EmissionsByActivityData, IntensityPathwayData, LcaStageBarData, PurchasedGoodsBreakdownData, ReductionPathwayData, ScopeDonutData, ScopeYearOnYearData, SiteDonutData, TrainingAttendanceData } from "./types";

type Props = {
  manifest: ReportManifest;
  charts: AnyChartData[];
  reviewedSnapshotId: string;
  showSectionHeadings?: boolean;
};

/** The only chart-assembly path for reports, PDFs and published portal results. */
export function ManifestChartSet({ manifest, charts, reviewedSnapshotId, showSectionHeadings = true }: Props) {
  const validation = validateManifest(manifest, charts, reviewedSnapshotId);
  if (!validation.valid) return <div role="alert" style={blocked}><b>Graphics unavailable — publication blocked.</b><ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>{validation.issues.map((issue, index) => <li key={`${issue.chartId}-${index}`}>{issue.message}</li>)}</ul></div>;
  const byId = new Map(charts.map((chart) => [chart.spec.id, chart]));
  return <div data-report-manifest={manifest.id} data-manifest-version={manifest.version} data-reviewed-snapshot={reviewedSnapshotId}>
    {manifest.sections.map((section) => <section key={section.id} style={{ marginBottom: 24 }}>
      {showSectionHeadings && <header style={{ marginBottom: 12 }}><h3 style={{ margin: 0, fontSize: 18, color: tokens.ink.primary }}>{section.title}</h3>{section.description && <p style={{ margin: "4px 0 0", fontSize: 12.5, color: tokens.ink.secondary }}>{section.description}</p>}</header>}
      <div className={`nz-chart-manifest-grid${section.layout === "two-column" ? " two-column" : ""}`}>{section.chartIds.map((id) => <ChartFromManifest key={id} chart={byId.get(id)!} />)}</div>
    </section>)}
  </div>;
}

function ChartFromManifest({ chart }: { chart: AnyChartData }): ReactNode {
  let graphic:ReactNode;
  if (chart.spec.type === "emissions_scope_donut") graphic=<EmissionsScopeDonut data={chart as ScopeDonutData} />;
  else if (chart.spec.type === "reduction_pathway") graphic=<ReductionPathway data={chart as ReductionPathwayData} />;
  else if (chart.spec.type === "scope_year_on_year_bar") graphic=<ScopeYearOnYearBar data={chart as ScopeYearOnYearData} />;
  else if (chart.spec.type === "emissions_by_activity") graphic=<EmissionsByActivity data={chart as EmissionsByActivityData} />;
  else if (chart.spec.type === "emissions_site_donut") graphic=<EmissionsSiteDonut data={chart as SiteDonutData} />;
  else if (chart.spec.type === "intensity_pathway") graphic=<IntensityPathway data={chart as IntensityPathwayData} />;
  else if (chart.spec.type === "purchased_goods_breakdown") graphic=<PurchasedGoodsBreakdown data={chart as PurchasedGoodsBreakdownData} />;
  else if (chart.spec.type === "lca_stage_bar") graphic=<LcaStageBar data={chart as LcaStageBarData}/>;
  else if (chart.spec.type === "training_attendance") graphic=<TrainingAttendance data={chart as TrainingAttendanceData}/>;
  else return <div role="alert" style={blocked}>Unsupported chart type: {(chart as AnyChartData).spec.type}</div>;
  return <div>{graphic}<details style={evidence}><summary style={evidenceSummary}>View chart evidence</summary><div style={evidenceGrid}><span>Reviewed snapshot<b>{chart.provenance.reviewedSnapshotId}</b></span><span>Data identity<b>{chart.provenance.dataHash}</b></span><span>Factor sources<b>{chart.provenance.factorSets.join(" · ")}</b></span><span>Specification<b>v{chart.spec.specVersion} · resolver v{chart.provenance.resolverVersion}</b></span></div></details></div>;
}

const blocked: CSSProperties = { border: `1px solid ${tokens.brand.coral}`, background: "#FFF1EF", color: tokens.ink.primary, borderRadius: 10, padding: 16, fontSize: 12.5 };
const evidence:CSSProperties={marginTop:-1,border:`1px solid ${tokens.line}`,borderRadius:"0 0 10px 10px",background:tokens.paper,fontSize:11,color:tokens.ink.secondary};
const evidenceSummary:CSSProperties={padding:"9px 12px",cursor:"pointer",fontWeight:650,color:tokens.brand.pine};
const evidenceGrid:CSSProperties={display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:8,padding:"0 12px 12px"};
