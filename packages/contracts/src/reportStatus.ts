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
  /** The job's current published version, with the client's response to it — null when none is published. */
  published: { approvalCount: number; lastCommentFrom: "portal" | "staff" | null } | null;
  /** The job's period is imported history whose record of account is its v7 report (decision 12). */
  v7Record: boolean;
};

export type DerivedReportStatus = {
  stage: ReportStage;
  /** A published report with a newer validated version waiting: a re-issue is ready. */
  reissueReady: boolean;
};

/**
 * One rule. The published version, when there is one, is what the client holds, so its client-side state is the job's
 * status; a validated re-issue behind it is a flag, not a regression of the stage.
 *
 * "Changes requested" is derived for v1 (ruled): a published version the client has commented on last, and not approved.
 * Approval outranks an open thread — the client's own act of approving is the stronger signal.
 */
export function deriveReportStatus(facts: ReportStatusFacts): DerivedReportStatus {
  if (facts.published) {
    const stage: ReportStage = facts.published.approvalCount > 0 ? "client-approved"
      : facts.published.lastCommentFrom === "portal" ? "changes-requested"
      : "awaiting-client";
    return { stage, reissueReady: facts.hasValidatedVersion };
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
