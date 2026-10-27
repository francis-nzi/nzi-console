// Reporting S-2 (ruled: RULING-reporting-site-scope.md R-S1 (A′) and its sub-rulings; RULING-reporting-S.md) — a report's
// emissions recomposed for its scope, as a pure function of frozen rows. Nothing here reads a live record or apportions a
// figure: a site scope is a filter of the snapshot's per-row measurements, and organisation-level (unallocated) emissions are
// excluded from it and stated, never split across sites (sub-ruling 1).
import type { ReportScope } from "./reportScope";
import { withUsage } from "./reportLabelResolution";
import type { ReportComparisonColumn, ReportEmissionsComparison, ReportSiteEmissions } from "./reportComposition";
import { reportingGrainYears } from "./dataAssurance";

export type ScopedMeasurement = {
  scope: string; tco2e: number; siteId?: string | null; siteLabel?: string | null; sourceLabel?: string | null; reportLabel?: string | null;
  /** Dedup slice 2 (0171): the row's usage type, as frozen. A line per (activity, usage); none, one line as before. */
  usageLabel?: string | null;
};
export type ScopedHistoryPeriod = { year: number; rows: ReadonlyArray<{ siteId: string | null; scope: string; scopeCode?: string; tco2e: number }>; sitesKnown: boolean };

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
    const label = withUsage((row.reportLabel ?? row.sourceLabel ?? "").trim() || "Unlabelled activity", row.usageLabel);
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
  scope: ReportScope; currentYear: number; current: ReadonlyArray<{ siteId?: string | null; scope: string; scopeCode?: string | null; tco2e: number }>;
  history: readonly ScopedHistoryPeriod[]; baselineYear: number | null;
}): ReportEmissionsComparison {
  const earlier = input.history.filter((period) => period.year < input.currentYear).sort((a, b) => a.year - b.year);
  const baseline = input.baselineYear !== null && input.baselineYear < input.currentYear ? earlier.find((period) => period.year === input.baselineYear) ?? null : null;
  // D3 (R5): the universal grain — the baseline, then up to four prior periods after it (the most recent is "Previous"), then the
  // current period. The same `reportingGrainYears` the QA trend reads.
  // In a baseline year (the baseline at or after the current year) the baseline alone: no prior column.
  const baselineYearNow = input.baselineYear !== null && input.baselineYear >= input.currentYear;
  const priors = baselineYearNow ? [] : reportingGrainYears(earlier.filter((period) => period !== baseline && (!baseline || period.year > baseline.year)), input.currentYear, null);
  const previous = priors[priors.length - 1] ?? null;
  const periods: Array<{ column: ReportComparisonColumn; rows: ScopedHistoryPeriod["rows"] | null; sitesKnown?: boolean }> = [];
  const notes: string[] = [];
  const attributable = (period: ScopedHistoryPeriod) => {
    if (input.scope.kind === "whole" || period.sitesKnown) return period.rows;
    notes.push(`FY${period.year} was frozen before its rows carried a site, so it cannot be attributed to these sites.`);
    return null;
  };
  if (baseline) periods.push({ column: { key: "baseline", year: baseline.year, label: `Baseline (FY${baseline.year})` }, rows: attributable(baseline), sitesKnown: baseline.sitesKnown });
  for (const prior of priors) {
    periods.push(prior === previous
      ? { column: { key: "previous", year: prior.year, label: `Previous (FY${prior.year})` }, rows: attributable(prior), sitesKnown: prior.sitesKnown }
      : { column: { key: `earlier-${prior.year}`, year: prior.year, label: `FY${prior.year}` }, rows: attributable(prior), sitesKnown: prior.sitesKnown });
  }
  periods.push({ column: { key: "current", year: input.currentYear, label: `Current (FY${input.currentYear})` }, rows: input.current.map((row) => ({ siteId: row.siteId ?? null, scope: row.scope, ...(row.scopeCode ? { scopeCode: row.scopeCode } : {}), tco2e: row.tco2e })), sitesKnown: true });
  const selected = input.scope.kind === "sites" ? new Set(input.scope.siteIds) : null;
  const inScope = (rows: ScopedHistoryPeriod["rows"]) => selected ? rows.filter((row) => row.siteId !== null && selected.has(row.siteId)) : rows;
  const value = (rows: ScopedHistoryPeriod["rows"] | null, scope?: string) => rows === null ? null : sumBy(inScope(rows).filter((row) => scope === undefined || row.scope === scope), (row) => row.tco2e);
  const totals = periods.map((period) => value(period.rows));
  const baselineTotal = baseline ? totals[0] ?? null : null, currentTotal = totals[totals.length - 1] ?? null;
  // composed@5 (ACCEPT-composed5-checkpoint3): each current site's own figure in each column, from the same frozen periods.
  // A site with no row in a period, or a period frozen before its rows carried a site, is null — said, never modelled.
  const current = periods[periods.length - 1]!;
  const siteIds = [...new Set(inScope(current.rows ?? []).map((row) => row.siteId))];
  const siteValue = (period: (typeof periods)[number], siteId: string | null) => {
    if (period.rows === null || !period.sitesKnown) return null;
    const rows = inScope(period.rows).filter((row) => row.siteId === siteId);
    return rows.length ? sumBy(rows, (row) => row.tco2e) : null;
  };
  // composed@5 (ACCEPT-composed5-checkpoint4: the category table year-aware, like the by-site one): each current category's own
  // figure per column, by its GHG code. A period with no row in that category is null — "—"; so is a period whose rows carry no
  // code (frozen before rows carried one), as none of its rows can match a code.
  const codeOf = (row: ScopedHistoryPeriod["rows"][number]) => row.scopeCode ?? null;
  const currentRows = inScope(current.rows ?? []);
  const codes = [...new Map(currentRows.filter((row) => codeOf(row) !== null).map((row) => [codeOf(row)!, row.scope])).entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }));
  const categoryValue = (period: (typeof periods)[number], code: string) => {
    if (period.rows === null) return null;
    const matching = inScope(period.rows).filter((row) => codeOf(row) === code);
    return matching.length ? sumBy(matching, (row) => row.tco2e) : null;
  };
  return {
    columns: periods.map((period) => period.column),
    rows: SCOPES.map((scope) => ({ scope, values: periods.map((period) => value(period.rows, scope)) })),
    totals,
    changeVsBaselinePct: baselineTotal !== null && baselineTotal > 0 && currentTotal !== null ? ((currentTotal - baselineTotal) / baselineTotal) * 100 : null,
    notes,
    sites: siteIds.map((siteId) => ({ siteId, values: periods.map((period) => siteValue(period, siteId)) })),
    categories: codes.map(([scopeCode, scope]) => ({ scope, scopeCode, values: periods.map((period) => categoryValue(period, scopeCode)) })),
  };
}
