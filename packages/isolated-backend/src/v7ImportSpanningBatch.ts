// The batch bring-in for spanning jobs (BRIEF-v7-import-spanning-batch, 26 Nov 2026).
//
// A job over two calendar years comes in only with the previous system's own row figures (endpoint 2) read, and only when its bring-in
// reconciles with them in every scope. The batch adds no way to commit: each job is the fast path (Phase D) exactly as the import
// batch runs it — the same preview, the same eligibility (no issued report, no manual decisions or edits, nothing flagged), the same
// commit with the same guards — with the figures client handed in. A job that would not come in automatically is skipped, with the
// reasons the refusal gives (one per row it names).
//
//   * Which jobs: the organisation's imported CRP jobs whose period spans two calendar years (or those named; or, `behindOnly`, those
//     whose latest drift check says behind), in job order. A job whose latest import record is a committed refresh with nothing newer
//     is clean — nothing to bring in — and is reported with its latest drift check: level, or behind with its per-scope gaps, which
//     is "needs re-pricing (backfill)" (27 Nov), never skipped.
//   * Pace: one job at a time. Endpoint 2 is read once per job (the fast path's preview hands its read to its commit), through the
//     caller's client — the service's goes through the process's pace, the 2 s floor. Between jobs, the import batch's pause (2 s floor,
//     adaptive to 60 s). Three jobs in a row with the source not answering stop the run.
//   * A dry run (the default): each job's fast-path preview, rolled back — before and after per scope, and the previous system's own.
//   * A commit: the fast path, then a drift check of the job (trigger `bring-in`), as a person's bring-in has.
//
// Ids, codes and tCO2e only — never a label.
import { grantFor, v7PeriodSpansTwoYears, V7_DRIFT_TOLERANCE_TCO2E, type CommandContext, type V7DriftOutcome, type V7DriftScope, type V7DriftUnknownReason, type V7ImportScope } from "@nzi/contracts";
import { AuthorizationError, resolveMemberGrant } from "./auth";
import { withTenantRead, type PoolLike } from "./postgres";
import { CommandValidationError } from "./postgresCommands";
import { checkV7Drift, readConsoleScopeTotals, readLatestV7Drift, type V7FiguresClient, type V7RowFiguresClient } from "./v7Drift";
import { currentLocally, v7ImportBatchFailureClass, v7ImportBatchPauseAfter, V7_IMPORT_BATCH_PACING } from "./v7ImportBatch";
import { previewV7ImportFastPath, refreshV7ImportFastPath, type V7ImportFastPathBlocker } from "./v7ImportFastPath";
import { readSpanningFigures, readV7ImportPeriod, type V7ImportRefreshOptions, type V7ImportRefreshSource } from "./v7ImportRefresh";

const SCOPES: readonly V7ImportScope[] = ["1", "2", "3"];
const SOURCE_DOWN: readonly V7DriftUnknownReason[] = ["unreachable", "timeout", "busy"];

export const v7SpanningBatchIdempotencyKey = (runId: string, jobId: string) => `v7-spanning-batch:${runId}:${jobId}`;

/** Before (the console now), after (what the bring-in leaves), and the previous system's own, per scope, in tCO2e. */
export type V7SpanningBatchScope = { scope: V7ImportScope; before: number; after: number; previous: number };

export type V7SpanningBatchOutcome =
  | { status: "would-come-in"; jobId: string; jobNumber: string; scopes: V7SpanningBatchScope[] }
  | { status: "brought-in"; jobId: string; jobNumber: string; scopes: V7SpanningBatchScope[]; ingestId: string;
      drift: { outcome: V7DriftOutcome; unknownReason: V7DriftUnknownReason | null } | { outcome: "failed"; unknownReason: null } }
  /** Clean (current locally): nothing to bring in. Behind at its latest drift check → needs re-pricing (backfill). */
  | { status: "nothing-to-bring-in"; jobId: string; jobNumber: string; drift: V7SpanningLatestDrift }
  | { status: "needs-repricing"; jobId: string; jobNumber: string; drift: V7SpanningLatestDrift }
  | { status: "skipped"; jobId: string; jobNumber: string; codes: string[]; reasons: string[] };

/** A clean job's latest stored drift check: per scope the console's, V7's and console − V7; "unchecked" (no scopes) when never checked. */
export type V7SpanningLatestDrift = { outcome: V7DriftOutcome | "unchecked"; checkedAt: string | null; scopes: V7DriftScope[] | null };

export type V7SpanningBatchResult = { outcomes: V7SpanningBatchOutcome[]; stopped: "completed" | "source-unresponsive" };

export type V7SpanningBatchOptions = {
  runId: string;
  /** The Admin the batch runs as: their grant is re-derived for every job, and they must hold import.refresh_batch. */
  actorId: string;
  commit: boolean;
  source: V7ImportRefreshSource;
  /** Endpoint 2, the previous system's own row figures. */
  rowFigures: V7RowFiguresClient;
  /** Endpoint 1, for the drift check after each bring-in. */
  figures: V7FiguresClient;
  /** The job's refresh options (its committed plan), as the single-job route builds them; the repository's plan unless set. */
  optionsFor?: (jobId: string, legacyJobNumber: string) => V7ImportRefreshOptions | Promise<V7ImportRefreshOptions>;
  /** Only these jobs (J numbers of the previous system); every spanning job unless set. */
  jobNumbers?: readonly string[];
  /** Only the spanning jobs whose latest drift check says behind (`--behind-only`). */
  behindOnly?: boolean;
  /** The least pause between jobs: the batch's floor, never below it. */
  pauseMs?: number;
  maxPauseMs?: number;
  breakerThreshold?: number;
  /** Each job's outcome as it lands (the script prints it). */
  onJob?: (outcome: V7SpanningBatchOutcome) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** The fast path's blockers, in words. "flagged" is answered by the preview's own refusal or exceptions instead. */
const BLOCKER_WORDS: Record<Exclude<V7ImportFastPathBlocker, "flagged">, string> = {
  "issued-report": "A report has been issued for it, so it is a person's bring-in.",
  "manual-edits": "It has manual decisions or edits, so it is a person's bring-in.",
  "admin-commits": "The organisation requires an Admin to commit, and the batch's actor is not one.",
};

export const v7SpanningUnreadWords = (reason: V7DriftUnknownReason) => `The previous system's own figures can't be read (${reason}), so it can't be checked against them.`;

/** The organisation's imported CRP jobs whose period spans two calendar years, in job order — or only those named; or only those behind. */
export async function listV7SpanningJobs(pool: PoolLike, organisationId: string, jobNumbers?: readonly string[], behindOnly = false): Promise<Array<{ jobId: string; jobNumber: string }>> {
  return withTenantRead(pool, organisationId, async (db) => {
    const jobs = (await db.query<{ job_id: string; legacy_job_number: string }>(
      `SELECT job_id, legacy_job_number FROM nzi_console.jobs WHERE organisation_id = $1 AND job_family = 'crp' AND legacy_job_number IS NOT NULL
          AND ($2::text[] IS NULL OR legacy_job_number = ANY($2::text[])) ORDER BY sequence, job_id`,
      [organisationId, jobNumbers?.length ? [...jobNumbers] : null])).rows;
    const out: Array<{ jobId: string; jobNumber: string }> = [];
    for (const job of jobs) {
      if (!v7PeriodSpansTwoYears(await readV7ImportPeriod(db, organisationId, job.job_id))) continue;
      if (behindOnly && (await readLatestV7Drift(db, organisationId, job.job_id))?.outcome !== "behind") continue;
      out.push({ jobId: job.job_id, jobNumber: job.legacy_job_number });
    }
    return out;
  });
}

const r6 = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * Every spanning job, one at a time: a dry run previews each (rolled back); a commit brings in each that the fast path takes, then
 * checks it for drift. A job's own failure is its outcome, never the run's.
 */
export async function runV7SpanningBatch(pool: PoolLike, organisationId: string, options: V7SpanningBatchOptions): Promise<V7SpanningBatchResult> {
  const now = options.now ?? (() => performance.now());
  const wait = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const floor = Math.max(options.pauseMs ?? V7_IMPORT_BATCH_PACING.pauseMs, V7_IMPORT_BATCH_PACING.pauseMs);
  const threshold = options.breakerThreshold ?? V7_IMPORT_BATCH_PACING.breakerThreshold;
  const jobs = await listV7SpanningJobs(pool, organisationId, options.jobNumbers, options.behindOnly ?? false);
  const outcomes: V7SpanningBatchOutcome[] = [];
  let down = 0;
  for (const [at, job] of jobs.entries()) {
    const started = now();
    const { outcome, sourceDown } = await oneJob(pool, organisationId, job, options);
    outcomes.push(outcome);
    options.onJob?.(outcome);
    down = sourceDown ? down + 1 : 0;
    if (down >= threshold) return { outcomes, stopped: "source-unresponsive" };
    if (at < jobs.length - 1) await wait(v7ImportBatchPauseAfter(now() - started, floor, options.maxPauseMs ?? V7_IMPORT_BATCH_PACING.maxPauseMs));
  }
  return { outcomes, stopped: "completed" };
}

async function oneJob(pool: PoolLike, org: string, job: { jobId: string; jobNumber: string }, options: V7SpanningBatchOptions): Promise<{ outcome: V7SpanningBatchOutcome; sourceDown: boolean }> {
  const skipped = (codes: string[], reasons: string[], sourceDown = false) => ({ outcome: { status: "skipped" as const, ...job, codes, reasons }, sourceDown });
  // The actor's grant as it stands now: the batch is theirs only while they may still run one.
  const grant = await resolveMemberGrant(pool, org, options.actorId);
  // An operator run, run as an Admin (Francis, 27 Nov): since matrix v17 a Consultant holds import.refresh_batch for the in-app
  // batch, so the capability alone no longer means Admin — the role is checked too.
  if (!grant || grant.role !== "admin" || !grantFor(grant.capabilities, "import.refresh_batch")) return skipped(["PERMISSION_DENIED"], ["The batch's actor may not run an import batch."]);
  // Clean: nothing to bring in. Reported with its latest drift check (stored; V7 is not called for it).
  const clean = await withTenantRead(pool, org, async (db) => (await currentLocally(db, org, job.jobId)) ? { latest: await readLatestV7Drift(db, org, job.jobId) } : null);
  if (clean) {
    const drift: V7SpanningLatestDrift = clean.latest ? { outcome: clean.latest.outcome, checkedAt: clean.latest.checkedAt, scopes: clean.latest.scopes }
      : { outcome: "unchecked", checkedAt: null, scopes: null };
    return { outcome: drift.outcome === "behind" ? { status: "needs-repricing", ...job, drift } : { status: "nothing-to-bring-in", ...job, drift }, sourceDown: false };
  }
  // Endpoint 2, read once for this job: the preview and its commit both run from it.
  const spanningFigures = await readSpanningFigures(pool, org, job.jobId, options.rowFigures);
  if (!spanningFigures.read?.ok) {
    const reason = spanningFigures.read?.reason ?? "not-configured";
    return skipped(["FIGURES_UNREAD"], [v7SpanningUnreadWords(reason)], SOURCE_DOWN.includes(reason));
  }
  const context: CommandContext = { organisationId: org, actorId: grant.userId, principal: "staff", grant,
    idempotencyKey: v7SpanningBatchIdempotencyKey(options.runId, job.jobId), correlationId: options.runId };
  const given: V7ImportRefreshOptions = { ...(await (options.optionsFor?.(job.jobId, job.jobNumber) ?? {})), rowFigures: options.rowFigures, spanningFigures };
  const before = await withTenantRead(pool, org, (db) => readConsoleScopeTotals(db, org, job.jobId));
  try {
    if (!options.commit) {
      const { preview, because } = await previewV7ImportFastPath(pool, options.source, job.jobId, context, given);
      if (because.length) return skipped(because.map((code) => code.toUpperCase().replace(/-/g, "_")), blockerReasons(because, preview));
      return { outcome: { status: "would-come-in", ...job, scopes: SCOPES.map((scope) => ({ scope, before: r6(before[scope]),
        after: r6(preview.scopeTotals![scope].liveTco2e), previous: r6(preview.scopeTotals![scope].v7Tco2e) })) }, sourceDown: false };
    }
    const result = await refreshV7ImportFastPath(pool, options.source, job.jobId, context, given);
    if (result.fastPath === "deliberate") return skipped(result.because.map((code) => code.toUpperCase().replace(/-/g, "_")), blockerReasons(result.because, result.preview));
    const after = await withTenantRead(pool, org, (db) => readConsoleScopeTotals(db, org, job.jobId));
    // The drift check a person's bring-in has: stored, so the job's banner and the publish gate read what was just brought in.
    let drift: Extract<V7SpanningBatchOutcome, { status: "brought-in" }>["drift"];
    try {
      const check = await checkV7Drift(pool, options.figures, org, job.jobId, { trigger: "bring-in", requestedBy: grant.userId, correlationId: options.runId, principal: "staff" });
      drift = { outcome: check.outcome, unknownReason: check.unknownReason };
    } catch { drift = { outcome: "failed", unknownReason: null }; }
    return { outcome: { status: "brought-in", ...job, ingestId: result.committed.ingestId, drift, scopes: SCOPES.map((scope) => ({ scope, before: r6(before[scope]),
      after: r6(after[scope]), previous: r6(result.preview.scopeTotals![scope].v7Tco2e) })) }, sourceDown: false };
  } catch (error) {
    // The refusal as it is given: SPANS_TWO_DATASET_YEARS names the scopes apart, then each row with its reason.
    if (error instanceof CommandValidationError) return skipped([...new Set(error.issues.map((issue) => issue.code))], error.issues.map((issue) => issue.message));
    if (error instanceof AuthorizationError) return skipped(["PERMISSION_DENIED"], [error.message]);
    const failureClass = v7ImportBatchFailureClass(error);
    return skipped(["FAILED"], [`Failed: ${failureClass}.`], failureClass === "view-timeout" || failureClass === "view-unavailable");
  }
}

/** Why the fast path would not take it: each blocker in words, and for "flagged" what the preview itself says. */
function blockerReasons(because: readonly V7ImportFastPathBlocker[], preview: { refusal: { issues: Array<{ message: string }> } | null; exceptions: readonly unknown[] }): string[] {
  return because.flatMap((code) => {
    if (code !== "flagged") return [BLOCKER_WORDS[code]];
    if (preview.refusal) return preview.refusal.issues.map((issue) => issue.message);
    const n = preview.exceptions.length;
    return [n ? `${n} row${n === 1 ? "" : "s"} still need${n === 1 ? "s" : ""} a decision.` : "Its preview did not reconcile."];
  });
}

// ── The list, as the script prints it and writes it ──────────────────────────────────────────────────────────────────

const t = (n: number) => n.toFixed(4);
const csv = (value: string) => /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const isGap = (s: V7DriftScope) => Math.abs(s.difference) > V7_DRIFT_TOLERANCE_TCO2E + 1e-9;

export function v7SpanningBatchLines(outcome: V7SpanningBatchOutcome, commit: boolean): string[] {
  if (outcome.status === "skipped") return [`  ${outcome.jobNumber}: SKIPPED — ${outcome.codes.join(" ")}`, ...outcome.reasons.map((reason) => `      ${reason}`)];
  if (outcome.status === "nothing-to-bring-in" || outcome.status === "needs-repricing") {
    const d = outcome.drift;
    const drift = `drift ${d.outcome}${d.checkedAt ? ` (checked ${d.checkedAt})` : ""}`;
    if (outcome.status === "nothing-to-bring-in") return [`  ${outcome.jobNumber}: NOTHING TO BRING IN — ${drift}`];
    return [`  ${outcome.jobNumber}: NEEDS RE-PRICING (BACKFILL) — nothing to bring in · ${drift}`,
      ...(d.scopes ?? []).filter(isGap).map((s) => `      Scope ${s.scope}: here ${t(s.console)} t · previous system ${t(s.previous)} t · gap ${t(s.difference)} t`)];
  }
  const head = outcome.status === "brought-in"
    ? `  ${outcome.jobNumber}: BROUGHT IN — ingest ${outcome.ingestId} · drift ${outcome.drift.outcome}${outcome.drift.unknownReason ? ` (${outcome.drift.unknownReason})` : ""}`
    : `  ${outcome.jobNumber}: WOULD COME IN${commit ? "" : " (dry run)"}`;
  return [head, ...outcome.scopes.map((s) => `      Scope ${s.scope}: before ${t(s.before)} t → after ${t(s.after)} t · previous system ${t(s.previous)} t`)];
}

const OUTCOME_ORDER: ReadonlyArray<[V7SpanningBatchOutcome["status"], string]> = [
  ["would-come-in", "would come in"], ["brought-in", "brought in"], ["nothing-to-bring-in", "nothing to bring in"],
  ["needs-repricing", "needs re-pricing (backfill)"], ["skipped", "skipped"]];

/** The jobs per outcome, in the list's order (a dry run never brings in; a commit's "would come in" are brought in). */
export function v7SpanningBatchTotals(outcomes: readonly V7SpanningBatchOutcome[], commit: boolean): Array<{ status: V7SpanningBatchOutcome["status"]; label: string; jobs: number }> {
  return OUTCOME_ORDER.filter(([status]) => status !== (commit ? "would-come-in" : "brought-in"))
    .map(([status, label]) => ({ status, label, jobs: outcomes.filter((o) => o.status === status).length }));
}

export function v7SpanningBatchTotalsLines(outcomes: readonly V7SpanningBatchOutcome[], commit: boolean): string[] {
  return ["Totals:", ...v7SpanningBatchTotals(outcomes, commit).map((row) => `  ${row.label}: ${row.jobs}`), `  jobs: ${outcomes.length}`];
}

export function v7SpanningBatchCsv(outcomes: readonly V7SpanningBatchOutcome[], commit: boolean): string {
  const lines = ["job,job_id,status,scope,before_tco2e,after_tco2e,previous_tco2e,codes,reason,ingest_id,drift,gap_tco2e"];
  for (const o of outcomes) {
    if (o.status === "skipped") for (const reason of o.reasons) lines.push([o.jobNumber, o.jobId, "skipped", "", "", "", "", o.codes.join(" "), csv(reason), "", "", ""].join(","));
    // A clean job: nothing changes, so before is after; per scope its latest check's gap (console − previous), one row if never read.
    else if (o.status === "nothing-to-bring-in" || o.status === "needs-repricing") {
      if (!o.drift.scopes) lines.push([o.jobNumber, o.jobId, o.status, "", "", "", "", "", "", "", o.drift.outcome, ""].join(","));
      else for (const s of o.drift.scopes) lines.push([o.jobNumber, o.jobId, o.status, s.scope, t(s.console), t(s.console), t(s.previous), "", "", "", o.drift.outcome, t(s.difference)].join(","));
    }
    else for (const s of o.scopes) lines.push([o.jobNumber, o.jobId, o.status, s.scope, t(s.before), t(s.after), t(s.previous), "", "",
      o.status === "brought-in" ? o.ingestId : "", o.status === "brought-in" ? o.drift.outcome : "", ""].join(","));
  }
  // The totals, after a blank line: jobs per outcome, then all.
  lines.push("", "outcome,jobs", ...v7SpanningBatchTotals(outcomes, commit).map((row) => `${row.status},${row.jobs}`), `total,${outcomes.length}`);
  return `${lines.join("\n")}\n`;
}
