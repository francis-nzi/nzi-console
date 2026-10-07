import type { Queryable } from "./postgres";

/**
 * The archived-site invariant (#424 and its siblings, ruled 6–7 Oct): no write on any path may land an archived site on a
 * row or record unless that row or record already cites it. One comparison, shared by every write that sets a site —
 * the console's scope-row create and update (`requireSiteForJob`), and the portal's record create, record update and
 * acceptance onto the scope row.
 *
 * `currentSiteId` is what the row or record cites before this write — null for a new one, the stored site (read in the
 * same transaction) otherwise; for acceptance, the scope row's. The caller says how a refusal is thrown, because the
 * console's commands and the portal's writes report validation differently; the database and organisation are explicit,
 * because the portal writes run in `withTenantWrite`, not the command runner.
 */
export const SITE_ARCHIVED_MESSAGE = "That site is archived — unarchive it to record against it.";

export async function refuseArchivedSiteChange(db: Queryable, organisationId: string, targetSiteId: string | null, currentSiteId: string | null,
  refusal: (message: string) => Error): Promise<void> {
  if (!targetSiteId || targetSiteId === currentSiteId) return;
  const { rows: [site] } = await db.query<{ archived: boolean }>(
    `SELECT archived FROM nzi_console.client_sites WHERE organisation_id = $1 AND site_id = $2`, [organisationId, targetSiteId]);
  if (site?.archived) throw refusal(SITE_ARCHIVED_MESSAGE);
}
