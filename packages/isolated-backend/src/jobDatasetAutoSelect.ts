import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import { automaticDatasetsFor, selectAutomaticDatasets, type ReportingWindow } from "./datasetSelection";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, runPostgresCommandInTransaction, type StoredOutcome } from "./postgresCommands";

/**
 * job.datasets.autoSelect (JW-13 step 3) — the automatic dataset rule, applied once to a CRP job that has **no selection
 * at all**. The v7 import writes jobs directly, so its CRP jobs carry a window but no datasets, and the Add-entry factor
 * search is empty on every one of them.
 *
 * - **Fill-blank-only:** a job holding any selection, automatic or manual, is refused (`ALREADY_SELECTED`) and untouched
 *   — a person's choice, or job.create's, is never second-guessed here. job.update is the path that re-derives.
 * - **The rule is the rule's:** `automaticDatasetsFor` / `selectAutomaticDatasets` (#413: the GB and GLOBAL editions valid
 *   on the window's last day), with job.create's selection reason — never a second copy of its SQL.
 * - Refused, and left for a person: no window (`NO_WINDOW`); no active edition valid on its last day (`NO_EDITION`).
 * - The audit and outbox carry the job, the datasets chosen and the count — no money, rates or names (NZC-120).
 */

export type JobDatasetAutoSelectResult = { jobId: string; datasets: Array<{ datasetId: string; name: string }>; datasetCount: number };

function autoSelectHandler(input: CommandInputMap["job.datasets.autoSelect"], context: CommandContext) {
  return async (db: Queryable) => {
    const org = context.organisationId;
    // Locked, so a concurrent job.update or a second run cannot interleave between the blank check and the insert.
    const { rows: [job] } = await db.query<{ job_family: string }>(`SELECT job_family FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 FOR UPDATE`, [org, input.jobId]);
    if (!job) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "Job was not found." }]);
    if (job.job_family !== "crp") throw new CommandValidationError([{ field: "jobId", code: "WRONG_FAMILY", message: "Only a carbon-reporting job selects emission-factor datasets." }]);
    const { rows: [held] } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.job_dataset_selections WHERE organisation_id = $1 AND job_id = $2`, [org, input.jobId]);
    if ((held?.n ?? 0) > 0) throw new CommandValidationError([{ field: "jobId", code: "ALREADY_SELECTED", message: `This job already has ${held!.n} dataset selection${held!.n === 1 ? "" : "s"}; they are kept as they are.` }]);
    const { rows: [config] } = await db.query<{ reporting_from: string; reporting_to: string }>(
      `SELECT reporting_from::text AS reporting_from, reporting_to::text AS reporting_to FROM nzi_console.job_emissions_config WHERE organisation_id = $1 AND job_id = $2`, [org, input.jobId]);
    if (!config) throw new CommandValidationError([{ field: "jobId", code: "NO_WINDOW", message: "This job has no reporting window to choose datasets against." }]);
    const window: ReportingWindow = { from: config.reporting_from, to: config.reporting_to };
    if ((await automaticDatasetsFor(db, org, window)).length === 0) {
      throw new CommandValidationError([{ field: "jobId", code: "NO_EDITION", message: `No active GB or GLOBAL dataset is valid on the window's last day (${window.to}).` }]);
    }
    await selectAutomaticDatasets(db, org, input.jobId, window, context.actorId);
    // What was written, read back — the audit says what the job now holds, not what was meant to be.
    const { rows } = await db.query<{ dataset_id: string; name: string }>(
      `SELECT s.dataset_id, d.name FROM nzi_console.job_dataset_selections s JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (s.organisation_id, s.dataset_id)
        WHERE s.organisation_id = $1 AND s.job_id = $2 ORDER BY s.dataset_id`, [org, input.jobId]);
    const datasets = rows.map((row) => ({ datasetId: row.dataset_id, name: row.name }));
    return { data: { jobId: input.jobId, datasets, datasetCount: datasets.length } satisfies JobDatasetAutoSelectResult,
      before: { datasetCount: 0 }, entityType: "job", entityId: input.jobId, topic: "job.datasets.auto_selected" };
  };
}

export function autoSelectJobDatasets(pool: PoolLike, input: CommandInputMap["job.datasets.autoSelect"], context: CommandContext): Promise<StoredOutcome<JobDatasetAutoSelectResult>> {
  return runPostgresCommand(pool, "job.datasets.autoSelect", input, context, autoSelectHandler(input, context));
}
/** The same, inside a caller's transaction — a gated backfill's dry run is the whole run, rolled back. */
export function autoSelectJobDatasetsInTransaction(db: Queryable, input: CommandInputMap["job.datasets.autoSelect"], context: CommandContext): Promise<StoredOutcome<JobDatasetAutoSelectResult>> {
  return runPostgresCommandInTransaction(db, "job.datasets.autoSelect", input, context, autoSelectHandler(input, context));
}
