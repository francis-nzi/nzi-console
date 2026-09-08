import { randomUUID } from "node:crypto";
import { portalActionLevers, type PortalActionTracker, type PortalTrackerAction } from "@nzi/contracts";
import type { PortalPrincipal } from "./auth";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { withTenantRead, withTenantWrite } from "./postgres";

export class PortalActionValidationError extends Error {
  constructor(message: string) { super(message); this.name = "PortalActionValidationError"; }
}

type Row = { action_id: string; lever_code: string; title: string; notes: string; progress_percent: number; version: number; updated_at: Date | string };
const map = (row: Row): PortalTrackerAction => ({ id: row.action_id, leverCode: row.lever_code, title: row.title, notes: row.notes, progressPercent: row.progress_percent, version: row.version, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at) });

async function requireGrant(db: Queryable, principal: PortalPrincipal, jobId: string): Promise<void> {
  const { rows } = await db.query(`SELECT 1 FROM nzi_console.portal_access_grants WHERE portal_user_id=$1 AND client_id=$2 AND job_id=$3 AND revoked_at IS NULL`, [principal.userId, principal.clientId, jobId]);
  if (!rows[0]) throw new PortalActionValidationError("This engagement is not available to your account.");
}

const clean = (input: { leverCode?: unknown; title?: unknown; notes?: unknown; progressPercent?: unknown }) => {
  const leverCode = typeof input.leverCode === "string" ? input.leverCode.trim() : "";
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";
  const progressPercent = input.progressPercent;
  if (!portalActionLevers.some((lever) => lever.code === leverCode)) throw new PortalActionValidationError("Choose one of the 24 Spheres of Influence levers.");
  if (!title || title.length > 240) throw new PortalActionValidationError("Enter an action title of no more than 240 characters.");
  if (notes.length > 4000) throw new PortalActionValidationError("Notes must be no more than 4,000 characters.");
  if (!Number.isInteger(progressPercent) || Number(progressPercent) < 0 || Number(progressPercent) > 100) throw new PortalActionValidationError("Progress must be a whole percentage from 0 to 100.");
  return { leverCode, title, notes, progressPercent: Number(progressPercent) };
};

export async function getPortalActionTracker(pool: PoolLike, principal: PortalPrincipal, jobId: string): Promise<PortalActionTracker> {
  return withTenantRead(pool, principal.organisationId, async (db) => {
    await requireGrant(db, principal, jobId);
    const { rows } = await db.query<Row>(`SELECT action_id,lever_code,title,notes,progress_percent,version,updated_at FROM nzi_console.portal_tracker_actions WHERE client_id=$1 AND job_id=$2 ORDER BY updated_at DESC,action_id`, [principal.clientId, jobId]);
    return { levers: portalActionLevers, actions: rows.map(map) };
  });
}

export async function createPortalTrackerAction(pool: PoolLike, principal: PortalPrincipal, jobId: string, input: Record<string, unknown>): Promise<PortalTrackerAction> {
  const value = clean(input), actionId = randomUUID(), now = new Date().toISOString();
  return withTenantWrite(pool, principal.organisationId, async (db) => {
    await requireGrant(db, principal, jobId);
    const { rows } = await db.query<Row>(`INSERT INTO nzi_console.portal_tracker_actions(organisation_id,action_id,client_id,job_id,lever_code,title,notes,progress_percent,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$10) RETURNING action_id,lever_code,title,notes,progress_percent,version,updated_at`, [principal.organisationId, actionId, principal.clientId, jobId, value.leverCode, value.title, value.notes, value.progressPercent, principal.userId, now]);
    await db.query(`INSERT INTO nzi_console.audit_events(organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,after_json) VALUES($1,$2,$3,'portal','portal.tracker.action.create','portal_tracker_action',$4,$2,jsonb_build_object('jobId',$5,'leverCode',$6,'progressPercent',$7))`, [principal.organisationId, `audit-${actionId}`, principal.userId, actionId, jobId, value.leverCode, value.progressPercent]);
    return map(rows[0]!);
  });
}

export async function updatePortalTrackerAction(pool: PoolLike, principal: PortalPrincipal, jobId: string, actionId: string, expectedVersion: number, input: Record<string, unknown>): Promise<PortalTrackerAction> {
  const value = clean(input), now = new Date().toISOString();
  return withTenantWrite(pool, principal.organisationId, async (db) => {
    await requireGrant(db, principal, jobId);
    const { rows } = await db.query<Row>(`UPDATE nzi_console.portal_tracker_actions SET lever_code=$5,title=$6,notes=$7,progress_percent=$8,version=version+1,updated_by=$9,updated_at=$10 WHERE action_id=$1 AND client_id=$2 AND job_id=$3 AND version=$4 RETURNING action_id,lever_code,title,notes,progress_percent,version,updated_at`, [actionId, principal.clientId, jobId, expectedVersion, value.leverCode, value.title, value.notes, value.progressPercent, principal.userId, now]);
    if (!rows[0]) throw new VersionConflictError();
    await db.query(`INSERT INTO nzi_console.audit_events(organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,after_json) VALUES($1,$2,$3,'portal','portal.tracker.action.update','portal_tracker_action',$4,$2,jsonb_build_object('jobId',$5,'leverCode',$6,'progressPercent',$7,'version',$8))`, [principal.organisationId, `audit-${randomUUID()}`, principal.userId, actionId, actionId, jobId, value.leverCode, value.progressPercent, rows[0].version]);
    return map(rows[0]);
  });
}

export async function deletePortalTrackerAction(pool: PoolLike, principal: PortalPrincipal, jobId: string, actionId: string, expectedVersion: number): Promise<{ actionId: string; deleted: true }> {
  if (!actionId.trim() || !Number.isInteger(expectedVersion) || expectedVersion < 1) throw new PortalActionValidationError("An action and its current version are required.");
  return withTenantWrite(pool, principal.organisationId, async (db) => {
    await requireGrant(db, principal, jobId);
    const { rows } = await db.query<{ action_id: string }>(`DELETE FROM nzi_console.portal_tracker_actions WHERE action_id=$1 AND client_id=$2 AND job_id=$3 AND version=$4 RETURNING action_id`, [actionId, principal.clientId, jobId, expectedVersion]);
    if (!rows[0]) throw new VersionConflictError();
    const auditId = randomUUID();
    await db.query(`INSERT INTO nzi_console.audit_events(organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,after_json) VALUES($1,$2,$3,'portal','portal.tracker.action.delete','portal_tracker_action',$4,$2,jsonb_build_object('jobId',$5))`, [principal.organisationId, `audit-${auditId}`, principal.userId, actionId, jobId]);
    return { actionId, deleted: true };
  });
}
