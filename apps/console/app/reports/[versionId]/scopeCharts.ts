import { CRP_RESOLVER_VERSION, RENDERER_VERSION, TOKENS_VERSION, type EmissionsByActivityData, type Provenance, type ScopeDonutData, type SiteDonutData } from "@nzi/charts";
import { strategyScopeLabel, type ReportComposition, type ReportEmissionsSection, type ReportSiteEmissions, type StrategyScope } from "@nzi/contracts";

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
