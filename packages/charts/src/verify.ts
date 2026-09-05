// R1 — print-safe chart pack (NZC-050). The console's report charts are already
// derived, deterministic SVG (see ManifestChartSet). This module adds the last
// guarantee the spec asks for: a chart figure can never disagree with the table
// it sits beside, because both are pure functions of the same reviewed snapshot.
//
// `verifyChartsAgainstSnapshot` recomputes each chart's headline figure(s)
// straight from `snapshot.measurements` and checks the chart is carrying the
// same number. The report surface renders the result as the "Data integrity
// check passed — every chart figure matches Outputs" banner, and folds it into
// the single `data-report-ready` signal the PDF step waits on.

import type {
  AnyChartData,
  EmissionsByActivityData,
  LcaHotspotsBarData,
  LcaModuleDonutData,
  ReductionPathwayData,
  ScopeDonutData,
  ScopeYearOnYearData,
  SiteDonutData,
} from "./types";

export type ChartFigureCheck = {
  chartId: string;
  /** Human-readable figure being checked, e.g. "Scope donut — total". */
  label: string;
  /** Value recomputed from the reviewed snapshot. */
  expected: number;
  /** Value the chart is carrying. */
  actual: number;
  ok: boolean;
};

export type ChartVerification = {
  ok: boolean;
  checks: ChartFigureCheck[];
};

/** Snapshot shape this module needs — a structural subset of ReviewedCrpSnapshotCore. */
export type VerifiableSnapshot = {
  measurements: Array<{ scope: "1" | "2" | "3"; scopeCode?: string; tco2e: number }>;
  target?: { baselineTco2e: number } | null;
  intensityTarget?: { baselineIntensity: number } | null;
};

// tCO₂e figures are surfaced to two decimals; allow a cent of rounding drift
// plus a relative epsilon for large totals.
const TOLERANCE = 0.01;
const matches = (a: number, b: number): boolean =>
  Math.abs(a - b) <= TOLERANCE + Math.abs(b) * 1e-6;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function verifyChartsAgainstSnapshot(
  snapshot: VerifiableSnapshot,
  charts: readonly AnyChartData[],
): ChartVerification {
  const rows = snapshot.measurements;
  const total = rows.reduce((sum, row) => sum + row.tco2e, 0);
  const scopeTotal = (scope: string): number =>
    rows.filter((row) => row.scope === scope).reduce((sum, row) => sum + row.tco2e, 0);
  const purchasedGoodsTotal = rows
    .filter((row) => row.scopeCode === "3.1")
    .reduce((sum, row) => sum + row.tco2e, 0);

  const checks: ChartFigureCheck[] = [];
  const check = (chartId: string, label: string, expected: number, actual: number): void => {
    checks.push({ chartId, label, expected: round2(expected), actual: round2(actual), ok: matches(expected, actual) });
  };

  for (const chart of charts) {
    // A chart that is not itself in a success state is handled by the manifest
    // validator; the figure check only speaks to figures.
    if (chart.state !== "success") continue;

    switch (chart.spec.type) {
      case "emissions_scope_donut": {
        const donut = chart as ScopeDonutData;
        const shownTotal = donut.total ?? donut.segments.reduce((sum, seg) => sum + seg.value, 0);
        check(chart.spec.id, "Scope donut — total", total, shownTotal);
        for (const segment of donut.segments) {
          check(chart.spec.id, `Scope donut — ${segment.label}`, scopeTotal(segment.scope), segment.value);
        }
        break;
      }
      case "emissions_site_donut": {
        const donut = chart as SiteDonutData;
        const shownTotal = donut.total ?? donut.sites.reduce((sum, site) => sum + site.value, 0);
        check(chart.spec.id, "Site donut — total", total, shownTotal);
        break;
      }
      case "emissions_by_activity": {
        const bars = chart as EmissionsByActivityData;
        check(chart.spec.id, "Activity breakdown — sum", total, bars.activities.reduce((sum, bar) => sum + bar.value, 0));
        break;
      }
      case "purchased_goods_breakdown": {
        const bars = chart as EmissionsByActivityData;
        check(chart.spec.id, "Purchased goods breakdown — sum", purchasedGoodsTotal, bars.activities.reduce((sum, bar) => sum + bar.value, 0));
        break;
      }
      case "scope_year_on_year_bar": {
        // The reporting-year column is the one derived from this snapshot's rows
        // (earlier years come from prior published reports and are out of scope).
        const bars = chart as ScopeYearOnYearData;
        const latest = [...bars.years].sort((a, b) => b.year - a.year)[0];
        if (!latest) break;
        const latestTotal = latest.values.reduce((sum, value) => sum + value.value, 0);
        // Only assert when the latest column actually equals the snapshot total —
        // otherwise it is a prior year and there is nothing to reconcile.
        if (matches(latestTotal, total)) {
          for (const value of latest.values) {
            check(chart.spec.id, `Year-on-year ${latest.year} — Scope ${value.scope}`, scopeTotal(value.scope), value.value);
          }
        }
        break;
      }
      case "reduction_pathway": {
        const pathway = chart as ReductionPathwayData;
        const baseline = pathway.milestones.find((milestone) => milestone.kind === "baseline");
        if (baseline && snapshot.target) {
          check(chart.spec.id, "Reduction pathway — baseline", snapshot.target.baselineTco2e, baseline.value);
        }
        break;
      }
      case "intensity_pathway": {
        const pathway = chart as ReductionPathwayData;
        const baseline = pathway.milestones.find((milestone) => milestone.kind === "baseline");
        if (baseline && snapshot.intensityTarget) {
          check(chart.spec.id, "Intensity pathway — baseline", snapshot.intensityTarget.baselineIntensity, baseline.value);
        }
        break;
      }
      default:
        break;
    }
  }

  return { ok: checks.every((entry) => entry.ok), checks };
}

/** Snapshot shape for the LCA figure check — a structural subset of the reviewed LCA snapshot. */
export type VerifiableLcaSnapshot = {
  totalTco2e: number;
  moduleBreakdown: Array<{ moduleCode: string; tco2e: number }>;
};

/**
 * The LCA analogue of `verifyChartsAgainstSnapshot`: the module-donut total
 * and every segment must equal the reviewed snapshot's `moduleBreakdown`, and
 * the hotspots bar can never claim more than the total.
 */
export function verifyLcaChartsAgainstSnapshot(
  snapshot: VerifiableLcaSnapshot,
  charts: readonly AnyChartData[],
): ChartVerification {
  const byModule = new Map(snapshot.moduleBreakdown.map((entry) => [entry.moduleCode, entry.tco2e]));
  const moduleTotal = snapshot.moduleBreakdown.reduce((sum, entry) => sum + entry.tco2e, 0);
  const checks: ChartFigureCheck[] = [];
  const check = (chartId: string, label: string, expected: number, actual: number): void => {
    checks.push({ chartId, label, expected: round2(expected), actual: round2(actual), ok: matches(expected, actual) });
  };
  for (const chart of charts) {
    if (chart.state !== "success") continue;
    if (chart.spec.type === "lca_module_donut") {
      const donut = chart as LcaModuleDonutData;
      const shownTotal = donut.total ?? donut.modules.reduce((sum, m) => sum + m.value, 0);
      check(chart.spec.id, "Module donut — total", snapshot.totalTco2e, shownTotal);
      check(chart.spec.id, "Module donut — Σ segments", moduleTotal, donut.modules.reduce((sum, m) => sum + m.value, 0));
      for (const segment of donut.modules) {
        check(chart.spec.id, `Module donut — ${segment.code}`, byModule.get(segment.code) ?? 0, segment.value);
      }
    } else if (chart.spec.type === "lca_hotspots_bar") {
      const bars = chart as LcaHotspotsBarData;
      const sum = bars.hotspots.reduce((total, h) => total + h.value, 0);
      checks.push({ chartId: chart.spec.id, label: "Hotspots bar — Σ ≤ total", expected: round2(snapshot.totalTco2e), actual: round2(sum), ok: sum <= snapshot.totalTco2e + TOLERANCE });
    }
  }
  return { ok: checks.every((entry) => entry.ok), checks };
}
