import { reportScopeLabel, type InputSpecCategory, type PortalAssuredDashboard, type PortalLiveBroadcast, type ReportScope } from "@nzi/contracts";
import { AuthorizationError, requireCapability, type StaffPrincipal } from "./auth";
import { assertCapabilityOnClient } from "./access";
import { listInputSpecForClient } from "./categoryVisibility";
import { listLivePortalBroadcasts } from "./portalBroadcasts";
import { assemblePortalDataView, assemblePortalRowHistory, type PortalDataView, type PortalRowHistoryEntry } from "./portalCapture";
import { assemblePortalAssuredDashboard } from "./portalAnalytics";
import { assemblePortalReportView, portalPublishedReportOf, type PortalReportView } from "./portalComposition";
import { getCurrentPublishedCrpReport, listCurrentPublishedCrpReports } from "./readModels";
import { withTenantRead, type PoolLike, type Queryable } from "./postgres";

/**
 * The staff preview's second authorizer on the client's job-level reads (BUILD-staff-portal-preview-job-aware, R2).
 *
 * Each read here opens the **same inner assembly** the client's own read does — `assemblePortalDataView`,
 * `assemblePortalAssuredDashboard`, `assemblePortalReportView`, `portalPublishedReportOf` — and differs only in who may ask and
 * where `clientId`/`jobId` come from:
 *  - the portal principal: a live access grant on the job, the client from the session (unchanged, in each read's own module);
 *  - the staff preview (here): `support.portal_impersonate` on the client, resolved against the database, and the job checked to
 *    be that client's. No portal grant, user or window is needed, so a client nobody has been invited for still previews (R3).
 *
 * The two never cross: a portal principal is refused here before anything is read, and a staff principal has no grant for the
 * portal path to find. Nothing here writes (R5); the preview's one write, the `portal.preview.open` audit, is `getPortalPreview`'s.
 *
 * What a portal *user* owns has no subject in a preview: the data-entry window (`access`), a report's approval, an unread reply.
 * Those read as nobody's — `null`, `false` — never as some user's chosen on the staff member's behalf.
 */

/** Staff only, and holding the capability at all — before anything is read. A portal principal never reaches the reads below. */
function requireStaffPreview(principal: StaffPrincipal): void {
  if (!principal || !Array.isArray((principal as { capabilities?: unknown }).capabilities) || "clientId" in principal) {
    throw new AuthorizationError("support.portal_impersonate");
  }
  requireCapability(principal, "support.portal_impersonate");
}

/** The capability on the client (tenant and own-client scope, from the database), and the job that client's. */
export async function assertStaffPreviewJob(db: Queryable, principal: StaffPrincipal, clientId: string, jobId: string): Promise<void> {
  await assertCapabilityOnClient(db, principal, "support.portal_impersonate", { clientId });
  const job = await db.query(`SELECT 1 FROM nzi_console.jobs WHERE organisation_id = $1 AND client_id = $2 AND job_id = $3`, [principal.organisationId, clientId, jobId]);
  if (!job.rows[0]) throw new AuthorizationError("tenant", "That job is not this client's.");
}

/** Async, so a refusal is a rejection like every other — never a throw before the caller holds a promise. */
async function previewRead<T>(pool: PoolLike, principal: StaffPrincipal, clientId: string, jobId: string | null, work: (db: Queryable) => Promise<T>): Promise<T> {
  requireStaffPreview(principal);
  return withTenantRead(pool, principal.organisationId, async (db) => {
    if (jobId === null) await assertCapabilityOnClient(db, principal, "support.portal_impersonate", { clientId });
    else await assertStaffPreviewJob(db, principal, clientId, jobId);
    return work(db);
  });
}

/** The authorizer alone, for a read whose answer in preview is "no portal user" (the data-entry window and what was sent in it). */
export function authorizePortalPreviewJob(pool: PoolLike, principal: StaffPrincipal, clientId: string, jobId: string): Promise<void> {
  return previewRead(pool, principal, clientId, jobId, async () => undefined);
}

/** A job as the client's portfolio lists it (`/api/portal/jobs`), with the portal user's own fields read as nobody's. */
export type PortalPreviewJob = {
  id: string; number: string; title: string; family: string; status: string; reportingYear: number | null;
  hasPublishedReport: boolean; approved: false; approvedAt: null; hasUnreadNziResponse: false;
  publishedReports: Array<{ reportVersionId: string; scope: ReportScope; scopeLabel: string; approved: false; approvedAt: null }>;
};

/**
 * R3: the client's own jobs — every job the console shows for this client — never its portal grants. A client with no portal
 * user, or none granted, lists in full. Newest first, as the portfolio orders them.
 */
export async function listClientPreviewJobs(db: Queryable, organisationId: string, clientId: string): Promise<PortalPreviewJob[]> {
  const jobs = await db.query<{ job_id: string; job_number: string; title: string; job_family: string; status: string; reporting_year: number | null }>(
    `SELECT job_id, job_number, title, job_family, status, reporting_year FROM nzi_console.jobs WHERE organisation_id = $1 AND client_id = $2 ORDER BY sequence DESC`,
    [organisationId, clientId]);
  const published = await db.query<{ job_id: string; report_version_id: string; scope_kind: "whole" | "sites"; scope_site_ids: string[] | null }>(
    `SELECT r.job_id, r.report_version_id, r.scope_kind, r.scope_site_ids FROM nzi_console.report_versions r
       JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (r.organisation_id, r.job_id)
      WHERE r.organisation_id = $1 AND j.client_id = $2 AND r.status = 'published'
      ORDER BY (r.scope_kind = 'whole') DESC, r.published_at DESC, r.report_version_id`, [organisationId, clientId]);
  const names = published.rows.some((row) => row.scope_kind === "sites")
    ? new Map((await db.query<{ site_id: string; name: string }>(`SELECT site_id, name FROM nzi_console.client_sites WHERE client_id = $1`, [clientId])).rows.map((site) => [site.site_id, site.name]))
    : new Map<string, string>();
  return jobs.rows.map((job) => {
    const reports = published.rows.filter((report) => report.job_id === job.job_id);
    return {
      id: job.job_id, number: job.job_number, title: job.title, family: job.job_family, status: job.status, reportingYear: job.reporting_year,
      hasPublishedReport: reports.length > 0, approved: false, approvedAt: null, hasUnreadNziResponse: false,
      publishedReports: reports.map((report) => {
        const scope: ReportScope = report.scope_kind === "sites" && report.scope_site_ids ? { kind: "sites", siteIds: report.scope_site_ids } : { kind: "whole" };
        return { reportVersionId: report.report_version_id, scope, scopeLabel: reportScopeLabel(scope, names), approved: false, approvedAt: null };
      }),
    };
  });
}

export function listPortalPreviewJobs(pool: PoolLike, principal: StaffPrincipal, clientId: string): Promise<PortalPreviewJob[]> {
  return previewRead(pool, principal, clientId, null, (db) => listClientPreviewJobs(db, principal.organisationId, clientId));
}

/** The client's Data view for a job. The window is a portal user's, so there is none here — and it never gates a preview. */
export function getPortalDataViewForStaff(pool: PoolLike, principal: StaffPrincipal, clientId: string, jobId: string): Promise<PortalDataView> {
  return previewRead(pool, principal, clientId, jobId, (db) => assemblePortalDataView(db, clientId, jobId, null));
}

export function getPortalRowHistoryForStaff(pool: PoolLike, principal: StaffPrincipal, clientId: string, jobId: string, rowId: string): Promise<PortalRowHistoryEntry[]> {
  return previewRead(pool, principal, clientId, jobId, (db) => assemblePortalRowHistory(db, clientId, jobId, rowId));
}

/** The client's assured dashboard for a job: the job's default published report, as the grant path resolves it without the grant. */
export function getPortalAssuredDashboardForStaff(pool: PoolLike, principal: StaffPrincipal, clientId: string, jobId: string): Promise<PortalAssuredDashboard> {
  return previewRead(pool, principal, clientId, jobId, async (db) => assemblePortalAssuredDashboard(db, await getCurrentPublishedCrpReport(db, jobId), jobId));
}

/** `/published-report` as the client gets it, with no approval: an approval is a portal user's, and the preview has none. */
export function getPortalPublishedReportForStaff(pool: PoolLike, principal: StaffPrincipal, clientId: string, jobId: string, wanted: string | null) {
  return previewRead(pool, principal, clientId, jobId, async (db) => {
    const selected = portalPublishedReportOf(await listCurrentPublishedCrpReports(db, jobId), wanted);
    return selected ? { report: selected.report, approval: null, reports: selected.reports } : null;
  });
}

export function getPortalReportViewForStaff(pool: PoolLike, principal: StaffPrincipal, clientId: string, jobId: string, reportVersionId: string | null): Promise<PortalReportView | null> {
  return previewRead(pool, principal, clientId, jobId, async (db) => assemblePortalReportView(db, await getCurrentPublishedCrpReport(db, jobId, reportVersionId)));
}

/** The input spec as this client sees it (NZC-110) — the client's own resolver. */
export function getPortalInputSpecForStaff(pool: PoolLike, principal: StaffPrincipal, clientId: string): Promise<InputSpecCategory[]> {
  return previewRead(pool, principal, clientId, null, (db) => listInputSpecForClient(db, clientId));
}

/** The broadcasts live for this client — the client's own resolver. */
export function listPortalBroadcastsForStaff(pool: PoolLike, principal: StaffPrincipal, clientId: string): Promise<PortalLiveBroadcast[]> {
  return previewRead(pool, principal, clientId, null, (db) => listLivePortalBroadcasts(db, clientId));
}
