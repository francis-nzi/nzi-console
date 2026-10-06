// Redesign Phase 1b (0158) — a client's intensity targets, one per metric, beside net zero.
//
// The metric is the client's own (`client_intensity_metrics`, 0071) and the job records the year's Value against it; the
// target — a baseline intensity and the reductions from it — is the client's commitment and lives here. Versioned and
// append-only (the shape of `client_targets`): a change writes the next version; withdrawing writes a version with
// active = false and a reason. Moving a held baseline is a deliberate act, so it needs a reason too.
import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { type IntensityTargetRow, intensityTargetFromRow } from "./clientIntensityTargetRecords";
export * from "./clientIntensityTargetRecords";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

export type SetIntensityTargetResult = { clientId: string; metricKey: string; version: number; active: boolean };

const SELECT_LATEST = `SELECT version, baseline_year, baseline_intensity::text, interim_year, interim_reduction_pct::text, target_year, target_reduction_pct::text, active
  FROM nzi_console.client_intensity_targets WHERE organisation_id = $1 AND client_id = $2 AND metric_key = $3 ORDER BY version DESC LIMIT 1`;
// No row lock: the table is append-only (no UPDATE privilege, so no FOR UPDATE). Two writers of the same next version meet
// at the primary key, and the loser is told the record moved — a version conflict, never a raw error.
async function insertVersion(db: Queryable, sql: string, values: unknown[], expected: number): Promise<void> {
  try { await db.query(sql, values); }
  catch (error) { if ((error as { code?: string }).code === "23505") throw new VersionConflictError(expected, expected + 1); throw error; }
}

/** The commitment as the audit reads it — the numbers of the target, never money or a person. */
const summary = (row: { baselineYear: number; baselineIntensity: number; interimYear: number | null; interimReductionPct: number | null; targetYear: number | null; targetReductionPct: number | null; active: boolean }) => ({
  baselineYear: row.baselineYear, baselineIntensity: row.baselineIntensity,
  interim: row.interimYear === null ? null : `${row.interimYear} · −${row.interimReductionPct}%`,
  target: row.targetYear === null ? null : `${row.targetYear} · −${row.targetReductionPct}%`,
  active: row.active,
});
async function requireActiveMetric(db: Queryable, organisationId: string, clientId: string, metricKey: string): Promise<void> {
  const metric = (await db.query<{ active: boolean }>(
    `SELECT active FROM nzi_console.client_intensity_metrics WHERE organisation_id = $1 AND client_id = $2 AND metric_key = $3 ORDER BY version DESC LIMIT 1`,
    [organisationId, clientId, metricKey])).rows[0];
  if (!metric?.active) throw new CommandValidationError([{ field: "metricKey", code: "METRIC_NOT_ACTIVE", message: "Set a target on one of this client's active intensity metrics." }]);
}

/** Set one metric's target, as the next version. */
export function setClientIntensityTarget(pool: PoolLike, input: CommandInputMap["client.intensityTarget.set"], context: CommandContext): Promise<StoredOutcome<SetIntensityTargetResult>> {
  return runPostgresCommand(pool, "client.intensityTarget.set", input, context, async (db) => {
    await requireActiveMetric(db, context.organisationId, input.clientId, input.metricKey);
    const previousRow = (await db.query<IntensityTargetRow>(SELECT_LATEST, [context.organisationId, input.clientId, input.metricKey])).rows[0] ?? null;
    if ((previousRow?.version ?? 0) !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, previousRow?.version ?? 0);
    const previous = previousRow ? intensityTargetFromRow(previousRow) : null;
    // Moving a held baseline restates what the client committed to measure from — say why.
    const movesBaseline = previous !== null && previous.active && (previous.baselineYear !== input.baselineYear || previous.baselineIntensity !== input.baselineIntensity);
    if (movesBaseline && !context.reason?.trim()) {
      throw new CommandValidationError([{ field: "reason", code: "REASON_REQUIRED", message: "Moving the baseline of a held intensity target needs a reason." }]);
    }
    const version = (previousRow?.version ?? 0) + 1;
    await insertVersion(db,
      `INSERT INTO nzi_console.client_intensity_targets (organisation_id, client_id, metric_key, version, baseline_year, baseline_intensity,
         interim_year, interim_reduction_pct, target_year, target_reduction_pct, active, reason, set_by, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, $12, $13)`,
      [context.organisationId, input.clientId, input.metricKey, version, input.baselineYear, input.baselineIntensity,
        input.interimYear, input.interimReductionPct, input.targetYear, input.targetReductionPct, context.reason?.trim() || null, context.actorId, context.correlationId], input.expectedVersion);
    const after = summary({ ...input, active: true });
    return {
      data: { clientId: input.clientId, metricKey: input.metricKey, version, active: true },
      ...(previous ? { before: summary(previous) } : {}), after,
      entityType: "client_intensity_target", entityId: `${input.clientId}:${input.metricKey}`, topic: "client.intensity_target.set",
    };
  });
}

/** Withdraw one metric's target — a version that says so, with a reason. Never a delete. */
export function deactivateClientIntensityTarget(pool: PoolLike, input: CommandInputMap["client.intensityTarget.deactivate"], context: CommandContext): Promise<StoredOutcome<SetIntensityTargetResult>> {
  return runPostgresCommand(pool, "client.intensityTarget.deactivate", input, context, async (db) => {
    const previousRow = (await db.query<IntensityTargetRow>(SELECT_LATEST, [context.organisationId, input.clientId, input.metricKey])).rows[0];
    if (!previousRow) throw new CommandValidationError([{ field: "metricKey", code: "NOT_FOUND", message: "This metric has no target to withdraw." }]);
    if (previousRow.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, previousRow.version);
    if (!previousRow.active) throw new CommandValidationError([{ field: "metricKey", code: "ALREADY_INACTIVE", message: "This target is already withdrawn." }]);
    const previous = intensityTargetFromRow(previousRow);
    const version = previousRow.version + 1;
    await insertVersion(db,
      `INSERT INTO nzi_console.client_intensity_targets (organisation_id, client_id, metric_key, version, baseline_year, baseline_intensity,
         interim_year, interim_reduction_pct, target_year, target_reduction_pct, active, reason, set_by, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11, $12, $13)`,
      [context.organisationId, input.clientId, input.metricKey, version, previous.baselineYear, previous.baselineIntensity,
        previous.interimYear, previous.interimReductionPct, previous.targetYear, previous.targetReductionPct, context.reason!.trim(), context.actorId, context.correlationId], input.expectedVersion);
    return {
      data: { clientId: input.clientId, metricKey: input.metricKey, version, active: false },
      before: summary(previous), after: summary({ ...previous, active: false }),
      entityType: "client_intensity_target", entityId: `${input.clientId}:${input.metricKey}`, topic: "client.intensity_target.deactivated",
    };
  });
}
