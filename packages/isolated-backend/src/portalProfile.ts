import {
  categoryShown, offeredPortalProfile, PORTAL_PROFILE_DEFAULT, PORTAL_PROFILE_KEYS, PORTAL_PROFILE_LABELS, PORTAL_PROFILE_VALUES, PORTAL_SCOPE_LABELS,
  PORTAL_SCOPES, resolvePortalProfile, type PortalDecisionRecord, type PortalOfferedProfile, type PortalProfile, type PortalProfileStaffView,
} from "@nzi/contracts";
import { assertCapabilityOnClient, type CapabilityHolder } from "./access";
import { listInputSpec } from "./inputSpecRecords";
import { withTenantRead, type PoolLike, type Queryable } from "./postgres";

/**
 * The effective portal profile for one client — the keystone the later phases consume (BUILD-portal-dataentry-phase1 §4).
 *
 * The org default (`PORTAL_PROFILE_DEFAULT`, in `@nzi/contracts`) overlaid with the client's active decisions (0176), plus
 * the scope and category registers composed by `categoryShown`. Two readers, as `categoryVisibility.ts` splits them:
 *
 * - **The portal** asks "what may I offer?" and gets `PortalOfferedProfile` and the categories it may show — absent means
 *   not offered, and nothing names, flags or counts what was withheld.
 * - **Staff** ask "why does this client see it differently?" and get, per key, scope and category, the default, the
 *   decision (who, when, note) and the effective result — for Portal Management and the staff preview (NZC-087).
 *
 * Phase 1 builds the read and wires it to Portal Management and the preview. The live portal surfaces adopt it in phase 2,
 * with the capture loop; until then they behave as before (category visibility already applies through
 * `listInputSpecForClient`).
 */

type DecisionRow = { decided_by: string; decided_by_name: string | null; decided_at: Date | string; note: string };
const record = <V>(row: DecisionRow, value: V): PortalDecisionRecord<V> => ({
  value, note: row.note, decidedBy: row.decided_by, decidedByName: row.decided_by_name,
  decidedAt: row.decided_at instanceof Date ? row.decided_at.toISOString() : String(row.decided_at),
});
const BY_NAME = `LEFT JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (d.organisation_id, d.decided_by)`;

async function profileDecisions(db: Queryable, clientId: string) {
  const { rows } = await db.query<DecisionRow & { profile_key: string; value: string }>(
    `SELECT d.profile_key, d.value, d.note, d.decided_by, nullif(btrim(m.display_name), '') AS decided_by_name, d.decided_at
       FROM nzi_console.client_portal_profile_decisions d ${BY_NAME}
      WHERE d.client_id=$1 AND d.active ORDER BY d.profile_key`, [clientId]);
  return rows;
}
async function scopeDecisions(db: Queryable, clientId: string) {
  const { rows } = await db.query<DecisionRow & { scope: string; visible: boolean }>(
    `SELECT d.scope, d.visible, d.note, d.decided_by, nullif(btrim(m.display_name), '') AS decided_by_name, d.decided_at
       FROM nzi_console.client_portal_scope_visibility d ${BY_NAME}
      WHERE d.client_id=$1 AND d.active ORDER BY d.scope`, [clientId]);
  return rows;
}
async function categoryDecisions(db: Queryable, clientId: string) {
  const { rows } = await db.query<DecisionRow & { category_code: string; visible: boolean }>(
    `SELECT d.category_code, d.visible, d.note, d.decided_by, nullif(btrim(m.display_name), '') AS decided_by_name, d.decided_at
       FROM nzi_console.client_category_visibility d ${BY_NAME}
      WHERE d.client_id=$1 AND d.active ORDER BY d.category_code`, [clientId]);
  return rows;
}

/** The default overlaid with this client's decisions. */
export async function effectivePortalProfile(db: Queryable, clientId: string): Promise<PortalProfile> {
  return resolvePortalProfile((await profileDecisions(db, clientId)).map((row) => ({ profileKey: row.profile_key, value: row.value })));
}

/**
 * The portal's reading: what it may offer, and the categories it may show (scope on AND category on). Nothing in it says
 * that anything was withheld.
 */
export async function portalFacingProfile(db: Queryable, clientId: string): Promise<{ profile: PortalOfferedProfile; categoryCodes: string[] }> {
  const [profile, spec, scopes, categories] = await Promise.all([effectivePortalProfile(db, clientId), listInputSpec(db), scopeDecisions(db, clientId), categoryDecisions(db, clientId)]);
  const hidden = {
    scopes: new Set(scopes.filter((row) => !row.visible).map((row) => row.scope)),
    categories: new Set(categories.filter((row) => !row.visible).map((row) => row.category_code)),
  };
  return { profile: offeredPortalProfile(profile), categoryCodes: spec.filter((category) => categoryShown(category, hidden)).map((category) => category.categoryCode) };
}

/**
 * Portal data-entry phase 2: the scope ∧ category gate as a predicate, for the reads and writes on the shared rows. A row's
 * category is its `category_code`, or its scope for a granular Scope 3 row; a row with no category (an older Scope 1/2 line)
 * is shown when its scope is. The same rule as `categoryShown`, from the same registers.
 */
export async function clientCategoryGate(db: Queryable, clientId: string): Promise<{ shows: (categoryCode: string | null, scope: string) => boolean }> {
  const [scopes, categories] = await Promise.all([scopeDecisions(db, clientId), categoryDecisions(db, clientId)]);
  const hidden = {
    scopes: new Set(scopes.filter((row) => !row.visible).map((row) => row.scope)),
    categories: new Set(categories.filter((row) => !row.visible).map((row) => row.category_code)),
  };
  return { shows: (categoryCode, scope) => categoryShown({ categoryCode: categoryCode ?? "", scope: scope.split(".")[0]! }, hidden) };
}

/**
 * The staff reading, unguarded: callers check their own capability first (Portal Management: `portal.admin`; the preview:
 * `support.portal_impersonate`), each on this client, inside its own transaction.
 */
export async function portalProfileStaffView(db: Queryable, clientId: string): Promise<PortalProfileStaffView> {
  const [profileRows, spec, scopeRows, categoryRows] = await Promise.all([profileDecisions(db, clientId), listInputSpec(db), scopeDecisions(db, clientId), categoryDecisions(db, clientId)]);
  const effective = resolvePortalProfile(profileRows.map((row) => ({ profileKey: row.profile_key, value: row.value })));
  const profileByKey = new Map(profileRows.map((row) => [row.profile_key, row]));
  const scopeByKey = new Map(scopeRows.map((row) => [row.scope, row]));
  const categoryByCode = new Map(categoryRows.map((row) => [row.category_code, row]));
  const hidden = {
    scopes: new Set(scopeRows.filter((row) => !row.visible).map((row) => row.scope)),
    categories: new Set(categoryRows.filter((row) => !row.visible).map((row) => row.category_code)),
  };
  return {
    clientId,
    profile: PORTAL_PROFILE_KEYS.map((key) => {
      const row = profileByKey.get(key);
      return {
        key, ...PORTAL_PROFILE_LABELS[key], values: PORTAL_PROFILE_VALUES[key],
        defaultValue: PORTAL_PROFILE_DEFAULT[key], effectiveValue: effective[key],
        decision: row ? record(row, row.value) : null,
      };
    }),
    scopes: PORTAL_SCOPES.map((scope) => {
      const row = scopeByKey.get(scope);
      return {
        scope, label: PORTAL_SCOPE_LABELS[scope], effectiveVisible: !hidden.scopes.has(scope),
        decision: row ? record(row, row.visible) : null,
        categories: spec.filter((category) => category.scope === scope).map((category) => {
          const decision = categoryByCode.get(category.categoryCode);
          const shown = categoryShown(category, hidden);
          return {
            categoryCode: category.categoryCode, name: category.name, shown,
            hiddenBy: shown ? null : hidden.scopes.has(scope) ? "scope" as const : "category" as const,
            decision: decision ? record(decision, decision.visible) : null,
          };
        }),
      };
    }),
  };
}

/** Portal Management's read: `portal.admin` on this client (own clients for a consultant), resolved against the database. */
export async function getPortalProfileForStaff(pool: PoolLike, holder: CapabilityHolder, clientId: string): Promise<PortalProfileStaffView> {
  return withTenantRead(pool, holder.organisationId, async (db) => {
    await assertCapabilityOnClient(db, holder, "portal.admin", { clientId });
    return portalProfileStaffView(db, clientId);
  });
}
