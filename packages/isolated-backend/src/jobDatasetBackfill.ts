import { randomUUID } from "node:crypto";
import { commandGrantForRole, todayInLondon, type CommandContext } from "@nzi/contracts";
import type { ReportingWindow } from "./datasetSelection";
import { autoSelectJobDatasetsInTransaction } from "./jobDatasetAutoSelect";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError } from "./postgresCommands";
import { SOURCE_SYSTEM } from "./v7ClientImport";

/**
 * JW-13 step 3 — the one-time backfill of automatic datasets onto imported CRP jobs, through the governed
 * `job.datasets.autoSelect`. The v7 import wrote 729 CRP jobs with a window and no dataset selection, so their Add-entry
 * factor search is empty; #413 fixed the rule (the edition valid on the window's last day), and this applies it to them.
 *
 * **Who:** CRP jobs of the organisation imported from v7 (`source_system`) with **no** selection. Imported CRP jobs that
 * already hold one are left alone and counted — fill-blank-only, here and again in the command.
 * **Manual fixes, never guessed:** no window (`NO_WINDOW`); no edition valid on its last day (`NO_EDITION`); and a window
 * ending implausibly late (`IMPLAUSIBLE_WINDOW`: end year beyond next year — v7 holds a `2203-12-31`), which is refused
 * *before* the command is called — a typo'd year must be corrected, not given whatever edition happens to match it.
 * **Post-conditions, in the run:** each fill re-read (the job holds ≥ 1 selection), and the candidate query re-run at the
 * end — what it would still fill, apart from the manual fixes, must be 0. A dry run checks both inside the rollback.
 * One transaction for the run, a savepoint per job; a dry run is the whole run, rolled back.
 */

export const JW13_RUN_PREFIX = "jw13-dataset-backfill-";
export const JW13_ACTOR = "policy:jw13-dataset-backfill";

export type ManualFixKind = "NO_WINDOW" | "WINDOW_MISMATCH" | "NO_EDITION" | "IMPLAUSIBLE_WINDOW";
export type Edition = { name: string; version: string; validFrom: string; validTo: string; country: string };
export type BackfillCandidate = { jobId: string; jobNumber: string; window: ReportingWindow | null };
export type BackfillLine = BackfillCandidate & {
  result: "filled" | "manual" | "error";
  /** The job's selections before the run, by name — a candidate has none, and the line says so rather than assuming it. */
  current: string[];
  /** The editions the fill selected (or would, in a dry run), read back from the job. */
  editions: Edition[];
  /** Dataset names selected (or that would be, in a dry run — the same insert, rolled back). */
  datasets: string[];
  manualKind: ManualFixKind | null;
  /** Why it was refused or failed — codes and messages only; no names. */
  detail: string | null;
};
export type BackfillOutcome = {
  committed: boolean; runId: string; reason: string;
  candidates: number;
  /** Imported CRP jobs that already hold a selection — never touched. */
  alreadySelected: number;
  lines: BackfillLine[];
  /** The candidate query re-run inside the transaction, after the fills. */
  rerunCandidates: number;
  /** Of those, the ones that are not a manual fix — must be 0. */
  rerunWouldFill: number;
};

const MANUAL_CODES = new Set<string>(["NO_WINDOW", "WINDOW_MISMATCH", "NO_EDITION"]);

/**
 * Imported CRP jobs, and whether each holds a selection. The window is the job's reporting period — the source job.create
 * and job.update feed the rule from — so "no window" here is the same set the command refuses. Job numbers, ids and
 * windows only — nothing about the client.
 */
export async function readBackfillCandidates(db: Queryable, organisationId: string): Promise<{ candidates: BackfillCandidate[]; alreadySelected: number }> {
  const { rows } = await db.query<{ job_id: string; job_number: string; reporting_from: string | null; reporting_to: string | null; selected: boolean }>(
    `SELECT j.job_id, j.job_number, j.reporting_period_start::text AS reporting_from, j.reporting_period_end::text AS reporting_to,
            EXISTS (SELECT 1 FROM nzi_console.job_dataset_selections s WHERE s.organisation_id = j.organisation_id AND s.job_id = j.job_id) AS selected
       FROM nzi_console.jobs j
      WHERE j.organisation_id = $1 AND j.job_family = 'crp' AND j.source_system = $2
      ORDER BY j.job_number, j.job_id`, [organisationId, SOURCE_SYSTEM]);
  return {
    candidates: rows.filter((row) => !row.selected).map((row) => ({ jobId: row.job_id, jobNumber: row.job_number,
      window: row.reporting_from && row.reporting_to ? { from: row.reporting_from, to: row.reporting_to } : null })),
    alreadySelected: rows.filter((row) => row.selected).length,
  };
}

/** A window ending beyond next year is a data error to correct by hand (v7's `2203-12-31`), not a window to fill. */
export function implausibleWindow(window: ReportingWindow, today: string): boolean {
  return Number(window.to.slice(0, 4)) > Number(today.slice(0, 4)) + 1;
}

class DryRunRollback extends Error {}

const selectionNames = async (db: Queryable, organisationId: string, jobId: string) => (await db.query<{ name: string }>(
  `SELECT d.name FROM nzi_console.job_dataset_selections s JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (s.organisation_id, s.dataset_id)
    WHERE s.organisation_id = $1 AND s.job_id = $2 ORDER BY d.name`, [organisationId, jobId])).rows.map((row) => row.name);
const selectedEditions = async (db: Queryable, organisationId: string, jobId: string): Promise<Edition[]> => (await db.query<{ name: string; version: string; valid_from: string; valid_to: string; country_code: string }>(
  `SELECT d.name, d.version, d.valid_from::text AS valid_from, d.valid_to::text AS valid_to, d.country_code FROM nzi_console.job_dataset_selections s
     JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (s.organisation_id, s.dataset_id)
    WHERE s.organisation_id = $1 AND s.job_id = $2 ORDER BY d.country_code, d.name`, [organisationId, jobId])).rows
  .map((row) => ({ name: row.name, version: row.version, validFrom: row.valid_from, validTo: row.valid_to, country: row.country_code }));

export async function runJobDatasetBackfill(pool: PoolLike, organisationId: string, options: { commit: boolean; reason: string; runId?: string; today?: string }): Promise<BackfillOutcome> {
  const reason = options.reason.trim();
  if (!reason) throw new Error("A reason is required.");
  const runId = options.runId ?? `${JW13_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(JW13_RUN_PREFIX)) throw new Error(`A JW-13 backfill run id must start ${JW13_RUN_PREFIX}.`);
  const today = options.today ?? todayInLondon();
  let outcome: BackfillOutcome | null = null;
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      const { candidates, alreadySelected } = await readBackfillCandidates(db, organisationId);
      const lines: BackfillLine[] = [];
      for (const candidate of candidates) {
        const line: BackfillLine = { ...candidate, result: "error", current: await selectionNames(db, organisationId, candidate.jobId), editions: [], datasets: [], manualKind: null, detail: null };
        lines.push(line);
        if (candidate.window && implausibleWindow(candidate.window, today)) {
          line.result = "manual"; line.manualKind = "IMPLAUSIBLE_WINDOW"; line.detail = `window ends in ${candidate.window.to.slice(0, 4)}`;
          continue;
        }
        await db.query("SAVEPOINT jw13_job");
        try {
          const context: CommandContext = {
            organisationId, actorId: JW13_ACTOR, principal: "system", idempotencyKey: `${runId}:${candidate.jobId}`, correlationId: runId,
            reason, grant: commandGrantForRole("admin", organisationId, JW13_ACTOR),
          };
          const saved = await autoSelectJobDatasetsInTransaction(db, { jobId: candidate.jobId }, context);
          line.datasets = saved.data.datasets.map((dataset) => dataset.name);
          line.editions = await selectedEditions(db, organisationId, candidate.jobId);
          // The post-condition the verify counts, checked here: the job now holds a selection.
          const { rows: [held] } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.job_dataset_selections WHERE organisation_id = $1 AND job_id = $2`, [organisationId, candidate.jobId]);
          if ((held?.n ?? 0) >= 1) line.result = "filled";
          else line.detail = "POST-CONDITION MISS: no selection after the fill";
          await db.query("RELEASE SAVEPOINT jw13_job");
        } catch (error) {
          await db.query("ROLLBACK TO SAVEPOINT jw13_job");
          if (error instanceof CommandValidationError) {
            const manual = error.issues.find((issue) => MANUAL_CODES.has(issue.code));
            if (manual) { line.result = "manual"; line.manualKind = manual.code as ManualFixKind; }
            line.detail = error.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
          } else {
            line.detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          }
        }
      }
      // The run's own verify: the candidate query again, inside the same transaction.
      const manualJobs = new Set(lines.filter((line) => line.result === "manual").map((line) => line.jobId));
      const rerun = (await readBackfillCandidates(db, organisationId)).candidates;
      outcome = { committed: options.commit, runId, reason, candidates: candidates.length, alreadySelected, lines,
        rerunCandidates: rerun.length, rerunWouldFill: rerun.filter((candidate) => !manualJobs.has(candidate.jobId)).length };
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome!;
}
