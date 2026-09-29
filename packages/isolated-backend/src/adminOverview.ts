import type { Queryable } from "./postgres";

/**
 * The admin overview (admin Phase A1; docs/design/admin-prototype.html): real configuration figures, the imported
 * clients' links to the lookups they name, and the recent admin changes from the audit log. Read-only, and read
 * under the caller's tenant — every figure is the organisation's own.
 */

export type AdminLookupCategory = { key: string; label: string; active: number; inactive: number };
export type AdminClientLink = {
  key: "industry" | "referral" | "manager";
  label: string;
  /** Pointing at a lookup value (or, for the manager, a member of the team). */
  linked: number;
  /** Carrying text that names one, but not yet linked — what the Phase A4 backfill addresses. */
  unlinked: number;
  /** Carrying nothing to link. */
  none: number;
};
export type AdminChange = {
  id: string; at: string; actorId: string; actorLabel: string | null; action: string;
  entity: string; entityId: string; correlationId: string; reason: string | null; before: unknown; after: unknown;
};
export type AdminOverview = {
  lookups: { categories: number; values: number; active: number; added: number; perCategory: AdminLookupCategory[] };
  clients: number;
  links: AdminClientLink[];
  /** Null when the viewer's role does not include the whole audit log — said so, never shown as "no changes". */
  recentChanges: AdminChange[] | null;
};

/**
 * The audit actions that are administration: configuration and lookups, the team and its roles, the curated
 * catalogues, and the operator loads that fill them. Client and job imports are data, not configuration, and are
 * not listed. Prefixes, matched with LIKE.
 */
export const ADMIN_AUDIT_ACTIONS = [
  "reference.%", "team.%", "staff.role.%", "staff.invite%", "staff.enrolment.issue", "staff.enrolment.revoke",
  "strategy.library.%", "factor.variant.%", "milestones.imported",
] as const;

export async function getAdminOverview(db: Queryable, options: { includeChanges: boolean; changeLimit?: number }): Promise<AdminOverview> {
  const { rows: categories } = await db.query<{ key: string; label: string; active: string; inactive: string; added: string }>(
    `SELECT rc.category_key AS key, rc.label,
            count(rv.value_id) FILTER (WHERE rv.active)::text AS active,
            count(rv.value_id) FILTER (WHERE NOT rv.active)::text AS inactive,
            count(rv.value_id) FILTER (WHERE rv.source = 'admin')::text AS added
       FROM nzi_console.reference_categories rc
       LEFT JOIN nzi_console.reference_values rv ON rv.category_key = rc.category_key
      WHERE rc.active
      GROUP BY rc.category_key, rc.label
      ORDER BY lower(rc.label)`);
  const perCategory = categories.map((row) => ({ key: row.key, label: row.label, active: Number(row.active), inactive: Number(row.inactive) }));

  const { rows: [links] } = await db.query<Record<string, string>>(
    `SELECT count(*)::text AS clients,
            count(*) FILTER (WHERE sector_value_id IS NOT NULL)::text AS industry_linked,
            count(*) FILTER (WHERE sector_value_id IS NULL AND nullif(btrim(sector), '') IS NOT NULL)::text AS industry_unlinked,
            count(*) FILTER (WHERE referral_value_id IS NOT NULL)::text AS referral_linked,
            count(*) FILTER (WHERE referral_value_id IS NULL AND nullif(btrim(referral), '') IS NOT NULL)::text AS referral_unlinked,
            count(*) FILTER (WHERE client_manager_user_id IS NOT NULL)::text AS manager_linked,
            count(*) FILTER (WHERE client_manager_user_id IS NULL AND nullif(btrim(client_manager), '') IS NOT NULL)::text AS manager_unlinked
       FROM nzi_console.clients`);
  const clients = Number(links?.clients ?? 0);
  const link = (key: AdminClientLink["key"], label: string): AdminClientLink => {
    const linked = Number(links?.[`${key}_linked`] ?? 0), unlinked = Number(links?.[`${key}_unlinked`] ?? 0);
    return { key, label, linked, unlinked, none: clients - linked - unlinked };
  };

  let recentChanges: AdminChange[] | null = null;
  if (options.includeChanges) {
    const limit = Math.min(Math.max(Math.trunc(options.changeLimit ?? 8), 1), 50);
    const { rows } = await db.query<{
      audit_event_id: string; occurred_at: Date | string; actor_id: string; actor_label: string | null; action: string; entity_type: string;
      entity_id: string; correlation_id: string; reason: string | null; before_json: unknown; after_json: unknown;
    }>(
      `SELECT a.audit_event_id, a.occurred_at, a.actor_id, m.display_name AS actor_label, a.action, a.entity_type, a.entity_id,
              a.correlation_id, a.reason, a.before_json, a.after_json
         FROM nzi_console.audit_events a
         LEFT JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (a.organisation_id, a.actor_id)
        WHERE a.action LIKE ANY($1::text[])
        ORDER BY a.occurred_at DESC, a.audit_event_id DESC
        LIMIT $2`, [ADMIN_AUDIT_ACTIONS, limit]);
    recentChanges = rows.map((row) => ({
      id: row.audit_event_id, at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
      actorId: row.actor_id, actorLabel: row.actor_label, action: row.action, entity: row.entity_type, entityId: row.entity_id,
      correlationId: row.correlation_id, reason: row.reason, before: row.before_json ?? null, after: row.after_json ?? null,
    }));
  }

  return {
    lookups: {
      categories: perCategory.length,
      values: perCategory.reduce((sum, category) => sum + category.active + category.inactive, 0),
      active: perCategory.reduce((sum, category) => sum + category.active, 0),
      added: categories.reduce((sum, row) => sum + Number(row.added), 0),
      perCategory,
    },
    clients,
    links: [link("industry", "Industry"), link("referral", "Referral"), link("manager", "Client manager")],
    recentChanges,
  };
}
