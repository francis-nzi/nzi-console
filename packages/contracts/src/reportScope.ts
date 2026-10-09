// Reporting S (ruled 8 Oct 2026: RULING-reporting-site-scope.md, RULING-reporting-S.md) — the scope a report version is
// validated at, and so the view it issues: the whole client, or a set of the snapshot's sites. Several published reports may
// stand for one job, one per scope (migration 0163).
//
// "Every site" is not "whole client" (ruled): a site scope excludes organisation-level (unallocated) emissions, so the two
// are distinct reports and are never normalised into one.

export type ReportScope = { kind: "whole" } | { kind: "sites"; siteIds: string[] };

export const WHOLE_CLIENT_SCOPE: ReportScope = { kind: "whole" };

/** The canonical form: site ids sorted and distinct, so one view has one key (the table's CHECK holds the same). */
export function normaliseReportScope(scope: ReportScope | null | undefined): ReportScope {
  if (!scope || scope.kind === "whole") return WHOLE_CLIENT_SCOPE;
  return { kind: "sites", siteIds: [...new Set(scope.siteIds.map((id) => id.trim()))].sort() };
}

/** The key 0163 generates: 'whole', or 'sites:' and the sorted ids. */
export function reportScopeKey(scope: ReportScope): string {
  const canonical = normaliseReportScope(scope);
  return canonical.kind === "whole" ? "whole" : `sites:${canonical.siteIds.join(",")}`;
}

/** The scope as a reader names it: "Whole client", or its sites by name ("Works, Annex"), falling back to the id. */
export function reportScopeLabel(scope: ReportScope, siteNames: ReadonlyMap<string, string>): string {
  if (scope.kind === "whole") return "Whole client";
  return scope.siteIds.map((id) => siteNames.get(id) ?? id).join(", ");
}

/** Shape issues for a scope arriving on a command; an absent scope is the whole client. */
export function reportScopeIssues(scope: unknown): Array<{ field: string; code: string; message: string }> {
  if (scope === undefined || scope === null) return [];
  if (typeof scope !== "object") return [{ field: "scope", code: "INVALID", message: "The scope must be the whole client or a set of sites." }];
  const value = scope as { kind?: unknown; siteIds?: unknown };
  if (value.kind === "whole") return [];
  if (value.kind !== "sites") return [{ field: "scope", code: "INVALID", message: "The scope must be the whole client or a set of sites." }];
  if (!Array.isArray(value.siteIds) || value.siteIds.length === 0) return [{ field: "scope.siteIds", code: "REQUIRED", message: "Choose at least one site." }];
  if (value.siteIds.length > 500 || !value.siteIds.every((id) => typeof id === "string" && id.trim() !== "")) {
    return [{ field: "scope.siteIds", code: "INVALID", message: "Each site must be a site id." }];
  }
  return [];
}

/** A site the scope may pick: the snapshot's boundary stamp when present, else the frozen rows' own sites (pre-stamp). */
export function selectableScopeSites(snapshot: {
  provenance?: { boundary?: { siteIds?: string[] } } | null;
  measurements: ReadonlyArray<{ siteId?: string | null }>;
}): string[] {
  const stamped = snapshot.provenance?.boundary?.siteIds;
  if (Array.isArray(stamped)) return [...new Set(stamped)].sort();
  return [...new Set(snapshot.measurements.map((row) => row.siteId).filter((id): id is string => typeof id === "string" && id !== ""))].sort();
}

/**
 * S-2: what the preparation screen offers — every selectable site with its frozen tCO₂e (a boundary site with no rows reads
 * 0), and the organisation-level total a site scope leaves out, so the reader sees exactly why an all-sites total differs
 * from the whole client's (ruled).
 */
export function reportScopeChoices(snapshot: {
  provenance?: { boundary?: { siteIds?: string[] } } | null;
  measurements: ReadonlyArray<{ siteId?: string | null; siteLabel?: string | null; tco2e: number }>;
}): { sites: Array<{ siteId: string; label: string; tco2e: number }>; unallocatedTco2e: number; totalTco2e: number } {
  const label = new Map<string, string>();
  for (const row of snapshot.measurements) if (row.siteId && row.siteLabel?.trim()) label.set(row.siteId, row.siteLabel.trim());
  const sum = (rows: ReadonlyArray<{ tco2e: number }>) => rows.reduce((total, row) => total + row.tco2e, 0);
  return {
    sites: selectableScopeSites(snapshot).map((siteId) => ({ siteId, label: label.get(siteId) ?? siteId, tco2e: sum(snapshot.measurements.filter((row) => row.siteId === siteId)) })),
    unallocatedTco2e: sum(snapshot.measurements.filter((row) => !row.siteId)),
    totalTco2e: sum(snapshot.measurements),
  };
}

/** The selector's live summary: what a choice covers and, under a site scope, what it excludes. */
export function reportScopeSummary(choices: ReturnType<typeof reportScopeChoices>, scope: ReportScope): string {
  const fmt = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 1 });
  if (scope.kind === "whole") return `Whole client · ${choices.sites.length} site${choices.sites.length === 1 ? "" : "s"} · ${fmt(choices.totalTco2e)} tCO₂e, including ${fmt(choices.unallocatedTco2e)} tCO₂e organisation-level`;
  const chosen = new Set(scope.siteIds);
  const attributable = choices.sites.filter((site) => chosen.has(site.siteId)).reduce((total, site) => total + site.tco2e, 0);
  return `Covers ${chosen.size} of ${choices.sites.length} site${choices.sites.length === 1 ? "" : "s"} · ${fmt(attributable)} tCO₂e attributable · ${fmt(choices.unallocatedTco2e)} tCO₂e organisation-level, excluded`;
}
