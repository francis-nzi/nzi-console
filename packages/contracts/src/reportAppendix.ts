// R5a (NZC-051) — the report's audit appendices. Both tables read straight off
// the frozen reviewed snapshot's `measurements` (already on every report
// version) — no new backend, migration or command. Pure functions so the
// pagination CSS (repeating `<thead>`, row-atomic breaks) has real long
// tables to apply to.
import { crpScopeCategoryLabel } from "./commands";

/** The subset of a snapshot measurement these builders need. */
export type ReportAuditMeasurement = {
  rowId: string;
  scope: "1" | "2" | "3";
  scopeCode?: string;
  sourceLabel: string;
  siteLabel?: string | null;
  sourceQuantity?: number | null;
  sourceUnit?: string | null;
  tco2e: number;
  factorSet: string;
  qualityTier: string;
};

export type ReportAuditRow = {
  rowId: string;
  scope: "1" | "2" | "3";
  category: string;
  sourceLabel: string;
  quantityLabel: string;
  factorSet: string;
  qualityTier: string;
  siteLabel: string;
  tco2e: number;
};

/** Appendix 1 — Full Emissions Audit: one row per measurement. */
export function buildReportAuditRows(
  measurements: readonly ReportAuditMeasurement[],
): ReportAuditRow[] {
  return [...measurements]
    .sort(
      (a, b) =>
        a.scope.localeCompare(b.scope) ||
        (a.scopeCode ?? a.scope).localeCompare(b.scopeCode ?? b.scope) ||
        a.sourceLabel.localeCompare(b.sourceLabel),
    )
    .map((measurement) => ({
      rowId: measurement.rowId,
      scope: measurement.scope,
      category: crpScopeCategoryLabel(measurement.scopeCode ?? measurement.scope),
      sourceLabel: measurement.sourceLabel,
      quantityLabel:
        measurement.sourceQuantity == null
          ? "—"
          : `${measurement.sourceQuantity.toLocaleString("en-GB")}${measurement.sourceUnit ? ` ${measurement.sourceUnit}` : ""}`,
      factorSet: measurement.factorSet || "—",
      qualityTier: measurement.qualityTier,
      siteLabel: measurement.siteLabel?.trim() || "Unallocated",
      tco2e: measurement.tco2e,
    }));
}

export type ReportSiteCategoryTotal = { scopeCode: string; category: string; tco2e: number };
export type ReportSiteScopeTotal = { scope: "1" | "2" | "3"; total: number; categories: ReportSiteCategoryTotal[] };
export type ReportSiteBreakdown = { siteLabel: string; total: number; byScope: ReportSiteScopeTotal[] };

/** Appendix 2 — Emissions by Site, Scope & Category. */
export function buildReportSiteBreakdown(
  measurements: readonly ReportAuditMeasurement[],
): ReportSiteBreakdown[] {
  const bySite = new Map<string, ReportAuditMeasurement[]>();
  for (const measurement of measurements) {
    const site = measurement.siteLabel?.trim() || "Unallocated";
    bySite.set(site, [...(bySite.get(site) ?? []), measurement]);
  }
  return [...bySite.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([siteLabel, rows]) => {
      const total = rows.reduce((sum, row) => sum + row.tco2e, 0);
      const byScope = (["1", "2", "3"] as const)
        .map((scope) => {
          const scopeRows = rows.filter((row) => row.scope === scope);
          const categoryTotals = new Map<string, number>();
          for (const row of scopeRows) {
            const code = row.scopeCode ?? row.scope;
            categoryTotals.set(code, (categoryTotals.get(code) ?? 0) + row.tco2e);
          }
          const categories = [...categoryTotals.entries()]
            .map(([scopeCode, tco2e]) => ({ scopeCode, category: crpScopeCategoryLabel(scopeCode), tco2e }))
            .sort((a, b) => a.category.localeCompare(b.category));
          return { scope, total: categories.reduce((sum, c) => sum + c.tco2e, 0), categories };
        })
        .filter((scopeTotal) => scopeTotal.categories.length > 0);
      return { siteLabel, total, byScope };
    });
}
