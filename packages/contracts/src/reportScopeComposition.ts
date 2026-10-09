// Reporting S-2 (ruled: RULING-reporting-site-scope.md R-S1 (A′) and its sub-rulings; RULING-reporting-S.md) — a report's
// emissions recomposed for its scope, as a pure function of frozen rows. Nothing here reads a live record or apportions a
// figure: a site scope is a filter of the snapshot's per-row measurements, and organisation-level (unallocated) emissions are
// excluded from it and stated, never split across sites (sub-ruling 1).
import type { ReportScope } from "./reportScope";
import type { ReportComparisonColumn, ReportEmissionsComparison, ReportSiteEmissions } from "./reportComposition";

export type ScopedMeasurement = {
  scope: string; tco2e: number; siteId?: string | null; siteLabel?: string | null; sourceLabel?: string | null; reportLabel?: string | null;
};
export type ScopedHistoryPeriod = { year: number; rows: ReadonlyArray<{ siteId: string | null; scope: string; tco2e: number }>; sitesKnown: boolean };

export const UNALLOCATED_LABEL = "Unallocated / organisation-level";
/** How many activities a site's breakdown lists before the rest are summed into one line. */
export const SITE_ACTIVITY_LIMIT = 8;

const SCOPES = ["1", "2", "3"] as const;
const fmt = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 1 });
const sumBy = <T>(rows: readonly T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0);
const byScopeOf = (rows: ReadonlyArray<{ scope: string; tco2e: number }>) =>
  [...rows.reduce((map, row) => map.set(row.scope, (map.get(row.scope) ?? 0) + row.tco2e), new Map<string, number>()).entries()]
    .sort(([a], [b]) => a.localeCompare(b)).map(([scope, tco2e]) => ({ scope, tco2e }));

/** The statement a site view carries about what it leaves out — prominent, because it is often a large share. */
export const unallocatedStatement = (tco2e: number) =>
  `Organisation-level emissions (${fmt(tco2e)} tCO₂e, not attributable to a site) are reported at whole-client level only and are not included in this site view.`;

/** A site's activities: its rows by label and scope, largest first; beyond the limit, one "Other activities" line per scope. */
function activitiesOf(rows: readonly ScopedMeasurement[]): ReportSiteEmissions["activities"] {
  const grouped = new Map<string, { label: string; scope: string; tco2e: number }>();
  for (const row of rows) {
    const label = (row.reportLabel ?? row.sourceLabel ?? "").trim() || "Unlabelled activity";
    const key = `${row.scope}\u0000${label}`;
    const entry = grouped.get(key) ?? { label, scope: row.scope, tco2e: 0 };
    entry.tco2e += row.tco2e;
    grouped.set(key, entry);
  }
  const ordered = [...grouped.values()].sort((a, b) => b.tco2e - a.tco2e || a.label.localeCompare(b.label));
  if (ordered.length <= SITE_ACTIVITY_LIMIT) return ordered;
  const rest = ordered.slice(SITE_ACTIVITY_LIMIT - 1);
  return [...ordered.slice(0, SITE_ACTIVITY_LIMIT - 1), { label: `Other activities (${rest.length})`, scope: "", tco2e: sumBy(rest, (row) => row.tco2e) }];
}

export type ScopedEmissions = {
  totalTco2e: number;
  byScope: Array<{ scope: string; tco2e: number }>;
  sites: ReportSiteEmissions[];
  unallocated?: { tco2e: number; statement: string };
  /** The selected sites' names, from the frozen rows (a renamed site does not rename a report), else the given fallback. */
  siteLabels: string[];
};

/**
 * Emissions for a scope, from the snapshot's frozen rows. Whole client: every row, with an "Unallocated / organisation-level"
 * line for rows with no site. A site scope: only the rows at the selected sites; unallocated is carried apart, stated.
 */
export function composeScopedEmissions(measurements: readonly ScopedMeasurement[], scope: ReportScope, fallbackNames: ReadonlyMap<string, string> = new Map()): ScopedEmissions {
  const names = new Map(fallbackNames);
  for (const row of measurements) if (row.siteId && row.siteLabel?.trim()) names.set(row.siteId, row.siteLabel.trim());
  const site = (siteId: string | null): ReportSiteEmissions => {
    const rows = measurements.filter((row) => (row.siteId ?? null) === siteId);
    return { siteId, label: siteId === null ? UNALLOCATED_LABEL : names.get(siteId) ?? siteId, totalTco2e: sumBy(rows, (row) => row.tco2e), byScope: byScopeOf(rows), activities: activitiesOf(rows) };
  };
  if (scope.kind === "whole") {
    const siteIds = [...new Set(measurements.map((row) => row.siteId).filter((id): id is string => typeof id === "string" && id !== ""))];
    const sites = siteIds.map(site).sort((a, b) => b.totalTco2e - a.totalTco2e || a.label.localeCompare(b.label));
    const unallocated = measurements.some((row) => !row.siteId) ? [site(null)] : [];
    return { totalTco2e: sumBy(measurements, (row) => row.tco2e), byScope: byScopeOf(measurements), sites: [...sites, ...unallocated], siteLabels: [] };
  }
  const selected = new Set(scope.siteIds);
  const inScope = measurements.filter((row) => row.siteId && selected.has(row.siteId));
  const unallocatedTco2e = sumBy(measurements.filter((row) => !row.siteId), (row) => row.tco2e);
  return {
    totalTco2e: sumBy(inScope, (row) => row.tco2e),
    byScope: byScopeOf(inScope),
    // Every selected site appears, rows or none: a boundary site with no rows reads 0 because it was read and is empty.
    sites: scope.siteIds.map(site),
    ...(unallocatedTco2e > 0 ? { unallocated: { tco2e: unallocatedTco2e, statement: unallocatedStatement(unallocatedTco2e) } } : {}),
    siteLabels: scope.siteIds.map((id) => names.get(id) ?? id),
  };
}

/**
 * Year-on-year for a scope (sub-ruling 4). The columns follow the assured periods that exist — no toggle: the current period
 * always; the client's baseline year when an assured period holds it; the latest earlier period besides. Each prior figure
 * is the same filter over that period's own frozen rows; a period frozen before rows carried a site cannot be attributed to
 * a site scope, and says so rather than reading as nought.
 */
export function composeScopedComparison(input: {
  scope: ReportScope; currentYear: number; current: ReadonlyArray<{ siteId?: string | null; scope: string; tco2e: number }>;
  history: readonly ScopedHistoryPeriod[]; baselineYear: number | null;
}): ReportEmissionsComparison {
  const earlier = input.history.filter((period) => period.year < input.currentYear).sort((a, b) => a.year - b.year);
  const baseline = input.baselineYear !== null && input.baselineYear < input.currentYear ? earlier.find((period) => period.year === input.baselineYear) ?? null : null;
  const previous = [...earlier].reverse().find((period) => period !== baseline) ?? null;
  const periods: Array<{ column: ReportComparisonColumn; rows: ScopedHistoryPeriod["rows"] | null }> = [];
  const notes: string[] = [];
  const attributable = (period: ScopedHistoryPeriod) => {
    if (input.scope.kind === "whole" || period.sitesKnown) return period.rows;
    notes.push(`FY${period.year} was frozen before its rows carried a site, so it cannot be attributed to these sites.`);
    return null;
  };
  if (baseline) periods.push({ column: { key: "baseline", year: baseline.year, label: `Baseline (FY${baseline.year})` }, rows: attributable(baseline) });
  if (previous && (!baseline || previous.year > baseline.year)) periods.push({ column: { key: "previous", year: previous.year, label: `Previous (FY${previous.year})` }, rows: attributable(previous) });
  periods.push({ column: { key: "current", year: input.currentYear, label: `Current (FY${input.currentYear})` }, rows: input.current.map((row) => ({ siteId: row.siteId ?? null, scope: row.scope, tco2e: row.tco2e })) });
  const selected = input.scope.kind === "sites" ? new Set(input.scope.siteIds) : null;
  const inScope = (rows: ScopedHistoryPeriod["rows"]) => selected ? rows.filter((row) => row.siteId !== null && selected.has(row.siteId)) : rows;
  const value = (rows: ScopedHistoryPeriod["rows"] | null, scope?: string) => rows === null ? null : sumBy(inScope(rows).filter((row) => scope === undefined || row.scope === scope), (row) => row.tco2e);
  const totals = periods.map((period) => value(period.rows));
  const baselineTotal = baseline ? totals[0] ?? null : null, currentTotal = totals[totals.length - 1] ?? null;
  return {
    columns: periods.map((period) => period.column),
    rows: SCOPES.map((scope) => ({ scope, values: periods.map((period) => value(period.rows, scope)) })),
    totals,
    changeVsBaselinePct: baselineTotal !== null && baselineTotal > 0 && currentTotal !== null ? ((currentTotal - baselineTotal) / baselineTotal) * 100 : null,
    notes,
  };
}
