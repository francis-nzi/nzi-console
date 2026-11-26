import type { CommandIssue } from "./commands";
import type { V7ImportCarryState, V7ImportResolution, V7ImportResolvedVerdict } from "./v7ImportDecision";
import type { V7ImportIngestCounts, V7ImportIngestStage, V7ImportIngestTotals } from "./v7ImportIngest";
import type { V7ImportCounts, V7ImportRowStatus, V7ImportScope } from "./v7ImportSummary";

/**
 * The import, server-side — Phase B (BRIEF-v7-import-server-side-phase-b; R-3, R-6): `import.refresh`, one command, run in the
 * console service. It reads the job's rows from the previous system through the Phase A view set, and the job's decisions
 * (0228), and runs revert → re-sync (carried pairs) → re-plan → complete-from-decisions → re-ingest in ONE transaction, with
 * D7 the automatic floor: it reconciles (Σ live = Σ previous system per scope, row by row) or nothing is kept.
 *
 *   preview — the whole chain, rolled back: the reconciliation and the rows that still need a person. Nothing is written —
 *             no run, no record, no audit.
 *   commit  — the same chain, kept, with a reason. It names the summary and the decisions the preview showed (their
 *             fingerprints); either moved since, and it is refused. Recorded in `v7_import_ingests` (0229), as the ingest is.
 *
 * Its input is closed: ids, the mode and two fingerprints. Nothing of the previous system's rows travels in it.
 */
export const V7_IMPORT_REFRESH_MODES = ["preview", "commit"] as const;
export type V7ImportRefreshMode = (typeof V7_IMPORT_REFRESH_MODES)[number];

export type V7ImportRefreshInput =
  | { jobId: string; mode: "preview" }
  | { jobId: string; mode: "commit"; summarySha256: string; decisionsSha256: string };

/** A row the preview found still needing a person: ids, codes and states only. */
export type V7ImportRefreshException = {
  legacyDbId: string; status: V7ImportRowStatus; ownStatus: Exclude<V7ImportRowStatus, "linked-pair-changed">;
  resolution: V7ImportResolution; carry: V7ImportCarryState | null; scope: V7ImportScope; code: string | null; pairGroup: string | null;
};

/**
 * The preview, returned to the caller and never stored. `summarySha256` and `decisionsSha256` are what a commit names.
 * `refusal` is the first step that refused (`ready` when rows still need a person — then the chain did not run).
 */
export type V7ImportRefreshPreview = {
  mode: "preview"; jobId: string; legacyJobNumber: string;
  outcome: "would-commit" | "refused";
  summarySha256: string; decisionsSha256: string;
  counts: V7ImportCounts; verdict: V7ImportResolvedVerdict;
  exceptions: V7ImportRefreshException[];
  refusal: { stage: V7ImportIngestStage; issues: Array<{ field: string; code: string; message: string }> } | null;
  chain: V7ImportIngestCounts;
  /** Σ previous system and Σ live per scope, as D7 reconciled them; null unless it would commit. */
  scopeTotals: V7ImportIngestTotals | null;
};

/** The commit's result — and so its audit: ids and counts, no figures. Σ per scope is in its 0229 record. */
export type V7ImportRefreshCommitted = {
  mode: "commit"; jobId: string; ingestId: string; sessionId: string; resyncRunId: string; reingestRunId: string;
  resync: { unchanged: number; superseded: number; added: number; withdrawn: number }; plan: { committed: number; decided: number };
};

/**
 * The two-dataset-year guard (urgent, 25 Nov; J000265). The previous system prices a period that spans two calendar years month by
 * month across the two editions (J000265's UK electricity: 0.177 for 2025, 0.13096 for 2026, blended 0.15674). The import's
 * "previous system" figure is a recompute from the single factor it stores, so on such a job it is not the previous system's figure,
 * and a reconcile against it passes falsely. A job with no period is refused, whose years cannot be told.
 *
 * Lifted per job (Datasets Part 2, increment 2): with monthly pricing live, a spanning job may be brought in once its preview — the
 * re-ingested rows, priced by month — reconciles with the previous system's own figures (endpoint 2) within 0.1 t in every scope
 * (`v7SpanningReconcile`). Until it does, SPANS_TWO_DATASET_YEARS still refuses it, naming the rows (`v7SpanningRefusal`); with no
 * read of those figures (not configured, or not answering), it is refused before anything is read (`V7_IMPORT_TWO_DATASET_YEARS_UNREAD`).
 * `v7ImportPeriodIssue` is the period's own rule, before any of that.
 */
export const V7_IMPORT_TWO_DATASET_YEARS = "This job spans two dataset years. It can't be brought in until its figures are checked against the previous system's own. Nothing was written.";
export const V7_IMPORT_NO_REPORTING_PERIOD = "This job has no reporting period, so its dataset years can't be checked. It can't be brought in until it has one. Nothing was written.";

/** A reporting period, inclusive, as ISO dates (`YYYY-MM-DD`), or null where none is recorded. */
export type V7ImportPeriod = { from: string | null; to: string | null };

/** True when the period's first and last days fall in different calendar years. */
export const v7PeriodSpansTwoYears = (period: V7ImportPeriod) => period.from !== null && period.to !== null && period.from.slice(0, 4) !== period.to.slice(0, 4);

/** Why bring-in is refused for the period, or null when it may go ahead (a period within one calendar year). */
export function v7ImportPeriodIssue(period: V7ImportPeriod): CommandIssue | null {
  if (period.from === null || period.to === null) return { field: "jobId", code: "NO_REPORTING_PERIOD", message: V7_IMPORT_NO_REPORTING_PERIOD };
  if (v7PeriodSpansTwoYears(period)) return { field: "jobId", code: "SPANS_TWO_DATASET_YEARS", message: V7_IMPORT_TWO_DATASET_YEARS };
  return null;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function v7ImportRefreshIssues(input: V7ImportRefreshInput): CommandIssue[] {
  const record = input as unknown as Record<string, unknown>;
  const allowed = record.mode === "commit" ? ["jobId", "mode", "summarySha256", "decisionsSha256"] : ["jobId", "mode"];
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  // Closed: the unknown key is named, its value never.
  if (extra.length) return [{ field: "input", code: "UNKNOWN_FIELD", message: `A ${record.mode === "commit" ? "commit" : "preview"} names the job${record.mode === "commit" ? ", the summary and the decisions" : ""}; it has ${extra.slice(0, 5).join(", ")}.` }];
  const issues: CommandIssue[] = [];
  if (typeof record.jobId !== "string" || !record.jobId.trim()) issues.push({ field: "jobId", code: "REQUIRED", message: "Name the job." });
  if (!(V7_IMPORT_REFRESH_MODES as readonly unknown[]).includes(record.mode)) issues.push({ field: "mode", code: "INVALID", message: "A refresh is a preview or a commit." });
  if (record.mode === "commit") {
    if (typeof record.summarySha256 !== "string" || !SHA256.test(record.summarySha256)) issues.push({ field: "summarySha256", code: "REQUIRED", message: "A commit names the summary its preview showed." });
    if (typeof record.decisionsSha256 !== "string" || !SHA256.test(record.decisionsSha256)) issues.push({ field: "decisionsSha256", code: "REQUIRED", message: "A commit names the decisions its preview ran with." });
  }
  return issues;
}

/** organisation.importPolicy.set: whether committing a refresh needs an Admin. expectedVersion 0 = never set (off). */
export type OrganisationImportPolicyInput = { refreshCommitRequiresAdmin: boolean; expectedVersion: number };

export function organisationImportPolicyIssues(input: OrganisationImportPolicyInput): CommandIssue[] {
  const issues: CommandIssue[] = [];
  const extra = Object.keys(input as unknown as Record<string, unknown>).filter((key) => !["refreshCommitRequiresAdmin", "expectedVersion"].includes(key));
  if (extra.length) return [{ field: "input", code: "UNKNOWN_FIELD", message: `The import policy has one setting; it has ${extra.slice(0, 5).join(", ")}.` }];
  if (typeof input.refreshCommitRequiresAdmin !== "boolean") issues.push({ field: "refreshCommitRequiresAdmin", code: "INVALID", message: "Say whether committing a refresh needs an Admin." });
  if (typeof input.expectedVersion !== "number" || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0)
    issues.push({ field: "expectedVersion", code: "INVALID", message: "Expected version must be 0 (not yet set) or positive." });
  return issues;
}
