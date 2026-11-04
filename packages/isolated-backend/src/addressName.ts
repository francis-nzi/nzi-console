import type { Queryable } from "./postgres";

/**
 * How a person is addressed, resolved in SQL (0207).
 *
 * The rule — first name to address a person, full name to record who did something — is one in `@nzi/contracts`
 * (`callName`). These are the same rule where the name is read in a query rather than held in an object, so a notification
 * scan, a password reset and an invitation cannot each invent their own way of finding the first word of a name.
 *
 * Both fragments answer null only when the person has no name at all; an email then says "there" (`FIRST_NAME_FALLBACK`).
 */

/** A member of staff: the first name held, else the first word of their name. `alias` is the `memberships` alias. */
export const staffFirstNameSql = (alias: string) =>
  `coalesce(nullif(btrim(${alias}.first_name), ''), substring(btrim(${alias}.display_name) from '^\\S+'))`;

/**
 * A client portal user: the first name of the active contact at their client with their address (the linked contact —
 * the primary one, should a client hold the address twice), else the first word of their own display name. `alias` is the
 * `portal_users` alias.
 */
export const portalUserFirstNameSql = (alias: string) =>
  `coalesce(
     (SELECT nullif(btrim(pc.first_name), '') FROM nzi_console.client_contacts pc
       WHERE pc.organisation_id = ${alias}.organisation_id AND pc.client_id = ${alias}.client_id AND pc.status = 'active'
         AND lower(pc.email) = ${alias}.email_normalized
       ORDER BY pc.is_primary DESC, pc.contact_id LIMIT 1),
     substring(btrim(${alias}.display_name) from '^\\S+'))`;

/** A member of staff's first name; null when they have no name (a chip says nobody, an email says "there"). */
export async function staffFirstName(db: Queryable, organisationId: string, userId: string): Promise<string | null> {
  const { rows: [row] } = await db.query<{ first_name: string | null }>(
    `SELECT ${staffFirstNameSql("m")} AS first_name FROM nzi_console.memberships m WHERE m.organisation_id = $1 AND m.user_id = $2`, [organisationId, userId]);
  return row?.first_name || null;
}

/** A portal user's first name; null when they have no name. */
export async function portalUserFirstName(db: Queryable, organisationId: string, portalUserId: string): Promise<string | null> {
  const { rows: [row] } = await db.query<{ first_name: string | null }>(
    `SELECT ${portalUserFirstNameSql("u")} AS first_name FROM nzi_console.portal_users u WHERE u.organisation_id = $1 AND u.portal_user_id = $2`, [organisationId, portalUserId]);
  return row?.first_name || null;
}
