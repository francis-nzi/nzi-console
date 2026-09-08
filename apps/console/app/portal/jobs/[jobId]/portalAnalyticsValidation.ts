import type { PortalAssuredDashboard } from "@nzi/contracts";

// Client portal Phase 2 · A1 — shared guard for the assured-dashboard payload
// (`/api/portal/jobs/[jobId]/dashboard`). Server-side it is the 502 gate; the
// client re-validates before rendering a figure.

const finiteNonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const validDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

const isScopeTotals = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const totals = value as Record<string, unknown>;
  return finiteNonNegative(totals["1"]) && finiteNonNegative(totals["2"]) && finiteNonNegative(totals["3"]);
};

const isCategoryTotal = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return nonEmpty(row.scopeCode) && nonEmpty(row.label) && finiteNonNegative(row.tco2e);
};

const isSiteTotal = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (row.siteId === null || nonEmpty(row.siteId)) && nonEmpty(row.label) && finiteNonNegative(row.tco2e);
};

const isTrendYear = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Number.isInteger(row.year)
    && (row.kind === "baseline" || row.kind === "prior" || row.kind === "current")
    && (row.total === null || finiteNonNegative(row.total))
    && isScopeTotals(row.byScope);
};

const isTarget = (value: unknown): boolean => {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return Number.isInteger(target.baselineYear) && finiteNonNegative(target.baselineTco2e)
    && Number.isInteger(target.interimYear) && finiteNonNegative(target.interimReductionPercent)
    && Number.isInteger(target.netZeroYear);
};

export function isPortalAssuredDashboard(value: unknown): value is PortalAssuredDashboard {
  if (!value || typeof value !== "object") return false;
  const dashboard = value as Record<string, unknown>;
  if (dashboard.published === false) return true;
  if (dashboard.published !== true) return false;
  return nonEmpty(dashboard.reportVersionId)
    && validDate(dashboard.publishedAt)
    && nonEmpty(dashboard.dataHash)
    && Number.isInteger(dashboard.reportingYear)
    && finiteNonNegative(dashboard.total)
    && isScopeTotals(dashboard.byScope)
    && Array.isArray(dashboard.byCategory) && dashboard.byCategory.every(isCategoryTotal)
    && Array.isArray(dashboard.bySite) && dashboard.bySite.every(isSiteTotal)
    && (dashboard.intensity === null || finite(dashboard.intensity))
    && (dashboard.intensityUnit === null || nonEmpty(dashboard.intensityUnit))
    && isTarget(dashboard.target)
    && Array.isArray(dashboard.trend) && dashboard.trend.every(isTrendYear)
    && (dashboard.trend as Array<{ kind: string }>).some((year) => year.kind === "current");
}
