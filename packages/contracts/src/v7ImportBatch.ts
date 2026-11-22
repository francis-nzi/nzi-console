import type { CommandIssue } from "./commands";

/**
 * The import, server-side — Phase E (BRIEF-v7-import-server-side-phase-e, R-5; RULING-v7-import-phase-e-infra): the batch.
 *
 * One client's imported jobs, each through the Phase D fast path as it stands: an eligible job auto-commits (every Phase B/D guard
 * runs), any other is queued for a person with the fast path's own `because` and flagged count. The batch adds no way to commit.
 *
 *   import.refreshBatch.start  — freeze the client's imported jobs into a run (one open run per client) and audit it.
 *   import.refreshBatch.resume — an Admin picks up a run whose runner stopped (a deploy, a crash): its lease has expired.
 *
 * Both are `import.refresh_batch` (Admin only, matrix v16). Inputs are closed: ids only.
 */
export const V7_IMPORT_BATCH_RUN_STATUSES = ["queued", "running", "completed", "cancelled"] as const;
export type V7ImportBatchRunStatus = (typeof V7_IMPORT_BATCH_RUN_STATUSES)[number];

/**
 * Per job. `current`: the preview found nothing to refresh (every row already matches the previous system). `skipped`: not read
 * again at all — a committed refresh stands and nothing in the job's import record is newer (shown as "already current locally";
 * the batch does NOT re-verify such a job against the previous system).
 */
export const V7_IMPORT_BATCH_RESULT_STATUSES = ["pending", "running", "refreshed", "current", "queued", "refused", "failed", "skipped"] as const;
export type V7ImportBatchResultStatus = (typeof V7_IMPORT_BATCH_RESULT_STATUSES)[number];

/** A class, never a message: nothing free-text about a failure is stored. */
export const V7_IMPORT_BATCH_FAILURE_CLASSES = ["view-timeout", "view-unavailable", "plan-missing", "internal"] as const;
export type V7ImportBatchFailureClass = (typeof V7_IMPORT_BATCH_FAILURE_CLASSES)[number];

export const V7_IMPORT_BATCH_BLOCKERS = ["issued-report", "manual-edits", "flagged", "admin-commits"] as const;
export type V7ImportBatchBlocker = (typeof V7_IMPORT_BATCH_BLOCKERS)[number];

export type V7ImportBatchStartInput = { clientId: string };
export type V7ImportBatchResumeInput = { clientId: string; runId: string };

export type V7ImportBatchStarted = { clientId: string; runId: string; jobs: number };
export type V7ImportBatchResumed = { clientId: string; runId: string; remaining: number };

/** total · refreshed · exceptions (queued + refused) · failed — and the rest, so the parts add up to the total. */
export type V7ImportBatchTally = { total: number; refreshed: number; exceptions: number; failed: number; current: number; skipped: number; pending: number };

export const V7_IMPORT_BATCH_RUN_ID = /^v7-batch-[0-9a-f-]{36}$/;

const closed = (input: unknown, allowed: string[], what: string): CommandIssue[] => {
  const extra = Object.keys((input ?? {}) as Record<string, unknown>).filter((key) => !allowed.includes(key));
  // The unknown key is named, its value never.
  return extra.length ? [{ field: "input", code: "UNKNOWN_FIELD", message: `${what}; it has ${extra.slice(0, 5).join(", ")}.` }] : [];
};
const clientIssue = (clientId: unknown): CommandIssue[] =>
  typeof clientId === "string" && clientId.trim() ? [] : [{ field: "clientId", code: "REQUIRED", message: "Name the client." }];

export function v7ImportBatchStartIssues(input: V7ImportBatchStartInput): CommandIssue[] {
  const extra = closed(input, ["clientId"], "A batch names the client");
  return extra.length ? extra : clientIssue(input.clientId);
}

export function v7ImportBatchResumeIssues(input: V7ImportBatchResumeInput): CommandIssue[] {
  const extra = closed(input, ["clientId", "runId"], "A resume names the client and the run");
  if (extra.length) return extra;
  const issues = clientIssue(input.clientId);
  if (typeof input.runId !== "string" || !V7_IMPORT_BATCH_RUN_ID.test(input.runId)) issues.push({ field: "runId", code: "INVALID", message: "The run id is `v7-batch-` and a UUID." });
  return issues;
}
