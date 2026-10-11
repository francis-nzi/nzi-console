import { deriveReportStatus, reportScopeLabel, type DerivedReportStatus, type ReportScope, type ReportStage } from "@nzi/contracts";
import type { Queryable } from "./postgres";

/**
 * R-ST1 (RULING-reporting-site-scope, 8 Oct 2026): every live CRP job with its report status, derived from the records
 * already kept — the reviewed snapshot (prepared → approved), the report version (validated → published), the client's
 * response (approvals; the comment thread) — so the register shows the jobs that have no version yet as honest stages,
 * never as a count of zero. Nothing is stored and nothing here writes. Cancelled jobs are not reporting work.
 *
 * S-1 (0163): a job may have several published reports, one per scope. It is still **one row per job**: the stage is the one
 * that most needs attention across its published scopes, and `scopes` names each scope's own stage.
 *
 * `ownerUserId` is the client's owner (`clients.owner_user_id`, 0066): the register's "My clients" view filters on it. That
 * is a view, not an access boundary — `report.view` is held across the portfolio by every role today.
 */
export type ReportStatusRow = {
  jobId: string; jobNumber: string; clientId: string; client: string; ownerUserId: string | null;
  reportingYear: number | null; jobStatus: string;
  stage: ReportStage; reissueReady: boolean;
  /** The job's default published report (whole-client first, then the most recent) — null when none is published. */
  publishedVersionId: string | null;
  scopes?: DerivedReportStatus["scopes"];
  /** Track A: what the shared row shows and filters on. */
  title: string;
  /** v7's own J-number, kept verbatim on an imported job (search covers it). */
  legacyJobNumber: string | null;
  /** The job's lead consultant (`jobs.owner_name`) — a name, distinct from the client owner "My clients" reads. */
  leadConsultant: string | null;
  /** A reviewed snapshot exists: the job can be prepared for a composed report (compose-eligible). */
  hasSnapshot: boolean;
  /** Imported v7 history whose record of account is its v7 report (decision 12). */
  v7Record: boolean;
  /**
   * Track A Q1 (b): the latest v7 report version's **unsealed** metadata — never its sealed content. Null when the job carries
   * imported rows but v7 issued no report version for it.
   */
  v7Report: { version: number; status: string; finalisedAt: string | null; dataHash: string | null } | null;
};

type PublishedEntry = { reportVersionId: string; scopeKind: "whole" | "sites"; siteIds: string[] | null; approvals: number; lastFrom: "portal" | "staff" | null };

/**
 * Track A: the one read model the Reports page and the preparation picker share (and the job page reads its own row of) —
 * one query over the live CRP jobs, no per-job round trip. `jobId` narrows it to that job.
 */
export async function listReportStatusRegister(db: Queryable, options: { jobId?: string | null } = {}): Promise<ReportStatusRow[]> {
  const { rows } = await db.query<{
    job_id: string; job_number: string; client_id: string; client_name: string; owner_user_id: string | null;
    reporting_year: number | null; status: string;
    title: string; legacy_job_number: string | null; lead_consultant: string | null;
    has_snapshot: boolean; latest_approved: boolean | null; has_validated: boolean;
    published: PublishedEntry[];
    v7_record: boolean;
    v7_report: { version: number; status: string; finalisedAt: string | null; dataHash: string | null } | null;
  }>(
    `SELECT j.job_id, j.job_number, c.client_id, c.name AS client_name, c.owner_user_id, j.reporting_year, j.status,
            j.title, j.legacy_job_number, nullif(btrim(j.owner_name), '') AS lead_consultant,
            -- Q1 (b): the unsealed columns only — the sealed payload is never read here.
            (SELECT jsonb_build_object('version', l.version_number, 'status', l.legacy_status, 'finalisedAt', l.finalized_at, 'dataHash', l.v7_data_hash)
               FROM nzi_console.legacy_report_versions l WHERE (l.organisation_id, l.job_id) = (j.organisation_id, j.job_id) AND l.kind = 'report'
              ORDER BY l.version_number DESC LIMIT 1) AS v7_report,
            EXISTS (SELECT 1 FROM nzi_console.reviewed_crp_snapshots s WHERE (s.organisation_id, s.job_id) = (j.organisation_id, j.job_id)) AS has_snapshot,
            (SELECT s.approved_by IS NOT NULL FROM nzi_console.reviewed_crp_snapshots s
              WHERE (s.organisation_id, s.job_id) = (j.organisation_id, j.job_id) ORDER BY s.snapshot_version DESC LIMIT 1) AS latest_approved,
            EXISTS (SELECT 1 FROM nzi_console.report_versions v WHERE (v.organisation_id, v.job_id) = (j.organisation_id, j.job_id) AND v.status = 'validated') AS has_validated,
            coalesce((SELECT jsonb_agg(jsonb_build_object(
                       'reportVersionId', p.report_version_id, 'scopeKind', p.scope_kind, 'siteIds', p.scope_site_ids,
                       'approvals', (SELECT count(*) FROM nzi_console.portal_report_approvals a WHERE (a.organisation_id, a.report_version_id) = (p.organisation_id, p.report_version_id)),
                       'lastFrom', (SELECT m.author_principal FROM nzi_console.portal_report_comments m WHERE (m.organisation_id, m.report_version_id) = (p.organisation_id, p.report_version_id)
                                     ORDER BY m.created_at DESC, m.comment_id DESC LIMIT 1))
                     ORDER BY (p.scope_kind = 'whole') DESC, p.published_at DESC, p.report_version_id)
                FROM nzi_console.report_versions p WHERE (p.organisation_id, p.job_id) = (j.organisation_id, j.job_id) AND p.status = 'published'), '[]'::jsonb) AS published,
            (EXISTS (SELECT 1 FROM nzi_console.legacy_report_versions l WHERE (l.organisation_id, l.job_id) = (j.organisation_id, j.job_id) AND l.kind = 'report')
              OR EXISTS (SELECT 1 FROM nzi_console.job_scope_rows r WHERE (r.organisation_id, r.job_id) = (j.organisation_id, j.job_id) AND r.origin = 'migrated')) AS v7_record
       FROM nzi_console.jobs j
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
      WHERE j.job_family = 'crp' AND j.status <> 'cancelled' AND ($1::text IS NULL OR j.job_id = $1)
      ORDER BY j.sequence DESC`, [options.jobId ?? null]);
  // Site names for scope labels, read once and only when a site scope is published somewhere.
  const names = rows.some((row) => row.published.some((entry) => entry.scopeKind === "sites"))
    ? new Map((await db.query<{ site_id: string; name: string }>(`SELECT site_id, name FROM nzi_console.client_sites`)).rows.map((site) => [site.site_id, site.name]))
    : new Map<string, string>();
  return rows.map((row) => {
    const derived = deriveReportStatus({
      hasSnapshot: row.has_snapshot,
      latestSnapshotApproved: row.latest_approved === true,
      hasValidatedVersion: row.has_validated,
      published: row.published.map((entry) => {
        const scope: ReportScope = entry.scopeKind === "sites" && entry.siteIds ? { kind: "sites", siteIds: entry.siteIds } : { kind: "whole" };
        return { scopeLabel: reportScopeLabel(scope, names), approvalCount: Number(entry.approvals), lastCommentFrom: entry.lastFrom };
      }),
      v7Record: row.v7_record,
    });
    return {
      jobId: row.job_id, jobNumber: row.job_number, clientId: row.client_id, client: row.client_name, ownerUserId: row.owner_user_id,
      reportingYear: row.reporting_year, jobStatus: row.status, stage: derived.stage, reissueReady: derived.reissueReady,
      publishedVersionId: row.published[0]?.reportVersionId ?? null,
      ...(derived.scopes ? { scopes: derived.scopes } : {}),
      title: row.title, legacyJobNumber: row.legacy_job_number, leadConsultant: row.lead_consultant,
      hasSnapshot: row.has_snapshot, v7Record: row.v7_record, v7Report: row.v7_report,
    };
  });
}
