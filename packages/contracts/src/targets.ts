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

/**
 * Decision 2 (Francis): a client's net-zero target **defaults to a 90% reduction by 2050** — NZI's methodology minimum —
 * both editable, so a new client is never left with the target blank or unpaired. A client committing to more (an
 * earlier year, a higher %) overrides it. It only ever fills a blank: never a value someone set, never an existing
 * client's held target.
 */
export const NET_ZERO_DEFAULT: TargetMilestone = { year: 2050, pct: 90 };

/**
 * Decision 2, server side (#403 flag #1, ruled): a client created with **neither** net-zero field takes the default pair,
 * so an API-created client matches the wizard's. **Omitted-only** — `undefined`, not `null`: a caller that sends either
 * field, or sends both as `null` (a target deliberately cleared), is respected as sent, and the pair rule still refuses
 * a year without its % (and the reverse). Create only; nothing calls this on update.
 */
export function withNetZeroDefault<T extends { netZeroTargetYear?: number | null; netZeroTargetReductionPct?: number | null }>(input: T): T {
  if (input.netZeroTargetYear !== undefined || input.netZeroTargetReductionPct !== undefined) return input;
  return { ...input, netZeroTargetYear: NET_ZERO_DEFAULT.year, netZeroTargetReductionPct: NET_ZERO_DEFAULT.pct };
}

/** Decision 2a(ii): the reduction-% field names the client's net-zero year — "Net Zero target % 2050", or "… % 2040". */
export function netZeroPctLabel(year: number | string | null | undefined): string {
  const parsed = typeof year === "string" ? Number(year.trim()) : year;
  const shown = typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 2000 && parsed <= 2100 ? parsed : NET_ZERO_DEFAULT.year;
  return `Net Zero target % ${shown}`;
}

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

/**
 * 0238 (ruled 25 Nov 2026) — a target version stamped while the baseline was pending has the year and no figures. Once the
 * baseline in force has figures **for that year**, the version is measured against them: figures arriving is not a
 * re-baseline, so nothing is held and nothing is restated. The percentage is the record; the tCO₂e is derived.
 * A different year is a moved baseline, and the version is held as `benchmarkIsStale` holds one.
 */
export function benchmarkForPendingStamp(stampedYear: number, inForce: TargetBenchmark | null): TargetBenchmark | null {
  return inForce && inForce.year === stampedYear ? inForce : null;
}

/** One milestone as the targets list shows it: the percentage (the record) and its tCO₂e, null while the baseline is pending. */
export type TargetMilestoneValue = { kind: "near-term" | "net-zero" | `scope${TargetScope}`; year: number; pct: number; tco2e: number | null };

/**
 * Each milestone set, with `benchmark × (1 − pct)` — or null ("pending") when the benchmark has no figures yet. A scope
 * target needs that scope's figure; a baseline without it leaves that milestone pending, never 0.
 */
export function targetMilestoneValues(benchmark: TargetBenchmark | null, model: ForwardTargetModel | null): TargetMilestoneValue[] {
  if (!model) return [];
  const values: TargetMilestoneValue[] = [];
  if (model.nearTerm) values.push({ kind: "near-term", ...model.nearTerm, tco2e: benchmark ? reduce(benchmark.totalTco2e, model.nearTerm.pct) : null });
  if (model.netZero) values.push({ kind: "net-zero", ...model.netZero, tco2e: benchmark ? reduce(benchmark.totalTco2e, model.netZero.pct) : null });
  for (const scope of ["1", "2", "3"] as const) {
    const milestone = model.scopes[scope];
    if (!milestone) continue;
    const scopeBenchmark = benchmark?.scopes[scope];
    values.push({ kind: `scope${scope}`, ...milestone, tco2e: scopeBenchmark === undefined ? null : reduce(scopeBenchmark, milestone.pct) });
  }
  return values;
}

/**
 * The baseline year as the Carbon tab states it (0238). `pending` = a period with no figures: "Baseline year … · figures
 * pending", never "No baseline". `supplyingJob` is the client's CRP job whose reporting period is the baseline period —
 * with its current reviewed snapshot when it has one, which is what "Use J… figures as the baseline" writes from.
 * `figuresFrom` names the snapshot the figures in force came from, when they did.
 */
export type BaselineYearState = {
  year: number;
  periodStart: string;
  periodEnd: string;
  pending: boolean;
  figuresFrom: { snapshotId: string; jobId: string; jobNumber: string } | null;
  supplyingJob: { jobId: string; jobNumber: string; snapshotId: string | null } | null;
};

/** The year a baseline period is labelled by — the year it starts in (the rule `benchmarkFromClientRecord` uses). Null without a period start. */
export function baselineYearOf(periodStart: string | null | undefined): number | null {
  return periodStart && /^\d{4}-\d{2}-\d{2}/.test(periodStart) ? Number(periodStart.slice(0, 4)) : null;
}

/** Whether the client record's baseline has any figure. A period alone is a pending baseline. */
export function baselineHasFigures(client: ClientRecordBaseline): boolean {
  return [client.baselineScope1Tco2e, client.baselineScope2Tco2e, client.baselineScope3Tco2e, client.baselineTotalTco2e].some((value) => typeof value === "number");
}

/**
 * 0238 rule 4 — 0 is not "pending". A baseline figure of 0 is a claim that the scope is genuinely zero, so it is accepted only
 * with an explicit confirm naming it; a blank is pending. The keys a confirm can name:
 */
export const baselineZeroFields = ["baselineScope1Tco2e", "baselineScope2Tco2e", "baselineScope3Tco2e", "baselineTotalTco2e"] as const;
export type BaselineZeroField = (typeof baselineZeroFields)[number];
export const BASELINE_ZERO_CONFIRM_TEXT = "This scope's baseline is zero, not unknown";

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
  // A period with no figures is a pending baseline (0238): still no benchmark, so no reader can measure against a number.
  const start = client.baselinePeriodStart;
  if (baselineYearOf(start) === null) return null;
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
  return { year: baselineYearOf(start)!, totalTco2e: total, scopes, source: "client-record", reference: null };
}
