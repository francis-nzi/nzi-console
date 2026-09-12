// ── NZC-072 · the forward target model ──
//
// The baseline is the past anchor — tonnes, measured, restated only through a governed
// re-baseline (NZC-065/068). Targets are the forward commitment — years and percentage
// reductions *against that benchmark*. They are different things with different
// governance, so they are different records; the only link is the benchmark a target
// version was set against, stamped when it was saved.
//
// Everything the pathway chart draws and everything the gap engine measures comes from
// the functions here, so the chart and the gap cannot tell different stories.

export type TargetScope = "1" | "2" | "3";
export type TargetMilestone = { year: number; pct: number };

/** The forward commitment. Any part may be unset — a client with nothing set has no targets, not zeros. */
export type ForwardTargetModel = {
  nearTerm: TargetMilestone | null;
  netZero: TargetMilestone | null;
  scopes: Partial<Record<TargetScope, TargetMilestone>>;
};

/**
 * The benchmark a target is measured against: the baseline in force, read — never typed
 * into the targets editor. `reference` says which record it came from so the card can
 * cite it.
 */
export type TargetBenchmark = {
  year: number;
  totalTco2e: number;
  scopes: Partial<Record<TargetScope, number>>;
  source: "client-record" | "baseline-record";
  reference: string | null;
};

export type TargetPointKind = "benchmark" | "near-term" | "net-zero";
export type TargetPoint = { year: number; tco2e: number; kind: TargetPointKind; pct: number };

export const emptyTargetModel = (): ForwardTargetModel => ({ nearTerm: null, netZero: null, scopes: {} });

/** A client with nothing set shows "No targets set" — never a zero line. */
export function hasForwardTargets(model: ForwardTargetModel | null | undefined): boolean {
  if (!model) return false;
  return Boolean(model.nearTerm || model.netZero) || (["1", "2", "3"] as const).some((scope) => model.scopes[scope]);
}

const reduce = (total: number, pct: number) => Math.max(0, total * (1 - pct / 100));

/**
 * The target line: the benchmark, then each milestone as `benchmark × (1 − pct)`, in year
 * order. Only milestones that are set appear — no invented points, and no assumed zero at
 * net zero (a 90% target leaves a 10% residual, which is what the client committed to).
 */
export function targetTrajectory(benchmark: TargetBenchmark, model: ForwardTargetModel): TargetPoint[] {
  const points: TargetPoint[] = [{ year: benchmark.year, tco2e: benchmark.totalTco2e, kind: "benchmark", pct: 0 }];
  if (model.nearTerm) points.push({ year: model.nearTerm.year, tco2e: reduce(benchmark.totalTco2e, model.nearTerm.pct), kind: "near-term", pct: model.nearTerm.pct });
  if (model.netZero) points.push({ year: model.netZero.year, tco2e: reduce(benchmark.totalTco2e, model.netZero.pct), kind: "net-zero", pct: model.netZero.pct });
  return points.sort((a, b) => a.year - b.year);
}

/** The same line for one scope, against that scope's share of the benchmark. Null when either is unset. */
export function scopeTargetTrajectory(benchmark: TargetBenchmark, model: ForwardTargetModel, scope: TargetScope): TargetPoint[] | null {
  const milestone = model.scopes[scope];
  const scopeBenchmark = benchmark.scopes[scope];
  if (!milestone || scopeBenchmark === undefined) return null;
  return [
    { year: benchmark.year, tco2e: scopeBenchmark, kind: "benchmark", pct: 0 },
    { year: milestone.year, tco2e: reduce(scopeBenchmark, milestone.pct), kind: "near-term", pct: milestone.pct },
  ];
}

/**
 * Where the line sits in a given year: straight between the anchors, held flat after the
 * last one (the commitment does not keep falling once it is met). Null before the
 * benchmark year, and null when there is no line at all.
 */
export function targetForYear(points: readonly TargetPoint[], year: number): number | null {
  if (points.length < 2) return null;
  const first = points[0]!, last = points[points.length - 1]!;
  if (year < first.year) return null;
  if (year >= last.year) return last.tco2e;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!, to = points[index]!;
    if (year <= to.year) {
      const span = to.year - from.year;
      return span === 0 ? to.tco2e : from.tco2e + ((to.tco2e - from.tco2e) * (year - from.year)) / span;
    }
  }
  return last.tco2e;
}

/** Within this much of the line (as a share of the benchmark) counts as on track rather than ahead or behind. */
export const TARGET_ON_TRACK_TOLERANCE_PCT = 0.5;

export type TargetGapStatus = "ahead" | "on-track" | "behind" | "no-target";
export type TargetGap = {
  year: number;
  actualTco2e: number;
  targetTco2e: number | null;
  /** Actual minus target: positive means above the line — behind the commitment. */
  gapTco2e: number | null;
  /** The gap as a share of the target, for a figure that reads the same at any scale. */
  gapPct: number | null;
  status: TargetGapStatus;
};

/**
 * Actual against the target line, year by year. The pathway chart and the gap engine both
 * read this, so a target change moves both together or neither.
 */
export function targetGaps(
  benchmark: TargetBenchmark,
  model: ForwardTargetModel,
  actuals: ReadonlyArray<{ year: number; tco2e: number }>,
): TargetGap[] {
  const points = targetTrajectory(benchmark, model);
  const tolerance = (benchmark.totalTco2e * TARGET_ON_TRACK_TOLERANCE_PCT) / 100;
  return [...actuals].sort((a, b) => a.year - b.year).map((actual) => {
    const target = hasForwardTargets(model) ? targetForYear(points, actual.year) : null;
    if (target === null) return { year: actual.year, actualTco2e: actual.tco2e, targetTco2e: null, gapTco2e: null, gapPct: null, status: "no-target" };
    const gap = actual.tco2e - target;
    return {
      year: actual.year,
      actualTco2e: actual.tco2e,
      targetTco2e: target,
      gapTco2e: gap,
      gapPct: target > 0 ? (gap / target) * 100 : null,
      status: Math.abs(gap) <= tolerance ? "on-track" : gap > 0 ? "behind" : "ahead",
    };
  });
}

/** The most recent year measured against the line — what the card and the gap engine headline. */
export function latestTargetGap(gaps: readonly TargetGap[]): TargetGap | null {
  const measured = gaps.filter((gap) => gap.status !== "no-target");
  return measured.length ? measured[measured.length - 1]! : null;
}

/**
 * NZC-068 — a target version is stamped with the benchmark it was set against. When a
 * re-baseline moves the benchmark, the targets are **held**: they stay in force, still
 * measured against the benchmark they were set against, and are flagged as standing on a
 * superseded one until someone restates them deliberately.
 */
export function benchmarkIsStale(stamped: Pick<TargetBenchmark, "year" | "totalTco2e">, inForce: Pick<TargetBenchmark, "year" | "totalTco2e"> | null): boolean {
  if (!inForce) return false;
  return stamped.year !== inForce.year || Math.abs(stamped.totalTco2e - inForce.totalTco2e) > 0.0005;
}

/** The baseline fields carried on the client record — the benchmark source until `client_baselines` (#137) lands. */
export type ClientRecordBaseline = {
  baselinePeriodStart?: string | null;
  baselinePeriodEnd?: string | null;
  baselineTotalTco2e?: number | null;
  baselineScope1Tco2e?: number | null;
  baselineScope2Tco2e?: number | null;
  baselineScope3Tco2e?: number | null;
};

/**
 * The benchmark in force for a client. One seam: today it reads the client record's
 * baseline fields; when the dated `client_baselines` record lands it reads the record in
 * force instead, and everything downstream is unchanged. Null when the client has no
 * baseline — there is then nothing to measure a percentage against, which is why the
 * targets editor asks for a baseline first.
 */
export function benchmarkFromClientRecord(client: ClientRecordBaseline): TargetBenchmark | null {
  // The label is the year the period starts in — FY23 is 01/04/2023–31/03/2024 for a March
  // year end, the same rule `reportingPeriodForYear` uses. Without a period there is no year.
  const start = client.baselinePeriodStart;
  if (!start || !/^\d{4}-\d{2}-\d{2}/.test(start)) return null;
  const scopes: Partial<Record<TargetScope, number>> = {};
  if (typeof client.baselineScope1Tco2e === "number") scopes["1"] = client.baselineScope1Tco2e;
  if (typeof client.baselineScope2Tco2e === "number") scopes["2"] = client.baselineScope2Tco2e;
  if (typeof client.baselineScope3Tco2e === "number") scopes["3"] = client.baselineScope3Tco2e;
  const scopeSum = (["1", "2", "3"] as const).reduce<number | null>((sum, scope) => {
    const value = scopes[scope];
    return value === undefined ? sum : (sum ?? 0) + value;
  }, null);
  const total = typeof client.baselineTotalTco2e === "number" ? client.baselineTotalTco2e : scopeSum;
  if (total === null) return null;
  return { year: Number(start.slice(0, 4)), totalTco2e: total, scopes, source: "client-record", reference: null };
}
