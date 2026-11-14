// The import, server-side — Phase B (BRIEF-v7-import-server-side-phase-b; DESIGN-v7-import-rethink R-3, R-6): `import.refresh`.
//
// One command, run in the console service. It reads the job's current rows from the previous system through the Phase A view
// set (`readV7JobRowsFromViews`: one read-only snapshot, the guard first, every label through the R-1 rule), and the job's
// decisions (0228), and drives the chain the import workbench's ingest already runs (`runV7ResyncChain`, with
// `chainOptions`): revert the standing re-ingest → re-sync (carried pairs let through) → re-plan the committed crosswalk plan
// onto the current rows → complete it from the decisions → re-ingest. All in ONE transaction, with the re-ingest's D7 the
// automatic floor: it reconciles (Σ live = Σ previous system per scope, row by row) or it refuses and nothing is kept.
//
//   preview — the whole command, rolled back: its validation, its access check, the chain, and the audit it would write. The
//             caller gets the reconciliation and the rows that still need a person; the database keeps nothing.
//   commit  — the same chain, kept. A reason is required. It names the summary and the decisions the preview showed, by their
//             fingerprints, and refuses if either moved (SUMMARY_MOVED / DECISIONS_MOVED). It stores the summary it ran from
//             (the import view's latest, as an upload would) and records the run in v7_import_ingests (0229), as the ingest does.
//
// Who: `import.refresh` (matrix v15) — Admin and the CRM. An organisation may require an Admin to commit (0231; off until set).
// The inner steps run under their own system principals, exactly as the ingest's do. The audit holds ids, counts and codes —
// never a figure; Σ per scope is in the 0229 record.
//
// Nothing of the previous system's rows travels in the command's input, and nothing of them is stored but what the re-sync
// itself writes (the previous system's records, as the import always has).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import {
  resolveV7Import, v7ImportSummaryIssues,
  type CommandContext, type CommandInputMap, type V7ImportDecision, type V7ImportRefreshCommitted, type V7ImportRefreshException, type V7ImportRefreshPreview,
  type V7ImportSummary, type V7ReingestJobInput,
} from "@nzi/contracts";
import { AuthorizationError } from "./auth";
import { readImportPolicy } from "./organisationSettings";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, runPostgresCommandInTransaction, type StoredOutcome } from "./postgresCommands";
import type { PlannedRow } from "./v7ClientImport";
import { currentDecisions, invalidApplied, lockV7Job } from "./v7ImportDecision";
import {
  chainInput, chainOptions, countsOf, insertIngest, summariseV7JobAsTheChainSees, totalsOf, v7ImportDecisionsSha256,
  type PlanCounts, type V7ImportIngestRun,
} from "./v7ImportIngest";
import { storeV7ImportSession } from "./v7ImportSummary";
import { readV7JobRowsFromViews } from "./v7ImportView";
import { emptyRehearsalReport, runV7ResyncChain, type V7RehearsalReport } from "./v7ResyncRehearsal";

const fail = (field: string, code: string, message: string): never => { throw new CommandValidationError([{ field, code, message }]); };
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value ?? null);
const sha256 = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");

/**
 * Where the job's rows come from: the previous system's current records of it, planned, and the fingerprint of what was read.
 * In the service, the view set (`v7ImportViewSource`); a test may hand in planned rows directly.
 */
export type V7ImportRefreshSource = (consoleDb: Queryable, job: { organisationId: string; jobId: string; legacyJobNumber: string }) =>
  Promise<{ sourceSha256: string; rows: readonly PlannedRow[] }>;

/** The service's source: the Phase A view set, through NZI_V7_VIEW_URL's pool (`v7ImportViewPoolConfig`). */
export const v7ImportViewSource = (pool: Pick<Pool, "connect">): V7ImportRefreshSource => (consoleDb, job) => readV7JobRowsFromViews(consoleDb, pool, job);

/** The summary's fingerprint as a commit names it: its content, not the moment it was made. */
export const v7ImportRefreshSummarySha256 = (summary: V7ImportSummary) => sha256({ ...summary, generatedAt: null });

const CROSSWALK_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "data", "v7-crosswalk-v1");

/**
 * The job's committed crosswalk plan (`data/v7-crosswalk-v1/plan-<job>.json`, in the repository), or — a job with none — an empty
 * one, so the decisions alone plan it. The same plan the operator's script reads.
 */
export function committedV7CrosswalkPlan(jobId: string, legacyJobNumber: string, dir = CROSSWALK_DIR): Omit<V7ReingestJobInput, "runId"> {
  if (!/^J\d{6}$/.test(legacyJobNumber)) fail("jobId", "JOB_NUMBER", "The job has no J number of the previous system.");
  const file = join(dir, `plan-${legacyJobNumber}.json`);
  if (!existsSync(file)) return { jobId, crosswalkVersion: "none", crosswalkSha256: createHash("sha256").update("").digest("hex"), vintageDatasetIds: [], rows: [] };
  const plan = JSON.parse(readFileSync(file, "utf8")) as Omit<V7ReingestJobInput, "runId">;
  if (plan.jobId !== jobId) fail("jobId", "PLAN_OF_ANOTHER_JOB", `The committed plan for ${legacyJobNumber} is another job's.`);
  return plan;
}

export type V7ImportRefreshOptions = {
  /** The committed plan; by default the repository's (`committedV7CrosswalkPlan`). */
  basePlan?: Omit<V7ReingestJobInput, "runId">;
};

type Refresh = {
  legacyJobNumber: string; sourceSha256: string; rows: readonly PlannedRow[]; summary: V7ImportSummary; summarySha256: string;
  decisions: V7ImportDecision[]; decisionsSha256: string; resolved: ReturnType<typeof resolveV7Import>; exceptions: V7ImportRefreshException[];
};

/**
 * Read everything the chain runs from, inside the command's transaction: the job (locked against a concurrent decision, as the
 * decision commands lock it), its rows from the source, its summary as the chain will see it, its decisions and what they
 * resolve. Writes nothing.
 */
async function readRefresh(db: Queryable, source: V7ImportRefreshSource, organisationId: string, jobId: string): Promise<Refresh> {
  await lockV7Job(db, organisationId, jobId);
  const legacyJobNumber = (await db.query<{ legacy_job_number: string | null }>(
    `SELECT legacy_job_number FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [organisationId, jobId])).rows[0]?.legacy_job_number ?? null;
  if (!legacyJobNumber) fail("jobId", "JOB_NUMBER", "The job has no J number of the previous system.");
  const { sourceSha256, rows } = await source(db, { organisationId, jobId, legacyJobNumber: legacyJobNumber! });
  const summary = await summariseV7JobAsTheChainSees(db, { organisationId, jobId, legacyJobNumber: legacyJobNumber!, extractSha256: sourceSha256, rows });
  const decisions = (await currentDecisions(db, jobId)).get(jobId) ?? [];
  const resolved = resolveV7Import(summary.rows, decisions, await invalidApplied(db, organisationId, decisions));
  // What still needs a person: a row whose own status needs a decision it lacks (or has stood down), and a pair awaiting its carry.
  const exceptions = resolved.rows.flatMap((row, at): V7ImportRefreshException[] => {
    if (row.resolution !== "unresolved" && row.resolution !== "stale" && row.carry !== "awaiting" && row.carry !== "needs-fresh-summary") return [];
    const of = summary.rows[at]!;
    return [{ legacyDbId: row.legacyDbId, status: of.status, ownStatus: row.ownStatus, resolution: row.resolution, carry: row.carry, scope: of.scope, code: of.code, pairGroup: of.pairGroup }];
  });
  return { legacyJobNumber: legacyJobNumber!, sourceSha256, rows, summary, summarySha256: v7ImportRefreshSummarySha256(summary),
    decisions, decisionsSha256: v7ImportDecisionsSha256(decisions), resolved, exceptions };
}

const notReady = (verdict: string) => ({ field: "jobId", code: "NOT_READY_TO_INGEST",
  message: `The job is ${verdict}, not ready to ingest: every row that differs needs its decision, and every decision must stand.` });

/** The chain, in the caller's transaction, from what `readRefresh` read. Returns whether the re-ingest went through. */
async function runChain(db: Queryable, read: Refresh, organisationId: string, jobId: string, reason: string, suffix: string, basePlan: Omit<V7ReingestJobInput, "runId">) {
  const run: V7ImportIngestRun = { organisationId, jobId, legacyJobNumber: read.legacyJobNumber, reason, extractSha256: read.sourceSha256, rows: read.rows, basePlan };
  const counts: PlanCounts = { committed: 0, decided: 0 };
  const chain = chainInput(run);
  const report: V7RehearsalReport = emptyRehearsalReport(jobId);
  let planSha256: string | null = null;
  const options = chainOptions(run, { decisions: read.decisions, carriedPairGroups: read.resolved.groups.filter((group) => group.moved && group.carried).map((group) => group.pairGroup) }, counts);
  const committed = await runV7ResyncChain(db, chain, report, { ...options, reingestReasonSuffix: suffix,
    completePlan: async (db2, replan, superseded) => { const plan = await options.completePlan!(db2, replan, superseded); planSha256 = plan.crosswalkSha256; return plan; } });
  return { committed: committed && report.refusal === null, report, chain, counts, planSha256: planSha256 as string | null };
}

class PreviewRollback extends Error {}

/**
 * import.refresh, `mode: "preview"` — the command run whole and rolled back: validated and access-checked as a commit is, the
 * chain run, the audit it would write discarded with everything else. Returns the reconciliation and what still needs a person.
 */
export async function previewV7ImportRefresh(pool: PoolLike, source: V7ImportRefreshSource, input: Extract<CommandInputMap["import.refresh"], { mode: "preview" }>,
  context: CommandContext, options: V7ImportRefreshOptions = {}): Promise<V7ImportRefreshPreview> {
  let preview: V7ImportRefreshPreview | null = null;
  try {
    await withTenantWrite(pool, context.organisationId, async (db) => {
      const outcome = await runPostgresCommandInTransaction(db, "import.refresh", input, context, async (tx) => {
        const read = await readRefresh(tx, source, context.organisationId, input.jobId);
        const base = { mode: "preview" as const, jobId: input.jobId, legacyJobNumber: read.legacyJobNumber, summarySha256: read.summarySha256,
          decisionsSha256: read.decisionsSha256, counts: read.summary.counts, verdict: read.resolved.verdict, exceptions: read.exceptions };
        let data: V7ImportRefreshPreview;
        if (read.resolved.verdict !== "ready-to-ingest") {
          data = { ...base, outcome: "refused", refusal: { stage: "ready", issues: [notReady(read.resolved.verdict)] }, chain: { resync: null, plan: null }, scopeTotals: null };
        } else {
          // Under a savepoint, so the command's own tail runs on a clean transaction whatever a step did — then all of it goes.
          await tx.query("SAVEPOINT v7_import_refresh_preview");
          try {
            const ran = await runChain(tx, read, context.organisationId, input.jobId, context.reason?.trim() || "import refresh preview", " — refresh preview, rolled back",
              options.basePlan ?? committedV7CrosswalkPlan(input.jobId, read.legacyJobNumber));
            data = { ...base, outcome: ran.committed ? "would-commit" : "refused",
              refusal: ran.committed ? null : ran.report.refusal ?? { stage: "reingest", issues: [{ field: "jobId", code: "NOT_COMMITTED", message: "The re-ingest did not commit." }] },
              chain: countsOf(ran.report, ran.counts), scopeTotals: ran.committed ? totalsOf(ran.report) : null };
          } finally {
            await tx.query("ROLLBACK TO SAVEPOINT v7_import_refresh_preview");
          }
        }
        return { data, entityType: "job", entityId: input.jobId, topic: "import.refresh.previewed" };
      });
      preview = outcome.data;
      throw new PreviewRollback();
    });
  } catch (error) {
    if (!(error instanceof PreviewRollback)) throw error;
  }
  return preview!;
}

/**
 * import.refresh, `mode: "commit"` — the chain, kept, in the command's own transaction. Refused, with nothing written, when the
 * organisation requires an Admin and the caller is not one; when the summary or the decisions moved since the preview; when the
 * job is not ready to ingest; or when any step refuses — D7's reconciliation included.
 */
export function commitV7ImportRefresh(pool: PoolLike, source: V7ImportRefreshSource, input: Extract<CommandInputMap["import.refresh"], { mode: "commit" }>,
  context: CommandContext, options: V7ImportRefreshOptions = {}): Promise<StoredOutcome<V7ImportRefreshCommitted>> {
  return runPostgresCommand(pool, "import.refresh", input, context, async (db) => {
    if ((await readImportPolicy(db, context.organisationId)).refreshCommitRequiresAdmin && context.grant?.role !== "admin")
      throw new AuthorizationError("import.refresh", "This organisation requires an Admin to commit a refresh; a preview is still yours to run.");
    const read = await readRefresh(db, source, context.organisationId, input.jobId);
    if (read.summarySha256 !== input.summarySha256) fail("summarySha256", "SUMMARY_MOVED", "The job's rows have moved since the preview; preview again.");
    if (read.decisionsSha256 !== input.decisionsSha256) fail("decisionsSha256", "DECISIONS_MOVED", "The job's decisions changed since the preview; preview again.");
    if (read.resolved.verdict !== "ready-to-ingest") throw new CommandValidationError([notReady(read.resolved.verdict)]);
    const ran = await runChain(db, read, context.organisationId, input.jobId, context.reason!.trim(), " — import refresh",
      options.basePlan ?? committedV7CrosswalkPlan(input.jobId, read.legacyJobNumber));
    if (!ran.committed) throw new CommandValidationError(ran.report.refusal?.issues ?? [{ field: "jobId", code: "NOT_COMMITTED", message: "The re-ingest did not commit." }]);
    // The summary it ran from, stored as the job's latest (closed, as an upload is), then the run's record against it.
    const issues = v7ImportSummaryIssues(read.summary);
    if (issues.length) throw new CommandValidationError(issues);
    const sessionId = await storeV7ImportSession(db, context, input.jobId, read.summary);
    const record = { sessionId, extractSha256: read.sourceSha256, decisionsSha256: read.decisionsSha256, planSha256: ran.planSha256, outcome: "committed" as const,
      refusedStage: null, refusalCodes: [], counts: countsOf(ran.report, ran.counts), scopeTotals: totalsOf(ran.report) };
    const ingestId = await insertIngest(db, context, input.jobId, "ingest", record, { resync: ran.chain.resyncRunId, reingest: ran.chain.reingestRunId });
    const data: V7ImportRefreshCommitted = { mode: "commit", jobId: input.jobId, ingestId, sessionId, resyncRunId: ran.chain.resyncRunId, reingestRunId: ran.chain.reingestRunId,
      resync: record.counts.resync!, plan: record.counts.plan ?? { committed: 0, decided: 0 } };
    return { data, entityType: "job", entityId: input.jobId, topic: "import.refreshed" };
  });
}
