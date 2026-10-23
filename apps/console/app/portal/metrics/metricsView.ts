// The portal Metrics view (BUILD-portal-shell-lookandfeel R8): the job's published emissions, filterable by scope and site, each
// chart re-drawable in the forms its job allows. Pure, so the forms, the filters and the figures are tested without a browser.
//
// The figures are the dashboard's: the published report's own measurements (the client's copy), through the same
// `aggregateAssuranceYear` the dashboard, the report and Data Assurance use — so unfiltered, every total here equals the
// dashboard's. The prior years are the dashboard's trend. Nothing is computed that the dashboard does not already compute.
import { aggregateAssuranceYear, type AssuranceMeasurement, type AssuranceScopeTotals, type PortalTrendYear } from "@nzi/contracts";

export type MetricChart = "scope" | "category" | "site" | "trend";
export type MetricForm = "donut" | "pie" | "bar" | "line" | "table";

/**
 * The forms each chart may take — only those true to its job (dataviz: choosing-a-form):
 *  - by scope is part-to-whole over three fixed parts: donut, pie or bar;
 *  - by category and by site are magnitude over many parts: bars (angles cannot compare a dozen slices, and there is no
 *    validated palette to tell a ring of sites apart); never a donut;
 *  - over time is a trend: line or bar; never a pie of a trend.
 * Every chart can be read as a table.
 */
export const METRIC_FORMS: Record<MetricChart, readonly MetricForm[]> = {
  scope: ["donut", "pie", "bar", "table"],
  category: ["bar", "table"],
  site: ["bar", "table"],
  trend: ["line", "bar", "table"],
};
export const metricFormsFor = (chart: MetricChart): readonly MetricForm[] => METRIC_FORMS[chart];
export const defaultMetricForm = (chart: MetricChart): MetricForm => METRIC_FORMS[chart][0]!;
/** A form asked for (a remembered choice, a URL) is honoured only if the chart allows it. */
export const metricFormOr = (chart: MetricChart, wanted: string | null | undefined): MetricForm =>
  (METRIC_FORMS[chart] as readonly string[]).includes(wanted ?? "") ? wanted as MetricForm : defaultMetricForm(chart);

export type MetricFilters = { scope: "all" | "1" | "2" | "3"; site: string };
export const ALL_SITES = "all";

/** A published measurement as the client's copy carries it — what the filters need and nothing more. */
export type MetricMeasurement = { scope: "1" | "2" | "3"; scopeCode?: string | null; siteId?: string | null; siteLabel?: string | null; tco2e: number };

const UNALLOCATED = "__unallocated__";
const siteKey = (row: { siteId?: string | null }) => row.siteId ?? UNALLOCATED;

export type MetricSite = { key: string; label: string };
/** The sites in the published report, largest first, "Unallocated" for rows without one. */
export function metricSites(rows: readonly MetricMeasurement[]): MetricSite[] {
  const year = aggregate(rows);
  return year.bySite.map((site) => ({ key: site.siteId ?? UNALLOCATED, label: site.label }));
}

const aggregate = (rows: readonly MetricMeasurement[]) => aggregateAssuranceYear({ year: 0, kind: "current", source: "reviewed-snapshot", measurements: rows as readonly AssuranceMeasurement[] });

export type MetricFigures = {
  /** All published emissions, before any filter: what a filtered share is a share of. */
  reportTotal: number;
  /** The selection's total. */
  total: number;
  byScope: AssuranceScopeTotals;
  byCategory: Array<{ key: string; label: string; scope: "1" | "2" | "3"; tco2e: number }>;
  /** Every site, scope-filtered; the chosen site is marked, the rest stay as context (emphasis, not removal). */
  bySite: Array<{ key: string; label: string; tco2e: number; selected: boolean }>;
};

export function metricFigures(rows: readonly MetricMeasurement[], filters: MetricFilters): MetricFigures {
  const scoped = filters.scope === "all" ? rows : rows.filter((row) => row.scope === filters.scope);
  const selected = filters.site === ALL_SITES ? scoped : scoped.filter((row) => siteKey(row) === filters.site);
  const year = aggregate(selected);
  const sites = aggregate(scoped);
  const scopeOf = (code: string): "1" | "2" | "3" => (code.startsWith("1") ? "1" : code.startsWith("2") ? "2" : "3");
  return {
    reportTotal: aggregate(rows).total ?? 0,
    total: year.total ?? 0,
    byScope: year.byScope,
    byCategory: year.byCategory.map((category) => ({ key: category.scopeCode, label: category.label, scope: scopeOf(category.scopeCode), tco2e: category.tco2e })),
    bySite: sites.bySite.map((site) => {
      const key = site.siteId ?? UNALLOCATED;
      return { key, label: site.label, tco2e: site.tco2e, selected: filters.site === ALL_SITES || key === filters.site };
    }),
  };
}

/**
 * The trend, as the dashboard holds it (whole client: earlier years carry no site breakdown, so a site filter cannot apply and
 * is said not to). Scope-filtered to that scope's series; a year with no published report is a gap, never a zero.
 */
export function metricTrend(trend: readonly PortalTrendYear[], scope: MetricFilters["scope"]): { years: number[]; series: Array<{ scope: "1" | "2" | "3"; values: Array<number | null> }> } {
  const ordered = [...trend].sort((a, b) => a.year - b.year);
  const scopes = (scope === "all" ? ["1", "2", "3"] : [scope]) as Array<"1" | "2" | "3">;
  return {
    years: ordered.map((year) => year.year),
    series: scopes.map((key) => ({ scope: key, values: ordered.map((year) => year.total === null ? null : year.byScope[key]) })),
  };
}

export const SCOPE_NAMES: Record<"1" | "2" | "3", string> = { "1": "Scope 1 — direct", "2": "Scope 2 — purchased energy", "3": "Scope 3 — value chain" };
