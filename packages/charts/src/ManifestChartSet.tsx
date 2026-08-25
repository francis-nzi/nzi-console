import type { CSSProperties, ReactNode } from "react";
import { EmissionsByActivity } from "./EmissionsByActivity";
import { EmissionsScopeDonut } from "./EmissionsScopeDonut";
import { ReductionPathway } from "./ReductionPathway";
import { ScopeYearOnYearBar } from "./ScopeYearOnYearBar";
import { validateManifest, type ReportManifest } from "./manifest";
import { tokens } from "./tokens";
import type { AnyChartData, EmissionsByActivityData, ReductionPathwayData, ScopeDonutData, ScopeYearOnYearData } from "./types";

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
      <div style={{ display: "grid", gridTemplateColumns: section.layout === "two-column" ? "repeat(2, minmax(360px, 1fr))" : "1fr", gap: 18 }}>{section.chartIds.map((id) => <ChartFromManifest key={id} chart={byId.get(id)!} />)}</div>
    </section>)}
  </div>;
}

function ChartFromManifest({ chart }: { chart: AnyChartData }): ReactNode {
  if (chart.spec.type === "emissions_scope_donut") return <EmissionsScopeDonut data={chart as ScopeDonutData} />;
  if (chart.spec.type === "reduction_pathway") return <ReductionPathway data={chart as ReductionPathwayData} />;
  if (chart.spec.type === "scope_year_on_year_bar") return <ScopeYearOnYearBar data={chart as ScopeYearOnYearData} />;
  if (chart.spec.type === "emissions_by_activity") return <EmissionsByActivity data={chart as EmissionsByActivityData} />;
  return <div role="alert" style={blocked}>Unsupported chart type: {chart.spec.type}</div>;
}

const blocked: CSSProperties = { border: `1px solid ${tokens.brand.coral}`, background: "#FFF1EF", color: tokens.ink.primary, borderRadius: 10, padding: 16, fontSize: 12.5 };
