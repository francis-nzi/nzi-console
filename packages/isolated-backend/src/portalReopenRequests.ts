import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import { requireShownCategory } from "./portalCapture";
import { sendTemplatedEmail } from "./templatedEmail";
import type { Queryable, PoolLike } from "./postgres";

/**
 * Data entry D3 (R6) — reopen after submit is a request, through the messaging system (0195, `scope_row_reopen_requests`).
 *
 * A client changes their own portal entry while it waits for review. Once it is reviewed it is the CRM's: the client cannot recall
 * it themselves. They ask — with a reason — and the request is recorded on the entry and sent to the CRM as a message (the
 * `portal.data.reopen-request` template, through `sendTemplatedEmail`: the outbox, the isolation gate, the organisation's wording).
 * The CRM reopens by editing the entry, which returns it to pending (`scopeRowUpdateHandler`) and marks the request `reopened`.
 * Both are audited: the request by this command, the reopen by the edit's own audit event, which names the request.
 */

export const ENTRY_STILL_EDITABLE = "ENTRY_STILL_EDITABLE";
export const ENTRY_NOT_REOPENABLE = "ENTRY_NOT_REOPENABLE";
export const REOPEN_ALREADY_REQUESTED = "REOPEN_ALREADY_REQUESTED";
export const REOPEN_REQUEST_TEMPLATE = "portal.data.reopen-request";

export type ReopenRequestResult = { requestId: string; notified: boolean };

type RowForRequest = {
  scope: string; category_code: string | null; review_status: string; enabled: boolean; origin: string; captured_as: string | null; version: number;
  label: string; job_number: string; client_name: string; crm_user_id: string | null;
};

/**
 * The client asks the CRM to reopen a reviewed entry. `consoleOrigin` is the console's own origin, from the request the route
 * serves — never from the request body — for the job link in the message.
 */
export function requestScopeRowReopen(pool: PoolLike, input: CommandInputMap["portal.scope.row.reopen.request"], context: CommandContext, consoleOrigin: string | null): Promise<StoredOutcome<ReopenRequestResult>> {
  return runPostgresCommand(pool, "portal.scope.row.reopen.request", input, context, async (db) => {
    const row = (await db.query<RowForRequest>(
      `SELECT r.scope,r.category_code,r.review_status,r.enabled,r.origin,r.provenance_json->>'capturedAs' AS captured_as,r.version,
              coalesce(nullif(btrim(r.report_label),''),r.source_label) AS label,j.job_number,c.name AS client_name,
              coalesce(j.client_manager_user_id,c.client_manager_user_id,c.owner_user_id) AS crm_user_id
         FROM nzi_console.job_scope_rows r
         JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(r.organisation_id,r.job_id)
         JOIN nzi_console.clients c ON (c.organisation_id,c.client_id)=(j.organisation_id,j.client_id)
        WHERE r.organisation_id=$1 AND r.job_id=$2 AND r.scope_row_id=$3 FOR UPDATE OF r`,
      [context.organisationId, input.jobId, input.rowId])).rows[0];
    if (!row) throw new CommandValidationError([{ field: "rowId", code: "NOT_FOUND", message: "That entry was not found." }]);
    await requireShownCategory(db, context.portal!.clientId, { categoryCode: row.category_code, scope: row.scope });
    if (row.origin !== "live" || row.captured_as !== "client-portal" || !row.enabled) {
      throw new CommandValidationError([{ field: "rowId", code: ENTRY_NOT_REOPENABLE, message: "Only an entry made in the portal can be reopened this way. Ask your adviser about this one." }]);
    }
    if (row.review_status === "pending") {
      throw new CommandValidationError([{ field: "rowId", code: ENTRY_STILL_EDITABLE, message: "This entry hasn't been reviewed yet, so you can still change it yourself." }]);
    }
    if (row.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, row.version);
    const open = await db.query(`SELECT 1 FROM nzi_console.scope_row_reopen_requests WHERE organisation_id=$1 AND scope_row_id=$2 AND status='open'`, [context.organisationId, input.rowId]);
    if (open.rows[0]) throw new CommandValidationError([{ field: "rowId", code: REOPEN_ALREADY_REQUESTED, message: "You have already asked for this entry to be reopened. Your adviser has the request." }]);

    const requestId = randomUUID();
    const emailMessageId = await notifyCrm(db, context, { requestId, jobId: input.jobId, row, consoleOrigin });
    // The insert is the request; the unique open index holds one per entry against a concurrent second ask.
    await db.query(
      `INSERT INTO nzi_console.scope_row_reopen_requests (organisation_id,request_id,job_id,scope_row_id,row_version,portal_user_id,reason,email_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [context.organisationId, requestId, input.jobId, input.rowId, row.version, context.actorId, input.reason.trim(), emailMessageId]);
    return { data: { requestId, notified: emailMessageId !== null }, entityType: "scope_row", entityId: input.rowId, topic: "portal.scope.row.reopen.requested" };
  });
}

/**
 * The message to the CRM, queued in the command's transaction (so a refused request sends nothing). No CRM with an email, or no
 * origin to link to: nothing is sent and the request still stands — the job shows it either way.
 */
async function notifyCrm(db: Queryable, context: CommandContext, input: { requestId: string; jobId: string; row: RowForRequest; consoleOrigin: string | null }): Promise<string | null> {
  if (!input.row.crm_user_id || !input.consoleOrigin) return null;
  const crm = (await db.query<{ email: string | null; display_name: string | null }>(
    `SELECT email,display_name FROM nzi_console.memberships WHERE organisation_id=$1 AND user_id=$2 AND status='active'`,
    [context.organisationId, input.row.crm_user_id])).rows[0];
  if (!crm?.email) return null;
  const requester = (await db.query<{ display_name: string }>(
    `SELECT display_name FROM nzi_console.portal_users WHERE organisation_id=$1 AND portal_user_id=$2`, [context.organisationId, context.actorId])).rows[0];
  const queued = await sendTemplatedEmail(db, context.organisationId, {
    templateCode: REOPEN_REQUEST_TEMPLATE, to: crm.email, consoleOrigin: input.consoleOrigin,
    vars: {
      firstName: crm.display_name?.trim().split(/\s+/)[0] || "there",
      clientName: input.row.client_name, jobNumber: input.row.job_number, entryLabel: input.row.label,
      requestedBy: requester?.display_name?.trim() || "Your client",
      jobLink: `${input.consoleOrigin.replace(/\/+$/, "")}/jobs/${encodeURIComponent(input.jobId)}`,
    },
    correlationId: input.requestId, idempotencyKey: `${REOPEN_REQUEST_TEMPLATE}:${input.requestId}`,
  });
  return queued.emailMessageId;
}

/**
 * The CRM's reopen: called by the staff edit of an entry (`scopeRowUpdateHandler`), in its transaction. An open request on the
 * entry is marked `reopened` by the editor; returns its id, so the edit's audit names the request it answered.
 */
export async function resolveReopenRequestOnEdit(db: Queryable, context: CommandContext, rowId: string): Promise<string | null> {
  if (context.principal !== "staff") return null;
  const { rows } = await db.query<{ request_id: string }>(
    `UPDATE nzi_console.scope_row_reopen_requests SET status='reopened',resolved_by=$3,resolved_at=now()
      WHERE organisation_id=$1 AND scope_row_id=$2 AND status='open' RETURNING request_id`,
    [context.organisationId, rowId, context.actorId]);
  return rows[0]?.request_id ?? null;
}

export type OpenReopenRequest = { requestId: string; rowId: string; rowLabel: string; reason: string; requestedBy: string; requestedAt: string; notified: boolean };

/** The job's open requests, for the CRM (staff read): which entry, why, who asked and when. */
export async function listOpenReopenRequests(db: Queryable, jobId: string): Promise<OpenReopenRequest[]> {
  const { rows } = await db.query<{ request_id: string; scope_row_id: string; label: string; reason: string; requested_by: string; requested_at: Date | string; email_message_id: string | null }>(
    `SELECT q.request_id,q.scope_row_id,coalesce(nullif(btrim(r.report_label),''),r.source_label) AS label,q.reason,
            coalesce(nullif(btrim(u.display_name),''),'The client') AS requested_by,q.requested_at,q.email_message_id
       FROM nzi_console.scope_row_reopen_requests q
       JOIN nzi_console.job_scope_rows r ON (r.organisation_id,r.scope_row_id)=(q.organisation_id,q.scope_row_id)
       JOIN nzi_console.portal_users u ON (u.organisation_id,u.portal_user_id)=(q.organisation_id,q.portal_user_id)
      WHERE q.job_id=$1 AND q.status='open'
      ORDER BY q.requested_at,q.request_id`,
    [jobId]);
  return rows.map((row) => ({
    requestId: row.request_id, rowId: row.scope_row_id, rowLabel: row.label, reason: row.reason, requestedBy: row.requested_by,
    requestedAt: row.requested_at instanceof Date ? row.requested_at.toISOString() : String(row.requested_at), notified: row.email_message_id !== null,
  }));
}

/** For the client's Data view: when each of the job's entries was asked to be reopened, while the request is open. */
export async function openReopenRequestsByRow(db: Queryable, jobId: string): Promise<Map<string, string>> {
  const { rows } = await db.query<{ scope_row_id: string; requested_at: Date | string }>(
    `SELECT scope_row_id,requested_at FROM nzi_console.scope_row_reopen_requests WHERE job_id=$1 AND status='open'`, [jobId]);
  return new Map(rows.map((row) => [row.scope_row_id, row.requested_at instanceof Date ? row.requested_at.toISOString() : String(row.requested_at)]));
}
