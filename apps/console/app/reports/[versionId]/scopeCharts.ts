import { CRP_RESOLVER_VERSION, RENDERER_VERSION, TOKENS_VERSION, type EmissionsByActivityData, type PathwayMilestone, type Provenance, type ReductionPathwayData, type ScopeDonutData, type SiteDonutData } from "@nzi/charts";
import { isReportGap, strategyScopeLabel, type ReportComposition, type ReportEmissionsSection, type ReportSiteEmissions, type ReportTargetsSection, type StrategyScope } from "@nzi/contracts";

/**
 * F-2 (composed@2): the reduction pathway, drawn from the report's own Targets section — the client target model the table
 * beside it states (NZC-072), never the superseded job-level target on the snapshot — with net zero at its residual, never
 * a flat zero the client's model does not say. The actuals are the benchmark and this report's assured total. Whole-client
 * only: targets are client-level, and a site's actuals are not drawn against them.
 */
export function reportPathway(composition: ReportComposition, targets: ReportTargetsSection): ReductionPathwayData | null {
  if (composition.scope?.kind === "sites" || targets.trajectory.length === 0) return null;
  const baseline = targets.trajectory.find((point) => point.kind === "benchmark");
  const emissions = composition.emissions;
  const actual = baseline ? [{ year: baseline.year, value: baseline.tco2e }] : [];
  if (!isReportGap(emissions) && composition.reportingYear !== baseline?.year) actual.push({ year: composition.reportingYear, value: emissions.totalTco2e });
  const milestone = (point: ReportTargetsSection["trajectory"][number]): PathwayMilestone => point.kind === "benchmark"
    ? { year: point.year, value: point.tco2e, label: "Baseline", kind: "baseline" }
    : point.kind === "near-term"
      ? { year: point.year, value: point.tco2e, label: `Interim -${point.pct}%`, kind: "interim" }
      : { year: point.year, value: point.tco2e, label: "Net zero", kind: "netzero" };
  return {
    spec: { id: "reduction_pathway", type: "reduction_pathway", title: "Emissions reduction pathway to net zero", subtitle: `${composition.client} · ${composition.jobNumber}`, family: "crp", specVersion: 1 },
    unit: "tCO₂e", state: "success",
    actual, target: targets.trajectory.map((point) => ({ year: point.year, value: point.tco2e })), milestones: targets.trajectory.map(milestone),
    provenance: {
      jobId: composition.jobId, dataHash: composition.snapshotDataHash, factorSets: targets.provenance.factorSets, generatedAt: composition.issuedAt,
      reviewedSnapshotId: composition.snapshotId, resolverVersion: CRP_RESOLVER_VERSION, tokensVersion: TOKENS_VERSION, rendererVersion: RENDERER_VERSION,
    },
  };
}

/**
 * S-2: the Sites section's charts, derived at render from the frozen composition — never captured, never re-read. Each is
 * an `@nzi/charts` envelope over figures the composition already holds, so the same SVG renders to screen, PDF and portal.
 */
const provenanceOf = (composition: ReportComposition, emissions: ReportEmissionsSection): Provenance => ({
  jobId: composition.jobId, dataHash: composition.snapshotDataHash, factorSets: emissions.provenance.factorSets,
  generatedAt: composition.issuedAt, reviewedSnapshotId: composition.snapshotId,
  resolverVersion: CRP_RESOLVER_VERSION, tokensVersion: TOKENS_VERSION, rendererVersion: RENDERER_VERSION,
});
const spec = (composition: ReportComposition, id: string, type: "emissions_site_donut" | "emissions_scope_donut" | "emissions_by_activity", title: string) =>
  ({ id, type, title, subtitle: `${composition.client} · ${composition.jobNumber}`, family: "crp" as const, specVersion: 1 });

/** Emissions by site — at whole-client scope with the organisation-level line, under a site scope only the selected sites. */
export function sitesDonut(composition: ReportComposition, emissions: ReportEmissionsSection): SiteDonutData {
  const sites = emissions.sites ?? [];
  return {
    spec: spec(composition, "report_sites_donut", "emissions_site_donut", `${composition.reportingYear} emissions by site`),
    unit: "tCO₂e", state: sites.some((site) => site.totalTco2e > 0) ? "success" : "empty",
    stateMessage: sites.some((site) => site.totalTco2e > 0) ? undefined : "No emissions are attributable to these sites.",
    sites: sites.map((site) => ({ id: site.siteId ?? "unallocated", label: site.label, value: site.totalTco2e })),
    total: sites.reduce((total, site) => total + site.totalTco2e, 0),
    provenance: provenanceOf(composition, emissions),
  };
}

/** One site's emissions by scope (brand-locked scope colours, fixed order). */
export function siteScopeDonut(composition: ReportComposition, emissions: ReportEmissionsSection, site: ReportSiteEmissions): ScopeDonutData {
  return {
    spec: spec(composition, `report_site_scope_${site.siteId ?? "unallocated"}`, "emissions_scope_donut", `${site.label} by scope`),
    unit: "tCO₂e", state: site.totalTco2e > 0 ? "success" : "empty",
    stateMessage: site.totalTco2e > 0 ? undefined : "No emissions recorded at this site for the period.",
    segments: (["1", "2", "3"] as const).map((scope) => ({ scope, label: strategyScopeLabel(scope as StrategyScope), value: site.byScope.find((entry) => entry.scope === scope)?.tco2e ?? 0 })),
    total: site.totalTco2e,
    provenance: provenanceOf(composition, emissions),
  };
}

/** One site's largest activities. */
export function siteActivities(composition: ReportComposition, emissions: ReportEmissionsSection, site: ReportSiteEmissions): EmissionsByActivityData {
  return {
    spec: spec(composition, `report_site_activity_${site.siteId ?? "unallocated"}`, "emissions_by_activity", `${site.label} by activity`),
    unit: "tCO₂e", state: site.activities.length ? "success" : "empty",
    stateMessage: site.activities.length ? undefined : "No activities recorded at this site for the period.",
    activities: site.activities.map((activity, index) => ({ id: `${index}`, label: activity.label, scope: (["1", "2", "3"].includes(activity.scope) ? activity.scope : "3") as "1" | "2" | "3", value: activity.tco2e })),
    provenance: provenanceOf(composition, emissions),
  };
}
