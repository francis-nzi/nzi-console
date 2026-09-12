// NZC-072 — reading the forward target model: the stored version, the benchmark in force,
// and the pathway and gap derived from the same functions the chart draws with.
import {
  benchmarkFromClientRecord, benchmarkIsStale, hasForwardTargets, latestTargetGap, targetGaps, targetTrajectory,
  type CommandContext, type CommandInputMap, type ForwardTargetModel, type TargetBenchmark, type TargetGap, type TargetMilestone, type TargetPoint, type TargetScope,
} from "@nzi/contracts";
import type { Queryable } from "./postgres";

export type TargetRow = {
  version: number;
  near_term_year: number | null; near_term_pct: string | null;
  net_zero_year: number | null; net_zero_pct: string | null;
  scope1_year: number | null; scope1_pct: string | null;
  scope2_year: number | null; scope2_pct: string | null;
  scope3_year: number | null; scope3_pct: string | null;
  benchmark_year: number; benchmark_total_tco2e: string;
  benchmark_scope1_tco2e: string | null; benchmark_scope2_tco2e: string | null; benchmark_scope3_tco2e: string | null;
  benchmark_source: TargetBenchmark["source"]; benchmark_ref: string | null;
  reason: string | null; restated_benchmark: boolean; set_by: string; set_at: Date | string;
};

export const TARGET_COLUMNS = "version,near_term_year,near_term_pct,net_zero_year,net_zero_pct,scope1_year,scope1_pct,scope2_year,scope2_pct,scope3_year,scope3_pct,benchmark_year,benchmark_total_tco2e,benchmark_scope1_tco2e,benchmark_scope2_tco2e,benchmark_scope3_tco2e,benchmark_source,benchmark_ref,reason,restated_benchmark,set_by,set_at";

const milestone = (year: number | null, pct: string | null): TargetMilestone | null => year === null || pct === null ? null : { year, pct: Number(pct) };
const numeric = (value: string | null) => value === null ? undefined : Number(value);

export function modelFromRow(row: TargetRow): ForwardTargetModel {
  const scopes: Partial<Record<TargetScope, TargetMilestone>> = {};
  const scope1 = milestone(row.scope1_year, row.scope1_pct); if (scope1) scopes["1"] = scope1;
  const scope2 = milestone(row.scope2_year, row.scope2_pct); if (scope2) scopes["2"] = scope2;
  const scope3 = milestone(row.scope3_year, row.scope3_pct); if (scope3) scopes["3"] = scope3;
  return { nearTerm: milestone(row.near_term_year, row.near_term_pct), netZero: milestone(row.net_zero_year, row.net_zero_pct), scopes };
}

export function benchmarkFromRow(row: TargetRow): TargetBenchmark {
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
  /** The benchmark this version was set against (stamped), and the one in force now. */
  benchmark: TargetBenchmark | null;
  benchmarkInForce: TargetBenchmark | null;
  /** NZC-068 — the baseline moved after these targets were set: they are held, not restated. */
  benchmarkStale: boolean;
  setBy: string | null;
  setAt: string | null;
  reason: string | null;
  /** The target line, and actual against it — the pathway chart and the gap read these. */
  trajectory: TargetPoint[];
  gaps: TargetGap[];
  latestGap: TargetGap | null;
};

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : String(value);

/** The client's target record, the benchmark in force, and everything derived from the two. */
export async function getClientTargets(db: Queryable, clientId: string, input: { benchmarkInForce: TargetBenchmark | null; actuals: readonly TargetActual[] }): Promise<ClientTargetsReadModel> {
  const { rows } = await db.query<TargetRow>(
    `SELECT ${TARGET_COLUMNS} FROM nzi_console.client_targets WHERE client_id=$1 ORDER BY version DESC LIMIT 1`,
    [clientId],
  );
  const row = rows[0];
  const empty: ClientTargetsReadModel = {
    model: null, version: 0, benchmark: null, benchmarkInForce: input.benchmarkInForce, benchmarkStale: false,
    setBy: null, setAt: null, reason: null, trajectory: [], gaps: [], latestGap: null,
  };
  if (!row) return empty;
  const model = modelFromRow(row), benchmark = benchmarkFromRow(row);
  if (!hasForwardTargets(model)) return { ...empty, version: row.version, benchmark, setBy: row.set_by, setAt: iso(row.set_at), reason: row.reason };
  const actuals = input.actuals.map((actual) => ({ year: actual.year, tco2e: actual.tco2e }));
  const gaps = targetGaps(benchmark, model, actuals);
  return {
    model, version: row.version, benchmark, benchmarkInForce: input.benchmarkInForce,
    benchmarkStale: benchmarkIsStale(benchmark, input.benchmarkInForce),
    setBy: row.set_by, setAt: iso(row.set_at), reason: row.reason,
    trajectory: targetTrajectory(benchmark, model), gaps, latestGap: latestTargetGap(gaps),
  };
}

/** The benchmark in force for a client, from the baseline the client record carries (the `client_baselines` seam). */
export async function getBenchmarkInForce(db: Queryable, clientId: string): Promise<TargetBenchmark | null> {
  const { rows } = await db.query<{ baseline_period_start: Date | string | null; baseline_total_tco2e: string | null; baseline_scope1_tco2e: string | null; baseline_scope2_tco2e: string | null; baseline_scope3_tco2e: string | null }>(
    `SELECT baseline_period_start,baseline_total_tco2e,baseline_scope1_tco2e,baseline_scope2_tco2e,baseline_scope3_tco2e FROM nzi_console.clients WHERE client_id=$1`,
    [clientId],
  );
  const row = rows[0];
  if (!row) return null;
  const date = (value: Date | string | null) => value === null ? null : iso(value).slice(0, 10);
  return benchmarkFromClientRecord({
    baselinePeriodStart: date(row.baseline_period_start),
    baselineTotalTco2e: row.baseline_total_tco2e === null ? null : Number(row.baseline_total_tco2e),
    baselineScope1Tco2e: row.baseline_scope1_tco2e === null ? null : Number(row.baseline_scope1_tco2e),
    baselineScope2Tco2e: row.baseline_scope2_tco2e === null ? null : Number(row.baseline_scope2_tco2e),
    baselineScope3Tco2e: row.baseline_scope3_tco2e === null ? null : Number(row.baseline_scope3_tco2e),
  });
}
