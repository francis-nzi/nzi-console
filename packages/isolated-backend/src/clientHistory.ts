import type { CapabilityGrant } from "@nzi/contracts";
import { AuthorizationError } from "./auth";
import type { Queryable } from "./postgres";

/**
 * A client's history (CLIENT-12): the audit events about one client, newest first — every command that wrote to the
 * client, its sites, contacts, targets, strategies and jobs (0066 stamps `audit_events.client_id` on each).
 *
 * Read under audit.view (PERMISSION_MATRIX.md), the same rule as the organisation-wide trail (`auditEventsFor`):
 * - **none** — refused (`AuthorizationError`), so a route answers 403 and the panel is not offered;
 * - **own_clients** — this client's history only if the holder owns it, refused otherwise;
 * - **all** — any client's.
 *
 * `null` when there is no such client in the tenant, so a route answers 404 rather than an empty history.
 */
export type ClientHistoryEntry = {
  id: string; at: string; actorId: string; actorLabel: string | null; action: string;
  entity: string; entityId: string; correlationId: string; reason: string | null; before: unknown; after: unknown;
};

export const CLIENT_HISTORY_LIMIT = 100;

export async function clientHistoryFor(db: Queryable, holder: { userId: string; capabilities: readonly CapabilityGrant[] }, clientId: string,
  limit = CLIENT_HISTORY_LIMIT): Promise<ClientHistoryEntry[] | null> {
  const scope = holder.capabilities.find((grant) => grant.capability === "audit.view")?.scope;
  if (!scope) throw new AuthorizationError("audit.view", "Your role does not include reading the audit history.");
  const { rows: [client] } = await db.query<{ owner_user_id: string | null }>(`SELECT owner_user_id FROM nzi_console.clients WHERE client_id = $1`, [clientId]);
  if (!client) return null;
  if (scope === "own_clients" && client.owner_user_id !== holder.userId) throw new AuthorizationError("audit.view", "Your role shows the history of your own clients only.");
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 250);
  const { rows } = await db.query<{
    audit_event_id: string; occurred_at: Date | string; actor_id: string; actor_name: string | null; action: string; entity_type: string; entity_id: string;
    correlation_id: string; reason: string | null; before_json: unknown; after_json: unknown;
  }>(
    `SELECT a.audit_event_id, a.occurred_at, a.actor_id, nullif(btrim(m.display_name), '') AS actor_name, a.action, a.entity_type, a.entity_id,
            a.correlation_id, a.reason, a.before_json, a.after_json
       FROM nzi_console.audit_events a
       LEFT JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (a.organisation_id, a.actor_id)
      WHERE a.client_id = $1
      ORDER BY a.occurred_at DESC, a.audit_event_id DESC
      LIMIT $2`, [clientId, safeLimit]);
  return rows.map((row) => ({
    id: row.audit_event_id, at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
    actorId: row.actor_id, actorLabel: row.actor_name, action: row.action, entity: row.entity_type, entityId: row.entity_id,
    correlationId: row.correlation_id, reason: row.reason, before: row.before_json ?? null, after: row.after_json ?? null,
  }));
}
