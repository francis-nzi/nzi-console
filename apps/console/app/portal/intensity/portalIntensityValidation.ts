import { intensityDividers, type IntensityMetricDefinition } from "@nzi/contracts";
import type { PortalIntensityReadModel, PortalIntensityYear } from "@nzi/isolated-backend";

// Client portal · intensity — the shared guard for `/api/portal/intensity`.
// Server-side it is the 502 gate (an unverifiable payload is never rendered as a
// figure); the client re-validates before drawing anything. Same shape of trust as
// `portalAnalyticsValidation`: a payload that does not verify is a *failed* state,
// never an empty one, and never a zero.

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const finiteNonNegative = (value: unknown): value is number => finite(value) && value >= 0;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const validDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

const isDefinition = (value: unknown): value is IntensityMetricDefinition => {
  if (!value || typeof value !== "object") return false;
  const metric = value as Record<string, unknown>;
  return nonEmpty(metric.key) && Number.isInteger(metric.version) && nonEmpty(metric.label)
    && typeof metric.unitWording === "string"
    && (intensityDividers as readonly number[]).includes(metric.divider as number)
    && nonEmpty(metric.iconKey) && typeof metric.isStandard === "boolean"
    && (metric.valueSource === "entered" || metric.valueSource === "site-floor-area")
    && typeof metric.active === "boolean" && Number.isInteger(metric.ordering);
};

const isDenominator = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const denominator = value as Record<string, unknown>;
  return (denominator.value === null || finite(denominator.value))
    && (denominator.source === "recorded" || denominator.source === "site-floor-area" || denominator.source === "none")
    && (denominator.reason === undefined || typeof denominator.reason === "string");
};

const isYear = (value: unknown): value is PortalIntensityYear => {
  if (!value || typeof value !== "object") return false;
  const year = value as Record<string, unknown>;
  if (!Number.isInteger(year.year) || !finiteNonNegative(year.totalTco2e)) return false;
  if (year.basis !== "published" && year.basis !== "prior") return false;
  if (!year.denominators || typeof year.denominators !== "object") return false;
  return Object.values(year.denominators as Record<string, unknown>).every(isDenominator);
};

export function isPortalIntensity(value: unknown): value is PortalIntensityReadModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  return (model.clientName === null || nonEmpty(model.clientName))
    && (model.reportingYear === null || Number.isInteger(model.reportingYear))
    && (model.publishedAt === null || validDate(model.publishedAt))
    && (model.dataHash === null || nonEmpty(model.dataHash))
    && Array.isArray(model.metrics) && model.metrics.every(isDefinition)
    && Array.isArray(model.years) && model.years.every(isYear);
}
