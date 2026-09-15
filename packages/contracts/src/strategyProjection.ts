import type { ClientStrategy } from "./reductionStrategies";
import type { TargetBenchmark, TargetPoint } from "./targets";

/**
 * The projected trajectory: what the client's own strategies are expected to deliver.
 *
 * **A projection is an estimate, and never the footprint.** Nothing in this module reads a
 * reviewed snapshot, and nothing it returns may be rendered as measured. The three
 * trajectories answer three different questions and must stay visibly separate:
 *
 * - **target** — what the client committed to (top-down, from the target model)
 * - **projected** — what their plan is expected to deliver (bottom-up, this module)
 * - **actual** — what was measured (assured snapshots)
 *
 * The value is the distance between them. A projection that quietly merged into the actual
 * line would destroy exactly the comparison it exists to make.
 */

export const estimateUnits = ["tco2e_per_year", "percent"] as const;
export type EstimateUnit = (typeof estimateUnits)[number];

export const estimateConfidences = ["low", "medium", "high"] as const;
export type EstimateConfidence = (typeof estimateConfidences)[number];

export const estimateSources = ["library-default", "consultant"] as const;
export type EstimateSource = (typeof estimateSources)[number];

/** The scopes a reduction can land on. Governance strategies enable, they do not abate. */
export const estimateScopes = ["1", "2", "3"] as const;
export type EstimateScope = (typeof estimateScopes)[number];

export type StrategyEstimate = {
  amount: number;
  unit: EstimateUnit;
  scope: EstimateScope;
  /** What the roll-up sums, resolved once and stored — never recomputed on read. */
  tco2ePerYear: number;
  assumptions: string;
  confidence: EstimateConfidence | null;
  source: EstimateSource;
  /** The library version a seed came from, so "seeded from v3" stays true after v4. */
  sourceVersion: number | null;
};

export const estimateUnitLabels: Record<EstimateUnit, string> = {
  tco2e_per_year: "tCO₂e per year",
  percent: "% of baseline scope",
};

export const estimateSourceLabels: Record<EstimateSource, string> = {
  "library-default": "Seeded from the catalogue",
  consultant: "Consultant estimate",
};

/**
 * Resolve an entered amount to tCO₂e/yr.
 *
 * A percent resolves against **this scope's share of the benchmark in force** — the same
 * denominator the target pathway uses, which is what makes bottom-up and top-down
 * comparable at all. Resolving against a different baseline would produce two numbers that
 * look like they belong on one chart and do not.
 *
 * Returns `null` when it cannot be resolved honestly: a percent needs a benchmark, and a
 * benchmark with no figure for that scope cannot be turned into tonnes. The caller says so
 * rather than storing a zero, which would read as "this saves nothing".
 */
export function resolveEstimateTco2e(
  input: { amount: number; unit: EstimateUnit; scope: EstimateScope },
  benchmark: TargetBenchmark | null,
): number | null {
  if (!Number.isFinite(input.amount) || input.amount < 0) return null;
  if (input.unit === "tco2e_per_year") return input.amount;
  const scopeTotal = benchmark?.scopes[input.scope];
  if (benchmark === null || scopeTotal === undefined || !Number.isFinite(scopeTotal)) return null;
  return (scopeTotal * input.amount) / 100;
}

/* ── Why a strategy contributes nothing ──────────────────────────────────────────────── */

/**
 * A strategy that adds nothing to the trajectory, and the honest reason.
 *
 * Each of these is a different fact, and none of them is "this saves nothing" — which is
 * what a zero on the chart would say.
 */
export type ProjectionExclusion =
  | { strategyId: string; title: string; reason: "no-estimate"; detail: string }
  | { strategyId: string; title: string; reason: "no-target-date"; detail: string };

export type ProjectionContribution = {
  strategyId: string;
  title: string;
  scope: EstimateScope;
  tco2ePerYear: number;
  /** The year the reduction starts counting — the strategy's target date. */
  fromYear: number;
  estimate: StrategyEstimate;
};

/**
 * Split a plan into what contributes and what cannot, with the reason.
 *
 * **Undated contributes nothing.** The full annual reduction applies from the target date
 * onward, so a strategy with no date has no point at which to step in. Inventing one would
 * put a saving on the chart that nobody committed to a time for; it is flagged instead, so
 * the consultant knows to date it.
 */
export function splitProjectionInputs(plan: readonly ClientStrategy[]): {
  contributions: ProjectionContribution[];
  excluded: ProjectionExclusion[];
} {
  const contributions: ProjectionContribution[] = [];
  const excluded: ProjectionExclusion[] = [];
  for (const strategy of plan) {
    if (!strategy.active) continue;
    const estimate = strategy.estimate;
    if (estimate === null) {
      excluded.push({
        strategyId: strategy.id, title: strategy.title, reason: "no-estimate",
        detail: "No reduction estimate has been entered, so this contributes nothing to the projection.",
      });
      continue;
    }
    const year = yearOf(strategy.targetDate);
    if (year === null) {
      excluded.push({
        strategyId: strategy.id, title: strategy.title, reason: "no-target-date",
        detail: "No target date is set, so there is no year for this reduction to start from.",
      });
      continue;
    }
    contributions.push({
      strategyId: strategy.id, title: strategy.title, scope: estimate.scope,
      tco2ePerYear: estimate.tco2ePerYear, fromYear: year, estimate,
    });
  }
  return { contributions, excluded };
}

const yearOf = (date: string | null): number | null => {
  if (date === null || date === "") return null;
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) && year > 1900 ? year : null;
};

/* ── Over-claim ──────────────────────────────────────────────────────────────────────── */

/**
 * A scope whose projected reductions exceed the footprint they are reducing.
 *
 * Raised, never capped. Silently clamping to the footprint would make an arithmetic error
 * look like a plan that exactly eliminates a scope — the most flattering possible reading
 * of a mistake. The consultant resolves it by adjusting the estimates.
 */
export type ProjectionOverClaim = {
  scope: EstimateScope | "total";
  baselineTco2e: number;
  projectedTco2e: number;
  /** The strategies summing over the baseline — who to look at first. */
  strategyIds: string[];
  message: string;
};

export function projectionOverClaims(
  contributions: readonly ProjectionContribution[],
  benchmark: TargetBenchmark | null,
): ProjectionOverClaim[] {
  if (benchmark === null) return [];
  const claims: ProjectionOverClaim[] = [];
  for (const scope of estimateScopes) {
    const inScope = contributions.filter((entry) => entry.scope === scope);
    if (inScope.length === 0) continue;
    const baseline = benchmark.scopes[scope];
    if (baseline === undefined) continue;
    const projected = sum(inScope.map((entry) => entry.tco2ePerYear));
    if (projected > baseline) {
      claims.push({
        scope, baselineTco2e: baseline, projectedTco2e: projected,
        strategyIds: inScope.map((entry) => entry.strategyId),
        message: `Scope ${scope}: the plan projects ${round(projected)} tCO₂e/yr against a baseline of ${round(baseline)} tCO₂e. A scope cannot fall below zero — review these estimates.`,
      });
    }
  }
  const projectedTotal = sum(contributions.map((entry) => entry.tco2ePerYear));
  if (benchmark.totalTco2e > 0 && projectedTotal > benchmark.totalTco2e) {
    claims.push({
      scope: "total", baselineTco2e: benchmark.totalTco2e, projectedTco2e: projectedTotal,
      strategyIds: contributions.map((entry) => entry.strategyId),
      message: `The plan projects ${round(projectedTotal)} tCO₂e/yr against a total baseline of ${round(benchmark.totalTco2e)} tCO₂e. Review the estimates.`,
    });
  }
  return claims;
}

/* ── The trajectory ──────────────────────────────────────────────────────────────────── */

export type ProjectedPoint = { year: number; tco2e: number };

/**
 * The projected emissions line: the benchmark, less every reduction that has stepped in by
 * each year.
 *
 * Plotted across the same years the target pathway covers, so the two lines share an x-axis
 * and a baseline and can honestly be read against each other.
 *
 * **Never clamped at zero silently.** Where the plan over-claims the line would go negative;
 * it is floored at zero *and* the over-claim is raised, so the floor is visible as a warning
 * rather than passing for a plan that reaches net zero exactly.
 */
export function projectedTrajectory(
  contributions: readonly ProjectionContribution[],
  benchmark: TargetBenchmark | null,
  targetTrajectory: readonly TargetPoint[],
): ProjectedPoint[] {
  if (benchmark === null || targetTrajectory.length === 0) return [];
  const years = [...new Set(targetTrajectory.map((point) => point.year))].sort((a, b) => a - b);
  return years.map((year) => {
    const stepped = sum(contributions.filter((entry) => entry.fromYear <= year).map((entry) => entry.tco2ePerYear));
    return { year, tco2e: Math.max(0, benchmark.totalTco2e - stepped) };
  });
}

/**
 * What the plan delivers against what the target needs, at the target's own horizon.
 *
 * Stated as a number rather than left to two lines on a chart: "your plan delivers X, your
 * target needs Y" is the sentence a consultant acts on.
 */
export type ProjectionGap = {
  year: number;
  targetTco2e: number;
  projectedTco2e: number;
  /** Positive = the plan falls short of the target by this much. */
  shortfallTco2e: number;
  state: "short" | "meets";
};

export function projectionGap(
  projected: readonly ProjectedPoint[],
  targetTrajectory: readonly TargetPoint[],
): ProjectionGap | null {
  const horizon = [...targetTrajectory].filter((point) => point.kind !== "benchmark").sort((a, b) => b.year - a.year)[0];
  if (horizon === undefined) return null;
  const atHorizon = projected.find((point) => point.year === horizon.year);
  if (atHorizon === undefined) return null;
  const shortfall = atHorizon.tco2e - horizon.tco2e;
  return {
    year: horizon.year,
    targetTco2e: horizon.tco2e,
    projectedTco2e: atHorizon.tco2e,
    shortfallTco2e: Math.max(0, shortfall),
    state: shortfall > 0 ? "short" : "meets",
  };
}

/**
 * Whether a reduction that should already have landed shows up in the measured footprint.
 *
 * Only asked where a target date has passed and there is an assured figure for that year.
 * Until then there is nothing to check, and asserting a projection the actuals have already
 * overtaken is how a plan keeps claiming a saving that did not happen.
 */
export type ProjectionVsActual = {
  year: number;
  projectedTco2e: number;
  actualTco2e: number;
  /** Positive = the measured footprint is above what the plan projected. */
  differenceTco2e: number;
  state: "tracking" | "behind";
};

export function projectionVsActual(
  projected: readonly ProjectedPoint[],
  actuals: readonly { year: number; tco2e: number }[],
): ProjectionVsActual | null {
  const comparable = actuals
    .filter((actual) => projected.some((point) => point.year === actual.year))
    .sort((a, b) => b.year - a.year)[0];
  if (comparable === undefined) return null;
  const point = projected.find((entry) => entry.year === comparable.year)!;
  const difference = comparable.tco2e - point.tco2e;
  return {
    year: comparable.year,
    projectedTco2e: point.tco2e,
    actualTco2e: comparable.tco2e,
    differenceTco2e: difference,
    // A tolerance would be inventing a threshold nobody agreed; above is above.
    state: difference > 0 ? "behind" : "tracking",
  };
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const round = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 0 });
