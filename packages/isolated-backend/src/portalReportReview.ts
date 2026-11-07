// Client-review loop S4: what a client sees of a round open for their review - the live composition of an `in_client_review` (or
// `client_approved`) version, composed on read and stored nowhere (D6), with the sections they may edit. Grant-checked as the portal's
// other report reads are: an active portal user with a live grant on the job, the client's own report. The client's copy: every staff
// identity out (`clientFacingComposition`), as the published view does.
import { clientFacingComposition, clientMayEdit, reportScopeLabel, type ReportComposition, type ReportScope } from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { previewReportComposition } from "./reportCompositions";

export type PortalReviewRound = {
  reportVersionId: string; status: "in_client_review" | "client_approved"; version: number; scopeLabel: string; sentToReviewAt: string | null;
  /** The narrative sections the client may edit now: those the version draws, while the round is open. Never a figure, chart or table. */
  editableSections: string[];
  composition: ReportComposition;
};

export async function getGrantedPortalReviewRound(db: Queryable, input: { organisationId: string; portalUserId: string; clientId: string; jobId: string; reportVersionId?: string | null }): Promise<PortalReviewRound | null> {
  const { rows } = await db.query<{ report_version_id: string; status: "in_client_review" | "client_approved"; version: number; scope_kind: "whole" | "sites"; scope_site_ids: string[] | null; sent_to_review_at: Date | string | null }>(
    `SELECT r.report_version_id, r.status, r.version, r.scope_kind, r.scope_site_ids, r.sent_to_review_at
       FROM nzi_console.report_versions r
       JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (r.organisation_id, r.job_id)
       JOIN nzi_console.portal_access_grants g ON (g.organisation_id, g.job_id, g.client_id) = (j.organisation_id, j.job_id, j.client_id)
       JOIN nzi_console.portal_users u ON (u.organisation_id, u.portal_user_id, u.client_id) = (g.organisation_id, g.portal_user_id, g.client_id)
      WHERE r.organisation_id = $1 AND r.job_id = $2 AND r.status IN ('in_client_review', 'client_approved')
        AND g.portal_user_id = $3 AND g.client_id = $4 AND g.revoked_at IS NULL AND u.status = 'active'
        AND ($5::text IS NULL OR r.report_version_id = $5)
      ORDER BY (r.scope_kind = 'whole') DESC, r.sent_to_review_at DESC NULLS LAST, r.report_version_id
      LIMIT 1`,
    [input.organisationId, input.jobId, input.portalUserId, input.clientId, input.reportVersionId ?? null]);
  const row = rows[0];
  if (!row) return null;
  const preview = await previewReportComposition(db, { organisationId: input.organisationId, reportVersionId: row.report_version_id });
  if (!preview) return null;
  const scope: ReportScope = row.scope_kind === "sites" && row.scope_site_ids ? { kind: "sites", siteIds: row.scope_site_ids } : { kind: "whole" };
  const names = scope.kind === "sites"
    ? new Map((await db.query<{ site_id: string; name: string }>(`SELECT site_id, name FROM nzi_console.client_sites WHERE client_id = $1`, [input.clientId])).rows.map((site) => [site.site_id, site.name]))
    : new Map<string, string>();
  return {
    reportVersionId: row.report_version_id, status: row.status, version: row.version, scopeLabel: reportScopeLabel(scope, names),
    sentToReviewAt: row.sent_to_review_at ? (row.sent_to_review_at instanceof Date ? row.sent_to_review_at.toISOString() : String(row.sent_to_review_at)) : null,
    editableSections: clientMayEdit(row.status) ? (preview.composition.narrative ?? []).map((element) => element.key) : [],
    composition: clientFacingComposition(preview.composition),
  };
}
