import { randomUUID } from "node:crypto";
import { FIRST_NAME_FALLBACK } from "@nzi/contracts";
import { portalUserFirstNameSql, staffFirstNameSql } from "./addressName";
import { EmailValidationError } from "./email";
import type { Queryable } from "./postgres";
import { sendTemplatedEmail, TemplatedEmailError } from "./templatedEmail";

/**
 * Notify-only email for conversation messages (RULING-portal-messages, M4). The portal stays the sole channel: the email says there is a new
 * message and links to it - never the message, its author or its subject.
 *
 *  - **Queue, don't send.** A message (the command, in its own transaction) calls {@link queueMessageNotification}: it opens - or joins - ONE pending
 *    row per thread and audience (0206) due `MESSAGE_NOTIFY_WINDOW_MINUTES` after the first message of a burst. Nothing is sent from a request.
 *  - **The worker's scan sends.** {@link scanMessageNotifications} (a part of the worker tick, like A3's due-date reminders) takes the rows whose
 *    window has passed, resolves the recipients *now* from the records that own them, renders `sendTemplatedEmail` and lets the existing email drain
 *    deliver (through the isolation gate). One email per recipient per burst: a flurry of messages is one email.
 *  - **Client side - consent-gated (NZC-076).** The recipients are the client's active portal users who can see the thread (client-wide, or a job they
 *    hold) and whose address is an ACTIVE contact of that client with `email_consent = 'granted'` - read fresh at send time, any refusal winning.
 *    No consent (unknown or declined) means no email; the count is recorded, the person is not named.
 *  - **Staff side - internal, not consent-gated.** The thread's owner, else the client's manager / owner (the CRM, as a reopen request is routed).
 *  - **Ids and counts only** in the ledger and the audit - no address, name or text.
 */

export const MESSAGE_NOTIFY_WINDOW_MINUTES = 10;
export const CLIENT_MESSAGE_TEMPLATE = "message.notification";
export const STAFF_MESSAGE_TEMPLATE = "portal.message.staff-notification";
/** Who the audit trail names for the scan: the worker, as a system principal. */
export const MESSAGE_NOTIFY_ACTOR = "worker:message-notifications";

export type NotifyAudience = "client" | "staff";

/**
 * A message has been written: open the thread's pending notification for the OTHER side - or join the one already open, whose window has not passed.
 * Run in the message's own transaction, so a refused message queues nothing and a recorded one always has its notification.
 */
export async function queueMessageNotification(db: Queryable, organisationId: string, thread: { thread_id: string; client_id: string }, author: "portal" | "staff"): Promise<void> {
  const audience: NotifyAudience = author === "portal" ? "staff" : "client";
  await db.query(
    `INSERT INTO nzi_console.portal_message_notifications (organisation_id, notification_id, thread_id, client_id, audience, due_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(mins => $6))
     ON CONFLICT (organisation_id, thread_id, audience) WHERE state = 'pending'
     DO UPDATE SET message_count = nzi_console.portal_message_notifications.message_count + 1`,
    [organisationId, randomUUID(), thread.thread_id, thread.client_id, audience, MESSAGE_NOTIFY_WINDOW_MINUTES]);
}

export type MessageNotifyScan = { due: number; emailed: number; blockedNoConsent: number; noRecipient: number; refused: number };

type DueRow = {
  notification_id: string; thread_id: string; client_id: string; audience: NotifyAudience; message_count: number;
  job_id: string | null; scope: "client" | "job"; owner_id: string | null; client_name: string; crm_user_id: string | null;
  /** F3: set on a report-review round's thread (0201); null on every conversation. */
  report_version_id: string | null;
  /** SRS messaging (0221): the client's SRS readiness conversation. */
  srs_readiness: boolean;
};

/**
 * Where the client's notification points. A report-review round's thread (it carries `report_version_id`, 0201) links to the review page, where the round is
 * read and answered; every other thread links to its conversation, as before. Derived from the thread's own row - the worker reads nothing further.
 */
export const portalLink = (origin: string, jobId: string | null, threadId: string, reportVersionId: string | null = null, srsReadiness = false) => srsReadiness ? `${origin}/portal/srs`
  : !jobId ? `${origin}/portal`
  : reportVersionId ? `${origin}/portal/jobs/${encodeURIComponent(jobId)}/review`
  : `${origin}/portal/jobs/${encodeURIComponent(jobId)}/messages?thread=${encodeURIComponent(threadId)}`;

/**
 * Close every pending notification whose window has passed, in the worker's tenant transaction. A row that cannot be rendered (the organisation's
 * wording drifted, a bad address) is left pending and counted `refused`, so the next tick tries again once it is put right - nothing is lost.
 * `consoleOrigin` is required: a notification that cannot say where to read the message is not sent.
 */
export async function scanMessageNotifications(db: Queryable, input: { organisationId: string; consoleOrigin: string | undefined; limit?: number }): Promise<MessageNotifyScan> {
  const summary: MessageNotifyScan = { due: 0, emailed: 0, blockedNoConsent: 0, noRecipient: 0, refused: 0 };
  let origin: string;
  try { origin = new URL(input.consoleOrigin ?? "").origin; }
  catch { throw new Error("The console's own address (NZI_ISOLATED_API_URL) is not set, so a message notification could not link to the portal; none was sent."); }

  const { rows } = await db.query<DueRow>(
    `SELECT n.notification_id, n.thread_id, n.client_id, n.audience, n.message_count, t.job_id, t.scope, t.owner_id, t.report_version_id, t.srs_readiness, c.name AS client_name,
            coalesce(c.client_manager_user_id, c.owner_user_id) AS crm_user_id
       FROM nzi_console.portal_message_notifications n
       JOIN nzi_console.portal_threads t ON (t.organisation_id, t.thread_id) = (n.organisation_id, n.thread_id)
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (n.organisation_id, n.client_id)
      WHERE n.organisation_id = $1 AND n.state = 'pending' AND n.due_at <= now()
      ORDER BY n.due_at, n.notification_id
      LIMIT $2
      FOR UPDATE OF n SKIP LOCKED`, [input.organisationId, input.limit ?? 100]);

  for (const row of rows) {
    summary.due += 1;
    let outcome: { emailed: number; blocked: number; noRecipient: boolean };
    try {
      outcome = row.audience === "client" ? await notifyClient(db, input.organisationId, origin, row) : await notifyStaff(db, input.organisationId, origin, row);
    } catch (error) {
      if (error instanceof TemplatedEmailError || error instanceof EmailValidationError) { summary.refused += 1; continue; }
      throw error;
    }
    await db.query(
      `UPDATE nzi_console.portal_message_notifications SET state = 'done', processed_at = now(), emailed = $3, blocked_no_consent = $4, no_recipient = $5
        WHERE organisation_id = $1 AND notification_id = $2`, [input.organisationId, row.notification_id, outcome.emailed, outcome.blocked, outcome.noRecipient]);
    await db.query(
      `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, after_json, client_id)
       VALUES ($1,$2,$3,'system','portal_message_notified','portal_thread',$4,$5,$6::jsonb,$7)`,
      [input.organisationId, randomUUID(), MESSAGE_NOTIFY_ACTOR, row.thread_id, row.notification_id,
        JSON.stringify({ notificationId: row.notification_id, audience: row.audience, messages: row.message_count, emailed: outcome.emailed, blockedNoConsent: outcome.blocked, noRecipient: outcome.noRecipient }), row.client_id]);
    summary.emailed += outcome.emailed; summary.blockedNoConsent += outcome.blocked; summary.noRecipient += outcome.noRecipient ? 1 : 0;
  }
  return summary;
}

type ClientRecipient = { portal_user_id: string; email: string; display_name: string; first_name: string | null; consent: "granted" | "declined" | "unknown"; held_job: string | null };

async function notifyClient(db: Queryable, organisationId: string, origin: string, row: DueRow): Promise<{ emailed: number; blocked: number; noRecipient: boolean }> {
  // Who can see the thread now, and what consent their address carries now - read fresh, not remembered from when the message was written.
  const { rows: candidates } = await db.query<ClientRecipient>(
    `SELECT u.portal_user_id, u.email_normalized AS email, u.display_name, ${portalUserFirstNameSql("u")} AS first_name,
            CASE WHEN EXISTS (SELECT 1 FROM nzi_console.client_contacts k WHERE k.organisation_id = u.organisation_id AND k.client_id = u.client_id AND k.status = 'active'
                                 AND lower(k.email) = lower(u.email_normalized) AND k.email_consent = 'declined') THEN 'declined'
                 WHEN EXISTS (SELECT 1 FROM nzi_console.client_contacts k WHERE k.organisation_id = u.organisation_id AND k.client_id = u.client_id AND k.status = 'active'
                                 AND lower(k.email) = lower(u.email_normalized) AND k.email_consent = 'granted') THEN 'granted'
                 ELSE 'unknown' END AS consent,
            (SELECT g.job_id FROM nzi_console.portal_access_grants g WHERE g.organisation_id = u.organisation_id AND g.portal_user_id = u.portal_user_id AND g.client_id = u.client_id AND g.revoked_at IS NULL ORDER BY g.job_id LIMIT 1) AS held_job
       FROM nzi_console.portal_users u
      WHERE u.organisation_id = $1 AND u.client_id = $2 AND u.status = 'active'
        AND ($3 = 'client' OR EXISTS (SELECT 1 FROM nzi_console.portal_access_grants g WHERE g.organisation_id = u.organisation_id AND g.portal_user_id = u.portal_user_id AND g.client_id = u.client_id AND g.job_id = $4 AND g.revoked_at IS NULL))
      ORDER BY u.portal_user_id`, [organisationId, row.client_id, row.scope, row.job_id]);
  if (candidates.length === 0) return { emailed: 0, blocked: 0, noRecipient: true };
  let emailed = 0, blocked = 0;
  for (const person of candidates) {
    if (person.consent !== "granted") { blocked += 1; continue; }
    await sendTemplatedEmail(db, organisationId, {
      templateCode: CLIENT_MESSAGE_TEMPLATE, to: person.email, consoleOrigin: origin,
      // Greeted by first name; the full name stays available to wording that still uses it (0207).
      vars: { firstName: person.first_name || FIRST_NAME_FALLBACK, displayName: person.display_name?.trim() || FIRST_NAME_FALLBACK, clientName: row.client_name, threadLink: portalLink(origin, row.job_id ?? person.held_job, row.thread_id, row.report_version_id, row.srs_readiness) },
      correlationId: row.notification_id, idempotencyKey: `${CLIENT_MESSAGE_TEMPLATE}:${row.notification_id}:${person.portal_user_id}`,
    });
    emailed += 1;
  }
  return { emailed, blocked, noRecipient: false };
}

async function notifyStaff(db: Queryable, organisationId: string, origin: string, row: DueRow): Promise<{ emailed: number; blocked: number; noRecipient: boolean }> {
  const recipient = row.owner_id ?? row.crm_user_id;
  const member = recipient ? (await db.query<{ email: string | null; first_name: string | null }>(
    `SELECT m.email, ${staffFirstNameSql("m")} AS first_name FROM nzi_console.memberships m WHERE m.organisation_id = $1 AND m.user_id = $2 AND m.status = 'active'`, [organisationId, recipient])).rows[0] : undefined;
  if (!member?.email) return { emailed: 0, blocked: 0, noRecipient: true };
  await sendTemplatedEmail(db, organisationId, {
    templateCode: STAFF_MESSAGE_TEMPLATE, to: member.email, consoleOrigin: origin,
    vars: { firstName: member.first_name || FIRST_NAME_FALLBACK, clientName: row.client_name, threadLink: `${origin}/clients/${encodeURIComponent(row.client_id)}?area=${row.srs_readiness ? "srs" : "portal"}` },
    correlationId: row.notification_id, idempotencyKey: `${STAFF_MESSAGE_TEMPLATE}:${row.notification_id}`,
  });
  return { emailed: 1, blocked: 0, noRecipient: false };
}
