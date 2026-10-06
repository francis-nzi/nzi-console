// DATASET-CURRENCY §3 (ruled 6 Oct, DATASET-CURRENCY-freshness-rulings.md) — move a CRP job from a fallback edition to its
// reporting year's edition, now published, and recalculate the rows on it.
//
// Per job, previewed then confirmed, never automatic (NZC-030). The preview is this same code run in a transaction that is
// rolled back, so what it shows is what the write does. Per series, all or nothing:
//   - the selection is **swapped**, never added beside (two editions of one series break declared resolution): the old
//     automatic selection is deleted and the new edition selected — automatic selections are the rule's derived state,
//     as job.update already re-derives them;
//   - each live, dataset-sourced row on the old edition moves to the **same factor** in the new one and is recalculated by
//     the one row calculation (`recalculateScopeRowInTransaction`) — review back to pending, an override kept and still
//     winning, a lineage entry naming the move;
//   - a row that cannot move as it is (its factor missing from the new edition, its unit changed, its scope dropped) blocks
//     its series until a person resolves it — a factor in the new edition, or deactivated — and a register-managed row
//     blocks it outright (re-pointing sources is a named follow-up);
//   - a job with an issued snapshot or a published report moves only with a reason: the issued figures stay as they were.
// One audit event for the run, as scope.row.rollforward: the series, the rows (ids and counts) and the job's total before
// and after — emissions figures, no money, rates or person (NZC-120).
import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import { jobDatasetUpdates, ON_DAY_REASON, type DatasetUpdate } from "./datasetSelection";
import { VersionConflictError } from "./errors";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError, recalculateScopeRowInTransaction, runPostgresCommand, runPostgresCommandInTransaction, type StoredOutcome } from "./postgresCommands";

export type BlockReason = "FACTOR_MISSING" | "UNIT_CHANGED" | "SCOPE_DROPPED" | "SOURCE_MANAGED";
export type UpdateRow = { rowId: string; version: number; label: string; factorLabel: string | null; reviewStatus: string; hasOverride: boolean; recalculated: boolean };
export type BlockedRow = { rowId: string; version: number; label: string; scope: string; unit: string | null; factorLabel: string | null; reason: BlockReason;
  /** Factors in the new edition this row could take instead — same scope, same unit — for the preview's inline resolution. */
  candidates: Array<{ factorId: string; label: string; unit: string }> };
export type SeriesPlan = DatasetUpdate & { moved: UpdateRow[]; deactivated: string[]; blocked: BlockedRow[] };
/** A series as the preview shows it — with every planned row's version, which the confirm sends back as 'expected'. */
export type SeriesPreview = SeriesPlan & { versions: Record<string, number> };
export type JobDatasetUpdateResult = {
  jobId: string;
  series: Array<{ from: string; to: string; fromLabel: string; toLabel: string }>;
  movedRowIds: string[]; moved: number; recalculated: number; approvedReset: number; overridesKept: number; deactivated: number;
  totals: { beforeTco2e: number; afterTco2e: number };
  issued: boolean;
};
export type JobDatasetUpdatePreview = { jobId: string; issued: boolean; series: SeriesPreview[]; totals: { beforeTco2e: number; afterTco2e: number };
  /** Rows nothing here touches: v7 history (immutable) and rows on a client factor. */
  untouched: { migrated: number; clientFactor: number } };

type RowRecord = { scope_row_id: string; version: number; scope: string; unit: string | null; quantity: string | null; factor_id: string | null; factor_label: string | null;
  source_label: string; report_label: string | null; review_status: string; override_tco2e: string | null; source_id: string | null };

const jobTotal = async (db: Queryable, organisationId: string, jobId: string) => Number((await db.query<{ total: string }>(
  `SELECT coalesce(sum(coalesce(override_tco2e, calculated_tco2e, 0)) FILTER (WHERE enabled), 0)::text AS total FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2`,
  [organisationId, jobId])).rows[0]!.total);

/** The job has issued figures: a reviewed snapshot, or a published report. */
const hasIssued = async (db: Queryable, organisationId: string, jobId: string) => (await db.query(
  `SELECT 1 FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id = $1 AND job_id = $2
   UNION ALL SELECT 1 FROM nzi_console.report_versions WHERE organisation_id = $1 AND job_id = $2 AND status = 'published' LIMIT 1`, [organisationId, jobId])).rows.length > 0;

async function planSeries(db: Queryable, organisationId: string, jobId: string, update: DatasetUpdate, resolutions: CommandInputMap["job.datasets.update"]["resolutions"]): Promise<SeriesPlan & { moves: Array<{ row: RowRecord; factorId: string }>; versions: Map<string, number> }> {
  const { rows } = await db.query<RowRecord>(
    `SELECT scope_row_id, version, scope, unit, quantity::text AS quantity, factor_id, factor_label, source_label, report_label, review_status, override_tco2e::text AS override_tco2e, source_id
       FROM nzi_console.job_scope_rows
      WHERE organisation_id = $1 AND job_id = $2 AND origin = 'live' AND factor_source = 'dataset' AND dataset_id = $3
      ORDER BY scope_row_id FOR UPDATE`, [organisationId, jobId, update.fromDatasetId]);
  const factorIn = async (factorId: string) => (await db.query<{ label: string; activity_unit: string; scopes: string[] }>(
    `SELECT label, activity_unit, scopes FROM nzi_console.emission_factors_display WHERE organisation_id = $1 AND dataset_id = $2 AND factor_id = $3 AND active = true`,
    [organisationId, update.toDatasetId, factorId])).rows[0] ?? null;
  const plan: SeriesPlan & { moves: Array<{ row: RowRecord; factorId: string }>; versions: Map<string, number> } = { ...update, moved: [], deactivated: [], blocked: [], moves: [], versions: new Map() };
  for (const row of rows) {
    plan.versions.set(row.scope_row_id, row.version);
    const label = row.report_label || row.source_label;
    const top = row.scope.split(".")[0]!;
    const resolution = resolutions.find((item) => item.rowId === row.scope_row_id);
    const block = async (reason: BlockReason) => {
      const candidates = reason === "SOURCE_MANAGED" ? [] : (await db.query<{ factor_id: string; label: string; activity_unit: string }>(
        `SELECT factor_id, label, activity_unit FROM nzi_console.emission_factors_display
          WHERE organisation_id = $1 AND dataset_id = $2 AND active = true AND $3 = ANY(scopes) AND ($4::text IS NULL OR lower(activity_unit) = lower($4))
          ORDER BY (lower(label) = lower($5)) DESC, lower(label), factor_id LIMIT 50`,
        [organisationId, update.toDatasetId, top, row.unit, row.factor_label ?? ""])).rows.map((f) => ({ factorId: f.factor_id, label: f.label, unit: f.activity_unit }));
      plan.blocked.push({ rowId: row.scope_row_id, version: row.version, label, scope: row.scope, unit: row.unit, factorLabel: row.factor_label, reason, candidates });
    };
    // A register-managed row follows its source; re-pointing sources is a named follow-up (ruling 7), so it blocks.
    if (row.source_id) { await block("SOURCE_MANAGED"); continue; }
    if (resolution?.action === "deactivate") { plan.deactivated.push(row.scope_row_id); continue; }
    const factorId = resolution?.action === "factor" ? resolution.factorId! : row.factor_id;
    const target = factorId ? await factorIn(factorId) : null;
    const reason: BlockReason | null = !target ? "FACTOR_MISSING"
      : !target.scopes.includes(top) ? "SCOPE_DROPPED"
      : row.unit && row.unit.trim().toLowerCase() !== target.activity_unit.trim().toLowerCase() ? "UNIT_CHANGED" : null;
    if (reason) {
      if (resolution?.action === "factor") throw new CommandValidationError([{ field: "resolutions", code: "INVALID_RESOLUTION", message: `${label}: that factor is not one this row can take in ${update.toLabel}.` }]);
      await block(reason); continue;
    }
    plan.moves.push({ row, factorId: factorId! });
    plan.moved.push({ rowId: row.scope_row_id, version: row.version, label, factorLabel: target!.label, reviewStatus: row.review_status, hasOverride: row.override_tco2e !== null,
      recalculated: row.quantity !== null && row.unit !== null });
  }
  return plan;
}

/** Apply one series: the swap, then each row re-pointed and recalculated, each deactivation. */
async function applySeries(db: Queryable, context: CommandContext, jobId: string, plan: SeriesPlan & { moves: Array<{ row: RowRecord; factorId: string }>; versions: Map<string, number> }, reason: string | null): Promise<void> {
  const org = context.organisationId;
  await db.query(`DELETE FROM nzi_console.job_dataset_selections WHERE organisation_id = $1 AND job_id = $2 AND dataset_id = $3 AND selection_source = 'automatic'`, [org, jobId, plan.fromDatasetId]);
  await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, $3, 'automatic', $4, $5) ON CONFLICT DO NOTHING`,
    [org, jobId, plan.toDatasetId, ON_DAY_REASON, context.actorId]);
  const moveNote = { title: "Moved to a newer edition", detail: `${plan.fromLabel} → ${plan.toLabel} · run ${context.correlationId}` };
  const target = (await db.query<{ version: string }>(`SELECT version FROM nzi_console.emission_factor_datasets WHERE organisation_id = $1 AND dataset_id = $2`, [org, plan.toDatasetId])).rows[0]!;
  for (const { row, factorId } of plan.moves) {
    const label = (await db.query<{ label: string }>(`SELECT label FROM nzi_console.emission_factors_display WHERE organisation_id = $1 AND dataset_id = $2 AND factor_id = $3`, [org, plan.toDatasetId, factorId])).rows[0]!.label;
    const repointed = await db.query<{ version: number }>(
      `UPDATE nzi_console.job_scope_rows SET dataset_id = $4, factor_id = $5, factor_version = $6, factor_label = $7,
              lineage_json = coalesce(lineage_json, '[]'::jsonb) || $8::jsonb, version = version + 1, updated_at = now()
        WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3 AND version = $9 RETURNING version`,
      [org, jobId, row.scope_row_id, plan.toDatasetId, factorId, target.version, label, JSON.stringify([moveNote]), row.version]);
    if (!repointed.rows[0]) throw new VersionConflictError(row.version, row.version + 1);
    // The one calculation, for every row that has what it needs; a draft with no quantity is re-pointed only.
    if (row.quantity !== null && row.unit !== null) await recalculateScopeRowInTransaction(db, { jobId, rowId: row.scope_row_id, expectedVersion: repointed.rows[0].version }, context, [moveNote]);
  }
  for (const rowId of plan.deactivated) {
    const note = { title: "Deactivated: not carried to the newer edition", detail: `${plan.toLabel}${reason ? ` · ${reason}` : ""} · run ${context.correlationId}` };
    const version = plan.versions.get(rowId)!;
    const off = await db.query(`UPDATE nzi_console.job_scope_rows SET enabled = false, lineage_json = coalesce(lineage_json, '[]'::jsonb) || $4::jsonb, version = version + 1, updated_at = now()
                                 WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3 AND version = $5 RETURNING scope_row_id`, [org, jobId, rowId, JSON.stringify([note]), version]);
    if (!off.rows[0]) throw new VersionConflictError(version, version + 1);
  }
}

/** The handler both the preview and the write run: plan every requested series, then apply what may move. */
async function updateHandler(db: Queryable, input: CommandInputMap["job.datasets.update"], context: CommandContext, mode: "preview" | "write") {
  const org = context.organisationId;
  const job = (await db.query<{ job_family: string }>(`SELECT job_family FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 FOR UPDATE`, [org, input.jobId])).rows[0];
  if (!job) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "Job was not found." }]);
  if (job.job_family !== "crp") throw new CommandValidationError([{ field: "jobId", code: "WRONG_FAMILY", message: "Only a carbon-reporting job selects emission-factor datasets." }]);
  const available = await jobDatasetUpdates(db, org, input.jobId);
  const requested = available.filter((update) => input.series.includes(update.fromDatasetId));
  if (requested.length === 0 || requested.length !== new Set(input.series).size) {
    throw new CommandValidationError([{ field: "series", code: "NOTHING_TO_UPDATE", message: "There is no newer edition to move to for the datasets chosen — the job may have changed." }]);
  }
  const issued = await hasIssued(db, org, input.jobId);
  // Ruling 6: issued figures stay frozen; moving the live job past them is a deliberate, reasoned act.
  if (mode === "write" && issued && !context.reason?.trim()) {
    throw new CommandValidationError([{ field: "reason", code: "REASON_REQUIRED", message: "This job has an issued snapshot or published report. Say why it moves to the newer edition — the issued figures stay as they were." }]);
  }
  const before = await jobTotal(db, org, input.jobId);
  const plans = [];
  for (const update of requested) plans.push(await planSeries(db, org, input.jobId, update, input.resolutions));
  const blocked = plans.filter((plan) => plan.blocked.length > 0);
  if (mode === "write") {
    if (blocked.length) throw new CommandValidationError(blocked.flatMap((plan) => plan.blocked.map((row) => ({ field: "resolutions", code: "SERIES_BLOCKED", message: `${row.label} (${row.reason}) must be resolved before ${plan.toLabel} can be used.` }))));
    // Preview == write: the rows the preview showed, at the versions it showed — or the job changed since.
    const touched = plans.flatMap((plan) => [...plan.moved.map((row) => row.rowId), ...plan.deactivated].map((rowId) => `${rowId}@${plan.versions.get(rowId)}`)).sort();
    const expected = input.expected.map((row) => `${row.rowId}@${row.version}`).sort();
    if (touched.join("|") !== expected.join("|")) throw new CommandValidationError([{ field: "expected", code: "CHANGED_SINCE_PREVIEW", message: "The job changed since the preview — review it again before moving." }]);
  }
  // A series moves only whole: a preview applies the unblocked series (to show their totals); a write has none blocked.
  for (const plan of plans) if (plan.blocked.length === 0) await applySeries(db, context, input.jobId, plan, context.reason?.trim() || null);
  const after = await jobTotal(db, org, input.jobId);
  return { plans, issued, totals: { beforeTco2e: before, afterTco2e: after } };
}

/** The write: one governed command, one audit event for the run. */
export function updateJobDatasets(pool: PoolLike, input: CommandInputMap["job.datasets.update"], context: CommandContext): Promise<StoredOutcome<JobDatasetUpdateResult>> {
  return runPostgresCommand(pool, "job.datasets.update", input, context, async (db) => {
    const { plans, issued, totals } = await updateHandler(db, input, context, "write");
    const moved = plans.flatMap((plan) => plan.moved);
    const data: JobDatasetUpdateResult = {
      jobId: input.jobId,
      series: plans.map((plan) => ({ from: plan.fromDatasetId, to: plan.toDatasetId, fromLabel: plan.fromLabel, toLabel: plan.toLabel })),
      movedRowIds: moved.map((row) => row.rowId), moved: moved.length, recalculated: moved.filter((row) => row.recalculated).length,
      approvedReset: moved.filter((row) => row.recalculated && row.reviewStatus === "approved").length,
      overridesKept: moved.filter((row) => row.hasOverride).length, deactivated: plans.reduce((sum, plan) => sum + plan.deactivated.length, 0),
      totals, issued,
    };
    return { data, before: { series: plans.map((plan) => plan.fromDatasetId), totalTco2e: totals.beforeTco2e }, entityType: "job", entityId: input.jobId, topic: "job.datasets.updated" };
  });
}

class PreviewRollback extends Error {}

/**
 * The preview: the write's own code, in a transaction rolled back — so the totals, the moves and the blocked rows it shows
 * are what the write would do. Blocked series are listed, not applied; the rest are applied to compute the totals.
 */
export async function previewJobDatasetUpdate(pool: PoolLike, input: Omit<CommandInputMap["job.datasets.update"], "expected">, context: CommandContext): Promise<JobDatasetUpdatePreview> {
  let preview: JobDatasetUpdatePreview | null = null;
  try {
    await withTenantWrite(pool, context.organisationId, async (db) => {
      const full = { ...input, expected: [] };
      await runPostgresCommandInTransaction(db, "job.datasets.update", full, { ...context, idempotencyKey: `preview-${randomUUID()}` }, async (tx) => {
        const { plans, issued, totals } = await updateHandler(tx, full, context, "preview");
        const untouched = (await tx.query<{ migrated: string; client: string }>(
          `SELECT count(*) FILTER (WHERE origin = 'migrated')::text AS migrated, count(*) FILTER (WHERE origin = 'live' AND factor_source = 'client')::text AS client
             FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2`, [context.organisationId, input.jobId])).rows[0]!;
        preview = { jobId: input.jobId, issued, totals, series: plans.map(({ moves: _moves, versions, ...plan }) => ({ ...plan, versions: Object.fromEntries(versions) })), untouched: { migrated: Number(untouched.migrated), clientFactor: Number(untouched.client) } };
        return { data: { jobId: input.jobId }, entityType: "job", entityId: input.jobId, topic: "job.datasets.update_previewed" };
      });
      throw new PreviewRollback();
    });
  } catch (error) {
    if (!(error instanceof PreviewRollback)) throw error;
  }
  return preview!;
}
