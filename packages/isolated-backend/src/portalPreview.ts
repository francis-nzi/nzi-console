import { randomUUID } from "node:crypto";
import { requireCapability, type StaffPrincipal } from "./auth";
import { assertCapabilityOnClient } from "./access";
import { getPortalClientStrategies, type PortalStrategiesReadModel } from "./portalStrategies";
import { getPortalClientReadiness, type PortalReadinessReadModel } from "./portalReadiness";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";

/**
 * Staff portal preview — what a client sees, from the staff member's own identity.
 *
 * ## Preview, not impersonation
 *
 * There is no portal session here, no client principal, and nothing a client could later be
 * shown as having done. The staff member reads the client's portal surfaces **as themselves**,
 * and the audit says so: `portal.preview.open`, actor = the staff user, subject = the client.
 *
 * The distinction is not pedantry. Impersonation makes the audit trail lie — an action recorded
 * against a client who was not at their desk is worse than no record, because it looks like
 * evidence. A preview leaves a trail that says what actually happened: a named member of staff
 * looked.
 *
 * ## The capability was already there
 *
 * This is gated on **`support.portal_impersonate`**, which the matrix has carried since v1 and
 * describes as "enter a client's portal context … a read/preview context, never portal-user
 * credential access". That is this feature, written down before it was built — it was declared
 * and never enforced, waiting for something to enforce it.
 *
 * So no `portal.preview` capability was added and the matrix stays at v4. A second capability
 * would have split one concept in two, and the older name would have been left meaning nothing
 * while the newer one did its job — the exact overlap the brief warned against.
 *
 * Admin and Consultant hold it at scope `all`, which is the same scope they hold `client.view`
 * at: a consultant can already open any client in the organisation from the staff console. The
 * preview therefore grants **no new data reach**, which is the property that matters. Reviewer,
 * Finance and Viewer do not hold it and do not see the entry point.
 *
 * ## One read path
 *
 * The plan and readiness come from `getPortalClientStrategies` and `getPortalClientReadiness` —
 * the same resolvers the client's own portal routes call, not a staff-side copy of them. Every
 * rule they carry therefore applies here by construction rather than by imitation:
 * `include_in_report` filtering, withdrawn strategies excluded, draft assessments withheld,
 * as-at and provenance intact. A second path would be free to diverge, and the first time it did
 * a consultant would be reassuring a client about something the client cannot see.
 */

export type PortalPreviewReadModel = {
  client: { id: string; name: string };
  strategies: PortalStrategiesReadModel;
  readiness: PortalReadinessReadModel;
  /** Stamped server-side so the banner cannot be dated by a staff member's device clock. */
  previewedAt: string;
};

export async function getPortalPreview(
  pool: PoolLike,
  principal: StaffPrincipal,
  input: { clientId: string; today: string },
  now = new Date(),
): Promise<PortalPreviewReadModel> {
  // Held at all, before anything is read.
  requireCapability(principal, "support.portal_impersonate");

  // A write transaction because the open is audited. The reads inside it are the portal's own.
  return withTenantWrite(pool, principal.organisationId, async (db: Queryable) => {
    // Tenant and own-client scope, resolved against the database rather than trusted from the
    // request — the same check every client-subject command makes.
    await assertCapabilityOnClient(db, principal, "support.portal_impersonate", { clientId: input.clientId });

    const client = await db.query<{ client_id: string; name: string }>(
      `SELECT client_id, name FROM nzi_console.clients WHERE organisation_id=$1 AND client_id=$2`,
      [principal.organisationId, input.clientId]);
    const found = client.rows[0];
    if (!found) throw new PortalPreviewError("That client is unavailable.");

    const strategies = await getPortalClientStrategies(db, { clientId: input.clientId, today: input.today });
    const readiness = await getPortalClientReadiness(db, { clientId: input.clientId });

    // Audited on open, not per fetch: the event a reviewer wants is "who looked at this client's
    // portal, and when", and one row per surface would bury that in noise.
    const auditEventId = `audit-${randomUUID()}`;
    await db.query(
      `INSERT INTO nzi_console.audit_events
        (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, after_json, client_id)
       VALUES ($1,$2,$3,'staff','portal.preview.open','client',$4,$2,$5::jsonb,$4)`,
      [principal.organisationId, auditEventId, principal.userId, input.clientId,
        JSON.stringify({ clientId: input.clientId, clientName: found.name, readOnly: true, impersonated: false })]);

    return {
      client: { id: found.client_id, name: found.name },
      strategies, readiness,
      previewedAt: now.toISOString(),
    };
  });
}

export class PortalPreviewError extends Error {
  constructor(message = "That client is unavailable.") {
    super(message);
    this.name = "PortalPreviewError";
  }
}
