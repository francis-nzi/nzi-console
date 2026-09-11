import { aggregateAssuranceYear, type AssuranceCategoryTotal, type AssuranceScopeTotals, type AssuranceSiteTotal } from "./dataAssurance";
import type { EmissionsTargetReadModel, ReviewedCrpSnapshotReadModel } from "./commands";

// Client portal Phase 2 · A1 — the assured baseline every portal analytics
// surface reads from (§0). Derived ONLY from the content-addressed published
// report snapshot, through the SAME `aggregateAssuranceYear` resolver the CRM
// report and Data Assurance use — so the portal number, the report number and
// the CRM number are always the same value. A1's dashboard aggregates this
// client-side; A2's lever targeting reads the same per-scope / per-category
// breakdown from the same contract (no reshape).

export type PortalTrendYear = {
  year: number;
  kind: "baseline" | "prior" | "current";
  /** null only when that reporting year has no published/reviewed history. */
  total: number | null;
  byScope: AssuranceScopeTotals;
};

export type PortalAssuredTarget = {
  baselineYear: number;
  baselineTco2e: number;
  interimYear: number;
  interimReductionPercent: number;
  netZeroYear: number;
};

export type PortalAssuredBaseline = {
  reportingYear: number;
  total: number;
  byScope: AssuranceScopeTotals;
  byCategory: AssuranceCategoryTotal[];
  bySite: AssuranceSiteTotal[];
  intensity: number | null;
  intensityUnit: string | null;
  target: PortalAssuredTarget | null;
};

export type PortalAssuredDashboard =
  | { published: false }
  | ({
      published: true;
      reportVersionId: string;
      publishedAt: string;
      /** The published report's evidence identity — moves only on a new publish. */
      dataHash: string;
      trend: PortalTrendYear[];
    } & PortalAssuredBaseline);

const measurementsFor = (rows: ReviewedCrpSnapshotReadModel["measurements"]) =>
  rows.map((row) => ({
    scope: row.scope,
    scopeCode: row.scopeCode ?? row.scope,
    siteId: row.siteId ?? null,
    siteLabel: row.siteLabel ?? null,
    tco2e: row.tco2e,
  }));

const intensityInput = (target: ReviewedCrpSnapshotReadModel["intensityTarget"]) =>
  target && target.reportingDenominator !== null && target.reportingDenominator > 0
    ? { reportingDenominator: target.reportingDenominator, denominatorUnit: target.denominatorUnit }
    : null;

const asTarget = (target: EmissionsTargetReadModel | null): PortalAssuredTarget | null =>
  target
    ? {
        baselineYear: target.baselineYear,
        baselineTco2e: target.baselineTco2e,
        interimYear: target.interimYear,
        interimReductionPercent: target.interimReductionPercent,
        netZeroYear: target.netZeroYear,
      }
    : null;

/** One published snapshot → the assured baseline breakdown. Pure. */
export function derivePortalBaseline(snapshot: ReviewedCrpSnapshotReadModel): PortalAssuredBaseline {
  const year = aggregateAssuranceYear({
    year: snapshot.reportingYear,
    kind: "current",
    source: "reviewed-snapshot",
    measurements: measurementsFor(snapshot.measurements),
    intensity: intensityInput(snapshot.intensityTarget),
  });
  return {
    reportingYear: snapshot.reportingYear,
    total: year.total ?? 0,
    byScope: year.byScope,
    byCategory: year.byCategory,
    bySite: year.bySite,
    intensity: year.intensity,
    intensityUnit: year.intensityUnit,
    target: asTarget(snapshot.target),
  };
}

/** One prior/baseline year's frozen snapshot → its trend row. Pure. */
export function derivePortalTrendYear(
  input: { year: number; kind: PortalTrendYear["kind"]; snapshot: ReviewedCrpSnapshotReadModel | null },
): PortalTrendYear {
  if (!input.snapshot) return { year: input.year, kind: input.kind, total: null, byScope: { "1": 0, "2": 0, "3": 0 } };
  const aggregated = aggregateAssuranceYear({
    year: input.year,
    kind: input.kind === "current" ? "current" : input.kind === "baseline" ? "baseline" : "prior",
    source: "reviewed-snapshot",
    measurements: measurementsFor(input.snapshot.measurements),
  });
  return { year: input.year, kind: input.kind, total: aggregated.total, byScope: aggregated.byScope };
}

/** Fraction of the way from the assured baseline to the interim target (0–1+),
 *  by year; null when the target or a figure is missing. Presentation-only. */
export function portalTargetProgress(baseline: PortalAssuredBaseline): number | null {
  const target = baseline.target;
  if (!target || !(target.baselineTco2e > 0) || !(target.interimReductionPercent > 0)) return null;
  const interimTco2e = target.baselineTco2e * (1 - target.interimReductionPercent / 100);
  const achieved = target.baselineTco2e - baseline.total;
  const required = target.baselineTco2e - interimTco2e;
  return required > 0 ? achieved / required : null;
}
