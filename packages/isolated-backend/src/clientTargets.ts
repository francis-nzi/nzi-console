// NZC-072 — setting the forward targets: a new version, stamped with the benchmark in
// force. A re-baseline never rewrites targets; restating them onto a moved benchmark is an
// explicit, reasoned act (NZC-068).
import {
  benchmarkIsStale, hasForwardTargets,
  type CommandContext, type CommandInputMap, type ForwardTargetModel, type TargetMilestone,
} from "@nzi/contracts";
import { benchmarkFromRow, getBenchmarkInForce, modelFromRow, TARGET_COLUMNS, type TargetRow } from "./clientTargetRecords";
import { VersionConflictError } from "./errors";
import type { PoolLike } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
export * from "./clientTargetRecords";

export type SetClientTargetsResult = { clientId: string; version: number; benchmarkYear: number; restatedBenchmark: boolean };

const write = (value: { year: number | null; pct: number | null } | undefined) => [value?.year ?? null, value?.pct ?? null];

/**
 * Save the forward targets as the next version, stamped with the benchmark in force.
 *
 * A re-baseline never rewrites targets: they are held against the benchmark they were set
 * against. Moving them onto a new benchmark is this command with
 * `restateAgainstBenchmark` and a reason — an explicit, recorded choice (NZC-068).
 */
export function setClientTargets(pool: PoolLike, input: CommandInputMap["client.targets.set"], context: CommandContext): Promise<StoredOutcome<SetClientTargetsResult>> {
  return runPostgresCommand(pool, "client.targets.set", input, context, async (db) => {
    const benchmark = await getBenchmarkInForce(db, input.clientId);
    if (!benchmark) {
      throw new CommandValidationError([{ field: "clientId", code: "BASELINE_REQUIRED", message: "Set the client's baseline first — a target is a reduction against it." }]);
    }
    const current = await db.query<TargetRow>(`SELECT ${TARGET_COLUMNS} FROM nzi_console.client_targets WHERE organisation_id=$1 AND client_id=$2 ORDER BY version DESC LIMIT 1`, [context.organisationId, input.clientId]);
    const previous = current.rows[0] ?? null;
    if ((previous?.version ?? 0) !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, previous?.version ?? 0);

    // Held by default: a moved benchmark is restated only when it is asked for, with a reason.
    const stale = previous ? benchmarkIsStale(benchmarkFromRow(previous), benchmark) : false;
    const restating = stale && hasForwardTargets(modelFromRow(previous!));
    if (restating && !input.restateAgainstBenchmark) {
      throw new CommandValidationError([{
        field: "restateAgainstBenchmark", code: "BENCHMARK_MOVED",
        message: `These targets were set against the ${previous!.benchmark_year} benchmark, which has since been restated. They are held until you restate them against the ${benchmark.year} benchmark deliberately.`,
      }]);
    }
    if (restating && !context.reason?.trim()) {
      throw new CommandValidationError([{ field: "reason", code: "REASON_REQUIRED", message: "Restating targets onto a new benchmark needs a reason." }]);
    }
    for (const year of [input.nearTerm?.year, input.netZero?.year, input.scope1?.year, input.scope2?.year, input.scope3?.year]) {
      if (year != null && year <= benchmark.year) {
        throw new CommandValidationError([{ field: "nearTerm.year", code: "AFTER_BENCHMARK", message: `A target year must come after the ${benchmark.year} benchmark year.` }]);
      }
    }

    const version = (previous?.version ?? 0) + 1;
    const [nearYear, nearPct] = write(input.nearTerm), [netYear, netPct] = write(input.netZero);
    const [s1Year, s1Pct] = write(input.scope1), [s2Year, s2Pct] = write(input.scope2), [s3Year, s3Pct] = write(input.scope3);
    await db.query(
      `INSERT INTO nzi_console.client_targets (organisation_id,client_id,version,near_term_year,near_term_pct,net_zero_year,net_zero_pct,scope1_year,scope1_pct,scope2_year,scope2_pct,scope3_year,scope3_pct,
        benchmark_year,benchmark_total_tco2e,benchmark_scope1_tco2e,benchmark_scope2_tco2e,benchmark_scope3_tco2e,benchmark_source,benchmark_ref,reason,restated_benchmark,set_by,correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [context.organisationId, input.clientId, version, nearYear, nearPct, netYear, netPct, s1Year, s1Pct, s2Year, s2Pct, s3Year, s3Pct,
        benchmark.year, benchmark.totalTco2e, benchmark.scopes["1"] ?? null, benchmark.scopes["2"] ?? null, benchmark.scopes["3"] ?? null,
        benchmark.source, benchmark.reference, context.reason?.trim() || null, restating, context.actorId, context.correlationId],
    );
    const before = previous ? { version: previous.version, benchmarkYear: previous.benchmark_year, ...flatten(modelFromRow(previous)) } : { version: 0 };
    return {
      data: { clientId: input.clientId, version, benchmarkYear: benchmark.year, restatedBenchmark: restating, ...flatten({ nearTerm: milestoneOf(input.nearTerm), netZero: milestoneOf(input.netZero), scopes: {} }) },
      before,
      entityType: "client_targets",
      entityId: input.clientId,
      topic: "client.targets.set",
      // Moving the pathway and the gap onto a different benchmark is its own governed act.
      ...(restating ? { governedEvents: [{ action: "client_targets_restated", entityType: "client_targets", entityId: input.clientId, before: { benchmarkYear: previous!.benchmark_year, benchmarkTotalTco2e: Number(previous!.benchmark_total_tco2e) }, after: { benchmarkYear: benchmark.year, benchmarkTotalTco2e: benchmark.totalTco2e } }] } : {}),
    };
  });
}

const milestoneOf = (value: { year: number | null; pct: number | null } | undefined): TargetMilestone | null =>
  value?.year != null && value.pct != null ? { year: value.year, pct: value.pct } : null;

/** The audit event reads as the commitment itself, not as column names. */
function flatten(model: ForwardTargetModel): Record<string, unknown> {
  return {
    nearTerm: model.nearTerm ? `${model.nearTerm.year} · −${model.nearTerm.pct}%` : null,
    netZero: model.netZero ? `${model.netZero.year} · −${model.netZero.pct}%` : null,
  };
}
