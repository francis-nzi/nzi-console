import type { V7ImportIngestStage, V7ImportRefreshCommitted, V7ImportRefreshException, V7ImportRefreshPreview, V7ImportScope } from "@nzi/contracts";

/**
 * What one `import.refresh` preview means (BRIEF-v7-import-server-side-phase-c §3), for the import rows modal
 * (BRIEF-v7-import-rows-modal), which shows it in its reconcile strip and footer. Pure: no hooks, no requests. (The in-page
 * preview this drew — its exceptions table and Σ table — is retired with the modal.)
 *
 *   nothing    — the job is clean: every row matches. Not an error: "Nothing to refresh".
 *   exceptions — rows still need a person.
 *   ready      — it would commit: the previous system's total against the live total per scope, as D7 reconciled them.
 *   refused    — a step refused (D7's reconciliation, most often): the step and its codes, nothing written.
 */
export type ImportRefreshState =
  | { applies: false }
  | { applies: true; jobId: string; legacyJobNumber: string; writeEnabled: boolean; commitNeedsAdmin: boolean; isAdmin: boolean; canResolve: boolean };

export type ImportRefreshView =
  | { kind: "nothing" }
  | { kind: "exceptions"; exceptions: V7ImportRefreshException[] }
  | { kind: "ready"; totals: Array<{ scope: V7ImportScope; previous: number; live: number }> }
  | { kind: "refused"; stage: V7ImportIngestStage; issues: Array<{ code: string; message: string }> };

export const NOTHING_TO_REFRESH = "Nothing to refresh";

export function refreshViewOf(preview: V7ImportRefreshPreview): ImportRefreshView {
  if (preview.outcome === "would-commit" && preview.scopeTotals) {
    return { kind: "ready", totals: (["1", "2", "3"] as const).map((scope) => ({ scope, previous: preview.scopeTotals![scope].v7Tco2e, live: preview.scopeTotals![scope].liveTco2e })) };
  }
  // Phase B refuses a clean job at "ready" (NOT_READY_TO_INGEST, verdict clean): here, that is simply nothing to do.
  if (preview.refusal?.stage === "ready" && preview.verdict === "clean") return { kind: "nothing" };
  if (preview.refusal?.stage === "ready" && preview.exceptions.length) return { kind: "exceptions", exceptions: preview.exceptions };
  const refusal = preview.refusal ?? { stage: "reingest" as const, issues: [{ field: "jobId", code: "NOT_COMMITTED", message: "The re-ingest did not commit." }] };
  return { kind: "refused", stage: refusal.stage, issues: refusal.issues.map(({ code, message }) => ({ code, message })) };
}

/** Phase D (R-4): what one action did. `refreshed` — committed with the system reason; `deliberate` — the reasoned commit, and why. */
export type FastPathBlocker = "issued-report" | "manual-edits" | "flagged" | "admin-commits";
export type FastPathOutcome =
  | { fastPath: "refreshed"; preview: V7ImportRefreshPreview; committed: V7ImportRefreshCommitted; auditEventId: string }
  | { fastPath: "deliberate"; preview: V7ImportRefreshPreview; because: FastPathBlocker[]; flagged: number };

/** The one line saying why a refresh was not automatic; null when there is nothing to say (a clean job: nothing to refresh). */
export function notAutomaticLine(outcome: Extract<FastPathOutcome, { fastPath: "deliberate" }>): string | null {
  if (refreshViewOf(outcome.preview).kind === "nothing") return null;
  const parts = blockerParts(outcome.because, outcome.flagged);
  return parts.length ? `Not automatic: ${parts.join(" · ")}.` : null;
}

/** Each blocker in words — the modal's one line and the batch's review queue (Phase E) say it the same way. */
export function blockerParts(because: readonly FastPathBlocker[], flagged: number): string[] {
  return because.map((blocker) => blocker === "issued-report" ? "issued report"
    : blocker === "manual-edits" ? "manual edits"
      : blocker === "admin-commits" ? "an Admin commits on this organisation"
        : flagged > 0 ? `${flagged} flagged` : "it would not reconcile");
}
