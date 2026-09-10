// ── NZC-065 / NZC-067 / NZC-068 · the baseline, resolved in exactly one place ──
//
// The live platform grew **eleven** independent answers to "what is the baseline"
// — eight derivations of which *year*, plus three in the pathway charts, and four
// separate resolutions of which *job or figures* (MODEL_FIDELITY_BASELINE.md §1).
// Two pathway charts on one screen could start in different years for the same
// client, and one fallback resolved to a literal 2023.
//
// So there is one resolver here and the rule **never look earlier than the
// baseline in force** lives in it and nowhere else. Every consumer — the NZC-059
// trend table and BL pill, the pathway charts, NZC-060's gap engine, the portal —
// reads the resolved result rather than re-deriving it. The frontend receives it
// in the payload for the same reason: three of live's eleven were frontend
// re-derivations.

/** GHG Protocol distinguishes choosing a new base year from recalculating one after a
 *  structural change; they carry different disclosure obligations, so they are different acts. */
export type BaselineKind = "initial" | "rebaseline" | "recalculation";

/** `migrated_unverified` marks a record carried over from data that was never assured —
 *  the resolver declines to compare against it rather than treating it as a base year. */
export type BaselineSource = "assured" | "declared" | "migrated_unverified";

export type BaselineFigures = { scope1: number; scope2: number; scope3: number; total: number };

/** One row of `client_baselines`. Append-only: a re-baseline supersedes, never overwrites. */
export type ClientBaselineRecord = {
  baselineId: string;
  clientId: string;
  /** The period the baseline measures. */
  periodStart: string;
  periodEnd: string;
  /** Either a baseline job… */
  baselineJobId: string | null;
  /** …or typed figures. Both first-class: some clients' baselines predate the platform. */
  figures: BaselineFigures | null;
  kind: BaselineKind;
  source: BaselineSource;
  reason: string | null;
  setBy: string;
  setAt: string;
  /** The first reporting period this record governs — not the same as when it was entered. */
  effectiveFrom: string;
  supersededAt: string | null;
};

export type ResolvedBaseline = {
  record: ClientBaselineRecord;
  periodStart: string;
  periodEnd: string;
  figures: BaselineFigures | null;
  source: BaselineSource;
  /** A job that IS the baseline has nothing earlier to compare against — no BL column, no prior column. */
  jobIsItsOwnBaseline: boolean;
  /** False for `migrated_unverified`: present for context, never a comparison denominator. */
  comparable: boolean;
};

const day = 86_400_000;
const at = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/** Inclusive length of a reporting period in days. */
export function reportingPeriodDays(periodStart: string, periodEnd: string): number {
  return Math.round((at(periodEnd) - at(periodStart)) / day) + 1;
}

/**
 * Live (10 Sep) found stub jobs of 30–63 days and multi-year jobs of 452–790 days
 * standing in for reporting years. A 790-day total plotted as one year is a wrong
 * point, which is worse than no point — so a job represents a year only if its
 * reporting period is annual-ish.
 */
export const REPORTING_YEAR_MIN_DAYS = 300;
export const REPORTING_YEAR_MAX_DAYS = 400;

export function isEligibleReportingYear(periodStart: string, periodEnd: string): boolean {
  const days = reportingPeriodDays(periodStart, periodEnd);
  return days >= REPORTING_YEAR_MIN_DAYS && days <= REPORTING_YEAR_MAX_DAYS;
}

export type YearJobCandidate = { jobId: string; periodStart: string; periodEnd: string };

/**
 * Which job represents a client-year. Ineligible jobs are excluded outright and a
 * year with no eligible job yields null — no point rather than a wrong one. Among
 * eligible jobs: latest period end, then highest job id.
 *
 * (Live deduplicated to the highest `job_id` alone — insertion order, not authority.)
 */
export function selectReportingYearJob<T extends YearJobCandidate>(candidates: readonly T[]): T | null {
  const eligible = candidates.filter((job) => isEligibleReportingYear(job.periodStart, job.periodEnd));
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) =>
    at(b.periodEnd) - at(a.periodEnd) || (a.jobId < b.jobId ? 1 : a.jobId > b.jobId ? -1 : 0),
  )[0]!;
}

/**
 * Live compared baseline and reporting periods as exact 10-character string equality,
 * so a period differing by a single day — or stored at a different precision — was not
 * detected as "this job is its own baseline". A few days of tolerance fixes that without
 * letting genuinely different years collapse together.
 */
export const SAME_PERIOD_TOLERANCE_DAYS = 5;

export function isSamePeriod(
  aStart: string, aEnd: string, bStart: string, bEnd: string,
  toleranceDays: number = SAME_PERIOD_TOLERANCE_DAYS,
): boolean {
  const slack = toleranceDays * day;
  return Math.abs(at(aStart) - at(bStart)) <= slack && Math.abs(at(aEnd) - at(bEnd)) <= slack;
}

/**
 * The baseline record in force for a reporting period: the latest record that had taken
 * effect by the time that period began. Superseded records stay resolvable, which is what
 * lets a reissued report reproduce itself (NZC-066 stamps the result for exactly that reason).
 */
export function baselineInForce(
  records: readonly ClientBaselineRecord[],
  periodStart: string,
): ClientBaselineRecord | null {
  const eligible = records
    .filter((record) => at(record.effectiveFrom) <= at(periodStart))
    .sort((a, b) => at(b.effectiveFrom) - at(a.effectiveFrom) || Date.parse(b.setAt) - Date.parse(a.setAt));
  return eligible[0] ?? null;
}

/**
 * The one resolver (NZC-067). `figuresForJob` supplies the assured figures for a
 * job-referenced baseline — the caller owns snapshot access; this stays pure.
 */
export function resolveBaseline(input: {
  periodStart: string;
  periodEnd: string;
  records: readonly ClientBaselineRecord[];
  figuresForJob?: (jobId: string) => BaselineFigures | null;
}): ResolvedBaseline | null {
  const record = baselineInForce(input.records, input.periodStart);
  if (!record) return null;

  const figures = record.figures
    ?? (record.baselineJobId ? input.figuresForJob?.(record.baselineJobId) ?? null : null);

  return {
    record,
    periodStart: record.periodStart,
    periodEnd: record.periodEnd,
    figures,
    source: record.source,
    jobIsItsOwnBaseline: isSamePeriod(input.periodStart, input.periodEnd, record.periodStart, record.periodEnd),
    comparable: record.source !== "migrated_unverified" && figures !== null,
  };
}

/**
 * Never look earlier than the baseline in force. A baseline is the start of the measured
 * record, so a year at or before it is not a "prior year" — it is outside the record.
 */
export function yearsAfterBaseline(years: readonly number[], baselinePeriodEnd: string | null): number[] {
  if (baselinePeriodEnd === null) return [...years];
  const baselineYear = Number(baselinePeriodEnd.slice(0, 4));
  return years.filter((year) => year > baselineYear);
}
