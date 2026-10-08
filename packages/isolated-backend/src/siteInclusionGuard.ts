import type { Queryable } from "./postgres";

/**
 * Phase 3a (0161, ruled 8 Oct 2026, #4–#5) — the excluded-site invariant, the sibling of the archived-site one
 * (`siteArchiveGuard.ts`): no write may land a site the job has left out on a row or record of that job, unless the row or
 * record already cites it. In v1 that last case cannot arise — a site in use cannot be excluded (`SITE_IN_USE`) — but the
 * comparison keeps the archived guard's current-versus-target shape, so an edit that leaves the site alone never trips it.
 *
 * **Atomic by a shared lock on the job row.** `job.site.setInclusion` takes the job row `FOR UPDATE` before it counts what
 * uses the site; every site-setting write takes it `FOR SHARE` here before reading the inclusion. Writers do not block each
 * other, only an inclusion change, and the change waits for them — so a row cannot slip in between the count and the
 * exclusion, nor an exclusion between this check and the row's insert. The inclusion command locks no scope row, so there
 * is no lock-order cycle with portal acceptance, which locks the scope row first.
 */
export const SITE_EXCLUDED_MESSAGE = "That site is left out of this job — include it in the job's Sites to record against it.";

/**
 * Whether the job reports on the site, as a SQL boolean: the latest decision, true when none has been made. `jobExpr` and
 * `siteExpr` are SQL expressions (a column or a parameter); tenant isolation scopes the subquery.
 */
export const siteIncludedSql = (jobExpr: string, siteExpr: string): string =>
  `coalesce((SELECT i.included FROM nzi_console.job_site_inclusions i WHERE i.job_id=${jobExpr} AND i.site_id=${siteExpr} ORDER BY i.version DESC LIMIT 1), true)`;

/** The sites a job has left out — the latest decision for each (job, site) is an exclusion. */
export async function listExcludedSiteIds(db: Queryable, jobId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ site_id: string }>(
    `SELECT site_id FROM (SELECT DISTINCT ON (site_id) site_id, included FROM nzi_console.job_site_inclusions WHERE job_id=$1 ORDER BY site_id, version DESC) latest WHERE NOT included`,
    [jobId]);
  return new Set(rows.map((row) => row.site_id));
}

/**
 * Refuse a write that would move a row or record of `jobId` onto a site the job has left out. `currentSiteId` is what it
 * cites before this write (null for a new one). The caller says how a refusal is thrown, as for the archived guard.
 */
export async function refuseExcludedSiteChange(db: Queryable, organisationId: string, jobId: string, targetSiteId: string | null,
  currentSiteId: string | null, refusal: (message: string) => Error): Promise<void> {
  if (!targetSiteId || targetSiteId === currentSiteId) return;
  // The shared lock: held to the end of the writer's transaction, so an exclusion cannot land between here and its insert.
  await db.query(`SELECT 1 FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2 FOR SHARE`, [organisationId, jobId]);
  const { rows: [row] } = await db.query<{ included: boolean }>(`SELECT ${siteIncludedSql("$1", "$2")} AS included`, [jobId, targetSiteId]);
  if (row && row.included === false) throw refusal(SITE_EXCLUDED_MESSAGE);
}
