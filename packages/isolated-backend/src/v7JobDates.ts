// Addendum B (ruled 25 Nov 2026) — a job's dates, between the console and V7.
//
// - A date never edited in the console follows V7 on every sync: the sync applies V7's date through job.update (audited; a
//   period move over data needs its reason — the sync gives one — re-chooses the datasets and re-prices the rows; a job with
//   issued figures refuses it, and the difference is then shown instead).
// - Once a date is edited in the console, the console owns it (job_date_owners, 0238). The sync records what V7 says
//   (job_v7_date_observations) and the job shows "Dates differ from the previous system: console …, V7 …" with
//   **Use V7's dates** or **Keep the console's** (job.dates.resolve).
// Dates only — no figures and no person are read or written here.
import { commandGrantForRole, type CommandContext, type CommandInputMap } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import { recordDateOwner, updateJobInTransaction } from "./jobUpdate";
import { currentDateOwner, latestObservation, observeV7Date } from "./jobDateRecords";
export * from "./jobDateRecords";

/** A milestone written by "Use V7's dates" is V7's again: it carries the milestone backfill's run prefix, so the next sync updates it. */
const MILESTONE_FOLLOWS_V7 = "v7-milestones-resolve-";

export type ResolveJobDateResult = { jobId: string; dateKey: string; choice: "v7" | "console"; version: number; v7: { from: string | null; to: string | null } };

/** job.dates.resolve — "Use V7's dates" or "Keep the console's", for the V7 value the person was shown. */
export function resolveJobDate(pool: PoolLike, input: CommandInputMap["job.dates.resolve"], context: CommandContext): Promise<StoredOutcome<ResolveJobDateResult>> {
  return runPostgresCommand(pool, "job.dates.resolve", input, context, async (db) => {
    const org = context.organisationId;
    const job = (await db.query<{ version: number; source_system: string | null }>(
      `SELECT version, source_system FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 FOR UPDATE`, [org, input.jobId])).rows[0];
    if (!job) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "That job is not here." }]);
    if (job.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, job.version);
    const seen = await latestObservation(db, org, input.jobId, input.dateKey);
    if (!seen || Number(seen.observation_no) !== input.observationNo) {
      throw new CommandValidationError([{ field: "observationNo", code: "OBSERVATION_MOVED", message: "The previous system's date changed again since this was shown. Reopen the job to see it." }]);
    }
    const v7 = { from: seen.v7_from, to: seen.v7_to };
    let version = job.version;
    if (input.choice === "console") {
      await recordDateOwner(db, context, input.jobId, input.dateKey, "console", "kept", input.observationNo);
    } else if (input.dateKey.startsWith("milestone:")) {
      const kind = input.dateKey.slice("milestone:".length);
      const updated = await db.query(
        `UPDATE nzi_console.job_milestones SET due_date = $4::date, updated_by = $5, updated_at = now(), version = version + 1
          WHERE organisation_id = $1 AND job_id = $2 AND kind = $3 RETURNING kind`, [org, input.jobId, kind, v7.from, `${MILESTONE_FOLLOWS_V7}${context.correlationId}`]);
      if (!updated.rows[0]) throw new CommandValidationError([{ field: "dateKey", code: "NOT_FOUND", message: "That milestone is not on this job." }]);
      await recordDateOwner(db, context, input.jobId, input.dateKey, "v7", "use-v7", null);
    } else {
      // Through job.update itself: audited, a period move over data needs the reason, re-chooses datasets and re-prices rows,
      // and a job with issued figures refuses it — exactly as an edit here would.
      const applied = await updateJobInTransaction(db, {
        jobId: input.jobId, expectedVersion: job.version,
        ...(input.dateKey === "start_date" ? { startDate: v7.from ?? undefined }
          : input.dateKey === "due_date" ? { dueDate: v7.from ?? undefined }
          : { reportingPeriodStart: v7.from, reportingPeriodEnd: v7.to }),
      }, { ...context, idempotencyKey: `${context.idempotencyKey}:apply` }, "v7-sync");
      version = applied.data.version;
      await recordDateOwner(db, context, input.jobId, input.dateKey, "v7", "use-v7", null);
    }
    return {
      data: { jobId: input.jobId, dateKey: input.dateKey, choice: input.choice, version, v7 },
      entityType: "job", entityId: input.jobId, topic: "job.dates.resolved",
    };
  });
}

export const V7_DATE_SYNC_ACTOR = "system:v7-date-sync";

export type JobDateSyncOutcome = "unchanged" | "followed" | "held-by-console" | "refused";

/**
 * One imported job's start date, due date and reporting period against V7's, on a sync (the client load calls it for every job
 * it finds already loaded; for a job it has just inserted the dates are V7's and it only records them). What V7 owns moves in
 * one job.update; what the console owns is left, and the difference is shown.
 */
export async function syncV7JobDates(db: Queryable, org: string, runId: string,
  planned: { jobId: string; startDate: string | null; dueDate?: string | null; periodStart: string | null; periodEnd: string | null },
  inserted: boolean): Promise<{ outcome: JobDateSyncOutcome; refusal?: string }> {
  const dueDate = planned.dueDate ?? null;
  if (planned.startDate) await observeV7Date(db, org, planned.jobId, "start_date", planned.startDate, null, runId);
  if (dueDate) await observeV7Date(db, org, planned.jobId, "due_date", dueDate, null, runId);
  if (planned.periodStart && planned.periodEnd) await observeV7Date(db, org, planned.jobId, "reporting_period", planned.periodStart, planned.periodEnd, runId);
  if (inserted) return { outcome: "unchanged" };
  const job = (await db.query<{ version: number; start_date: string | null; due_date: string | null; period_start: string | null; period_end: string | null }>(
    `SELECT version, start_date::text AS start_date, due_date::text AS due_date, reporting_period_start::text AS period_start, reporting_period_end::text AS period_end
       FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [org, planned.jobId])).rows[0];
  if (!job) return { outcome: "unchanged" };
  const startDiffers = planned.startDate !== null && planned.startDate !== job.start_date;
  const dueDiffers = dueDate !== null && dueDate !== job.due_date;
  const periodDiffers = planned.periodStart !== null && planned.periodEnd !== null && (planned.periodStart !== job.period_start || planned.periodEnd !== job.period_end);
  const v7Owns = async (key: string) => (await currentDateOwner(db, org, planned.jobId, key))?.owner !== "console";
  const followStart = startDiffers && await v7Owns("start_date");
  const followDue = dueDiffers && await v7Owns("due_date");
  const followPeriod = periodDiffers && await v7Owns("reporting_period");
  if (!followStart && !followDue && !followPeriod) return { outcome: startDiffers || dueDiffers || periodDiffers ? "held-by-console" : "unchanged" };

  const context: CommandContext = {
    organisationId: org, actorId: V7_DATE_SYNC_ACTOR, principal: "system", idempotencyKey: `${runId}:dates:${planned.jobId}`, correlationId: runId,
    reason: `Dates changed in the previous system (V7) — followed on sync, run ${runId}`,
    grant: commandGrantForRole("admin", org, V7_DATE_SYNC_ACTOR),
  };
  await db.query("SAVEPOINT v7_job_dates");
  try {
    await updateJobInTransaction(db, {
      jobId: planned.jobId, expectedVersion: job.version,
      ...(followStart ? { startDate: planned.startDate! } : {}),
      ...(followDue ? { dueDate: dueDate! } : {}),
      ...(followPeriod ? { reportingPeriodStart: planned.periodStart, reportingPeriodEnd: planned.periodEnd } : {}),
    }, context, "v7-sync");
    await db.query("RELEASE SAVEPOINT v7_job_dates");
    return { outcome: "followed" };
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT v7_job_dates");
    // Refused (an issued job, a row that cannot be re-priced, a closed job): the difference stays, shown on the job.
    if (error instanceof CommandValidationError) return { outcome: "refused", refusal: error.issues.map((issue) => issue.code).join(", ") };
    throw error;
  }
}
