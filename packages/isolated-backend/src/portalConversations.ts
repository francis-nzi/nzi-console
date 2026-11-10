import { randomUUID } from "node:crypto";
import { attachmentState, openSrsReviewRequest, type SrsThreadReadModel, type CommandContext, type CommandInputMap, type PortalFileIngest, type PortalFileStatus, type PortalMessage, type PortalMessageAttachment, type PortalMessageAuthor, PortalThreadDetail, PortalThreadScope, PortalThreadState, PortalThreadSubject, PortalThreadSummary } from "@nzi/contracts";
import { assertCapabilityOnClient, type CapabilityHolder } from "./access";
import { AuthorizationError, type PortalPrincipal } from "./auth";
import { VersionConflictError } from "./errors";
import { queueMessageNotification } from "./portalMessageNotifications";
import { insertFile } from "./portalFiles";
import { withTenantRead, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

/**
 * Portal conversations (RULING-portal-messages, M1) - the threads between a client and their adviser, and the audited commands around them.
 *
 *  - **Who may see a thread:** a portal user sees the threads of their own client that are client-wide, or that are on a job they hold a live
 *    grant on - never another client's, never a job they do not hold. Staff see a client's threads under `portal.admin` on that client.
 *  - **Who may start one (the ruling's default):** any active user of the client - on a job they hold, or client-wide - and staff.
 *  - **State follows who spoke last:** a client post sets Awaiting adviser and the response target; a staff post sets Awaiting client and
 *    clears it; a post to a Resolved thread reopens it. Staff may set the owner and the state by hand. The target is surfaced, not enforced.
 *  - **The report bridge:** a thread with `report_version_id` is also the report page's comments. A report comment is mirrored in by the
 *    database function (0201); a message written here is mirrored out as a comment, so the two surfaces stay one conversation.
 *  - **Attachments (M3):** a message may carry files. Each is an ordinary `portal_files` row that arrived through the file gate (quarantined, scanned,
 *    released only when clean) and is linked to the message in one transaction with it; it is served by the existing signed-URL download, only once
 *    released, and only to whoever may see the thread. A client's attachment is a `client_upload`, an adviser's a `deliverable`.
 *  - **Notification (M4):** a message queues a notify-only email for the other side - one pending row per thread, so a burst is one email - which the
 *    worker sends after a short window: clients only if they have consented (NZC-076), staff internally. See portalMessageNotifications.ts.
 *  - **Names:** a message stores its author's id only. A portal user reads "You" / "A colleague" / their adviser; staff read names joined here.
 */
type ThreadRow = {
  thread_id: string; client_id: string; scope: PortalThreadScope; job_id: string | null; job_number: string | null; subject_code: string; subject_label: string; title: string;
  state: PortalThreadState; owner_id: string | null; owner_name: string | null; report_version_id: string | null; message_count: number; last_message_at: Date | string;
  created_at: Date | string; response_target_at: Date | string | null; version: number; unread: number;
};
const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
const refuse = (field: string, code: string, message: string) => new CommandValidationError([{ field, code, message }]);
const NOT_FOUND = () => refuse("threadId", "NOT_FOUND", "That conversation was not found.");

const SUMMARY_SELECT = (unreadSql: string) => `
  t.thread_id, t.client_id, t.scope, t.job_id, j.job_number, t.subject_code, s.label AS subject_label, t.title, t.state, t.owner_id, m.display_name AS owner_name,
  t.report_version_id, t.message_count, t.last_message_at, t.created_at, t.response_target_at, t.version, (${unreadSql})::int AS unread
  FROM nzi_console.portal_threads t
  JOIN nzi_console.portal_thread_subjects s ON (s.organisation_id, s.subject_code) = (t.organisation_id, t.subject_code)
  LEFT JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (t.organisation_id, t.job_id)
  LEFT JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (t.organisation_id, t.owner_id)`;

const toSummary = (row: ThreadRow, staff: boolean): PortalThreadSummary => ({
  threadId: row.thread_id, clientId: row.client_id, scope: row.scope, jobId: row.job_id, jobNumber: row.job_number, subjectCode: row.subject_code, subjectLabel: row.subject_label,
  title: row.title, state: row.state, reportVersionId: row.report_version_id, messageCount: row.message_count, lastMessageAt: iso(row.last_message_at)!, createdAt: iso(row.created_at)!,
  responseTargetAt: iso(row.response_target_at), unread: row.unread,
  ...(staff ? { ownerId: row.owner_id, ownerName: row.owner_name, version: row.version } : {}),
});

/** A portal user's live grant on a job - any window: a conversation is not data entry. */
async function portalHoldsJob(db: Queryable, organisationId: string, userId: string, clientId: string, jobId: string): Promise<boolean> {
  return !!(await db.query(
    `SELECT 1 FROM nzi_console.portal_access_grants g JOIN nzi_console.portal_users u ON (u.organisation_id, u.portal_user_id, u.client_id) = (g.organisation_id, g.portal_user_id, g.client_id)
      WHERE g.organisation_id = $1 AND g.portal_user_id = $2 AND g.client_id = $3 AND g.job_id = $4 AND g.revoked_at IS NULL AND u.status = 'active'`,
    [organisationId, userId, clientId, jobId])).rows[0];
}
async function requireClientJob(db: Queryable, organisationId: string, clientId: string, jobId: string | null): Promise<void> {
  if (!jobId) return;
  if (!(await db.query(`SELECT 1 FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 AND client_id = $3`, [organisationId, jobId, clientId])).rows[0]) throw refuse("jobId", "NOT_FOUND", "That job was not found.");
}
async function requireActiveSubject(db: Queryable, organisationId: string, code: string): Promise<void> {
  if (!(await db.query(`SELECT 1 FROM nzi_console.portal_thread_subjects WHERE organisation_id = $1 AND subject_code = $2 AND active`, [organisationId, code])).rows[0]) throw refuse("subjectCode", "NOT_FOUND", "That subject is not available.");
}

type Locked = { thread_id: string; client_id: string; scope: PortalThreadScope; job_id: string | null; state: PortalThreadState; message_count: number; version: number; owner_id: string | null; report_version_id: string | null };
async function lockThread(db: Queryable, organisationId: string, clientId: string, threadId: string): Promise<Locked> {
  const row = (await db.query<Locked>(
    `SELECT thread_id, client_id, scope, job_id, state, message_count, version, owner_id, report_version_id FROM nzi_console.portal_threads WHERE organisation_id = $1 AND client_id = $2 AND thread_id = $3 FOR UPDATE`,
    [organisationId, clientId, threadId])).rows[0];
  if (!row) throw NOT_FOUND();
  return row;
}
/** Whether this portal user may be in this thread: their own client's, and for a job thread a job they hold. */
async function portalMayHave(db: Queryable, context: CommandContext, thread: Locked): Promise<boolean> {
  if (thread.client_id !== context.portal!.clientId) return false;
  return thread.scope === "client" || (thread.job_id !== null && portalHoldsJob(db, context.organisationId, context.actorId, thread.client_id, thread.job_id));
}

/** Append one message and move the thread: who spoke last decides the state; a client post sets the target, a staff post clears it. */
type FileEvent = { action: string; entityType: string; entityId: string; before: Record<string, unknown>; after: Record<string, unknown> };
async function appendMessage(db: Queryable, context: CommandContext, thread: Locked, author: "portal" | "staff", body: string, attachments: readonly PortalFileIngest[] = [], reviewRequest = false): Promise<{ messageId: string; seq: number; state: PortalThreadState; fileEvents: FileEvent[] }> {
  const messageId = randomUUID(), seq = thread.message_count + 1;
  const state: PortalThreadState = author === "portal" ? "awaiting_nzi" : "awaiting_client";
  let legacyCommentId: string | null = null;
  if (thread.report_version_id) {
    // The thread is also the report page's comments: write the comment first, so the message can name it and neither is mirrored twice.
    legacyCommentId = randomUUID();
    const name = author === "portal"
      ? (await db.query<{ n: string | null }>(`SELECT display_name AS n FROM nzi_console.portal_users WHERE organisation_id = $1 AND portal_user_id = $2`, [context.organisationId, context.actorId])).rows[0]?.n
      : (await db.query<{ n: string | null }>(`SELECT display_name AS n FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2`, [context.organisationId, context.actorId])).rows[0]?.n;
    await db.query(
      `INSERT INTO nzi_console.portal_report_comments (organisation_id, comment_id, report_version_id, job_id, client_id, author_principal, author_id, author_display_name, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [context.organisationId, legacyCommentId, thread.report_version_id, thread.job_id, thread.client_id, author, context.actorId, name ?? (author === "portal" ? "Client user" : "Adviser"), body]);
  }
  await db.query(
    `INSERT INTO nzi_console.portal_messages (organisation_id, message_id, thread_id, seq, author_principal, author_id, body, legacy_comment_id, review_request) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [context.organisationId, messageId, thread.thread_id, seq, author, context.actorId, body, legacyCommentId, reviewRequest]);
  const fileEvents = await attachFiles(db, context, thread, messageId, author, attachments);
  // Notify-only email to the other side (M4): queued here - one pending row per thread and audience - and sent by the worker after the window.
  await queueMessageNotification(db, context.organisationId, thread, author);
  await db.query(
    `UPDATE nzi_console.portal_threads SET message_count = $4, last_message_at = now(), state = $5, resolved_at = NULL, version = version + 1,
            response_target_at = CASE WHEN $5 = 'awaiting_nzi' THEN nzi_console.portal_response_target(now()) END
      WHERE organisation_id = $1 AND client_id = $2 AND thread_id = $3`,
    [context.organisationId, thread.client_id, thread.thread_id, seq, state]);
  return { messageId, seq, state, fileEvents };
}

/**
 * Record each attachment as a portal file (the gate's decision, whatever it was) and link it to the message. The file must be the thread's own: its
 * job is the thread's job, so a client cannot attach into another job's folder and a forged ingest naming another job is refused. Each file gets its
 * own audit event, in the shape the Files history reads (uploaded -> scanned -> released), so an attachment's trail is the same as any file's.
 */
async function attachFiles(db: Queryable, context: CommandContext, thread: Locked, messageId: string, author: "portal" | "staff", attachments: readonly PortalFileIngest[]): Promise<FileEvent[]> {
  const events: FileEvent[] = [];
  for (const [index, ingest] of attachments.entries()) {
    if ((ingest.jobId ?? null) !== (thread.job_id ?? null)) throw refuse(`attachments[${index}].ingest.jobId`, "NOT_FOUND", "That file does not belong with this conversation.");
    await insertFile(db, context, thread.client_id, author === "portal" ? "client_upload" : "deliverable", ingest, "other");
    await db.query(
      `INSERT INTO nzi_console.portal_message_attachments (organisation_id, message_id, file_id, position) VALUES ($1,$2,$3,$4)`,
      [context.organisationId, messageId, ingest.fileId, index + 1]);
    events.push({
      action: author === "portal" ? "portal_file_uploaded" : "client_file_delivered", entityType: "portal_file", entityId: ingest.fileId, before: {},
      // The outcome and the file's hash - never the bytes, a storage identifier, or the message text.
      after: { fileId: ingest.fileId, clientId: thread.client_id, jobId: ingest.jobId, fileName: ingest.fileName, contentType: ingest.contentType, sizeBytes: ingest.sizeBytes, sha256: ingest.sha256, status: ingest.status, flag: ingest.flag, messageId },
    });
  }
  return events;
}
const recorded = (clientId: string, threadId: string, data: Record<string, unknown>, topic: string, fileEvents: FileEvent[] = []) => ({
  // What is audited: the ids and the state - never the text of the message.
  data: { clientId, threadId, ...data }, entityType: "portal_thread", entityId: threadId, topic,
  ...(fileEvents.length ? { governedEvents: fileEvents } : {}),
});

async function startThread(db: Queryable, context: CommandContext, input: CommandInputMap["portal.thread.start"], author: "portal" | "staff") {
  await requireActiveSubject(db, context.organisationId, input.subjectCode);
  await requireClientJob(db, context.organisationId, input.clientId, input.jobId);
  if (author === "portal" && input.jobId && !(await portalHoldsJob(db, context.organisationId, context.actorId, input.clientId, input.jobId))) throw refuse("jobId", "NOT_FOUND", "That job was not found.");
  if (author === "staff" && !(await db.query(`SELECT 1 FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [context.organisationId, input.clientId])).rows[0]) throw refuse("clientId", "NOT_FOUND", "Client was not found.");
  const threadId = randomUUID();
  await db.query(
    `INSERT INTO nzi_console.portal_threads (organisation_id, thread_id, client_id, scope, job_id, subject_code, title, state, owner_id, started_by_principal, started_by_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10)`,
    [context.organisationId, threadId, input.clientId, input.jobId ? "job" : "client", input.jobId, input.subjectCode, input.title.trim(), author === "staff" ? context.actorId : null, author, context.actorId]);
  const thread: Locked = { thread_id: threadId, client_id: input.clientId, scope: input.jobId ? "job" : "client", job_id: input.jobId, state: "open", message_count: 0, version: 1, owner_id: null, report_version_id: null };
  const posted = await appendMessage(db, context, thread, author, input.body.trim(), input.attachments);
  return recorded(input.clientId, threadId, { scope: thread.scope, jobId: input.jobId, subjectCode: input.subjectCode, messageId: posted.messageId, state: posted.state, attachments: input.attachments?.length ?? 0 },
    author === "portal" ? "portal.thread.started" : "client.thread.started", posted.fileEvents);
}

/** A client user starts a conversation - on a job they hold, or for the whole organisation. */
export function startPortalThread(pool: PoolLike, input: CommandInputMap["portal.thread.start"], context: CommandContext): Promise<StoredOutcome<Record<string, unknown>>> {
  return runPostgresCommand(pool, "portal.thread.start", input, context, (db) => startThread(db, context, input, "portal"));
}
/** The adviser starts a conversation with a client (portal.admin on the client). They own it until reassigned. */
export function startClientThread(pool: PoolLike, input: CommandInputMap["client.thread.start"], context: CommandContext): Promise<StoredOutcome<Record<string, unknown>>> {
  return runPostgresCommand(pool, "client.thread.start", input, context, (db) => startThread(db, context, input, "staff"));
}

export function postPortalMessage(pool: PoolLike, input: CommandInputMap["portal.message.post"], context: CommandContext): Promise<StoredOutcome<Record<string, unknown>>> {
  return runPostgresCommand(pool, "portal.message.post", input, context, async (db) => {
    const thread = await lockThread(db, context.organisationId, input.clientId, input.threadId);
    if (!(await portalMayHave(db, context, thread))) throw NOT_FOUND();
    const posted = await appendMessage(db, context, thread, "portal", input.body.trim(), input.attachments);
    return recorded(input.clientId, input.threadId, { messageId: posted.messageId, seq: posted.seq, state: posted.state, previousState: thread.state, attachments: input.attachments?.length ?? 0 }, "portal.message.posted", posted.fileEvents);
  });
}
export function postClientMessage(pool: PoolLike, input: CommandInputMap["client.message.post"], context: CommandContext): Promise<StoredOutcome<Record<string, unknown>>> {
  return runPostgresCommand(pool, "client.message.post", input, context, async (db) => {
    const thread = await lockThread(db, context.organisationId, input.clientId, input.threadId);
    const posted = await appendMessage(db, context, thread, "staff", input.body.trim(), input.attachments);
    // The first adviser to reply to an unowned conversation owns it: someone is accountable for the answer.
    if (!thread.owner_id) await db.query(`UPDATE nzi_console.portal_threads SET owner_id = $4 WHERE organisation_id = $1 AND client_id = $2 AND thread_id = $3`, [context.organisationId, input.clientId, input.threadId, context.actorId]);
    return recorded(input.clientId, input.threadId, { messageId: posted.messageId, seq: posted.seq, state: posted.state, previousState: thread.state, ownerClaimed: !thread.owner_id, attachments: input.attachments?.length ?? 0 }, "client.message.posted", posted.fileEvents);
  });
}

/** The client user has read the conversation up to its latest message. */
export function markPortalThreadRead(pool: PoolLike, input: CommandInputMap["portal.thread.read"], context: CommandContext): Promise<StoredOutcome<Record<string, unknown>>> {
  return runPostgresCommand(pool, "portal.thread.read", input, context, async (db) => {
    const thread = await lockThread(db, context.organisationId, input.clientId, input.threadId);
    if (!(await portalMayHave(db, context, thread))) throw NOT_FOUND();
    await db.query(
      `INSERT INTO nzi_console.portal_thread_reads (organisation_id, thread_id, portal_user_id, last_read_seq, last_read_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (organisation_id, thread_id, portal_user_id) DO UPDATE SET last_read_seq = GREATEST(portal_thread_reads.last_read_seq, EXCLUDED.last_read_seq), last_read_at = now()`,
      [context.organisationId, input.threadId, context.actorId, thread.message_count]);
    return recorded(input.clientId, input.threadId, { readThrough: thread.message_count }, "portal.thread.read");
  });
}

/** Staff set the owner and/or the state. A version guard stops two advisers overwriting each other; the target follows the state. */
export function updateClientThread(pool: PoolLike, input: CommandInputMap["client.thread.update"], context: CommandContext): Promise<StoredOutcome<Record<string, unknown>>> {
  return runPostgresCommand(pool, "client.thread.update", input, context, async (db) => {
    const thread = await lockThread(db, context.organisationId, input.clientId, input.threadId);
    if (input.expectedVersion !== thread.version) throw new VersionConflictError(input.expectedVersion, thread.version);
    if (input.ownerId) {
      const owner = (await db.query(`SELECT 1 FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2 AND status = 'active'`, [context.organisationId, input.ownerId])).rows[0];
      if (!owner) throw refuse("ownerId", "NOT_FOUND", "That member of staff was not found.");
    }
    const owner = input.ownerId === undefined ? thread.owner_id : input.ownerId;
    const state = input.state ?? thread.state;
    await db.query(
      `UPDATE nzi_console.portal_threads SET owner_id = $4, state = $5, version = version + 1,
              resolved_at = CASE WHEN $5 = 'resolved' THEN coalesce(resolved_at, now()) END,
              response_target_at = CASE WHEN $5 = 'awaiting_nzi' THEN coalesce(response_target_at, nzi_console.portal_response_target(now())) END
        WHERE organisation_id = $1 AND client_id = $2 AND thread_id = $3`,
      [context.organisationId, input.clientId, input.threadId, owner, state]);
    return recorded(input.clientId, input.threadId, { ownerId: owner, previousOwnerId: thread.owner_id, state, previousState: thread.state }, "client.thread.updated");
  });
}

/** Add, rename, reorder or switch off a subject tag (admin.lookups). A tag is never deleted - a thread keeps the one it was started under. */
export function setThreadSubject(pool: PoolLike, input: CommandInputMap["thread_subject.set"], context: CommandContext): Promise<StoredOutcome<Record<string, unknown>>> {
  return runPostgresCommand(pool, "thread_subject.set", input, context, async (db) => {
    const existing = (await db.query<{ active: boolean; sort_order: number }>(`SELECT active, sort_order FROM nzi_console.portal_thread_subjects WHERE organisation_id = $1 AND subject_code = $2 FOR UPDATE`, [context.organisationId, input.code])).rows[0];
    await db.query(
      `INSERT INTO nzi_console.portal_thread_subjects (organisation_id, subject_code, label, sort_order, active) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organisation_id, subject_code) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order, active = EXCLUDED.active, updated_at = now()`,
      [context.organisationId, input.code, input.label.trim(), input.sortOrder ?? existing?.sort_order ?? 100, input.active ?? existing?.active ?? true]);
    return { data: { code: input.code, label: input.label.trim(), created: !existing, active: input.active ?? existing?.active ?? true }, entityType: "portal_thread_subject", entityId: input.code, topic: "thread_subject.set" };
  });
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────

export async function listThreadSubjects(db: Queryable, organisationId: string, includeInactive = false): Promise<PortalThreadSubject[]> {
  return (await db.query<{ subject_code: string; label: string; sort_order: number; active: boolean }>(
    `SELECT subject_code, label, sort_order, active FROM nzi_console.portal_thread_subjects WHERE organisation_id = $1 ${includeInactive ? "" : "AND active"} ORDER BY sort_order, subject_code`, [organisationId]))
    .rows.map((row) => ({ code: row.subject_code, label: row.label, sortOrder: row.sort_order, active: row.active }));
}

/** $1 organisation, $2 client, $3 portal user: a client-wide thread, or a job thread on a job the user holds. */
const PORTAL_VISIBLE = `t.organisation_id = $1 AND t.client_id = $2
  AND (t.scope = 'client' OR t.job_id IN (SELECT g.job_id FROM nzi_console.portal_access_grants g WHERE g.organisation_id = $1 AND g.portal_user_id = $3 AND g.client_id = $2 AND g.revoked_at IS NULL))`;
const PORTAL_UNREAD = `SELECT count(*) FROM nzi_console.portal_messages x WHERE (x.organisation_id, x.thread_id) = (t.organisation_id, t.thread_id)
  AND x.seq > coalesce((SELECT r.last_read_seq FROM nzi_console.portal_thread_reads r WHERE (r.organisation_id, r.thread_id, r.portal_user_id) = (t.organisation_id, t.thread_id, $3)), 0)
  AND NOT (x.author_principal = 'portal' AND x.author_id = $3)`;

/** The threads a portal user may see (all of them, or one job's plus the client-wide ones), newest activity first, with the subject tags to start one under. */
export function listPortalThreads(pool: PoolLike, principal: PortalPrincipal, options: { jobId?: string | null } = {}): Promise<{ threads: PortalThreadSummary[]; subjects: PortalThreadSubject[] }> {
  return withTenantRead(pool, principal.organisationId, async (db) => {
    const params: unknown[] = [principal.organisationId, principal.clientId, principal.userId];
    let scopeFilter = "";
    if (options.jobId) { params.push(options.jobId); scopeFilter = ` AND (t.scope = 'client' OR t.job_id = $4)`; }
    const rows = (await db.query<ThreadRow>(`SELECT ${SUMMARY_SELECT(PORTAL_UNREAD)} WHERE ${PORTAL_VISIBLE}${scopeFilter} ORDER BY t.last_message_at DESC, t.thread_id`, params)).rows;
    return { threads: rows.map((row) => toSummary(row, false)), subjects: await listThreadSubjects(db, principal.organisationId) };
  });
}

const authorOf = (row: { author_principal: "portal" | "staff"; author_id: string }, viewerId: string): PortalMessageAuthor =>
  row.author_principal === "staff" ? "adviser" : row.author_id === viewerId ? "you" : "colleague";

/** A thread's attachments by message, in the order attached - the gate's status as a state, never a storage identifier or a hash. */
async function attachmentsByMessage(db: Queryable, organisationId: string, threadId: string): Promise<Map<string, PortalMessageAttachment[]>> {
  const rows = (await db.query<{ message_id: string; file_id: string; file_name: string; content_type: string; size_bytes: string; status: PortalFileStatus }>(
    `SELECT a.message_id, f.file_id, f.file_name, f.content_type, f.size_bytes::text AS size_bytes, f.status
       FROM nzi_console.portal_message_attachments a
       JOIN nzi_console.portal_messages m ON (m.organisation_id, m.message_id) = (a.organisation_id, a.message_id)
       JOIN nzi_console.portal_files f ON (f.organisation_id, f.file_id) = (a.organisation_id, a.file_id)
      WHERE m.organisation_id = $1 AND m.thread_id = $2 ORDER BY m.seq, a.position`, [organisationId, threadId])).rows;
  const byMessage = new Map<string, PortalMessageAttachment[]>();
  for (const row of rows) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push({ fileId: row.file_id, fileName: row.file_name, contentType: row.content_type, sizeBytes: Number(row.size_bytes), state: attachmentState(row.status) });
    byMessage.set(row.message_id, list);
  }
  return byMessage;
}

/** One thread and its messages for a portal user entitled to it (the list's rule); anything else is refused. */
export function getPortalThread(pool: PoolLike, principal: PortalPrincipal, threadId: string): Promise<PortalThreadDetail> {
  return withTenantRead(pool, principal.organisationId, async (db) => {
    const row = (await db.query<ThreadRow>(`SELECT ${SUMMARY_SELECT(PORTAL_UNREAD)} WHERE ${PORTAL_VISIBLE} AND t.thread_id = $4`, [principal.organisationId, principal.clientId, principal.userId, threadId])).rows[0];
    if (!row) throw new AuthorizationError("tenant", "That conversation is not available to your account.");
    const messages = (await db.query<{ message_id: string; seq: number; author_principal: "portal" | "staff"; author_id: string; body: string; created_at: Date | string }>(
      `SELECT message_id, seq, author_principal, author_id, body, created_at FROM nzi_console.portal_messages WHERE organisation_id = $1 AND thread_id = $2 ORDER BY seq`, [principal.organisationId, threadId])).rows;
    const attachments = await attachmentsByMessage(db, principal.organisationId, threadId);
    return {
      thread: toSummary(row, false),
      messages: messages.map((message): PortalMessage => ({ messageId: message.message_id, seq: message.seq, body: message.body, createdAt: iso(message.created_at)!, author: authorOf(message, principal.userId), authorPrincipal: message.author_principal, attachments: attachments.get(message.message_id) ?? [] })),
    };
  });
}

/** A thread's client messages since the team last spoke — what staff read as unread. Over `portal_threads t`; the Control Room counts it too. */
export const STAFF_UNREAD = `SELECT count(*) FROM nzi_console.portal_messages x WHERE (x.organisation_id, x.thread_id) = (t.organisation_id, t.thread_id) AND x.author_principal = 'portal'
  AND x.seq > coalesce((SELECT max(y.seq) FROM nzi_console.portal_messages y WHERE (y.organisation_id, y.thread_id) = (t.organisation_id, t.thread_id) AND y.author_principal = 'staff'), 0)`;

/** The client workspace's Conversations: every thread of the client (portal.admin on it), the subject tags, and the staff a thread can be assigned to. */
export function listClientThreads(pool: PoolLike, holder: CapabilityHolder, clientId: string): Promise<{ threads: PortalThreadSummary[]; subjects: PortalThreadSubject[]; staff: Array<{ userId: string; displayName: string }>; jobs: Array<{ jobId: string; jobNumber: string; title: string }> }> {
  return withTenantRead(pool, holder.organisationId, async (db) => {
    await assertCapabilityOnClient(db, holder, "portal.admin", { clientId });
    const rows = (await db.query<ThreadRow>(`SELECT ${SUMMARY_SELECT(STAFF_UNREAD)} WHERE t.organisation_id = $1 AND t.client_id = $2 ORDER BY t.last_message_at DESC, t.thread_id`, [holder.organisationId, clientId])).rows;
    const staff = (await db.query<{ user_id: string; display_name: string | null }>(`SELECT user_id, display_name FROM nzi_console.memberships WHERE organisation_id = $1 AND status = 'active' ORDER BY lower(coalesce(display_name, user_id))`, [holder.organisationId])).rows;
    const jobs = (await db.query<{ job_id: string; job_number: string; title: string }>(`SELECT job_id, job_number, title FROM nzi_console.jobs WHERE organisation_id = $1 AND client_id = $2 ORDER BY job_number DESC`, [holder.organisationId, clientId])).rows;
    return { threads: rows.map((row) => toSummary(row, true)), subjects: await listThreadSubjects(db, holder.organisationId, true), jobs: jobs.map((job) => ({ jobId: job.job_id, jobNumber: job.job_number, title: job.title })), staff: staff.map((member) => ({ userId: member.user_id, displayName: member.display_name ?? member.user_id })) };
  });
}
export function getClientThread(pool: PoolLike, holder: CapabilityHolder, clientId: string, threadId: string): Promise<PortalThreadDetail> {
  return withTenantRead(pool, holder.organisationId, async (db) => {
    await assertCapabilityOnClient(db, holder, "portal.admin", { clientId });
    const row = (await db.query<ThreadRow>(`SELECT ${SUMMARY_SELECT(STAFF_UNREAD)} WHERE t.organisation_id = $1 AND t.client_id = $2 AND t.thread_id = $3`, [holder.organisationId, clientId, threadId])).rows[0];
    if (!row) throw NOT_FOUND();
    const messages = (await db.query<{ message_id: string; seq: number; author_principal: "portal" | "staff"; author_id: string; body: string; created_at: Date | string; author_name: string | null }>(
      `SELECT x.message_id, x.seq, x.author_principal, x.author_id, x.body, x.created_at,
              CASE WHEN x.author_principal = 'portal' THEN (SELECT u.display_name FROM nzi_console.portal_users u WHERE (u.organisation_id, u.portal_user_id) = (x.organisation_id, x.author_id))
                   ELSE (SELECT m.display_name FROM nzi_console.memberships m WHERE (m.organisation_id, m.user_id) = (x.organisation_id, x.author_id)) END AS author_name
         FROM nzi_console.portal_messages x WHERE x.organisation_id = $1 AND x.thread_id = $2 ORDER BY x.seq`, [holder.organisationId, threadId])).rows;
    const attachments = await attachmentsByMessage(db, holder.organisationId, threadId);
    return {
      thread: toSummary(row, true),
      messages: messages.map((message): PortalMessage => ({ messageId: message.message_id, seq: message.seq, body: message.body, createdAt: iso(message.created_at)!, author: message.author_principal === "staff" ? "adviser" : "colleague", authorPrincipal: message.author_principal, authorName: message.author_name, attachments: attachments.get(message.message_id) ?? [] })),
    };
  });
}

// ── SRS messaging (BRIEF-srs-iterative-review-and-messaging, Phase B) ──────────────────────────────────────────────

/**
 * The client's one SRS readiness conversation (0221): a client-wide thread under the `srs` subject, created by the first message
 * from either side and locked for this one. Everything after is the ordinary conversation path above - append-only messages,
 * state by who spoke last, the other side's notify-only email queued in the same transaction - so there is one messaging system.
 * The assessment is never touched from here: the client's only write is a message; a review request is surfaced to the CRM, who
 * reopens through the existing command (NZC-022).
 */
const SRS_THREAD_TITLE = "SRS readiness";
async function lockSrsThread(db: Queryable, context: CommandContext, clientId: string, author: "portal" | "staff"): Promise<Locked> {
  await db.query(
    `INSERT INTO nzi_console.portal_threads (organisation_id, thread_id, client_id, scope, job_id, subject_code, title, state, owner_id, started_by_principal, started_by_id, srs_readiness)
     VALUES ($1,$2,$3,'client',NULL,'srs',$4,'open',$5,$6,$7,true)
     ON CONFLICT (organisation_id, client_id) WHERE srs_readiness DO NOTHING`,
    [context.organisationId, randomUUID(), clientId, SRS_THREAD_TITLE, author === "staff" ? context.actorId : null, author, context.actorId]);
  const threadId = (await db.query<{ thread_id: string }>(
    `SELECT thread_id FROM nzi_console.portal_threads WHERE organisation_id = $1 AND client_id = $2 AND srs_readiness`, [context.organisationId, clientId])).rows[0]!.thread_id;
  return lockThread(db, context.organisationId, clientId, threadId);
}

/** The client writes about their readiness - optionally asking for a review. Authorised before this runs: an active user of this client. */
export function postPortalSrsMessage(pool: PoolLike, input: CommandInputMap["portal.srs.message.post"], context: CommandContext): Promise<StoredOutcome<Record<string, unknown>>> {
  return runPostgresCommand(pool, "portal.srs.message.post", input, context, async (db) => {
    // Their own client only (NZC-120): the session's client, whatever the input says.
    if (input.clientId !== context.portal!.clientId) throw refuse("clientId", "NOT_FOUND", "Client was not found.");
    const thread = await lockSrsThread(db, context, input.clientId, "portal");
    const reviewRequest = input.reviewRequest === true;
    const posted = await appendMessage(db, context, thread, "portal", input.body.trim(), [], reviewRequest);
    return recorded(input.clientId, thread.thread_id, { messageId: posted.messageId, seq: posted.seq, state: posted.state, previousState: thread.state, reviewRequest }, "portal.srs.message.posted");
  });
}

/** The CRM replies (srs.manage on the client). The first adviser to write in an unowned SRS conversation owns it, as in any conversation. */
export function postSrsMessage(pool: PoolLike, input: CommandInputMap["srs.message.post"], context: CommandContext): Promise<StoredOutcome<Record<string, unknown>>> {
  return runPostgresCommand(pool, "srs.message.post", input, context, async (db) => {
    if (!(await db.query(`SELECT 1 FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [context.organisationId, input.clientId])).rows[0]) throw refuse("clientId", "NOT_FOUND", "Client was not found.");
    const thread = await lockSrsThread(db, context, input.clientId, "staff");
    const posted = await appendMessage(db, context, thread, "staff", input.body.trim());
    if (!thread.owner_id) await db.query(`UPDATE nzi_console.portal_threads SET owner_id = $3 WHERE organisation_id = $1 AND thread_id = $2`, [context.organisationId, thread.thread_id, context.actorId]);
    return recorded(input.clientId, thread.thread_id, { messageId: posted.messageId, seq: posted.seq, state: posted.state, previousState: thread.state, ownerClaimed: !thread.owner_id }, "srs.message.posted");
  });
}

type SrsMessageRow = { message_id: string; seq: number; author_principal: "portal" | "staff"; author_id: string; body: string; created_at: Date | string; review_request: boolean; author_name?: string | null };
const srsThreadModel = (thread: PortalThreadSummary | null, messages: PortalMessage[]): SrsThreadReadModel => ({ thread, messages, openReviewRequest: openSrsReviewRequest(messages) });

/**
 * The client's SRS conversation for a portal user of that client - the session's client only (NZC-120). Staff read as "your
 * adviser", never by name (NZC-110), as in every conversation. No thread yet: an empty model.
 */
export function getPortalSrsThread(pool: PoolLike, principal: PortalPrincipal): Promise<SrsThreadReadModel> {
  return withTenantRead(pool, principal.organisationId, async (db) => {
    const row = (await db.query<ThreadRow>(`SELECT ${SUMMARY_SELECT(PORTAL_UNREAD)} WHERE ${PORTAL_VISIBLE} AND t.srs_readiness`, [principal.organisationId, principal.clientId, principal.userId])).rows[0];
    if (!row) return srsThreadModel(null, []);
    const messages = (await db.query<SrsMessageRow>(
      `SELECT message_id, seq, author_principal, author_id, body, created_at, review_request FROM nzi_console.portal_messages WHERE organisation_id = $1 AND thread_id = $2 ORDER BY seq`, [principal.organisationId, row.thread_id])).rows;
    return srsThreadModel(toSummary(row, false), messages.map((message): PortalMessage => ({
      messageId: message.message_id, seq: message.seq, body: message.body, createdAt: iso(message.created_at)!, author: authorOf(message, principal.userId), authorPrincipal: message.author_principal, attachments: [],
      ...(message.review_request ? { reviewRequest: true } : {}),
    })));
  });
}

/** The client's SRS conversation for the CRM's SRS area, read in the workspace's tenant transaction (the client's access already checked). */
export async function readClientSrsThread(db: Queryable, clientId: string): Promise<SrsThreadReadModel> {
  const row = (await db.query<ThreadRow>(`SELECT ${SUMMARY_SELECT(STAFF_UNREAD)} WHERE t.client_id = $1 AND t.srs_readiness`, [clientId])).rows[0];
  if (!row) return srsThreadModel(null, []);
  const messages = (await db.query<SrsMessageRow>(
    `SELECT x.message_id, x.seq, x.author_principal, x.author_id, x.body, x.created_at, x.review_request,
            CASE WHEN x.author_principal = 'portal' THEN (SELECT u.display_name FROM nzi_console.portal_users u WHERE (u.organisation_id, u.portal_user_id) = (x.organisation_id, x.author_id))
                 ELSE (SELECT m.display_name FROM nzi_console.memberships m WHERE (m.organisation_id, m.user_id) = (x.organisation_id, x.author_id)) END AS author_name
       FROM nzi_console.portal_messages x WHERE x.thread_id = $1 ORDER BY x.seq`, [row.thread_id])).rows;
  return srsThreadModel(toSummary(row, true), messages.map((message): PortalMessage => ({
    messageId: message.message_id, seq: message.seq, body: message.body, createdAt: iso(message.created_at)!, author: message.author_principal === "staff" ? "adviser" : "colleague",
    authorPrincipal: message.author_principal, authorName: message.author_name ?? null, attachments: [], ...(message.review_request ? { reviewRequest: true } : {}),
  })));
}
