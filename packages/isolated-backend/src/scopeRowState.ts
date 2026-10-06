import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, requireCrpJob, runPostgresCommand, runPostgresCommandInTransaction, type StoredOutcome } from "./postgresCommands";

/**
 * JW-14 — removing a data-entry row, by what it holds.
 *
 *   - **A draft with no saved data** (captured in the console; no quantity in any form; never calculated, overridden or
 *     reviewed) is **discarded** — a true delete: there is nothing to keep. The audit event and the outbox say it was.
 *   - **A console row with data** is **deactivated** — out of entry and out of the totals, never deleted; its figures,
 *     review and history are kept, and it can be **reactivated**. A reason is required to deactivate.
 *   - **A row imported from v7 is locked** — neither (0133: history, disable-only by the owner's route, not here).
 *
 * Only the row's `enabled` (with `version`) changes on deactivate/reactivate — unlike `scope.row.update`, which resets
 * the calculation and the review on any write. A row the source register or an auto-pair manages, one a portal bucket
 * is built on, or one another row is paired with is not discarded (it is in use); it can still be deactivated.
 */

type StateRow = {
  version: number; origin: string; enabled: boolean; quantity: string | null; monthly: unknown; calculated: string | null;
  override: string | null; review_status: string; reviewed_by: string | null; source_id: string | null;
  is_auto_generated: boolean; auto_pair_kind: string | null; scope: string; category_code: string | null;
};
type RowRef = CommandInputMap["scope.row.discard"];
export type ScopeRowStateResult = { jobId: string; rowId: string; version: number | null; enabled: boolean | null; discarded: boolean };

async function lockRow(db: Queryable, context: CommandContext, input: RowRef): Promise<StateRow> {
  await requireCrpJob(db, context.organisationId, input.jobId);
  const row = (await db.query<StateRow>(
    `SELECT version, origin, enabled, quantity::text AS quantity, monthly_activity_json AS monthly, calculated_tco2e::text AS calculated,
            override_tco2e::text AS override, review_status, reviewed_by, source_id, coalesce(is_auto_generated, false) AS is_auto_generated,
            auto_pair_kind, scope, category_code
       FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3 FOR UPDATE`,
    [context.organisationId, input.jobId, input.rowId])).rows[0];
  if (!row) throw new CommandValidationError([{ field: "rowId", code: "NOT_FOUND", message: "Scope row was not found for this job." }]);
  if (row.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, row.version);
  if (row.origin === "migrated") {
    throw new CommandValidationError([{ field: "rowId", code: "ROW_LOCKED", message: "This row was imported from v7 — it is fixed history and cannot be removed or deactivated here." }]);
  }
  return row;
}

/** What a row holds that makes it more than an empty draft — named, so a refusal says which. */
function savedData(row: StateRow): string[] {
  const monthly = Array.isArray(row.monthly) ? row.monthly as Array<{ quantity?: unknown }> : [];
  const found: string[] = [];
  if (row.quantity !== null || monthly.some((slot) => slot?.quantity != null)) found.push("a quantity");
  if (row.calculated !== null || row.override !== null) found.push("a calculated figure");
  if (row.review_status !== "pending" || row.reviewed_by !== null) found.push("a review decision");
  return found;
}

const before = (row: StateRow) => ({ version: row.version, enabled: row.enabled, scope: row.scope, categoryCode: row.category_code });

function discardHandler(input: RowRef, context: CommandContext) {
  return async (db: Queryable) => {
    const row = await lockRow(db, context, input);
    const data = savedData(row);
    if (data.length) {
      throw new CommandValidationError([{ field: "rowId", code: "ROW_HAS_DATA",
        message: `This row holds ${data.join(" and ")}, so it is kept — deactivate it instead.` }]);
    }
    const inUse = row.source_id !== null || row.is_auto_generated || row.auto_pair_kind !== null ? "it is managed by the source register or paired automatically"
      : (await db.query(`SELECT 1 FROM nzi_console.portal_data_entry_bucket_grants WHERE organisation_id = $1 AND scope_row_id = $2 LIMIT 1`, [context.organisationId, input.rowId])).rows[0] ? "a portal data-entry bucket is built on it"
      : (await db.query(`SELECT 1 FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND linked_row_id = $2 LIMIT 1`, [context.organisationId, input.rowId])).rows[0] ? "another row is paired with it"
      : null;
    if (inUse) throw new CommandValidationError([{ field: "rowId", code: "ROW_IN_USE", message: `This row can't be discarded: ${inUse}. Deactivate it instead.` }]);
    await db.query(`DELETE FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3`, [context.organisationId, input.jobId, input.rowId]);
    return { data: { jobId: input.jobId, rowId: input.rowId, version: null, enabled: null, discarded: true } satisfies ScopeRowStateResult,
      before: before(row), entityType: "scope_row", entityId: input.rowId, topic: "scope.row.discarded" };
  };
}

function enabledHandler(input: RowRef, context: CommandContext, enabled: boolean) {
  return async (db: Queryable) => {
    const row = await lockRow(db, context, input);
    if (row.enabled === enabled) {
      throw new CommandValidationError([{ field: "rowId", code: enabled ? "ALREADY_ACTIVE" : "ALREADY_INACTIVE", message: enabled ? "This row is already active." : "This row is already deactivated." }]);
    }
    const updated = (await db.query<{ version: number }>(
      `UPDATE nzi_console.job_scope_rows SET enabled = $4, version = version + 1, updated_at = now()
        WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3 RETURNING version`,
      [context.organisationId, input.jobId, input.rowId, enabled])).rows[0]!;
    return { data: { jobId: input.jobId, rowId: input.rowId, version: updated.version, enabled, discarded: false } satisfies ScopeRowStateResult,
      before: before(row), entityType: "scope_row", entityId: input.rowId, topic: enabled ? "scope.row.reactivated" : "scope.row.deactivated" };
  };
}

export function discardScopeRow(pool: PoolLike, input: RowRef, context: CommandContext): Promise<StoredOutcome<ScopeRowStateResult>> {
  return runPostgresCommand(pool, "scope.row.discard", input, context, discardHandler(input, context));
}
/** The same, inside a caller's transaction — a gated clean-up's dry run is the whole run, rolled back. */
export function discardScopeRowInTransaction(db: Queryable, input: RowRef, context: CommandContext): Promise<StoredOutcome<ScopeRowStateResult>> {
  return runPostgresCommandInTransaction(db, "scope.row.discard", input, context, discardHandler(input, context));
}
export function deactivateScopeRow(pool: PoolLike, input: CommandInputMap["scope.row.deactivate"], context: CommandContext): Promise<StoredOutcome<ScopeRowStateResult>> {
  return runPostgresCommand(pool, "scope.row.deactivate", input, context, enabledHandler(input, context, false));
}
export function reactivateScopeRow(pool: PoolLike, input: CommandInputMap["scope.row.reactivate"], context: CommandContext): Promise<StoredOutcome<ScopeRowStateResult>> {
  return runPostgresCommand(pool, "scope.row.reactivate", input, context, enabledHandler(input, context, true));
}
