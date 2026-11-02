import { randomUUID } from "node:crypto";
import {
  portalClientAccessDefaults, type CommandContext, type CommandInputMap, type PortalAccessDecision, type PortalAccessField, type PortalClientAccess, type PortalClientAccessView,
  type PortalLoginEventRecord, type PortalPaymentStatus,
} from "@nzi/contracts";
import { assertCapabilityOnClient, type CapabilityHolder } from "./access";
import { VersionConflictError } from "./errors";
import { withTenantRead, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

/**
 * Portal Management → Access (RULING-portal-access-model): one record per client — absent means the defaults — with an append-only
 * decision log, and the enforcement that makes the switch real the moment it exists.
 *
 * ## One save, one transaction
 * `client.portal.access.set` takes the changes the tab made, applies only what actually differs, writes the record (version-checked),
 * one decision per changed field (who, from, to, when, why), and — when the save switches the client off or sets an expiry that has
 * already passed — ends every live session of the client through the confined `revoke_client_portal_sessions`, in the same
 * transaction. The record is never "saved but inert": login, MFA completion and every request of a live session read it
 * (`login.ts`, `auth.ts`), so the effect does not depend on the sweep.
 *
 * ## What is enforced and what is not
 * `enabled` and `expires_at` only — and the auth role can read nothing else of the record. The user cap never blocks an invitation;
 * trained, payment and notes are informational and staff-only.
 */
type AccessRow = {
  enabled: boolean; trained: boolean; expires_at: Date | string | null; user_cap: number | null; payment_status: PortalPaymentStatus | null; payment_ref: string | null;
  notes: string; version: number; updated_by: string; updated_at: Date | string;
};
const iso = (value: Date | string | null): string | null => (value ? new Date(value).toISOString() : null);

function toAccess(clientId: string, row: AccessRow | undefined): PortalClientAccess {
  if (!row) return portalClientAccessDefaults(clientId);
  return { clientId, enabled: row.enabled, trained: row.trained, expiresAt: iso(row.expires_at), userCap: row.user_cap, paymentStatus: row.payment_status, paymentRef: row.payment_ref, notes: row.notes, version: row.version, updatedBy: row.updated_by, updatedAt: iso(row.updated_at) };
}

const FIELD_OF: Record<keyof NonNullable<CommandInputMap["client.portal.access.set"]["changes"]>, PortalAccessField> = {
  enabled: "enabled", trained: "trained", expiresAt: "expires_at", userCap: "user_cap", paymentStatus: "payment_status", paymentRef: "payment_ref", notes: "notes",
};
const refuse = (field: string, code: string, message: string) => new CommandValidationError([{ field, code, message }]);

export function setClientPortalAccess(pool: PoolLike, input: CommandInputMap["client.portal.access.set"], context: CommandContext): Promise<StoredOutcome<{ clientId: string; version: number; changed: PortalAccessField[]; sessionsEnded: number; enabled: boolean; expiresAt: string | null }>> {
  return runPostgresCommand(pool, "client.portal.access.set", input, context, async (db) => {
    const client = await db.query(`SELECT 1 FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [context.organisationId, input.clientId]);
    if (!client.rows[0]) throw refuse("clientId", "NOT_FOUND", "Client was not found.");
    const row = (await db.query<AccessRow>(
      `SELECT enabled,trained,expires_at,user_cap,payment_status,payment_ref,notes,version,updated_by,updated_at FROM nzi_console.client_portal_access WHERE organisation_id = $1 AND client_id = $2 FOR UPDATE`,
      [context.organisationId, input.clientId])).rows[0];
    if (row ? input.expectedVersion !== row.version : input.expectedVersion !== null) throw new VersionConflictError(input.expectedVersion ?? 0, row?.version ?? 0);
    const before = toAccess(input.clientId, row);

    // The next value of every field the save names, normalised, and which of them really differ.
    const next = { ...before };
    const changes = input.changes;
    if (changes.enabled !== undefined) next.enabled = changes.enabled;
    if (changes.trained !== undefined) next.trained = changes.trained;
    if (changes.expiresAt !== undefined) next.expiresAt = changes.expiresAt === null ? null : new Date(changes.expiresAt).toISOString();
    if (changes.userCap !== undefined) next.userCap = changes.userCap;
    if (changes.paymentStatus !== undefined) next.paymentStatus = changes.paymentStatus;
    if (changes.paymentRef !== undefined) next.paymentRef = changes.paymentRef === null || changes.paymentRef.trim() === "" ? null : changes.paymentRef.trim();
    if (changes.notes !== undefined) next.notes = changes.notes.trim();
    const differing = (Object.keys(FIELD_OF) as Array<keyof typeof FIELD_OF>).filter((key) => key in changes && JSON.stringify(valueOf(before, key)) !== JSON.stringify(valueOf(next, key)));
    if (differing.length === 0) throw refuse("changes", "NO_CHANGE", "Nothing changed.");

    const version = (row?.version ?? 0) + 1;
    await db.query(
      `INSERT INTO nzi_console.client_portal_access (organisation_id,client_id,enabled,trained,expires_at,user_cap,payment_status,payment_ref,notes,version,updated_by,updated_at)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8,$9,$10,$11,now())
       ON CONFLICT (organisation_id,client_id) DO UPDATE SET enabled=$3,trained=$4,expires_at=$5::timestamptz,user_cap=$6,payment_status=$7,payment_ref=$8,notes=$9,version=$10,updated_by=$11,updated_at=now()`,
      [context.organisationId, input.clientId, next.enabled, next.trained, next.expiresAt, next.userCap, next.paymentStatus, next.paymentRef, next.notes, version, context.actorId]);
    const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
    for (const key of differing) {
      await db.query(
        `INSERT INTO nzi_console.client_portal_access_decisions (organisation_id,decision_id,client_id,field,from_json,to_json,note,changed_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
        [context.organisationId, randomUUID(), input.clientId, FIELD_OF[key], JSON.stringify(valueOf(before, key)), JSON.stringify(valueOf(next, key)), note, context.actorId]);
    }

    // Switching the client off, or setting an expiry that has already passed, ends its live sessions now (the per-request check would
    // also refuse them on the next request; this makes it visible in the sessions themselves).
    const cutsOff = (differing.includes("enabled") && !next.enabled) || (differing.includes("expiresAt") && next.expiresAt !== null && Date.parse(next.expiresAt) <= Date.now());
    const sessionsEnded = cutsOff ? await endClientSessions(db, context.organisationId, input.clientId) : 0;
    return {
      data: { clientId: input.clientId, version, changed: differing.map((key) => FIELD_OF[key]), sessionsEnded, enabled: next.enabled, expiresAt: next.expiresAt },
      entityType: "client_portal_access", entityId: input.clientId, topic: "client.portal.access.set",
    };
  });
}

const valueOf = (access: PortalClientAccess, key: keyof typeof FIELD_OF): unknown => access[key];

async function endClientSessions(db: Queryable, organisationId: string, clientId: string): Promise<number> {
  return Number((await db.query<{ ended: number }>(`SELECT nzi_console.revoke_client_portal_sessions($1,$2,now()) AS ended`, [organisationId, clientId])).rows[0]!.ended);
}

const RECENT = 25;

/** The Access tab's read: the record (or the defaults), who can sign in, the decision log and the recent attempts — under portal.admin on this client. */
export function getClientPortalAccess(pool: PoolLike, holder: CapabilityHolder, clientId: string): Promise<PortalClientAccessView> {
  return withTenantRead(pool, holder.organisationId, async (db) => {
    await assertCapabilityOnClient(db, holder, "portal.admin", { clientId });
    const row = (await db.query<AccessRow>(
      `SELECT enabled,trained,expires_at,user_cap,payment_status,payment_ref,notes,version,updated_by,updated_at FROM nzi_console.client_portal_access WHERE organisation_id = $1 AND client_id = $2`, [holder.organisationId, clientId])).rows[0];
    const active = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM nzi_console.portal_users WHERE organisation_id = $1 AND client_id = $2 AND status = 'active'`, [holder.organisationId, clientId]);
    const decisions = (await db.query<{ decision_id: string; field: PortalAccessField; from_json: unknown; to_json: unknown; note: string | null; changed_by: string; changed_at: Date | string; name: string | null }>(
      `SELECT d.decision_id,d.field,d.from_json,d.to_json,d.note,d.changed_by,d.changed_at,m.display_name AS name
         FROM nzi_console.client_portal_access_decisions d LEFT JOIN nzi_console.memberships m ON (m.organisation_id,m.user_id)=(d.organisation_id,d.changed_by)
        WHERE d.organisation_id = $1 AND d.client_id = $2 ORDER BY d.changed_at DESC, d.decision_id LIMIT ${RECENT}`, [holder.organisationId, clientId])).rows
      .map((d): PortalAccessDecision => ({ decisionId: d.decision_id, field: d.field, from: d.from_json, to: d.to_json, note: d.note, changedBy: d.changed_by, changedByName: d.name, changedAt: iso(d.changed_at)! }));
    const events = (await db.query<{ event_id: string; occurred_at: Date | string; outcome: PortalLoginEventRecord["outcome"]; portal_user_id: string | null; display_name: string | null; ip: string | null; user_agent: string | null }>(
      `SELECT e.event_id,e.occurred_at,e.outcome,e.portal_user_id,u.display_name,e.ip,e.user_agent
         FROM nzi_console.portal_login_events e LEFT JOIN nzi_console.portal_users u ON (u.organisation_id,u.portal_user_id)=(e.organisation_id,e.portal_user_id)
        WHERE e.organisation_id = $1 AND e.client_id = $2 ORDER BY e.occurred_at DESC, e.event_id LIMIT ${RECENT}`, [holder.organisationId, clientId])).rows
      .map((e): PortalLoginEventRecord => ({ eventId: e.event_id, occurredAt: iso(e.occurred_at)!, outcome: e.outcome, portalUserId: e.portal_user_id, userName: e.display_name, ip: e.ip, userAgent: e.user_agent }));
    return { access: toAccess(clientId, row), activeUsers: Number(active.rows[0]!.n), decisions, loginEvents: events };
  });
}
