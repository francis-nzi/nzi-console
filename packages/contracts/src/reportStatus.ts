// Reporting R-ST1 (RULING-reporting-site-scope, 8 Oct 2026): a CRP job's report status, DERIVED — not stored. Every input
// is a record the platform already keeps, append-only or versioned: the reviewed snapshot (prepared, then approved by
// someone other than its preparer), the report version (validated → published → superseded), and the client's response on
// the published version (approvals; the comment thread). Nothing here is a state a person sets.

/** The stages, in the order a report moves through them. */
export const REPORT_STAGES = [
  "in-preparation", "awaiting-review", "ready-to-validate", "ready-to-publish",
  "awaiting-client", "client-responded", "changes-requested", "awaiting-final-approval", "client-approved",
] as const;
export type ReportStage = (typeof REPORT_STAGES)[number] | "v7-record";

export const reportStageLabels: Record<ReportStage, string> = {
  "in-preparation": "In preparation",
  "awaiting-review": "Awaiting review",
  "ready-to-validate": "Ready to validate",
  "ready-to-publish": "Ready to publish",
  "awaiting-client": "Awaiting client approval",
  "client-responded": "Client responded — review needed",
  "changes-requested": "Changes requested",
  "awaiting-final-approval": "Awaiting final approval",
  "client-approved": "Client approved",
  "v7-record": "Issued before the console",
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

/**
 * One scope's report as the client holds it. `status` is the version's STORED status and is read first: a round `in_client_review`
 * is awaiting the client (or has changes requested), `client_approved` is client-approved, whatever the approval and comment counts
 * say. Absent, it is `published` — derived from the client's response as before. `scopeKey` pairs a reopened round with the
 * published version it will replace.
 */
export type PublishedScopeFacts = { scopeLabel: string; approvalCount: number; lastCommentFrom: "portal" | "staff" | null; status?: "published" | "in_client_review" | "client_approved"; scopeKey?: string;
  /**
   * Client-review loop S6, for a round `in_client_review`: whose turn it is. The client's latest act (an edit, a message) and the team's
   * latest (a reply, an edit) - ISO times. The client acting after the team is the CRM's turn; absent, the thread's last
   * author decides, as it did before.
   */
  lastClientActionAt?: string | null; lastStaffActionAt?: string | null };
type ClientStage = "awaiting-client" | "client-responded" | "changes-requested" | "awaiting-final-approval" | "client-approved";

/** S6: a round open for review - has the client acted since the team last did? Equal times are the team's (it spoke last). */
export function clientActedLast(round: Pick<PublishedScopeFacts, "lastCommentFrom" | "lastClientActionAt" | "lastStaffActionAt">): boolean {
  if (round.lastClientActionAt === undefined && round.lastStaffActionAt === undefined) return round.lastCommentFrom === "portal";
  const client = round.lastClientActionAt ? Date.parse(round.lastClientActionAt) : NaN;
  if (Number.isNaN(client)) return false;
  const staff = round.lastStaffActionAt ? Date.parse(round.lastStaffActionAt) : NaN;
  return Number.isNaN(staff) || client > staff;
}

export type DerivedReportStatus = {
  stage: ReportStage;
  /** A published report with a newer validated version waiting: a re-issue is ready. */
  reissueReady: boolean;
  /** S-1: with more than one published scope, each scope's own client stage — so the row shows which one needs attention. */
  scopes?: Array<{ scopeLabel: string; stage: ClientStage }>;
};

/** One published report's client stage. Approval outranks an open thread — the client's own act of approving is the stronger signal. */
const clientStage = (published: PublishedScopeFacts): ClientStage => {
  // The stored status first (client-review loop S1): the register and the version can never disagree about a round in the loop.
  if (published.status === "client_approved") return "awaiting-final-approval";
  if (published.status === "in_client_review") return clientActedLast(published) ? "client-responded" : "awaiting-client";
  return published.approvalCount > 0 ? "client-approved" : published.lastCommentFrom === "portal" ? "changes-requested" : "awaiting-client";
};

const isOpenRound = (entry: PublishedScopeFacts) => entry.status === "in_client_review" || entry.status === "client_approved";
/** A scope with an open round is judged by that round: the published version it will replace is still live, but it is not where the work is. */
function currentPerScope(entries: ReadonlyArray<PublishedScopeFacts>): PublishedScopeFacts[] {
  const reopened = new Set(entries.filter(isOpenRound).map((entry) => entry.scopeKey ?? entry.scopeLabel));
  return entries.filter((entry) => isOpenRound(entry) || !reopened.has(entry.scopeKey ?? entry.scopeLabel));
}

/**
 * Across a job's published scopes the job shows the one that most needs attention (S-1, §1b): a change request first, then a
 * report the client has yet to approve, then approved. So one scope approved and another with changes requested reads
 * "Changes requested" — nothing is hidden behind an approval elsewhere.
 */
const ATTENTION: readonly ClientStage[] = ["client-responded", "changes-requested", "awaiting-final-approval", "awaiting-client", "client-approved"];

/** S6: the stages where the ball is in the CRM's court - the client responded, asked for changes, or approved and awaits the final approval. */
export const CRM_TURN_STAGES: readonly ReportStage[] = ["client-responded", "changes-requested", "awaiting-final-approval"];
export const crmTurn = (stage: ReportStage): boolean => CRM_TURN_STAGES.includes(stage);

/**
 * S6: how many reports wait on the CRM. A job with several scopes counts each scope that needs the team (the row shows only the most
 * pressing one); a round awaiting the client is not counted. Derived from the register rows - nothing stored.
 */
export function crmQueue(rows: ReadonlyArray<{ stage: ReportStage; scopes?: ReadonlyArray<{ stage: ReportStage }> }>): { total: number; byStage: Record<"client-responded" | "changes-requested" | "awaiting-final-approval", number> } {
  const byStage = { "client-responded": 0, "changes-requested": 0, "awaiting-final-approval": 0 };
  for (const row of rows) for (const stage of row.scopes?.length ? row.scopes.map((scope) => scope.stage) : [row.stage]) if (stage in byStage) byStage[stage as keyof typeof byStage] += 1;
  return { total: byStage["client-responded"] + byStage["changes-requested"] + byStage["awaiting-final-approval"], byStage };
}

/**
 * One rule. The published versions, when there are any, are what the client holds, so their client-side state is the job's
 * status; a validated re-issue behind them is a flag, not a regression of the stage.
 *
 * "Changes requested" is derived for v1 (ruled): a published version the client has commented on last, and not approved.
 */
export function deriveReportStatus(facts: ReportStatusFacts): DerivedReportStatus {
  if (facts.published.length > 0) {
    const scopes = currentPerScope(facts.published).map((published) => ({ scopeLabel: published.scopeLabel, stage: clientStage(published) }));
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
