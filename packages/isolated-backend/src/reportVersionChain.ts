// Client-review loop S7: the chain of report versions for one job and scope, read-only. Reopen (S1) writes a NEW version row each round -
// `revision` + 1, `supersedes_report_version_id` pointing back - and a closed round is never edited, so the chain is already stored; this
// only reads it. A prior version's words are on its own row (`narrative`); a published one's whole document is in `report_compositions`.
import type { ReportComposition } from "@nzi/contracts";
import { composeForReportVersion, getReportComposition } from "./reportCompositions";
import type { Queryable } from "./postgres";
import { RESTORE_SOURCE_STATUSES } from "./reportReviewLoop";

export type ReportVersionChainEntry = {
  reportVersionId: string; revision: number; status: string; version: number; supersedesReportVersionId: string | null;
  createdAt: string; sentToReviewAt: string | null; clientApprovedAt: string | null; finalApprovedAt: string | null; publishedAt: string | null;
  /** The version the chain was asked about. */
  current: boolean;
  /** The CRM may restore wording from this one (closed: replaced or issued) - and it has wording to restore. */
  restorable: boolean;
};

const iso = (value: Date | string | null): string | null => value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/** Every version of the same job and scope as `reportVersionId`, oldest round first. Empty when the version is not found. Run inside a tenant read. */
export async function listReportVersionChain(db: Queryable, reportVersionId: string): Promise<ReportVersionChainEntry[]> {
  const { rows } = await db.query<{
    report_version_id: string; revision: number; status: string; version: number; supersedes_report_version_id: string | null; created_at: Date | string;
    sent_to_review_at: Date | string | null; client_approved_at: Date | string | null; final_approved_at: Date | string | null; published_at: Date | string | null; has_narrative: boolean;
  }>(
    `SELECT v.report_version_id, v.revision, v.status, v.version, v.supersedes_report_version_id, v.created_at, v.sent_to_review_at, v.client_approved_at,
            v.final_approved_at, v.published_at, v.narrative IS NOT NULL AS has_narrative
       FROM nzi_console.report_versions v
       JOIN nzi_console.report_versions me ON (me.organisation_id, me.job_id, me.scope_key) = (v.organisation_id, v.job_id, v.scope_key)
      WHERE me.report_version_id = $1
      ORDER BY v.revision, v.created_at, v.report_version_id`, [reportVersionId]);
  return rows.map((row) => ({
    reportVersionId: row.report_version_id, revision: row.revision, status: row.status, version: row.version, supersedesReportVersionId: row.supersedes_report_version_id,
    createdAt: iso(row.created_at)!, sentToReviewAt: iso(row.sent_to_review_at), clientApprovedAt: iso(row.client_approved_at), finalApprovedAt: iso(row.final_approved_at), publishedAt: iso(row.published_at),
    current: row.report_version_id === reportVersionId,
    restorable: row.report_version_id !== reportVersionId && RESTORE_SOURCE_STATUSES.includes(row.status) && row.has_narrative,
  }));
}

/**
 * A prior version's document, read-only, for the CRM to look at before restoring: a published one is read back from its frozen
 * composition; any other is composed now from its own snapshot, plan and narrative and stored nowhere. Only a version in the SAME job and
 * scope as `reportVersionId` (the chain) is reachable - anything else is null, as a missing one is.
 */
export async function previewPriorVersion(db: Queryable, input: { organisationId: string; reportVersionId: string; fromReportVersionId: string; now?: Date }): Promise<{ composition: ReportComposition; status: string; revision: number } | null> {
  const entry = (await listReportVersionChain(db, input.reportVersionId)).find((candidate) => candidate.reportVersionId === input.fromReportVersionId);
  if (!entry) return null;
  const composition = entry.status === "published"
    ? await getReportComposition(db, entry.reportVersionId)
    : await composeForReportVersion(db, { organisationId: input.organisationId, reportVersionId: entry.reportVersionId, issuedAt: (input.now ?? new Date()).toISOString() });
  return composition ? { composition, status: entry.status, revision: entry.revision } : null;
}
