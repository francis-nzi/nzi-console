// Data Assurance track (M8, NZC-059/060). The Review & QA stage becomes the
// assurance surface: a multi-year emissions trend read against the baseline, a
// four-flag integrity gap engine, and a governed sign-off that freezes the same
// content-addressed reviewed snapshot the Report track consumes.

import { crpScopeCategoryLabel } from "./commands";

// ── DA1a · baseline / prior-year resolution ─────────────────────────────────
//
// How a CRP job finds its baseline year and the reporting years it is compared
// against (confirmed 4 Sep 2026):
//
//  - Baseline year  = the job's emissions target `baseline_year`
//    (`job_emissions_targets`). No target ⇒ no baseline (trend shows current +
//    priors only, no BL pill / % vs BL).
//  - Prior years    = the reviewed CRP snapshots for the SAME client_id with
//    `job_family = 'crp'` and `reporting_year < current`, one per distinct year
//    (latest `snapshot_version` wins — same rule the existing `annualComparison`
//    query in `report.snapshot.create` uses). The trend takes the baseline year
//    plus the three most recent prior years strictly between baseline and current.
//  - Current year   = the job's own `reporting_year`; its latest reviewed
//    snapshot if one exists, else `live` (the unreviewed job figures).
//
// No new column on `jobs` — the chain is client + reporting-year sequence.

export type ReportingChainSource = "reviewed-snapshot" | "live" | "none";

export type ReportingChainEntry = {
  year: number;
  kind: "baseline" | "prior" | "current";
  snapshotId: string | null;
  dataHash: string | null;
  source: ReportingChainSource;
};

export type CrpReportingChain = {
  jobId: string;
  clientId: string;
  currentYear: number;
  /** From `job_emissions_targets.baseline_year`; null when no target is set. */
  baselineYear: number | null;
  /** Ascending by year: `[baseline?, …priors, current]`. */
  entries: ReportingChainEntry[];
};

/** Build the ordered chain from the resolved parts. Pure. */
export function buildReportingChain(input: {
  jobId: string;
  clientId: string;
  currentYear: number;
  baselineYear: number | null;
  priorSnapshots: ReadonlyArray<{ year: number; snapshotId: string; dataHash: string }>;
  currentSnapshot: { snapshotId: string; dataHash: string } | null;
  priorYearCount?: number;
}): CrpReportingChain {
  const priorYearCount = input.priorYearCount ?? 3;
  const byYear = new Map(input.priorSnapshots.map((snap) => [snap.year, snap]));

  const priorYears = [...byYear.keys()]
    .filter((year) => year < input.currentYear && year !== input.baselineYear)
    .sort((a, b) => b - a)
    .slice(0, priorYearCount)
    .sort((a, b) => a - b);

  const entries: ReportingChainEntry[] = [];

  if (input.baselineYear != null) {
    const snap = byYear.get(input.baselineYear) ?? null;
    entries.push({
      year: input.baselineYear,
      kind: "baseline",
      snapshotId: snap?.snapshotId ?? null,
      dataHash: snap?.dataHash ?? null,
      source: snap ? "reviewed-snapshot" : "none",
    });
  }

  for (const year of priorYears) {
    const snap = byYear.get(year)!;
    entries.push({ year, kind: "prior", snapshotId: snap.snapshotId, dataHash: snap.dataHash, source: "reviewed-snapshot" });
  }

  entries.push({
    year: input.currentYear,
    kind: "current",
    snapshotId: input.currentSnapshot?.snapshotId ?? null,
    dataHash: input.currentSnapshot?.dataHash ?? null,
    source: input.currentSnapshot ? "reviewed-snapshot" : "live",
  });

  entries.sort((a, b) => a.year - b.year);
  return { jobId: input.jobId, clientId: input.clientId, currentYear: input.currentYear, baselineYear: input.baselineYear, entries };
}

// ── DA1b · multi-year emissions trend ──────────────────────────────────────

export type AssuranceScopeTotals = { "1": number; "2": number; "3": number };
export type AssuranceCategoryTotal = { scopeCode: string; label: string; tco2e: number };
export type AssuranceSiteTotal = { siteId: string | null; label: string; tco2e: number };

export type AssuranceTrendYear = {
  year: number;
  kind: "baseline" | "prior" | "current";
  source: ReportingChainSource;
  /** null only when `source` is "none". */
  total: number | null;
  byScope: AssuranceScopeTotals;
  byCategory: AssuranceCategoryTotal[];
  bySite: AssuranceSiteTotal[];
  /** total ÷ reporting denominator, when the year carries an intensity target. */
  intensity: number | null;
  intensityUnit: string | null;
};

export type AssuranceTrend = {
  jobId: string;
  clientId: string;
  currentYear: number;
  baselineYear: number | null;
  /** Ascending by year: `[baseline?, …priors, current]`. */
  years: AssuranceTrendYear[];
};

/** A measurement as any snapshot payload / live figure set carries it. */
export type AssuranceMeasurement = {
  scope: "1" | "2" | "3";
  scopeCode?: string | null;
  siteId?: string | null;
  siteLabel?: string | null;
  tco2e: number;
};

const ZERO_SCOPES = (): AssuranceScopeTotals => ({ "1": 0, "2": 0, "3": 0 });

/** Aggregate one reporting year's measurements into a trend row. Pure. */
export function aggregateAssuranceYear(input: {
  year: number;
  kind: "baseline" | "prior" | "current";
  source: ReportingChainSource;
  measurements: readonly AssuranceMeasurement[];
  intensity?: { reportingDenominator: number; denominatorUnit: string } | null;
}): AssuranceTrendYear {
  if (input.source === "none") {
    return { year: input.year, kind: input.kind, source: "none", total: null, byScope: ZERO_SCOPES(), byCategory: [], bySite: [], intensity: null, intensityUnit: null };
  }
  const byScope = ZERO_SCOPES();
  const categories = new Map<string, AssuranceCategoryTotal>();
  const sites = new Map<string, AssuranceSiteTotal>();
  let total = 0;
  for (const measurement of input.measurements) {
    total += measurement.tco2e;
    byScope[measurement.scope] += measurement.tco2e;
    const code = measurement.scopeCode ?? measurement.scope;
    const category = categories.get(code) ?? { scopeCode: code, label: crpScopeCategoryLabel(code), tco2e: 0 };
    category.tco2e += measurement.tco2e;
    categories.set(code, category);
    const siteKey = measurement.siteId ?? "__unallocated__";
    const site = sites.get(siteKey) ?? { siteId: measurement.siteId ?? null, label: measurement.siteLabel?.trim() || "Unallocated", tco2e: 0 };
    site.tco2e += measurement.tco2e;
    sites.set(siteKey, site);
  }
  const intensity = input.intensity && input.intensity.reportingDenominator > 0 ? total / input.intensity.reportingDenominator : null;
  return {
    year: input.year, kind: input.kind, source: input.source, total,
    byScope,
    byCategory: [...categories.values()].sort((a, b) => b.tco2e - a.tco2e),
    bySite: [...sites.values()].sort((a, b) => b.tco2e - a.tco2e),
    intensity,
    intensityUnit: input.intensity ? `tCO₂e / ${input.intensity.denominatorUnit}` : null,
  };
}

/** current ÷ baseline − 1, as a signed fraction. null when either side is missing. */
export function percentVsBaseline(currentTotal: number | null, baselineTotal: number | null): number | null {
  if (currentTotal == null || baselineTotal == null || !(baselineTotal > 0)) return null;
  return currentTotal / baselineTotal - 1;
}

// ── DA1c · integrity gap engine (NZC-060) ──────────────────────────────────

export type AssuranceGapFlag = "yoy_movement" | "completeness" | "zero_blank" | "unmapped";

/** A current-year row as the working scope rows / live figures carry it. */
export type AssuranceCurrentRow = {
  rowId: string;
  scope: "1" | "2" | "3";
  scopeCode: string | null;
  sourceLabel: string;
  siteId: string | null;
  quantity: number | null;
  hasFactor: boolean;
  /** calculated or override tCO₂e; null = uncalculated. */
  tco2e: number | null;
  enabled: boolean;
  hasMonthlyActivity: boolean;
};

export type GapResolution = { gapKey: string; reason: string; resolvedBy: string; resolvedAt: string };

export type AssuranceGap = {
  /** Deterministic — stable across recomputes so a resolution sticks. */
  key: string;
  flag: AssuranceGapFlag;
  scopeRowId: string | null;
  scopeCode: string | null;
  siteId: string | null;
  label: string;
  detail: string;
  resolved: boolean;
  resolution: { reason: string; resolvedBy: string; resolvedAt: string } | null;
};

export type AssuranceGaps = {
  gaps: AssuranceGap[];
  /** unresolved — blocks sign-off. */
  openCount: number;
  resolvedCount: number;
};

/** The Data Assurance stage screen — trend + gap engine result + resolutions. */
export type AssuranceScreen = {
  trend: AssuranceTrend;
  gaps: AssuranceGaps;
  resolutions: GapResolution[];
};

const YOY_LOW = 0.5;
const YOY_HIGH = 2;
const oneDp = (value: number): string => value.toLocaleString("en-GB", { maximumFractionDigits: 1 });

export function computeAssuranceGaps(input: {
  trend: AssuranceTrend;
  currentRows: readonly AssuranceCurrentRow[];
  resolutions: readonly GapResolution[];
}): AssuranceGaps {
  const resolvedByKey = new Map(input.resolutions.map((resolution) => [resolution.gapKey, resolution]));
  const gaps: AssuranceGap[] = [];
  const add = (
    flag: AssuranceGapFlag,
    key: string,
    label: string,
    detail: string,
    scope: { scopeRowId?: string; scopeCode?: string | null; siteId?: string | null } = {},
  ): void => {
    const resolution = resolvedByKey.get(key);
    gaps.push({
      key, flag, label, detail,
      scopeRowId: scope.scopeRowId ?? null,
      scopeCode: scope.scopeCode ?? null,
      siteId: scope.siteId ?? null,
      resolved: Boolean(resolution),
      resolution: resolution ? { reason: resolution.reason, resolvedBy: resolution.resolvedBy, resolvedAt: resolution.resolvedAt } : null,
    });
  };

  const enabled = input.currentRows.filter((row) => row.enabled);
  const currentYear = input.trend.years.find((year) => year.kind === "current");
  const priorWithData = [...input.trend.years]
    .reverse()
    .find((year) => year.kind !== "current" && year.source !== "none" && year.total != null);

  // (4) unmapped / uncalculated — per row
  for (const row of enabled) {
    if (!row.hasFactor) {
      add("unmapped", `unmapped:${row.rowId}`, row.sourceLabel, "No emission factor is mapped to this row.", { scopeRowId: row.rowId, scopeCode: row.scopeCode });
    } else if (row.tco2e == null) {
      add("unmapped", `uncalculated:${row.rowId}`, row.sourceLabel, "This row has a factor but no calculated result.", { scopeRowId: row.rowId, scopeCode: row.scopeCode });
    }
  }

  // (3) zero / blank — factor set, quantity 0 or missing, no monthly activity
  for (const row of enabled) {
    if (row.hasFactor && !row.hasMonthlyActivity && (row.quantity == null || row.quantity === 0)) {
      add("zero_blank", `zero_blank:${row.rowId}`, row.sourceLabel, "A quantity is expected for this row but it is zero or blank.", { scopeRowId: row.rowId, scopeCode: row.scopeCode });
    }
  }

  // (2) completeness — a category / site with prior-year data and none now
  if (priorWithData && currentYear) {
    const currentCategory = new Map(currentYear.byCategory.map((category) => [category.scopeCode, category.tco2e]));
    for (const category of priorWithData.byCategory) {
      if (category.tco2e > 0 && !((currentCategory.get(category.scopeCode) ?? 0) > 0)) {
        add("completeness", `completeness:category:${category.scopeCode}`, category.label,
          `${category.label} had ${oneDp(category.tco2e)} tCO₂e in ${priorWithData.year} but nothing in ${currentYear.year}.`,
          { scopeCode: category.scopeCode });
      }
    }
    const currentSite = new Map(currentYear.bySite.map((site) => [site.siteId ?? "__unallocated__", site.tco2e]));
    for (const site of priorWithData.bySite) {
      const key = site.siteId ?? "__unallocated__";
      if (site.tco2e > 0 && !((currentSite.get(key) ?? 0) > 0)) {
        add("completeness", `completeness:site:${key}`, site.label,
          `${site.label} had data in ${priorWithData.year} but nothing in ${currentYear.year}.`,
          { siteId: site.siteId });
      }
    }
  }

  // (1) YoY movement — current category total vs the most recent prior, outside [0.5×, 2×]
  if (priorWithData && currentYear) {
    const priorCategory = new Map(priorWithData.byCategory.map((category) => [category.scopeCode, category.tco2e]));
    for (const category of currentYear.byCategory) {
      const prior = priorCategory.get(category.scopeCode);
      if (prior && prior > 0 && category.tco2e > 0) {
        const ratio = category.tco2e / prior;
        if (ratio < YOY_LOW || ratio > YOY_HIGH) {
          const change = ratio >= 1 ? `${ratio.toFixed(1)}×` : `${Math.round(ratio * 100)}% of`;
          add("yoy_movement", `yoy_movement:category:${category.scopeCode}`, category.label,
            `${category.label}: ${oneDp(category.tco2e)} tCO₂e is ${change} ${priorWithData.year} (${oneDp(prior)}).`,
            { scopeCode: category.scopeCode });
        }
      }
    }
  }

  const openCount = gaps.filter((gap) => !gap.resolved).length;
  return { gaps, openCount, resolvedCount: gaps.length - openCount };
}

/**
 * NZC-060 — a "% vs BL" reduction driven by an *unresolved* completeness /
 * zero-blank / unmapped flag reads neutral until the gap is resolved, so an
 * unverified data hole cannot look like a genuine reduction.
 */
export function percentVsBaselineTone(input: {
  scopeCode: string;
  percent: number | null;
  gaps: readonly AssuranceGap[];
}): "neutral" | "reduction" | "increase" {
  if (input.percent == null) return "neutral";
  const drivenByOpenGap = input.gaps.some(
    (gap) => !gap.resolved && gap.scopeCode === input.scopeCode && gap.flag !== "yoy_movement",
  );
  if (input.percent < 0 && drivenByOpenGap) return "neutral";
  return input.percent < 0 ? "reduction" : "increase";
}
