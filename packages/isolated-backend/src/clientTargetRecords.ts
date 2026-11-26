// NZC-072 — reading the forward target model: the stored version, the benchmark in force,
// and the pathway and gap derived from the same functions the chart draws with.
import {
  baselineYearOf, benchmarkForPendingStamp, benchmarkFromClientRecord, benchmarkIsStale, hasForwardTargets, isSamePeriod, latestTargetGap, targetGaps,
  targetMilestoneValues, targetTrajectory,
  type BaselineYearState, type EmissionsTargetReadModel, type ForwardTargetModel, type TargetBenchmark, type TargetGap, type TargetMilestone, type TargetMilestoneValue, type TargetPoint, type TargetScope,
} from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { dateOnly } from "./dates";

export type TargetRow = {
  version: number;
  near_term_year: number | null; near_term_pct: string | null;
  net_zero_year: number | null; net_zero_pct: string | null;
  scope1_year: number | null; scope1_pct: string | null;
  scope2_year: number | null; scope2_pct: string | null;
  scope3_year: number | null; scope3_pct: string | null;
  /** The total is null exactly when `benchmark_pending` (0238): the version was set while the baseline had no figures. */
  benchmark_year: number; benchmark_total_tco2e: string | null; benchmark_pending: boolean;
  benchmark_scope1_tco2e: string | null; benchmark_scope2_tco2e: string | null; benchmark_scope3_tco2e: string | null;
  benchmark_source: TargetBenchmark["source"]; benchmark_ref: string | null;
  reason: string | null; restated_benchmark: boolean; set_by: string; set_at: Date | string;
};

export const TARGET_COLUMNS = "version,near_term_year,near_term_pct,net_zero_year,net_zero_pct,scope1_year,scope1_pct,scope2_year,scope2_pct,scope3_year,scope3_pct,benchmark_year,benchmark_total_tco2e,benchmark_pending,benchmark_scope1_tco2e,benchmark_scope2_tco2e,benchmark_scope3_tco2e,benchmark_source,benchmark_ref,reason,restated_benchmark,set_by,set_at";

const milestone = (year: number | null, pct: string | null): TargetMilestone | null => year === null || pct === null ? null : { year, pct: Number(pct) };
const numeric = (value: string | null) => value === null ? undefined : Number(value);

export function modelFromRow(row: TargetRow): ForwardTargetModel {
  const scopes: Partial<Record<TargetScope, TargetMilestone>> = {};
  const scope1 = milestone(row.scope1_year, row.scope1_pct); if (scope1) scopes["1"] = scope1;
  const scope2 = milestone(row.scope2_year, row.scope2_pct); if (scope2) scopes["2"] = scope2;
  const scope3 = milestone(row.scope3_year, row.scope3_pct); if (scope3) scopes["3"] = scope3;
  return { nearTerm: milestone(row.near_term_year, row.near_term_pct), netZero: milestone(row.net_zero_year, row.net_zero_pct), scopes };
}

/** The benchmark a version was stamped with — null when it was set against a pending baseline (0238). */
export function benchmarkFromRow(row: TargetRow): TargetBenchmark | null {
  if (row.benchmark_pending || row.benchmark_total_tco2e === null) return null;
  const scopes: Partial<Record<TargetScope, number>> = {};
  const one = numeric(row.benchmark_scope1_tco2e); if (one !== undefined) scopes["1"] = one;
  const two = numeric(row.benchmark_scope2_tco2e); if (two !== undefined) scopes["2"] = two;
  const three = numeric(row.benchmark_scope3_tco2e); if (three !== undefined) scopes["3"] = three;
  return { year: row.benchmark_year, totalTco2e: Number(row.benchmark_total_tco2e), scopes, source: row.benchmark_source, reference: row.benchmark_ref };
}

/** One actual year, from the reviewed snapshot that stands for it. */
export type TargetActual = { year: number; tco2e: number; snapshotId: string; jobNumber: string };

export type ClientTargetsReadModel = {
  /** null = no targets have been set; the card says so rather than showing zeros. */
  model: ForwardTargetModel | null;
  version: number;
  /**
   * The benchmark this version is measured against: the one it was stamped with, or — for a version set while the baseline
   * was pending — the baseline in force once it has figures for that year (0238). Null while those figures are pending.
   */
  benchmark: TargetBenchmark | null;
  benchmarkInForce: TargetBenchmark | null;
  /** 0238 — the version stands on a baseline year whose figures are pending: every tCO₂e it implies shows "pending", never 0. */
  benchmarkPending: boolean;
  /** NZC-068 — the baseline moved after these targets were set: they are held, not restated. */
  benchmarkStale: boolean;
  /** 0238 — the baseline year (pending or with figures), the job that will supply it, and where its figures came from. */
  baselineYear: BaselineYearState | null;
  /** Each milestone set, its percentage and its tCO₂e (null = pending). */
  milestones: TargetMilestoneValue[];
  setBy: string | null;
  setAt: string | null;
  reason: string | null;
  /** The target line, and actual against it — the pathway chart and the gap read these. Empty while pending. */
  trajectory: TargetPoint[];
  gaps: TargetGap[];
  latestGap: TargetGap | null;
};

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : String(value);

/** The client's target record, the benchmark in force, and everything derived from the two. */
export async function getClientTargets(db: Queryable, clientId: string, input: { benchmarkInForce: TargetBenchmark | null; actuals: readonly TargetActual[]; baselineYear?: BaselineYearState | null }): Promise<ClientTargetsReadModel> {
  const { rows } = await db.query<TargetRow>(
    `SELECT ${TARGET_COLUMNS} FROM nzi_console.client_targets WHERE client_id=$1 ORDER BY version DESC LIMIT 1`,
    [clientId],
  );
  const row = rows[0];
  const baselineYear = input.baselineYear ?? null;
  const empty: ClientTargetsReadModel = {
    model: null, version: 0, benchmark: null, benchmarkInForce: input.benchmarkInForce, benchmarkPending: false, benchmarkStale: false, baselineYear,
    milestones: [], setBy: null, setAt: null, reason: null, trajectory: [], gaps: [], latestGap: null,
  };
  if (!row) return empty;
  const model = modelFromRow(row);
  const stamped = benchmarkFromRow(row);
  // A pending stamp is measured against the baseline in force once it has figures for the stamped year; a moved year is held.
  const benchmark = stamped ?? benchmarkForPendingStamp(row.benchmark_year, input.benchmarkInForce);
  const inForceYear = input.benchmarkInForce?.year ?? baselineYear?.year ?? null;
  const benchmarkStale = stamped ? benchmarkIsStale(stamped, input.benchmarkInForce) : inForceYear !== null && inForceYear !== row.benchmark_year;
  const meta = { version: row.version, setBy: row.set_by, setAt: iso(row.set_at), reason: row.reason };
  if (!hasForwardTargets(model)) return { ...empty, ...meta, benchmark };
  const actuals = input.actuals.map((actual) => ({ year: actual.year, tco2e: actual.tco2e }));
  const measured = benchmark !== null;
  const gaps = measured ? targetGaps(benchmark, model, actuals) : [];
  return {
    model, ...meta, benchmark, benchmarkInForce: input.benchmarkInForce, benchmarkPending: !measured, benchmarkStale, baselineYear,
    milestones: targetMilestoneValues(benchmark, model),
    trajectory: measured ? targetTrajectory(benchmark, model) : [], gaps, latestGap: latestTargetGap(gaps),
  };
}

type ClientBaselineRow = {
  baseline_period_start: Date | string | null; baseline_period_end: Date | string | null;
  baseline_total_tco2e: string | null; baseline_scope1_tco2e: string | null; baseline_scope2_tco2e: string | null; baseline_scope3_tco2e: string | null;
  baseline_snapshot_id: string | null;
};
/** A SQL `date` as its calendar day — never through an instant (NZC-096). */
const dateOf = (value: Date | string | null | undefined) => value == null ? null : dateOnly(value);
const tonnesOf = (value: string | null | undefined) => value == null ? null : Number(value);

// The organisation is pinned in the query, with the tenant policy's own expression, not left to row-level security (see
// getBenchmarkInForce).
async function clientBaselineRow(db: Queryable, clientId: string): Promise<ClientBaselineRow | null> {
  const { rows } = await db.query<ClientBaselineRow>(
    `SELECT baseline_period_start,baseline_total_tco2e,baseline_scope1_tco2e,baseline_scope2_tco2e,baseline_scope3_tco2e,baseline_period_end,baseline_snapshot_id
       FROM nzi_console.clients WHERE organisation_id=current_setting('app.organisation_id',true) AND client_id=$1`,
    [clientId],
  );
  return rows[0] ?? null;
}

/**
 * The benchmark in force for a client, from the baseline the client record carries (the `client_baselines` seam).
 *
 * The organisation is pinned in the query, with the tenant policy's own expression, not left to row-level security: on a
 * connection that bypasses RLS (the staging script role holds BYPASSRLS) a client id alone could read another
 * organisation's baseline. With no tenant context it reads nothing, so callers see no benchmark rather than a stranger's
 * (found by the GATE 2 dry run).
 *
 * A baseline year with no figures (0238) is still no benchmark: every reader that measures against a number gets none.
 */
export async function getBenchmarkInForce(db: Queryable, clientId: string): Promise<TargetBenchmark | null> {
  const row = await clientBaselineRow(db, clientId);
  if (!row) return null;
  return benchmarkFromClientRecord({
    baselinePeriodStart: dateOf(row.baseline_period_start),
    baselineTotalTco2e: tonnesOf(row.baseline_total_tco2e),
    baselineScope1Tco2e: tonnesOf(row.baseline_scope1_tco2e),
    baselineScope2Tco2e: tonnesOf(row.baseline_scope2_tco2e),
    baselineScope3Tco2e: tonnesOf(row.baseline_scope3_tco2e),
  });
}

/**
 * Addendum A (ruled 25 Nov 2026) — one baseline, on the client. A job's "Reduction pathway target" is no longer its own entry
 * (`job_emissions_targets`, kept as read-only history): it **reads** the client's baseline and targets. The job page shows it,
 * the reviewed snapshot freezes it, and the report chart draws it. `baseline` is the client's baseline year (pending or not)
 * so the panel can say "figures pending"; `target` is the chart's shape, null until the client has a benchmark with figures,
 * a near-term and a net-zero milestone (the chart cannot draw a line without all three — never a 0 baseline).
 */
export type JobPathwayTarget = {
  clientId: string;
  baseline: BaselineYearState | null;
  targets: ClientTargetsReadModel;
  target: EmissionsTargetReadModel | null;
};

export async function getJobPathwayTarget(db: Queryable, jobId: string): Promise<JobPathwayTarget | null> {
  const job = (await db.query<{ client_id: string }>(
    `SELECT client_id FROM nzi_console.jobs WHERE organisation_id = current_setting('app.organisation_id', true) AND job_id = $1`, [jobId])).rows[0];
  if (!job) return null;
  const baseline = await getBaselineYearState(db, job.client_id);
  const targets = await getClientTargets(db, job.client_id, { benchmarkInForce: await getBenchmarkInForce(db, job.client_id), actuals: [], baselineYear: baseline });
  const { benchmark, model } = targets;
  const target: EmissionsTargetReadModel | null = benchmark && model?.nearTerm && model.netZero
    ? {
      jobId, baselineYear: benchmark.year, baselineTco2e: benchmark.totalTco2e, interimYear: model.nearTerm.year, interimReductionPercent: model.nearTerm.pct,
      netZeroYear: model.netZero.year, version: targets.version, updatedAt: targets.setAt ?? "", updatedBy: targets.setBy ?? "",
    }
    : null;
  return { clientId: job.client_id, baseline, targets, target };
}

/** Addendum A — whether a job is its client's baseline year: its reporting period is the baseline period (the header badge). */
export async function isClientBaselineYearJob(db: Queryable, jobId: string): Promise<boolean> {
  const row = (await db.query<{ from: Date | string | null; to: Date | string | null; start: Date | string | null; end: Date | string | null }>(
    `SELECT coalesce(j.reporting_period_start, c.reporting_from) AS "from", coalesce(j.reporting_period_end, c.reporting_to) AS "to",
            cl.baseline_period_start AS start, cl.baseline_period_end AS "end"
       FROM nzi_console.jobs j
       JOIN nzi_console.clients cl ON (cl.organisation_id, cl.client_id) = (j.organisation_id, j.client_id)
       LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id, c.job_id) = (j.organisation_id, j.job_id)
      WHERE j.organisation_id = current_setting('app.organisation_id', true) AND j.job_id = $1 AND j.job_family = 'crp'`, [jobId])).rows[0];
  if (!row) return false;
  const [from, to, start, end] = [dateOf(row.from), dateOf(row.to), dateOf(row.start), dateOf(row.end)];
  return Boolean(from && to && start && end && isSamePeriod(from, to, start, end));
}

/** A client's CRP job whose reporting period is the given period, with its current reviewed snapshot (null when it has none). */
export type BaselineYearJob = { jobId: string; jobNumber: string; snapshotId: string | null };

/**
 * 0238 rule 3 — the job that supplies the baseline year's figures: a CRP job of the client, not cancelled, whose reporting
 * period is the baseline period (`isSamePeriod`, the resolver's own rule). Its snapshot is the latest version that a newer
 * import has not superseded (0234). Several candidates: one with a snapshot first, then the highest job number.
 */
export async function findBaselineYearJob(db: Queryable, clientId: string, periodStart: string, periodEnd: string): Promise<BaselineYearJob | null> {
  const { rows } = await db.query<{ job_id: string; job_number: string; period_from: Date | string | null; period_to: Date | string | null; snapshot_id: string | null }>(
    `SELECT j.job_id, j.job_number,
            coalesce(j.reporting_period_start, c.reporting_from) AS period_from, coalesce(j.reporting_period_end, c.reporting_to) AS period_to,
            (SELECT s.snapshot_id FROM nzi_console.reviewed_crp_snapshots s
              WHERE (s.organisation_id, s.job_id) = (j.organisation_id, j.job_id)
                AND NOT EXISTS (SELECT 1 FROM nzi_console.reviewed_crp_snapshot_supersessions x WHERE (x.organisation_id, x.snapshot_id) = (s.organisation_id, s.snapshot_id))
              ORDER BY s.snapshot_version DESC LIMIT 1) AS snapshot_id
       FROM nzi_console.jobs j
       LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id, c.job_id) = (j.organisation_id, j.job_id)
      WHERE j.organisation_id = current_setting('app.organisation_id', true) AND j.client_id = $1 AND j.job_family = 'crp' AND j.status <> 'cancelled'`,
    [clientId],
  );
  const matching = rows
    .filter((row) => row.period_from != null && row.period_to != null && isSamePeriod(dateOf(row.period_from)!, dateOf(row.period_to)!, periodStart, periodEnd))
    .sort((a, b) => Number(b.snapshot_id !== null) - Number(a.snapshot_id !== null) || b.job_number.localeCompare(a.job_number));
  const job = matching[0];
  return job ? { jobId: job.job_id, jobNumber: job.job_number, snapshotId: job.snapshot_id } : null;
}

/**
 * 0238 rule 1 — the baseline year as the Carbon tab states it: the period, whether its figures are pending, the job that will
 * supply them (when there is one), and the snapshot the figures in force came from (when they did). Null with no period.
 */
export async function getBaselineYearState(db: Queryable, clientId: string): Promise<BaselineYearState | null> {
  const row = await clientBaselineRow(db, clientId);
  const periodStart = row ? dateOf(row.baseline_period_start) : null, periodEnd = row ? dateOf(row.baseline_period_end) : null;
  const year = baselineYearOf(periodStart);
  if (!row || year === null || periodStart === null || periodEnd === null) return null;
  const pending = [row.baseline_total_tco2e, row.baseline_scope1_tco2e, row.baseline_scope2_tco2e, row.baseline_scope3_tco2e].every((value) => value === null);
  let figuresFrom: BaselineYearState["figuresFrom"] = null;
  if (row.baseline_snapshot_id) {
    const cited = (await db.query<{ job_id: string; job_number: string }>(
      `SELECT j.job_id, j.job_number FROM nzi_console.reviewed_crp_snapshots s JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (s.organisation_id, s.job_id)
        WHERE s.organisation_id = current_setting('app.organisation_id', true) AND s.snapshot_id = $1`, [row.baseline_snapshot_id])).rows[0];
    if (cited) figuresFrom = { snapshotId: row.baseline_snapshot_id, jobId: cited.job_id, jobNumber: cited.job_number };
  }
  return { year, periodStart, periodEnd, pending, figuresFrom, supplyingJob: await findBaselineYearJob(db, clientId, periodStart, periodEnd) };
}
