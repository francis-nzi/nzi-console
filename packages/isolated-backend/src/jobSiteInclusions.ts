// Redesign Phase 3a (0161, ruled 8 Oct 2026: RULING-phase3-design.md #1–#6) — which of the client's sites a job reports on.
//
// Versioned and append-only, the Phase 1 shape: a change writes the next version for (job, site); absence means included,
// so a job that leaves every site in has no rows here. Excluding a site that the job already uses is refused in v1
// (SITE_IN_USE, ruled #4): silently dropping counted rows from a report would break its total.
import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
export { SITE_EXCLUDED_MESSAGE, listExcludedSiteIds, refuseExcludedSiteChange, siteIncludedSql } from "./siteInclusionGuard";

export type SetJobSiteInclusionResult = { jobId: string; siteId: string; version: number; included: boolean };

export const SITE_IN_USE_MESSAGE = "This site has entries in the job — move or remove them before excluding it.";

const refuse = (field: string, code: string, message: string) => new CommandValidationError([{ field, code, message }]);

/**
 * What uses a site in a job (ruled #4): any scope row, enabled or not — a disabled row can be re-enabled; any emission
 * source; any portal record not yet accepted — a draft, or a submission still pending review — because it becomes a row.
 * Counts only, for the refusal; nothing about the rows themselves.
 */
async function siteUse(db: Queryable, organisationId: string, jobId: string, siteId: string) {
  const { rows: [use] } = await db.query<{ rows: number; sources: number; records: number }>(
    `SELECT
       (SELECT count(*)::int FROM nzi_console.job_scope_rows WHERE organisation_id=$1 AND job_id=$2 AND site_id=$3) AS rows,
       (SELECT count(*)::int FROM nzi_console.job_emission_sources WHERE organisation_id=$1 AND job_id=$2 AND site_id=$3) AS sources,
       (SELECT count(*)::int FROM nzi_console.portal_data_entry_records r
          JOIN nzi_console.portal_data_entry_bucket_grants b ON (b.organisation_id,b.bucket_grant_id)=(r.organisation_id,r.bucket_grant_id)
          JOIN nzi_console.portal_access_grants g ON (g.organisation_id,g.grant_id)=(b.organisation_id,b.access_grant_id)
         WHERE r.organisation_id=$1 AND g.job_id=$2 AND r.site_id=$3
           AND (r.status='draft' OR (r.status='submitted' AND EXISTS (SELECT 1 FROM nzi_console.portal_data_entry_review_queue q
                 WHERE (q.organisation_id,q.record_id)=(r.organisation_id,r.record_id) AND q.status='pending')))) AS records`,
    [organisationId, jobId, siteId]);
  return use!;
}

/** Include a client's site in this job's report, or leave it out — the next version for (job, site). */
export function setJobSiteInclusion(pool: PoolLike, input: CommandInputMap["job.site.setInclusion"], context: CommandContext): Promise<StoredOutcome<SetJobSiteInclusionResult>> {
  return runPostgresCommand(pool, "job.site.setInclusion", input, context, async (db) => {
    // The job row, locked: every site-setting write takes it FOR SHARE before its inclusion check (ruled #5), so nothing
    // can start using the site between the count below and this version's insert.
    const { rows: [job] } = await db.query<{ client_id: string; job_family: string }>(
      `SELECT client_id, job_family FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2 FOR UPDATE`, [context.organisationId, input.jobId]);
    if (!job) throw refuse("jobId", "NOT_FOUND", "Job was not found.");
    if (job.job_family !== "crp") throw refuse("jobId", "NOT_CRP", "Sites are included or left out of carbon reporting jobs only.");

    const { rows: [site] } = await db.query<{ archived: boolean }>(
      `SELECT archived FROM nzi_console.client_sites WHERE organisation_id=$1 AND site_id=$2 AND client_id=$3`, [context.organisationId, input.siteId, job.client_id]);
    if (!site) throw refuse("siteId", "NOT_FOUND", "Site was not found for this job's client.");
    // Ruled #3: an archived site is already out of every boundary and off every list — there is nothing to decide.
    if (site.archived) throw refuse("siteId", "SITE_ARCHIVED", "That site is archived — unarchive it on the client before deciding whether this job includes it.");

    const { rows: [latest] } = await db.query<{ version: number; included: boolean }>(
      `SELECT version, included FROM nzi_console.job_site_inclusions WHERE organisation_id=$1 AND job_id=$2 AND site_id=$3 ORDER BY version DESC LIMIT 1`,
      [context.organisationId, input.jobId, input.siteId]);
    const currentVersion = latest?.version ?? 0;
    if (currentVersion !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, currentVersion);
    const currentlyIncluded = latest?.included ?? true;
    // Ruled #3: no empty versions.
    if (currentlyIncluded === input.included) {
      throw refuse("included", "UNCHANGED", input.included ? "This site is already included in the job." : "This site is already left out of the job.");
    }

    const reason = context.reason?.trim() || null;
    if (!input.included) {
      // Ruled #2: the reason is the command's, and an exclusion needs one.
      if (!reason) throw refuse("reason", "REASON_REQUIRED", "Say why this site is left out of the job.");
      const use = await siteUse(db, context.organisationId, input.jobId, input.siteId);
      if (use.rows + use.sources + use.records > 0) throw refuse("siteId", "SITE_IN_USE", SITE_IN_USE_MESSAGE);
    }

    const version = currentVersion + 1;
    try {
      await db.query(
        `INSERT INTO nzi_console.job_site_inclusions (organisation_id, job_id, site_id, version, included, reason, decided_by, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [context.organisationId, input.jobId, input.siteId, version, input.included, reason, context.actorId, context.correlationId]);
    } catch (error) {
      // Under the job lock two writers cannot reach here together; the primary key is the backstop all the same.
      if ((error as { code?: string }).code === "23505") throw new VersionConflictError(input.expectedVersion, version);
      throw error;
    }
    return {
      // NZC-120: ids, a boolean and a version — the audit's after_json and the outbox payload.
      data: { jobId: input.jobId, siteId: input.siteId, version, included: input.included },
      before: { included: currentlyIncluded },
      entityType: "job_site_inclusion", entityId: `${input.jobId}:${input.siteId}`, topic: "job.site.inclusion.set",
    };
  });
}
