// The v7 re-sync of one named job (RULING-v7-resync-job v2, Route B; migration 0225). v7 changed a job's records after
// migration, so the console's migrated copy is stale. This brings that one job's migrated rows level with v7's current
// records — superseding the stale rows, never editing them — so the existing re-ingest can then be re-planned and re-run on
// the current figures. It is the only new piece; revert, re-plan, dry-run, commit and attest are the existing ones.
//
// The six invariants:
//   R1 — refused on a job snapshotted (the revert's own check, `snapshottedSince`) or with a completed re-ingest (revert it first).
//   R2 — the system principal `policy:v7-resync` only; every row and the job audited with ids, booleans and counts — no figures.
//   R3 — superseded, never deleted or edited: the stale row is switched off and marked with this run (0225, the only change 0133
//        allows it besides `enabled`), and v7's current record is inserted beside it. The revert flips both back.
//   R4 — re-sync never writes a live row. The re-ingest's D7 still gates every figure: a plan built before the re-sync is refused
//        (PLAN_SUPERSEDED_ROW), and a new plan must reconcile to the current rows to commit.
//   R5 — one named job, and only that job's rows: a v7 record that is current on another job is refused.
//   R6 — the loader is unchanged for every caller: it still refuses a client whose records changed. This is a separate entry
//        point that reuses the loader's own column list and comparison (`migratedRowCols`, `differs`).
//
// It refuses rather than guess where a person must decide: a v7 record gone from v7 (V7_ROW_REMOVED), and a changed or added
// row that is paired with another (V7_LINKED_ROW_CHANGED). A dry run is the whole re-sync, rolled back.
import { randomUUID } from "node:crypto";
import type { CommandContext } from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError, requireCrpJob } from "./postgresCommands";
import { differs, insert, migratedRowCols } from "./v7ClientLoad";
import { SOURCE_SYSTEM, type PlannedRow } from "./v7ClientImport";
import { snapshottedSince } from "./v7Reingest";

export const V7_RESYNC_ACTOR = "policy:v7-resync";
export const V7_RESYNC_RUN_PATTERN = /^v7-resync-[0-9a-f-]{36}$/;
export const V7_RESYNC_ROW_SUPERSEDED = "v7_row_resync_superseded";
export const V7_RESYNC_ROW_ADDED = "v7_row_resync_added";
export const V7_RESYNC_ROW_RESTORED = "v7_row_resync_restored";
export const V7_RESYNC_JOB = "v7.resync.job";
export const V7_RESYNC_REVERTED = "v7.resync.reverted";

export type V7ResyncContext = Pick<CommandContext, "organisationId" | "actorId" | "principal" | "reason">;
export type V7ResyncInput = {
  jobId: string; runId: string;
  /** The extract the planned rows came from (its manifest sha256), as the run's audit records it. */
  extractSha256: string;
  /** The importer's planned rows for this job, from a current v7 extract (`planV7ClientImport`). */
  rows: readonly PlannedRow[];
};
/** Ids and counts only (R2: no figures). */
export type V7ResyncResult = {
  runId: string; jobId: string; unchanged: number;
  superseded: Array<{ rowId: string; replacedBy: string }>;
  added: string[];
};
export type V7ResyncRevertResult = { runId: string; jobId: string; restored: string[]; switchedOff: string[] };

const fail = (code: string, message: string, field = "rows"): never => { throw new CommandValidationError([{ field, code, message }]); };

/** R2: the re-sync's own system principal, and a reason, or nothing runs. */
function requirePrincipal(context: V7ResyncContext): void {
  if (context.principal !== "system" || context.actorId !== V7_RESYNC_ACTOR)
    fail("NOT_RESYNC_PRINCIPAL", `Only ${V7_RESYNC_ACTOR}, as the system principal, re-syncs a job's v7 rows.`, "principal");
  if (!context.reason?.trim()) fail("REASON_REQUIRED", "A re-sync records why it ran; the reason is blank.", "reason");
}

/** The job, locked: a CRP job imported from v7. */
async function lockV7Job(db: Queryable, organisationId: string, jobId: string): Promise<{ client_id: string }> {
  await requireCrpJob(db, organisationId, jobId);
  const job = (await db.query<{ source_system: string | null; client_id: string }>(
    `SELECT source_system, client_id FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 FOR UPDATE`, [organisationId, jobId])).rows[0]!;
  if (job.source_system !== SOURCE_SYSTEM) fail("NOT_A_V7_JOB", "Only a job imported from NZ Insights Pro v7 is re-synced.", "jobId");
  return job;
}

const completedReingest = async (db: Queryable, organisationId: string, jobId: string) =>
  (await db.query(`SELECT 1 FROM nzi_console.v7_reingest_runs WHERE organisation_id = $1 AND job_id = $2 AND status = 'completed'`, [organisationId, jobId])).rows.length > 0;

type CurrentRow = { scope_row_id: string; job_id: string; legacy_db_id: string; enabled: boolean; linked_row_id: string | null };

/** The current (not superseded) migrated rows carrying these v7 identities, wherever they are. */
async function currentByIdentity(db: Queryable, organisationId: string, legacyDbIds: readonly string[]): Promise<Map<string, CurrentRow>> {
  return new Map((await db.query<CurrentRow>(
    `SELECT scope_row_id, job_id, legacy_db_id, enabled, linked_row_id FROM nzi_console.job_scope_rows
      WHERE organisation_id = $1 AND source_system = $2 AND legacy_db_id = ANY($3::text[]) AND superseded_by_run IS NULL FOR UPDATE`,
    [organisationId, SOURCE_SYSTEM, [...legacyDbIds]])).rows.map((row) => [row.legacy_db_id, row]));
}

/** The job's current migrated rows. */
async function currentOfJob(db: Queryable, organisationId: string, jobId: string): Promise<CurrentRow[]> {
  return (await db.query<CurrentRow>(
    `SELECT scope_row_id, job_id, legacy_db_id, enabled, linked_row_id FROM nzi_console.job_scope_rows
      WHERE organisation_id = $1 AND job_id = $2 AND origin = 'migrated' AND superseded_by_run IS NULL ORDER BY scope_row_id FOR UPDATE`,
    [organisationId, jobId])).rows;
}

async function audit(db: Queryable, context: V7ResyncContext, clientId: string, runId: string, action: string, entityType: string, entityId: string,
  before: Record<string, unknown> | null, after: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,reason,before_json,after_json,client_id)
     VALUES ($1,$2,$3,'system',$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
    [context.organisationId, randomUUID(), context.actorId, action, entityType, entityId, runId, context.reason!.trim(),
      before === null ? null : JSON.stringify(before), JSON.stringify(after), clientId]);
}

/** The re-sync, inside the caller's transaction (the dry run is this, rolled back). */
export async function resyncV7JobInTransaction(db: Queryable, input: V7ResyncInput, context: V7ResyncContext): Promise<V7ResyncResult> {
  requirePrincipal(context);
  const org = context.organisationId;
  if (!V7_RESYNC_RUN_PATTERN.test(input.runId)) fail("BAD_RUN_ID", "A re-sync run id is v7-resync-<uuid>.", "runId");
  const job = await lockV7Job(db, org, input.jobId);
  // R1: nothing client-facing is frozen on this job, and no re-ingest stands on the rows about to be superseded.
  if (await snapshottedSince(db, org, input.jobId, null))
    fail("SNAPSHOT_EXISTS", "The job has been snapshotted; its figures are frozen for the client. Roll the report version back first.", "jobId");
  if (await completedReingest(db, org, input.jobId))
    fail("ALREADY_REINGESTED", "This job has a completed re-ingest on its current v7 rows; revert it first, then re-sync.", "jobId");

  // R5: one job's rows, each once.
  if (input.rows.length === 0) fail("NOTHING_TO_RESYNC", "No v7 rows were given for this job.");
  const ids = input.rows.map((row) => row.legacyDbId);
  const repeated = ids.filter((id, at) => ids.indexOf(id) !== at);
  if (repeated.length) fail("ROW_REPEATED", `v7 record(s) ${[...new Set(repeated)].slice(0, 5).join(", ")} are given more than once.`);
  const current = await currentByIdentity(db, org, ids);
  const elsewhere = [...current.values()].filter((row) => row.job_id !== input.jobId);
  if (elsewhere.length)
    fail("ROW_OF_ANOTHER_JOB", `${elsewhere.length} v7 record(s) are current on another job (${elsewhere.slice(0, 5).map((row) => `${row.scope_row_id} on ${row.job_id}`).join(", ")}); a re-sync is one job's rows only.`);
  const ofJob = await currentOfJob(db, org, input.jobId);
  const given = new Set(ids);
  const removed = ofJob.filter((row) => !given.has(row.legacy_db_id));
  if (removed.length)
    fail("V7_ROW_REMOVED", `${removed.length} of this job's v7 row(s) are not in v7's current records (${removed.slice(0, 5).map((row) => row.scope_row_id).join(", ")}); a person decides what that means.`);

  // What changed: each row against its current copy, column for column, by the loader's own comparison.
  const changed: Array<{ planned: PlannedRow; was: CurrentRow }> = [];
  const added: PlannedRow[] = [];
  let unchanged = 0;
  for (const planned of input.rows) {
    const was = current.get(planned.legacyDbId);
    if (!was) { added.push(planned); continue; }
    const found = await differs(db, "job_scope_rows", "organisation_id=$1 AND scope_row_id=$2", [org, was.scope_row_id], migratedRowCols(input.jobId, planned));
    if (found && found.length) changed.push({ planned, was }); else unchanged += 1;
  }
  if (changed.length === 0 && added.length === 0) fail("NOTHING_TO_RESYNC", "The job's v7 rows already equal v7's current records.");
  // A paired row (an auto-generated pair, 0036) names its partner by id; a replacement would leave the pair pointing at history.
  const pairedTo = new Set(ofJob.map((row) => row.linked_row_id).filter((id): id is string => id !== null));
  const paired = [
    ...changed.filter(({ planned, was }) => planned.linkedRowId !== null || was.linked_row_id !== null || pairedTo.has(was.scope_row_id)).map(({ was }) => was.scope_row_id),
    ...added.filter((planned) => planned.linkedRowId !== null).map((planned) => planned.scopeRowId),
  ];
  if (paired.length)
    fail("V7_LINKED_ROW_CHANGED", `${paired.length} changed or added v7 row(s) are paired with another row (${paired.slice(0, 5).join(", ")}); a person decides how the pair carries.`);

  // R3: supersede, then insert v7's current record beside it — in that order, so one current row per v7 record (0225's index).
  const superseded: V7ResyncResult["superseded"] = [];
  for (const { planned, was } of changed) {
    const replacedBy = await nextRowId(db, org, planned);
    await db.query(`UPDATE nzi_console.job_scope_rows SET superseded_by_run = $3, enabled = false, version = version + 1, updated_at = now()
                     WHERE organisation_id = $1 AND scope_row_id = $2 AND origin = 'migrated' AND superseded_by_run IS NULL`,
      [org, was.scope_row_id, input.runId]);
    await insertCurrent(db, org, input.jobId, planned, replacedBy);
    await audit(db, context, job.client_id, input.runId, V7_RESYNC_ROW_SUPERSEDED, "scope_row", was.scope_row_id,
      { enabled: was.enabled, current: true }, { runId: input.runId, replacedBy, enabled: false, current: false });
    await audit(db, context, job.client_id, input.runId, V7_RESYNC_ROW_ADDED, "scope_row", replacedBy, null, { runId: input.runId, replaces: was.scope_row_id });
    superseded.push({ rowId: was.scope_row_id, replacedBy });
  }
  for (const planned of added) {
    const rowId = await nextRowId(db, org, planned);
    await insertCurrent(db, org, input.jobId, planned, rowId);
    await audit(db, context, job.client_id, input.runId, V7_RESYNC_ROW_ADDED, "scope_row", rowId, null, { runId: input.runId, replaces: null });
  }

  // The post-condition, read back: every v7 record has exactly one current row on this job, equal to v7's in every compared column.
  const misses: string[] = [];
  const after = await currentByIdentity(db, org, ids);
  for (const planned of input.rows) {
    const row = after.get(planned.legacyDbId);
    if (!row || row.job_id !== input.jobId) { misses.push(`${planned.scopeRowId}: no current row`); continue; }
    const found = await differs(db, "job_scope_rows", "organisation_id=$1 AND scope_row_id=$2", [org, row.scope_row_id], migratedRowCols(input.jobId, planned));
    if (!found || found.length) misses.push(`${row.scope_row_id}: differs in ${(found ?? []).join(", ")}`);
  }
  if ((await currentOfJob(db, org, input.jobId)).length !== input.rows.length) misses.push("the job's current v7 rows changed in number");
  if (misses.length) fail("RESYNC_POSTCONDITION_FAILED", `The re-sync does not leave the job equal to v7, so nothing is written: ${misses.slice(0, 10).join("; ")}.`);

  await audit(db, context, job.client_id, input.runId, V7_RESYNC_JOB, "job", input.jobId, null,
    { runId: input.runId, extractSha256: input.extractSha256, rows: input.rows.length, unchanged, superseded: superseded.length, added: added.length });
  return { runId: input.runId, jobId: input.jobId, unchanged, superseded, added: added.map((planned) => planned.scopeRowId) };
}

/** A v7 record's next row id: the importer's own (`v7-row-<id>`) when it has none yet, else `…-r<n>` for its n-th generation. */
async function nextRowId(db: Queryable, org: string, planned: PlannedRow): Promise<string> {
  const generation = Number((await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND source_system = $2 AND legacy_db_id = $3`,
    [org, SOURCE_SYSTEM, planned.legacyDbId])).rows[0]!.n);
  return generation === 0 ? planned.scopeRowId : `${planned.scopeRowId}-r${generation}`;
}

async function insertCurrent(db: Queryable, org: string, jobId: string, planned: PlannedRow, rowId: string): Promise<void> {
  await insert(db, "job_scope_rows", [
    { column: "organisation_id", value: org, type: "text" },
    { column: "source_system", value: SOURCE_SYSTEM, type: "text" },
    { column: "legacy_db_id", value: planned.legacyDbId, type: "text" },
    ...migratedRowCols(jobId, planned, rowId),
  ]);
}

/**
 * R3: the re-sync's revert, inside the caller's transaction. The run's own append-only audit events name its rows. Each row it
 * inserted is switched off and marked superseded by this run; each row it superseded is current again, switched back to how it
 * was. Refused once a re-ingest stands on the re-synced rows (revert that first), or once the job has been snapshotted since.
 */
export async function revertV7ResyncInTransaction(db: Queryable, input: { jobId: string; runId: string }, context: V7ResyncContext): Promise<V7ResyncRevertResult> {
  requirePrincipal(context);
  const org = context.organisationId;
  const job = await lockV7Job(db, org, input.jobId);
  const events = (await db.query<{ action: string; entity_id: string; before_json: { enabled?: boolean } | null; occurred_at: Date }>(
    `SELECT action, entity_id, before_json, occurred_at FROM nzi_console.audit_events
      WHERE organisation_id = $1 AND actor_id = $2 AND correlation_id = $3 AND action = ANY($4::text[]) ORDER BY occurred_at, entity_id`,
    [org, V7_RESYNC_ACTOR, input.runId, [V7_RESYNC_JOB, V7_RESYNC_ROW_SUPERSEDED, V7_RESYNC_ROW_ADDED, V7_RESYNC_REVERTED]])).rows;
  const ran = events.find((event) => event.action === V7_RESYNC_JOB && event.entity_id === input.jobId);
  if (!ran) fail("NOT_FOUND", "No such re-sync run for this job.", "runId");
  if (events.some((event) => event.action === V7_RESYNC_REVERTED)) fail("NOT_COMPLETED", "This re-sync has already been reverted.", "runId");
  if (await completedReingest(db, org, input.jobId))
    fail("ALREADY_REINGESTED", "A re-ingest stands on the re-synced rows; revert it first, then the re-sync.", "runId");
  if (await snapshottedSince(db, org, input.jobId, ran!.occurred_at))
    fail("SNAPSHOT_EXISTS", "The job has been snapshotted since the re-sync; it is no longer reverted here.", "runId");

  const supersededRows = events.filter((event) => event.action === V7_RESYNC_ROW_SUPERSEDED);
  const addedRows = events.filter((event) => event.action === V7_RESYNC_ROW_ADDED).map((event) => event.entity_id);
  // The run's rows must still be as it left them: its inserts current, its superseded rows marked by it.
  const state = new Map((await db.query<{ scope_row_id: string; superseded_by_run: string | null; job_id: string }>(
    `SELECT scope_row_id, superseded_by_run, job_id FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND scope_row_id = ANY($2::text[]) FOR UPDATE`,
    [org, [...addedRows, ...supersededRows.map((event) => event.entity_id)]])).rows.map((row) => [row.scope_row_id, row]));
  const out = [
    ...addedRows.filter((id) => state.get(id)?.superseded_by_run !== null || state.get(id)?.job_id !== input.jobId),
    ...supersededRows.filter((event) => state.get(event.entity_id)?.superseded_by_run !== input.runId).map((event) => event.entity_id),
  ];
  if (out.length) fail("REVERT_INCOMPLETE", `${out.length} of the re-sync's rows are no longer as it left them (${out.slice(0, 5).join(", ")}); nothing is reverted.`, "runId");

  // Flip back: its inserts out first, then the superseded rows current again — one current row per v7 record throughout.
  for (const rowId of addedRows) {
    await db.query(`UPDATE nzi_console.job_scope_rows SET superseded_by_run = $3, enabled = false, version = version + 1, updated_at = now()
                     WHERE organisation_id = $1 AND scope_row_id = $2`, [org, rowId, input.runId]);
  }
  for (const event of supersededRows) {
    const enabled = event.before_json?.enabled === true;
    await db.query(`UPDATE nzi_console.job_scope_rows SET superseded_by_run = NULL, enabled = $3, version = version + 1, updated_at = now()
                     WHERE organisation_id = $1 AND scope_row_id = $2`, [org, event.entity_id, enabled]);
    await audit(db, context, job.client_id, input.runId, V7_RESYNC_ROW_RESTORED, "scope_row", event.entity_id, { current: false }, { runId: input.runId, current: true, enabled });
  }
  // All or nothing, read back: none of the run's inserts current, every row it superseded current again.
  const after = (await db.query<{ added_current: string; restored: string }>(
    `SELECT count(*) FILTER (WHERE scope_row_id = ANY($2::text[]) AND superseded_by_run IS NULL)::text AS added_current,
            count(*) FILTER (WHERE scope_row_id = ANY($3::text[]) AND superseded_by_run IS NULL)::text AS restored
       FROM nzi_console.job_scope_rows WHERE organisation_id = $1`,
    [org, addedRows, supersededRows.map((event) => event.entity_id)])).rows[0]!;
  if (Number(after.added_current) !== 0 || Number(after.restored) !== supersededRows.length)
    fail("REVERT_INCOMPLETE", "The revert would not leave the job as it was before the re-sync; nothing is reverted.", "runId");
  await audit(db, context, job.client_id, input.runId, V7_RESYNC_REVERTED, "job", input.jobId, null,
    { runId: input.runId, restored: supersededRows.length, switchedOff: addedRows.length });
  return { runId: input.runId, jobId: input.jobId, restored: supersededRows.map((event) => event.entity_id), switchedOff: addedRows };
}

class DryRunRollback extends Error {}

/** The re-sync's context: its own system principal (R2). */
export const v7ResyncContext = (organisationId: string, reason: string): V7ResyncContext =>
  ({ organisationId, actorId: V7_RESYNC_ACTOR, principal: "system", reason });

/** The runner's half: one transaction, in the organisation, rolled back unless `commit`. */
export async function runInResyncTransaction<T>(pool: PoolLike, organisationId: string, commit: boolean, work: (db: Queryable) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      result = await work(db);
      if (!commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return result!;
}
