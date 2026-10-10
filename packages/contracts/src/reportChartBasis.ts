// Reporting F-2 (chart parity; RULING-reporting-F4 D2) — what a report's charts are drawn from, frozen with it.
//
// The portal draws a published report's charts today by passing the reviewed snapshot to `resolveCrpCoreCharts`. A composed
// report (`composed@2`) draws the same charts from this basis, so a whole-client report's charts are the portal's, field for
// field — parity, not a re-implementation. The one exception is the reduction pathway: the portal's draws the superseded
// job-level target from the snapshot; the composed report draws its own Targets section (the client target model), so this
// basis carries no job target at all. A site report's basis is cut to its sites by the same filter its figures were
// (R-S1 (A′)): only its sites' rows, its own year-on-year (the comparison's attributable periods), and no intensity pathway
// (the reported intensity is client-level) rather than site actuals drawn against a whole-client target.
import type { ReportChartBasis, ReportEmissionsComparison } from "./reportComposition";
import type { ReportScope } from "./reportScope";

type SnapshotRow = Record<string, unknown> & { scope: string; tco2e: number };

export type ChartBasisSnapshot = {
  id: string; jobId: string; jobNumber: string; client: string; reportingYear: number; dataHash: string; createdAt: string;
  intensityTarget?: Record<string, unknown> | null;
  annualComparison?: Array<{ year: number; values: Array<{ scope: string; value: number }> }>;
  measurements: SnapshotRow[];
};

const scopeOf = (value: string) => value as "1" | "2" | "3";
const text = (value: unknown) => typeof value === "string" ? value : undefined;
const nullable = (value: unknown) => typeof value === "string" ? value : value === null ? null : undefined;

/** One row as the portal passes it to the resolver: exactly these fields, no others. */
function chartRow(row: SnapshotRow): ReportChartBasis["measurements"][number] {
  return {
    rowId: String(row.rowId ?? ""), scope: scopeOf(row.scope), scopeCode: text(row.scopeCode), sourceLabel: String(row.sourceLabel ?? ""),
    siteId: nullable(row.siteId), siteLabel: nullable(row.siteLabel),
    purchasedGoodsCategoryId: nullable(row.purchasedGoodsCategoryId), purchasedGoodsCategoryLabel: nullable(row.purchasedGoodsCategoryLabel),
    tco2e: Number(row.tco2e), factorSet: String(row.factorSet ?? ""),
  };
}

/** A site view's year-on-year: the comparison's periods that are attributable to its sites, by scope. */
function scopedAnnualComparison(comparison: ReportEmissionsComparison | null | undefined): ReportChartBasis["annualComparison"] {
  if (!comparison) return [];
  return comparison.columns.flatMap((column, index) => comparison.totals[index] === null ? [] : [{
    year: column.year,
    values: comparison.rows.map((row) => ({ scope: scopeOf(row.scope), value: row.values[index] ?? 0 })),
  }]);
}

const withoutEditor = (target: Record<string, unknown>): Record<string, unknown> => {
  const { updatedBy: _editor, ...figures } = target;
  return figures;
};

export function composeReportChartBasis(input: { snapshot: ChartBasisSnapshot; scope: ReportScope; comparison?: ReportEmissionsComparison | null }): ReportChartBasis {
  const { snapshot, scope } = input;
  const sites = scope.kind === "sites" ? new Set(scope.siteIds) : null;
  const rows = sites ? snapshot.measurements.filter((row) => typeof row.siteId === "string" && sites.has(row.siteId)) : snapshot.measurements;
  return {
    id: snapshot.id, jobId: snapshot.jobId, jobNumber: snapshot.jobNumber, client: snapshot.client, reportingYear: snapshot.reportingYear,
    generatedAt: snapshot.createdAt, dataHash: snapshot.dataHash,
    // The chart needs the target's figures, never who last edited it: a staff identity is not frozen into an issued record
    // (F-4c, the ruled follow-up to F-4b's read-strip; free now — no composition had been issued).
    intensityTarget: sites || !snapshot.intensityTarget ? null : withoutEditor(snapshot.intensityTarget),
    annualComparison: sites
      ? scopedAnnualComparison(input.comparison)
      : (snapshot.annualComparison ?? []).map((year) => ({ year: year.year, values: year.values.map((value) => ({ scope: scopeOf(value.scope), value: value.value })) })),
    measurements: rows.map(chartRow),
  };
}
