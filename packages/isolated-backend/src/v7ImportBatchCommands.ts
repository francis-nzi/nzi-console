// The import, server-side — Phase E (BRIEF-v7-import-server-side-phase-e, R-5; RULING-v7-import-phase-e-infra): the batch's two
// commands. Both `import.refresh_batch` (Admin only, matrix v16), audited, idempotent, ids and counts only.
//
//   import.refreshBatch.start  — the client's imported jobs (CRP, carrying the previous system's J number), frozen into a run in
//                                job-number order. One open run per client (0232's partial unique index; refused BATCH_OPEN).
//   import.refreshBatch.resume — a run whose runner stopped (its lease expired: a deploy or a crash), released for a new runner.
//                                Nothing about its jobs changes here: the runner re-claims a job left running under the SAME
//                                idempotency key, so a commit that landed before the stop replays (v7ImportBatch.ts).
//
// Neither runs a job. The runner (v7ImportBatch.ts) does, after the response, in the console's process.
import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap, V7ImportBatchResumed, V7ImportBatchStarted } from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

const refuse = (field: string, code: string, message: string): never => { throw new CommandValidationError([{ field, code, message }]); };

/** The client's jobs a batch covers: CRP jobs imported from the previous system (they carry its J number), in job-number order. */
export async function v7ImportBatchJobIds(db: Queryable, organisationId: string, clientId: string): Promise<string[]> {
  return (await db.query<{ job_id: string }>(
    `SELECT job_id FROM nzi_console.jobs WHERE organisation_id = $1 AND client_id = $2 AND job_family = 'crp' AND legacy_job_number IS NOT NULL
      ORDER BY sequence, job_id`, [organisationId, clientId])).rows.map((row) => row.job_id);
}

export function startV7ImportBatch(pool: PoolLike, input: CommandInputMap["import.refreshBatch.start"], context: CommandContext): Promise<StoredOutcome<V7ImportBatchStarted>> {
  return runPostgresCommand(pool, "import.refreshBatch.start", input, context, async (db) => {
    const org = context.organisationId;
    // Serialise starts for the client, so the one-open-run check below is not a race (the partial unique index is the backstop).
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`v7-batch:${org}:${input.clientId}`]);
    const open = (await db.query(`SELECT 1 FROM nzi_console.v7_import_batch_runs WHERE organisation_id = $1 AND client_id = $2 AND status IN ('queued', 'running')`,
      [org, input.clientId])).rows.length > 0;
    if (open) refuse("clientId", "BATCH_OPEN", "A batch refresh is already open for this client; resume it, or wait for it to finish.");
    const jobs = await v7ImportBatchJobIds(db, org, input.clientId);
    if (!jobs.length) refuse("clientId", "NO_IMPORTED_JOBS", "This client has no jobs imported from the previous system.");
    const runId = `v7-batch-${randomUUID()}`;
    await db.query(`INSERT INTO nzi_console.v7_import_batch_runs (organisation_id, run_id, client_id, triggered_by, correlation_id) VALUES ($1, $2, $3, $4, $5)`,
      [org, runId, input.clientId, context.actorId, context.correlationId]);
    await db.query(`INSERT INTO nzi_console.v7_import_batch_results (organisation_id, run_id, job_id, position)
      SELECT $1, $2, job_id, position::int FROM unnest($3::text[]) WITH ORDINALITY AS frozen(job_id, position)`, [org, runId, jobs]);
    return { data: { clientId: input.clientId, runId, jobs: jobs.length }, entityType: "client", entityId: input.clientId, topic: "import.refreshBatch.started" };
  });
}

export function resumeV7ImportBatch(pool: PoolLike, input: CommandInputMap["import.refreshBatch.resume"], context: CommandContext): Promise<StoredOutcome<V7ImportBatchResumed>> {
  return runPostgresCommand(pool, "import.refreshBatch.resume", input, context, async (db) => {
    const org = context.organisationId;
    const run = (await db.query<{ status: string; stopped: boolean }>(
      `SELECT status, (lease_until IS NULL OR lease_until < now()) AS stopped FROM nzi_console.v7_import_batch_runs
        WHERE organisation_id = $1 AND run_id = $2 AND client_id = $3 FOR UPDATE`, [org, input.runId, input.clientId])).rows[0];
    if (!run) refuse("runId", "NOT_FOUND", "No such batch for this client.");
    if (run!.status !== "queued" && run!.status !== "running") refuse("runId", "BATCH_FINISHED", "This batch has finished; start a new one.");
    if (!run!.stopped) refuse("runId", "BATCH_RUNNING", "This batch is still running.");
    await db.query(`UPDATE nzi_console.v7_import_batch_runs SET lease_holder = NULL, lease_until = NULL WHERE organisation_id = $1 AND run_id = $2`, [org, input.runId]);
    const remaining = Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM nzi_console.v7_import_batch_results
      WHERE organisation_id = $1 AND run_id = $2 AND status IN ('pending', 'running')`, [org, input.runId])).rows[0]!.n);
    return { data: { clientId: input.clientId, runId: input.runId, remaining }, entityType: "client", entityId: input.clientId, topic: "import.refreshBatch.resumed" };
  });
}
