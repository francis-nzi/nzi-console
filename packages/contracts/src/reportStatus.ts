// Reporting R-ST1 (RULING-reporting-site-scope, 8 Oct 2026): a CRP job's report status, DERIVED — not stored. Every input
// is a record the platform already keeps, append-only or versioned: the reviewed snapshot (prepared, then approved by
// someone other than its preparer), the report version (validated → published → superseded), and the client's response on
// the published version (approvals; the comment thread). Nothing here is a state a person sets.

/** The stages, in the order a report moves through them. */
export const REPORT_STAGES = [
  "in-preparation", "awaiting-review", "ready-to-validate", "ready-to-publish",
  "awaiting-client", "changes-requested", "client-approved",
] as const;
export type ReportStage = (typeof REPORT_STAGES)[number] | "v7-record";

export const reportStageLabels: Record<ReportStage, string> = {
  "in-preparation": "In preparation",
  "awaiting-review": "Awaiting review",
  "ready-to-validate": "Ready to validate",
  "ready-to-publish": "Ready to publish",
  "awaiting-client": "Awaiting client approval",
  "changes-requested": "Changes requested",
  "client-approved": "Client approved",
  "v7-record": "Issued in NZ Insights Pro v7",
};

/** What the platform knows about one CRP job's report, as read. */
export type ReportStatusFacts = {
  /** A reviewed snapshot exists for the job (any version). */
  hasSnapshot: boolean;
  /** The job's latest snapshot is approved (NZC-022: by someone other than its preparer). */
  latestSnapshotApproved: boolean;
  /** A report version is validated and not yet published. */
  hasValidatedVersion: boolean;
  /**
   * The job's published reports — one per scope since S-1 (0163) — each with the client's response to it. Empty when none is
   * published.
   */
  published: ReadonlyArray<PublishedScopeFacts>;
  /** The job's period is imported history whose record of account is its v7 report (decision 12). */
  v7Record: boolean;
};

export type PublishedScopeFacts = { scopeLabel: string; approvalCount: number; lastCommentFrom: "portal" | "staff" | null };
type ClientStage = "awaiting-client" | "changes-requested" | "client-approved";

export type DerivedReportStatus = {
  stage: ReportStage;
  /** A published report with a newer validated version waiting: a re-issue is ready. */
  reissueReady: boolean;
  /** S-1: with more than one published scope, each scope's own client stage — so the row shows which one needs attention. */
  scopes?: Array<{ scopeLabel: string; stage: ClientStage }>;
};

/** One published report's client stage. Approval outranks an open thread — the client's own act of approving is the stronger signal. */
const clientStage = (published: PublishedScopeFacts): ClientStage =>
  published.approvalCount > 0 ? "client-approved" : published.lastCommentFrom === "portal" ? "changes-requested" : "awaiting-client";

/**
 * Across a job's published scopes the job shows the one that most needs attention (S-1, §1b): a change request first, then a
 * report the client has yet to approve, then approved. So one scope approved and another with changes requested reads
 * "Changes requested" — nothing is hidden behind an approval elsewhere.
 */
const ATTENTION: readonly ClientStage[] = ["changes-requested", "awaiting-client", "client-approved"];

/**
 * One rule. The published versions, when there are any, are what the client holds, so their client-side state is the job's
 * status; a validated re-issue behind them is a flag, not a regression of the stage.
 *
 * "Changes requested" is derived for v1 (ruled): a published version the client has commented on last, and not approved.
 */
export function deriveReportStatus(facts: ReportStatusFacts): DerivedReportStatus {
  if (facts.published.length > 0) {
    const scopes = facts.published.map((published) => ({ scopeLabel: published.scopeLabel, stage: clientStage(published) }));
    const stage = ATTENTION.find((candidate) => scopes.some((scope) => scope.stage === candidate))!;
    return { stage, reissueReady: facts.hasValidatedVersion, ...(scopes.length > 1 ? { scopes } : {}) };
  }
  if (facts.hasValidatedVersion) return { stage: "ready-to-publish", reissueReady: false };
  // Imported history is never "in preparation": its record of account already exists, in v7.
  if (facts.v7Record && !facts.hasSnapshot) return { stage: "v7-record", reissueReady: false };
  if (!facts.hasSnapshot) return { stage: "in-preparation", reissueReady: false };
  return { stage: facts.latestSnapshotApproved ? "ready-to-validate" : "awaiting-review", reissueReady: false };
}

/** Counts per stage, every stage present — a stage with no jobs is 0 because it was read and is empty, never a failed read. */
export function countReportStages(statuses: ReadonlyArray<Pick<DerivedReportStatus, "stage">>): Record<ReportStage, number> {
  const counts = Object.fromEntries([...REPORT_STAGES, "v7-record"].map((stage) => [stage, 0])) as Record<ReportStage, number>;
  for (const status of statuses) counts[status.stage] += 1;
  return counts;
}
