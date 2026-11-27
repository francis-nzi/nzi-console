// The import, server-side — Phase E (BRIEF-v7-import-server-side-phase-e, R-5; RULING-v7-import-phase-e-infra): the batch runner
// and the review queue it leaves.
//
// The engine is unchanged: each job goes through `refreshV7ImportFastPath` exactly as a person's one action does (Phase D). An
// eligible job auto-commits with every Phase B/D guard; any other is queued with the fast path's own `because` and flagged count.
// The batch adds no way to commit and widens nothing.
//
// The runner (in-process on the console service, ruled R):
//   * One runner per run, by the run's LEASE (lease_holder, lease_until), taken on a run that is queued, or running with its lease
//     expired, and renewed at every job. A runner that loses it stops at once. Jobs run one at a time — concurrency 1 through the
//     one view pool, with an optional pause between jobs: kind to the source (60s cap, a shared gateway).
//   * Each job runs as the Admin who started the batch, with their grant RE-DERIVED per job (resolveMemberGrant). If they no
//     longer hold import.refresh_batch, the run stops `cancelled` and the jobs not yet run stay pending.
//   * The job's idempotency key is `v7-batch:<run>:<job>:<attempts>`. A crash-resume re-claims a job left running WITHOUT bumping
//     `attempts` — the same key — so before running it the runner looks the key up: a commit that landed before the crash is found
//     there (its stored outcome, with the 0229 ingest it recorded) and is recorded as refreshed, never committed again. Only a
//     view timeout (no commit happened) bumps `attempts`, once, for a single retry in the run.
//   * Before any read of the source: SKIPPED when the job's latest import record (0229) is a committed refresh and nothing in 0229
//     or the decisions (0228) is newer — "already current locally". The batch does NOT re-verify such a job against the previous
//     system; a later change there is picked up by the job's own Refresh. This is also how a job a person resolved since the last
//     batch shows: skipped, current locally.
//   * Outcomes: refreshed · current (nothing to refresh) · queued (because, flagged) · refused (codes) · failed (a class, never a
//     message). A per-job failure is recorded and the batch goes on.
//   * Done: the run is completed (or cancelled), its lease released, and audited with the tally — counts only.
import { randomUUID } from "node:crypto";
import { grantFor, v7ImportRefreshIngestId, type CommandContext, type CommandGrant, type V7ImportBatchBlocker, type V7ImportBatchFailureClass, type V7ImportBatchResultStatus,
  type V7ImportBatchRunStatus, type V7ImportBatchTally } from "@nzi/contracts";
import { AuthorizationError, resolveMemberGrant } from "./auth";
import { withTenantRead, withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError } from "./postgresCommands";
import { refreshV7ImportFastPath } from "./v7ImportFastPath";
import { v7TotalsOnlySql } from "./v7ImportMapping";
import type { V7ImportRefreshOptions, V7ImportRefreshSource } from "./v7ImportRefresh";

export const v7ImportBatchIdempotencyKey = (runId: string, jobId: string, attempts: number) => `v7-batch:${runId}:${jobId}:${attempts}`;

export type V7ImportBatchRunnerOptions = {
  source: V7ImportRefreshSource;
  /** The job's refresh options (its committed plan), as the single-job route builds them. */
  optionsFor: (jobId: string, legacyJobNumber: string) => V7ImportRefreshOptions | Promise<V7ImportRefreshOptions>;
  /** Classifies an error the runner does not know (the console knows its own: a missing plan directory). */
  classify?: (error: unknown) => V7ImportBatchFailureClass | null;
  leaseHolder?: string;
  leaseSeconds?: number;
  /** The least pause between jobs (BRIEF-v7-import-batch-hardening §3): 2s unless set. */
  pauseMs?: number;
  /** The most the adaptive pause grows to: 60s unless set. */
  maxPauseMs?: number;
  /** A job whose reads of the source took longer than this counts as distress (§4): 30s unless set. */
  slowReadMs?: number;
  /** Consecutive distressed jobs that pause the run (§4): 3 unless set. */
  breakerThreshold?: number;
  /** Stop after this many jobs, leaving the run open — a test's stand-in for a runner that goes away. */
  maxJobs?: number;
  fastPath?: typeof refreshV7ImportFastPath;
  /** Max view-timeout attempts per job in a run (1 retry by default). */
  maxAttempts?: number;
  /** A test's clock and sleep; the real ones unless set. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** `paused`: the circuit breaker stopped the run — the source was not answering. It waits, Resumable, for an Admin. */
export type V7ImportBatchRunnerResult = { claimed: boolean; processed: number; status: V7ImportBatchRunStatus | "paused" | null };

export const V7_IMPORT_BATCH_PACING = { pauseMs: 2_000, maxPauseMs: 60_000, slowReadMs: 30_000, breakerThreshold: 3 } as const;
export const V7_IMPORT_BATCH_PAUSED_REASON = "source-unresponsive";

/** The pause after a job (§3): never less than the floor; twice the job's read time when the source is slowing; never past the cap. */
export function v7ImportBatchPauseAfter(readMs: number, pauseMs: number = V7_IMPORT_BATCH_PACING.pauseMs, maxPauseMs: number = V7_IMPORT_BATCH_PACING.maxPauseMs): number {
  return Math.min(Math.max(maxPauseMs, pauseMs), Math.max(pauseMs, Math.round(readMs * 2)));
}

type Claimed = { jobId: string; legacyJobNumber: string; attempts: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CODE = /^[A-Z0-9_]{1,64}$/;

/** A refusal's codes, as 0232 holds them: the pattern, deduplicated, at most 50. */
const refusalCodes = (error: CommandValidationError) => [...new Set(error.issues.map((issue) => issue.code).filter((code) => CODE.test(code)))].slice(0, 50);

/** The class of a failure the runner did not expect: a class, never the message. */
export function v7ImportBatchFailureClass(error: unknown): V7ImportBatchFailureClass {
  const record = (error ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof record.code === "string" ? record.code : "";
  const message = typeof record.message === "string" ? record.message : "";
  // A server-side cancel, or the client's own cap on an answer that never came (pg's query_timeout: "Query read timeout").
  if (code === "57014" || /statement timeout|canceling statement|query read timeout/i.test(message)) return "view-timeout";
  if (record.name === "PlanDirectoryMissing") return "plan-missing";
  if (record.name === "V7ImportViewConnectionRefused" || error instanceof Error && error.constructor.name === "V7ImportViewConnectionRefused") return "view-unavailable";
  if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "57P01", "57P03", "53300"].includes(code) || code.startsWith("08")
    || /connection (terminated|refused|timeout)|timeout exceeded when trying to connect/i.test(message)) return "view-unavailable";
  return "internal";
}

/** Takes the run's lease: a queued run, or a running one whose lease has expired (or was released by Resume). */
async function claimRun(pool: PoolLike, org: string, runId: string, holder: string, leaseSeconds: number) {
  return withTenantWrite(pool, org, async (db) => (await db.query<{ client_id: string; triggered_by: string; correlation_id: string }>(
    `UPDATE nzi_console.v7_import_batch_runs SET status = 'running', started_at = coalesce(started_at, now()), lease_holder = $3,
       lease_until = now() + make_interval(secs => $4)
     WHERE organisation_id = $1 AND run_id = $2 AND status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until < now())
     RETURNING client_id, triggered_by, correlation_id`, [org, runId, holder, leaseSeconds])).rows[0] ?? null);
}

/** Renews the lease and claims the next job in order: a pending one, or one a stopped runner left running (same attempts, same key). */
async function claimNext(pool: PoolLike, org: string, runId: string, holder: string, leaseSeconds: number): Promise<Claimed | "lost" | "done"> {
  return withTenantWrite(pool, org, async (db) => {
    const renewed = (await db.query(`UPDATE nzi_console.v7_import_batch_runs SET lease_until = now() + make_interval(secs => $4)
      WHERE organisation_id = $1 AND run_id = $2 AND status = 'running' AND lease_holder = $3 RETURNING 1`, [org, runId, holder, leaseSeconds])).rows.length;
    if (!renewed) return "lost";
    const next = (await db.query<{ job_id: string; legacy_job_number: string | null; attempts: number }>(
      `SELECT r.job_id, j.legacy_job_number, r.attempts FROM nzi_console.v7_import_batch_results r
         JOIN nzi_console.jobs j ON j.organisation_id = r.organisation_id AND j.job_id = r.job_id
        WHERE r.organisation_id = $1 AND r.run_id = $2 AND (r.status = 'pending' OR (r.status = 'running' AND r.lease_until < now()))
        ORDER BY r.position LIMIT 1 FOR UPDATE OF r SKIP LOCKED`, [org, runId])).rows[0];
    if (!next) return "done";
    await db.query(`UPDATE nzi_console.v7_import_batch_results SET status = 'running', lease_until = now() + make_interval(secs => $4), updated_at = now()
      WHERE organisation_id = $1 AND run_id = $2 AND job_id = $3`, [org, runId, next.job_id, leaseSeconds]);
    return { jobId: next.job_id, legacyJobNumber: next.legacy_job_number ?? "", attempts: next.attempts };
  });
}

/** One job's outcome. `retry`: a view timeout, put back as pending under the next attempt. */
export type V7ImportBatchJobOutcome =
  | { status: "refreshed"; ingestId: string; auditEventId: string }
  | { status: "current" | "skipped" }
  | { status: "queued"; because: V7ImportBatchBlocker[]; flagged: number }
  | { status: "refused"; codes: string[] }
  | { status: "failed"; failureClass: V7ImportBatchFailureClass }
  | { status: "retry" };

type Outcome = V7ImportBatchJobOutcome;

async function record(pool: PoolLike, org: string, runId: string, jobId: string, outcome: Outcome) {
  await withTenantWrite(pool, org, (db) => outcome.status === "retry"
    ? db.query(`UPDATE nzi_console.v7_import_batch_results SET status = 'pending', attempts = attempts + 1, lease_until = NULL, updated_at = now()
        WHERE organisation_id = $1 AND run_id = $2 AND job_id = $3`, [org, runId, jobId])
    : db.query(`UPDATE nzi_console.v7_import_batch_results SET status = $4, because = $5, flagged = $6, refusal_codes = $7, failure_class = $8,
        ingest_id = $9, audit_event_id = $10, lease_until = NULL, updated_at = now() WHERE organisation_id = $1 AND run_id = $2 AND job_id = $3`,
      [org, runId, jobId, outcome.status,
        outcome.status === "queued" ? outcome.because : [], outcome.status === "queued" ? outcome.flagged : 0,
        outcome.status === "refused" ? outcome.codes : [], outcome.status === "failed" ? outcome.failureClass : null,
        outcome.status === "refreshed" ? outcome.ingestId : null, outcome.status === "refreshed" ? outcome.auditEventId : null]));
}

/**
 * Net one: a commit already made under one of this (run, job)'s keys — a crash after the commit, before its result was recorded.
 * Its stored outcome names the 0229 ingest it recorded; that ingest must be there (it was written in the same transaction).
 */
async function landedCommit(db: Queryable, org: string, runId: string, jobId: string): Promise<{ ingestId: string; auditEventId: string } | null> {
  const row = (await db.query<{ ingest_id: string; audit_event_id: string }>(
    `SELECT i.outcome_json -> 'data' ->> 'ingestId' AS ingest_id, i.outcome_json ->> 'auditEventId' AS audit_event_id
       FROM nzi_console.command_idempotency i
       JOIN nzi_console.v7_import_ingests g ON g.organisation_id = i.organisation_id AND g.ingest_id = i.outcome_json -> 'data' ->> 'ingestId'
                                          AND g.job_id = $3 AND g.kind = 'ingest'
      WHERE i.organisation_id = $1 AND i.command_key = 'import.refresh' AND starts_with(i.idempotency_key, $2)
      ORDER BY i.created_at DESC LIMIT 1`, [org, `v7-batch:${runId}:${jobId}:`, jobId])).rows[0];
  return row ? { ingestId: row.ingest_id, auditEventId: row.audit_event_id } : null;
}

/** The skip predicate (ruled §4): the latest import record is a committed refresh, and nothing in 0229 or 0228 is newer. */
export async function currentLocally(db: Queryable, org: string, jobId: string): Promise<boolean> {
  return (await db.query<{ current: boolean }>(
    `WITH latest AS (SELECT kind, created_at FROM nzi_console.v7_import_ingests WHERE organisation_id = $1 AND job_id = $2 ORDER BY created_at DESC, ingest_id DESC LIMIT 1)
     SELECT EXISTS (SELECT 1 FROM latest WHERE kind = 'ingest'
       AND NOT EXISTS (SELECT 1 FROM nzi_console.v7_import_decisions d WHERE d.organisation_id = $1 AND d.job_id = $2 AND d.decided_at > latest.created_at)) AS current`,
    [org, jobId])).rows[0]?.current === true;
}

/**
 * One job of a run, as the runner does it — the nets, then the fast path under `grant` — returning what to record. The runner's
 * per-job step; exported so the orchestration can be shown under any grant (a CRM's: the per-job Admin gate still holds).
 */
export async function v7ImportBatchJobOutcome(pool: PoolLike, org: string, runId: string, run: { correlation_id: string }, claimed: Claimed, grant: CommandGrant,
  options: V7ImportBatchRunnerOptions): Promise<Outcome> {
  const landed = await withTenantRead(pool, org, (db) => landedCommit(db, org, runId, claimed.jobId));
  if (landed) return { status: "refreshed", ...landed };
  if (await withTenantRead(pool, org, (db) => currentLocally(db, org, claimed.jobId))) return { status: "skipped" };
  const context: CommandContext = { organisationId: org, actorId: grant.userId, principal: "staff", grant,
    idempotencyKey: v7ImportBatchIdempotencyKey(runId, claimed.jobId, claimed.attempts), correlationId: run.correlation_id };
  try {
    const result = await (options.fastPath ?? refreshV7ImportFastPath)(pool, options.source, claimed.jobId, context, await options.optionsFor(claimed.jobId, claimed.legacyJobNumber));
    // Derived rows alone (cause 8) need the previous system's own figures, which this runner never reads: a commit here is the chain's.
    if (result.fastPath === "refreshed") {
      const ingestId = v7ImportRefreshIngestId(result.committed);
      return ingestId ? { status: "refreshed", ingestId, auditEventId: result.auditEventId } : { status: "current" };
    }
    // A clean job — every row already matches — is not an exception: nothing to refresh.
    if (result.preview.refusal?.stage === "ready" && result.preview.verdict === "clean") return { status: "current" };
    return { status: "queued", because: result.because, flagged: result.flagged };
  } catch (error) {
    if (error instanceof CommandValidationError) {
      const codes = refusalCodes(error);
      return { status: "refused", codes: codes.length ? codes : ["REFUSED"] };
    }
    if (error instanceof AuthorizationError) return { status: "refused", codes: ["PERMISSION_DENIED"] };
    const failureClass = options.classify?.(error) ?? v7ImportBatchFailureClass(error);
    // A view timeout committed nothing: one retry in the run, under the next attempt's key. Anything else is recorded once.
    if (failureClass === "view-timeout" && claimed.attempts + 1 < (options.maxAttempts ?? 2)) return { status: "retry" };
    return { status: "failed", failureClass };
  }
}

async function finish(pool: PoolLike, org: string, runId: string, holder: string, status: "completed" | "cancelled") {
  await withTenantWrite(pool, org, async (db) => {
    const run = (await db.query<{ client_id: string; triggered_by: string; correlation_id: string }>(
      `UPDATE nzi_console.v7_import_batch_runs SET status = $4, finished_at = now(), lease_holder = NULL, lease_until = NULL
        WHERE organisation_id = $1 AND run_id = $2 AND lease_holder = $3 AND status = 'running' RETURNING client_id, triggered_by, correlation_id`,
      [org, runId, holder, status])).rows[0];
    if (!run) return;
    // A cancelled run's job left mid-claim goes back to pending: nothing ran for it.
    await db.query(`UPDATE nzi_console.v7_import_batch_results SET status = 'pending', lease_until = NULL, updated_at = now()
      WHERE organisation_id = $1 AND run_id = $2 AND status = 'running'`, [org, runId]);
    const tally = await v7ImportBatchTally(db, org, runId);
    // The run's own close, audited as the commands are: the actor who started it, the run's correlation, counts only.
    await db.query(`INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json, client_id)
      VALUES ($1, $2, $3, 'staff', $4, 'client', $5, $6, NULL, $7::jsonb, $5)`,
      [org, randomUUID(), run.triggered_by, status === "completed" ? "import.refreshBatch.finished" : "import.refreshBatch.cancelled", run.client_id, run.correlation_id,
        JSON.stringify({ runId, ...tally })]);
  });
}

/**
 * Runs (or carries on) one batch, one job at a time, until it is done, its lease is lost, or `maxJobs` is reached. Never throws for
 * a job's own failure — that is recorded; it throws only when its own bookkeeping cannot be written (the lease then expires, and an
 * Admin's Resume starts a new runner).
 */
export async function runV7ImportBatch(pool: PoolLike, organisationId: string, runId: string, options: V7ImportBatchRunnerOptions): Promise<V7ImportBatchRunnerResult> {
  const holder = options.leaseHolder ?? `runner-${randomUUID()}`;
  const leaseSeconds = options.leaseSeconds ?? 600;
  const run = await claimRun(pool, organisationId, runId, holder, leaseSeconds);
  if (!run) return { claimed: false, processed: 0, status: null };
  const now = options.now ?? (() => performance.now());
  const wait = options.sleep ?? sleep;
  const pauseMs = options.pauseMs ?? V7_IMPORT_BATCH_PACING.pauseMs;
  const slowReadMs = options.slowReadMs ?? V7_IMPORT_BATCH_PACING.slowReadMs;
  const threshold = options.breakerThreshold ?? V7_IMPORT_BATCH_PACING.breakerThreshold;
  // Each job's time spent reading the source (its preview's read and, when it commits, the commit's own).
  let readMs = 0;
  const source: V7ImportRefreshSource = async (db, job) => {
    const started = now();
    try { return await options.source(db, job); } finally { readMs += now() - started; }
  };
  // The breaker (§4): consecutive jobs showing the source in distress — a timeout, the source unreachable, or a slow read.
  let distressed = 0;
  const failedBySource: string[] = [];
  let processed = 0;
  for (;;) {
    if (options.maxJobs !== undefined && processed >= options.maxJobs) return { claimed: true, processed, status: "running" };
    const claimed = await claimNext(pool, organisationId, runId, holder, leaseSeconds);
    if (claimed === "lost") return { claimed: true, processed, status: null };
    if (claimed === "done") { await finish(pool, organisationId, runId, holder, "completed"); return { claimed: true, processed, status: "completed" }; }
    // The starter's grant as it stands now: a batch is theirs only while they may still run one.
    const grant = await resolveMemberGrant(pool, organisationId, run.triggered_by);
    if (!grant || !grantFor(grant.capabilities, "import.refresh_batch")) {
      await finish(pool, organisationId, runId, holder, "cancelled");
      return { claimed: true, processed, status: "cancelled" };
    }
    readMs = 0;
    const outcome = await v7ImportBatchJobOutcome(pool, organisationId, runId, run, claimed, grant, { ...options, source });
    await record(pool, organisationId, runId, claimed.jobId, outcome);
    processed += 1;
    const bySource = outcome.status === "retry" || outcome.status === "failed" && (outcome.failureClass === "view-timeout" || outcome.failureClass === "view-unavailable");
    if (bySource || readMs > slowReadMs) {
      distressed += 1;
      if (outcome.status === "failed") failedBySource.push(claimed.jobId);
    } else {
      distressed = 0;
      failedBySource.length = 0;
    }
    if (distressed >= threshold) {
      await pauseRun(pool, organisationId, runId, holder, failedBySource, distressed);
      return { claimed: true, processed, status: "paused" };
    }
    await wait(v7ImportBatchPauseAfter(readMs, pauseMs, options.maxPauseMs ?? V7_IMPORT_BATCH_PACING.maxPauseMs));
  }
}

/**
 * The breaker trips (§4): the run stops and waits — open, its lease released, so it reads as stopped and an Admin may Resume it
 * once the source answers. Nothing further is read. The jobs the source failed are put back to pending (the failure was the
 * source's, not theirs), so Resume runs them again; no commit happened for any of them, so their keys stand. Audited with the
 * reason the panel shows, counts only.
 */
async function pauseRun(pool: PoolLike, org: string, runId: string, holder: string, failedBySource: readonly string[], consecutive: number) {
  await withTenantWrite(pool, org, async (db) => {
    const run = (await db.query<{ client_id: string; triggered_by: string; correlation_id: string }>(
      `UPDATE nzi_console.v7_import_batch_runs SET lease_holder = NULL, lease_until = NULL
        WHERE organisation_id = $1 AND run_id = $2 AND lease_holder = $3 AND status = 'running' RETURNING client_id, triggered_by, correlation_id`,
      [org, runId, holder])).rows[0];
    if (!run) return;
    await db.query(`UPDATE nzi_console.v7_import_batch_results SET status = 'pending', failure_class = NULL, lease_until = NULL, updated_at = now()
      WHERE organisation_id = $1 AND run_id = $2 AND job_id = ANY($3::text[]) AND status = 'failed'`, [org, runId, [...failedBySource]]);
    await db.query(`INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json, client_id)
      VALUES ($1, $2, $3, 'staff', 'import.refreshBatch.paused', 'client', $4, $5, NULL, $6::jsonb, $4)`,
      [org, randomUUID(), run.triggered_by, run.client_id, run.correlation_id,
        JSON.stringify({ runId, reason: V7_IMPORT_BATCH_PAUSED_REASON, consecutive, putBack: failedBySource.length })]);
  });
}

/** The tally, derived from the results — never stored. exceptions = queued + refused. */
export async function v7ImportBatchTally(db: Queryable, organisationId: string, runId: string): Promise<V7ImportBatchTally> {
  const counts = new Map((await db.query<{ status: V7ImportBatchResultStatus; n: string }>(`SELECT status, count(*)::text AS n FROM nzi_console.v7_import_batch_results
    WHERE organisation_id = $1 AND run_id = $2 GROUP BY status`, [organisationId, runId])).rows.map((row) => [row.status, Number(row.n)]));
  const n = (status: V7ImportBatchResultStatus) => counts.get(status) ?? 0;
  return { total: [...counts.values()].reduce((sum, value) => sum + value, 0), refreshed: n("refreshed"), exceptions: n("queued") + n("refused"),
    failed: n("failed"), current: n("current"), skipped: n("skipped"), pending: n("pending") + n("running") };
}

export type V7ImportBatchQueueItem = {
  jobId: string; jobNumber: string; status: "queued" | "refused" | "failed";
  because: V7ImportBatchBlocker[]; flagged: number; refusalCodes: string[]; failureClass: V7ImportBatchFailureClass | null;
  /**
   * Flagged, and the console holds only the previous system's scope totals for the job (or nothing): its rows there are new to the
   * console, not regressed — a first-time mapping. Read from the console's own rows; nothing is stored for it.
   */
  firstTimeMapping: boolean;
};
export type V7ImportBatchView = {
  clientId: string; importedJobs: number;
  run: null | { runId: string; status: V7ImportBatchRunStatus; createdAt: string; finishedAt: string | null; stopped: boolean;
    /** Why a stopped run stopped, when the breaker stopped it: the source was not answering. Null for any other stop. */
    paused: typeof V7_IMPORT_BATCH_PAUSED_REASON | null;
    tally: V7ImportBatchTally; queue: V7ImportBatchQueueItem[] };
};

/**
 * The client's latest batch and its review queue: the jobs that did not refresh, in job order, each with why — the fast path's
 * own blockers and flagged count, a refusal's codes or a failure's class. `stopped`: open, but no runner holds it (Resume).
 */
export async function readV7ImportBatch(db: Queryable, organisationId: string, clientId: string): Promise<V7ImportBatchView> {
  const importedJobs = Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM nzi_console.jobs
    WHERE organisation_id = $1 AND client_id = $2 AND job_family = 'crp' AND legacy_job_number IS NOT NULL`, [organisationId, clientId])).rows[0]!.n);
  const run = (await db.query<{ run_id: string; status: V7ImportBatchRunStatus; created_at: Date; finished_at: Date | null; stopped: boolean }>(
    `SELECT run_id, status, created_at, finished_at,
            (status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until < now()) AND (status = 'running' OR created_at < now() - interval '1 minute')) AS stopped
       FROM nzi_console.v7_import_batch_runs WHERE organisation_id = $1 AND client_id = $2 ORDER BY created_at DESC, run_id DESC LIMIT 1`,
    [organisationId, clientId])).rows[0];
  if (!run) return { clientId, importedJobs, run: null };
  const queue = (await db.query<{ job_id: string; sequence: number; status: "queued" | "refused" | "failed"; because: V7ImportBatchBlocker[]; flagged: number;
    refusal_codes: string[]; failure_class: V7ImportBatchFailureClass | null; totals_only: boolean }>(
    `SELECT r.job_id, j.sequence, r.status, r.because, r.flagged, r.refusal_codes, r.failure_class, ${v7TotalsOnlySql("r.organisation_id", "r.job_id")} AS totals_only
       FROM nzi_console.v7_import_batch_results r
       JOIN nzi_console.jobs j ON j.organisation_id = r.organisation_id AND j.job_id = r.job_id
      WHERE r.organisation_id = $1 AND r.run_id = $2 AND r.status IN ('queued', 'refused', 'failed') ORDER BY r.position`, [organisationId, run.run_id])).rows;
  // The breaker's own record: the run's latest pause or resume. Paused, and not resumed since, and still stopped → the reason.
  const lastTurn = (await db.query<{ action: string }>(
    `SELECT action FROM nzi_console.audit_events WHERE organisation_id = $1 AND entity_type = 'client' AND entity_id = $2
        AND action IN ('import.refreshBatch.paused', 'import.refreshBatch.resumed') AND after_json ->> 'runId' = $3
      ORDER BY occurred_at DESC, action DESC LIMIT 1`, [organisationId, clientId, run.run_id])).rows[0];
  return { clientId, importedJobs, run: {
    runId: run.run_id, status: run.status, createdAt: run.created_at.toISOString(), finishedAt: run.finished_at?.toISOString() ?? null, stopped: run.stopped,
    paused: run.stopped && lastTurn?.action === "import.refreshBatch.paused" ? V7_IMPORT_BATCH_PAUSED_REASON : null,
    tally: await v7ImportBatchTally(db, organisationId, run.run_id),
    queue: queue.map((row) => ({ jobId: row.job_id, jobNumber: `J${String(row.sequence).padStart(6, "0")}`, status: row.status, because: row.because, flagged: row.flagged,
      refusalCodes: row.refusal_codes, failureClass: row.failure_class,
      firstTimeMapping: row.status === "queued" && row.flagged > 0 && row.because.includes("flagged") && row.totals_only })),
  } };
}
