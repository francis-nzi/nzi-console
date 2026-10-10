// Reporting F-4c (RULING-reporting-F4b-flip-and-dashboard, decision 2): the client's emissions dashboard honours the report it is
// drawn from. A section the default report leaves out is not shown here either — its tiles and charts are withheld, driven by the
// same plan the report renders with, and the dashboard says what was left out rather than going quiet about it.
//
// The dashboard's report-derived pieces, by the report section they speak to:
//   targets   → the target-progress tile and the reduction pathway chart
//   intensity → the intensity pathway chart
//   sites     → the site donut and the "Emissions by site" table
// Emissions (scope donut, year-on-year, by activity, purchased goods) is a mandatory section and always shown.
import type { AnyChartData, ReportManifest } from "@nzi/charts";
import { reportOmittedSections, reportSectionPlanOf, type ReportComposition, type ReportSectionPlan } from "@nzi/contracts";

export type DashboardSection = "targets" | "intensity" | "sites";
/** `unverified`: the report's plan could not be read, so the section-dependent pieces are withheld — and the dashboard says so. */
export type DashboardVisibility = Record<DashboardSection, boolean> & { omitted: string[]; unverified?: true };

const SECTION_CHARTS: Record<DashboardSection, readonly string[]> = {
  targets: ["reduction_pathway"],
  intensity: ["intensity_pathway"],
  sites: ["emissions_site_donut"],
};

/** What the dashboard may show, from the report's plan. A plan that leaves nothing out shows everything. */
export function dashboardVisibility(plan: ReportSectionPlan): DashboardVisibility {
  const included = (key: DashboardSection) => plan.find((entry) => entry.key === key)?.included !== false;
  return { targets: included("targets"), intensity: included("intensity"), sites: included("sites"), omitted: reportOmittedSections(plan) };
}

/**
 * The plan behind the dashboard's report: the frozen composition's own (or the default it was issued with), and — for a version
 * issued before compositions — everything, as it was then. When the plan cannot be read the dashboard fails closed: it withholds
 * every section-dependent piece rather than risk showing one the report left out.
 */
export type DashboardPlanSource = { state: "composed"; composition: ReportComposition } | { state: "pre-composition" } | { state: "failed" };
export function dashboardVisibilityOf(source: DashboardPlanSource): DashboardVisibility {
  if (source.state === "composed") return dashboardVisibility(reportSectionPlanOf(source.composition));
  if (source.state === "pre-composition") return { targets: true, intensity: true, sites: true, omitted: [] };
  return { targets: false, intensity: false, sites: false, omitted: [], unverified: true };
}

const withheldCharts = (visibility: DashboardVisibility) =>
  new Set((Object.keys(SECTION_CHARTS) as DashboardSection[]).filter((section) => !visibility[section]).flatMap((section) => SECTION_CHARTS[section]));

/**
 * The manifest as this dashboard draws it: the withheld sections' charts taken out of its requirements and its layout (a section
 * left with no chart goes too). Every manifest chart is required, so dropping a chart without this would block the whole set.
 */
export function manifestHonouringPlan(manifest: ReportManifest, visibility: DashboardVisibility): ReportManifest {
  const withheld = withheldCharts(visibility);
  if (withheld.size === 0) return manifest;
  return {
    ...manifest,
    charts: manifest.charts.filter((chart) => !withheld.has(chart.id)),
    sections: manifest.sections
      .map((section) => ({ ...section, chartIds: section.chartIds.filter((id) => !withheld.has(id)) }))
      .filter((section) => section.chartIds.length > 0),
  };
}

/** The charts as this dashboard draws them: none for a withheld section. */
export function chartsHonouringPlan(charts: AnyChartData[], visibility: DashboardVisibility): AnyChartData[] {
  const withheld = withheldCharts(visibility);
  return charts.filter((chart) => !withheld.has(chart.spec.id));
}
