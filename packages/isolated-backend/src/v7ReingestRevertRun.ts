// The runner's half of `v7.reingest.revert` (RULING-v7-reingest-row-protection, disposition step 2): one run of one job,
// reverted through the merged command, as `policy:v7-reingest` the system principal — the one principal the attest-only guard
// exempts, so the revert's deactivations reach the re-ingested rows. A dry run is the whole revert, its own all-or-nothing
// post-condition included, inside a transaction that is always rolled back; the job's counts are read back inside it, so the
// dry run shows what the commit would leave. No new command and no route: the CLI (scripts/v7-reingest-revert.ts) and its
// test are the only callers.
import { commandGrantForRole, V7_REINGEST_ACTOR, type CommandContext } from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { revertV7ReingestInTransaction } from "./v7Reingest";

export type V7ReingestRevertRunInput = { organisationId: string; jobId: string; runId: string; reason: string; commit: boolean };
/** The job's re-ingest state: tCO2e-free counts only. */
export type V7ReingestJobCounts = { linkedLiveRows: number; linkedLiveOn: number; v7Rows: number; v7On: number; runStatus: string | null };
export type V7ReingestRevertRunReport = {
  jobId: string; runId: string; committed: boolean;
  liveRowsSwitchedOff: number; v7RowsSwitchedOn: number;
  before: V7ReingestJobCounts;
  /** Read inside the transaction, after the revert: for a dry run, what the commit would leave. */
  after: V7ReingestJobCounts;
};

/** The revert's context: the re-ingest principal, as the re-ingest itself runs (scripts/v7-reingest-job.ts). */
export function v7ReingestRevertContext(organisationId: string, runId: string, reason: string): CommandContext {
  return { organisationId, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: `${runId}:revert`, correlationId: `${runId}:revert`,
    reason, grant: commandGrantForRole("admin", organisationId, V7_REINGEST_ACTOR) };
}

async function jobCounts(db: Queryable, organisationId: string, jobId: string, runId: string): Promise<V7ReingestJobCounts> {
  const row = (await db.query<{ linked: string; linked_on: string; v7: string; v7_on: string; status: string | null }>(
    `SELECT count(*) FILTER (WHERE origin = 'live' AND reingested_from_row_id IS NOT NULL)::text AS linked,
            count(*) FILTER (WHERE origin = 'live' AND reingested_from_row_id IS NOT NULL AND enabled)::text AS linked_on,
            count(*) FILTER (WHERE origin = 'migrated')::text AS v7,
            count(*) FILTER (WHERE origin = 'migrated' AND enabled)::text AS v7_on,
            (SELECT status FROM nzi_console.v7_reingest_runs WHERE organisation_id = $1 AND job_id = $2 AND run_id = $3) AS status
       FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2`, [organisationId, jobId, runId])).rows[0]!;
  return { linkedLiveRows: Number(row.linked), linkedLiveOn: Number(row.linked_on), v7Rows: Number(row.v7), v7On: Number(row.v7_on), runStatus: row.status };
}

class DryRunRollback extends Error {}

export async function runV7ReingestRevert(pool: PoolLike, input: V7ReingestRevertRunInput): Promise<V7ReingestRevertRunReport> {
  // A blank reason is refused by the command itself (`v7.reingest.revert` is reasonRequired), before anything is written.
  const context = v7ReingestRevertContext(input.organisationId, input.runId, input.reason.trim());
  let report: V7ReingestRevertRunReport | null = null;
  try {
    await withTenantWrite(pool, input.organisationId, async (db) => {
      const before = await jobCounts(db, input.organisationId, input.jobId, input.runId);
      const outcome = await revertV7ReingestInTransaction(db, { jobId: input.jobId, runId: input.runId }, context);
      const after = await jobCounts(db, input.organisationId, input.jobId, input.runId);
      report = { jobId: input.jobId, runId: input.runId, committed: input.commit, liveRowsSwitchedOff: outcome.data.liveRowsSwitchedOff,
        v7RowsSwitchedOn: outcome.data.v7RowsSwitchedOn, before, after };
      if (!input.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return report!;
}
