import { latestAssessed, overallReadiness, utcDay, type ReportStage, type SrsFramework } from "@nzi/contracts";
import type { JobFamily, JobScreenReadModel } from "./readModels";
import type { Queryable } from "./postgres";
import { CLIENT_CRM_SQL, JOB_CRM_SQL } from "./crmRouting";
import { listOpenTasks, readTaskOptions, type CrmTask } from "./crmTasks";
import { dateOnlyOrNull } from "./dates";
import { STAFF_UNREAD } from "./portalConversations";
import { listReportStatusRegister } from "./reportStatusRegister";
import { getSrsFramework, listSrsAssessments } from "./srsReadinessRecords";
import { LATEST_ASSESSMENT_SQL } from "./srsReviewReminders";

/**
 * The personalised Control Room (BRIEF-crm-control-room-redesign): the signed-in CRM's own work. Phase 1 — quiet counts and
 * the last five jobs they worked on; Phase 2 — the Red box, their conversations, the next fortnight's deadlines and their
 * clients' readiness; Phase 3 — their open tasks, which also feed the Red box and the deadlines. Read-only; nothing here writes.
 *
 * **Whose work.** A job or a client is a CRM's by the routing the platform already uses (crmRouting.ts). A conversation is
 * theirs by its assignee, else its client's CRM (as the message notification routes it).
 *
 * **Last worked on** is the CRM's own latest audit event on the job — the job itself, one of its scope rows or one of its
 * report versions. It is what they did, not what anyone did, and it needs nothing new stored.
 */

const LIVE = "('draft','open','on-hold')";
/** Report stages the team acts on next to get a report out: validate it, publish it, or give the final approval. */
const TO_VALIDATE_OR_ISSUE = new Set<ReportStage>(["ready-to-validate", "ready-to-publish", "awaiting-final-approval"]);
/** Report stages where the client has answered a review and it is the CRM's turn: they responded, or asked for changes. */
const CLIENT_ANSWERED = new Set<ReportStage>(["client-responded", "changes-requested"]);
export const RECENT_JOBS = 5;
/** Read conversations shown after the ones awaiting a reply, most recent first. */
export const RECENT_THREADS = 8;
export const DEADLINE_DAYS = 14;

export type CrmRecentJob = {
  jobId: string; number: string; family: JobFamily; clientId: string; client: string; title: string;
  status: JobScreenReadModel["header"]["status"]; workflowStage: string; dueDate: string | null;
  /** The CRM's own latest act on the job; null for a job of theirs they have not yet worked on. */
  lastWorkedAt: string | null;
};
export type CrmControlRoomCards = {
  liveJobs: number; overdueJobs: number;
  /** Reports sent to the client and not yet answered — to chase. */
  awaitingClient: number;
  toValidateOrIssue: number;
  /** Client messages since the team last replied, on the CRM's conversations, and the clients they come from. */
  unreadMessages: number; unreadClients: number;
  /** SRS reviews falling due by the end of this month, including any already past their date. */
  reviewsDue: number;
  /** Phase 2: the Red box's rows — one per subject. */
  needsMeNow: number;
};
/** One of the CRM's conversations: awaiting a reply (unread > 0), or one of the most recent. */
export type CrmThread = {
  threadId: string; clientId: string; client: string; jobId: string | null; jobNumber: string | null; title: string; subjectLabel: string;
  lastMessageAt: string; unread: number;
  /** When the client's oldest unanswered message was sent; null when nothing is awaiting a reply. */
  waitingSince: string | null;
  /** The client's latest message, cut short — what the widget quotes. */
  preview: string | null;
  /** The client's one SRS readiness conversation (replies go through `srs.message.post`). */
  srs: boolean;
  /** A client review request in it that the CRM has not answered yet (SRS Phase B). */
  reviewRequest: boolean;
  /** The conversation is a report's review comments. */
  reportReview: boolean;
};

/**
 * Phase 2's Red box: one row per subject, the most urgent thing on it. The tiers are the brief's rank — (1) a hard deadline
 * missed, (2) the client waiting on the CRM, (3) a task due (Phase 3), (4) a review date that is today.
 */
export type CrmRedBoxKind =
  | "job-overdue" | "srs-review-overdue"
  | "report-answered" | "srs-review-request" | "awaiting-approval" | "unread"
  | "task-due"
  | "srs-review-today";
export const RED_BOX_TIER: Record<CrmRedBoxKind, 1 | 2 | 3 | 4> = {
  "job-overdue": 1, "srs-review-overdue": 1,
  "report-answered": 2, "srs-review-request": 2, "awaiting-approval": 2, unread: 2,
  "task-due": 3,
  "srs-review-today": 4,
};
export type CrmRedBoxRow = {
  /** `job:<id>`, `thread:<id>`, `srs:<clientId>` or `task:<id>` — what the row is about, and what it was deduped on. */
  subject: string;
  kind: CrmRedBoxKind; tier: 1 | 2 | 3 | 4;
  /** How long it has waited: the date missed, or when the client asked. Oldest first within a tier. */
  since: string;
  clientId: string | null; client: string | null; jobId: string | null; jobNumber: string | null; threadId: string | null;
  /** Phase 3: the task, for a task row; its title is `preview`. */
  taskId: string | null;
  /** The due or review date; a report's stage; a message's unread count and quote — what the row says. */
  date: string | null; stage: ReportStage | null; unread: number; preview: string | null;
  /** The less urgent things on the same subject, collapsed into this row. */
  also: CrmRedBoxKind[];
};

export type CrmDeadlineKind = "srs-review" | "action-due" | "window-closes" | "job-end" | "task-due";
export type CrmDeadline = {
  kind: CrmDeadlineKind; date: string; clientId: string | null; client: string | null; jobId: string | null; jobNumber: string | null;
  /** The action's, the job's or the task's title. */
  label: string;
  /** Phase 3: the task, for a task's due date. */
  taskId: string | null;
  /** For a data-entry window: how many client users' windows close that day. */
  count: number;
};

/** A client's readiness, from its latest completed SRS assessment, read against the framework version it was made against. */
export type CrmPulseRow = { clientId: string; client: string; percent: number; assessedOn: string };

export type CrmControlRoom = {
  userId: string; cards: CrmControlRoomCards; recentJobs: CrmRecentJob[];
  redBox: CrmRedBoxRow[]; threads: CrmThread[]; deadlines: CrmDeadline[];
  /** Lowest readiness first; `notAssessed` counts the CRM's active clients with no completed assessment. */
  pulse: { rows: CrmPulseRow[]; notAssessed: number };
  /** Phase 3: the CRM's open tasks, soonest due first; who a task can be given to, and the jobs a quick-add can name. */
  tasks: CrmTask[];
  taskOptions: { staff: Array<{ userId: string; displayName: string }>; jobs: Array<{ jobId: string; jobNumber: string; client: string }> };
};

const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const dayStart = (day: string) => `${day}T00:00:00.000Z`;

/** `today` is the operating day (`todayInLondon`): overdue and "this month" are judged against it, never the database clock. */
export async function readCrmControlRoom(db: Queryable, input: { userId: string; today: string }): Promise<CrmControlRoom> {
  const { userId, today } = input;
  const jobs = (await db.query<{ job_id: string; job_number: string; client_id: string; client_name: string; due_date: Date | string | null; live: number; overdue: number }>(
    `SELECT j.job_id, j.job_number, j.client_id, c.name AS client_name, j.due_date,
            (j.status IN ${LIVE})::int AS live, (j.status IN ${LIVE} AND j.due_date < $2::date)::int AS overdue
       FROM nzi_console.jobs j JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
      WHERE ${JOB_CRM_SQL} = $1`, [userId, today])).rows;
  const mine = new Set(jobs.map((job) => job.job_id));
  const reports = (await listReportStatusRegister(db)).filter((row) => mine.has(row.jobId));

  // The CRM's conversations: every one awaiting a reply, then the most recent others.
  const threadRows = (await db.query<{ thread_id: string; client_id: string; client_name: string; job_id: string | null; job_number: string | null; title: string; subject_label: string;
    last_message_at: Date | string; unread: number; waiting_since: Date | string | null; preview: string | null; srs_readiness: boolean; review_request: boolean; report_version_id: string | null }>(
    `SELECT q.* FROM (
       SELECT t.thread_id, t.client_id, c.name AS client_name, t.job_id, j.job_number, t.title, s.label AS subject_label, t.last_message_at,
              (${STAFF_UNREAD})::int AS unread, t.srs_readiness, t.report_version_id,
              (SELECT min(x.created_at) FROM nzi_console.portal_messages x WHERE (x.organisation_id, x.thread_id) = (t.organisation_id, t.thread_id) AND x.author_principal = 'portal' AND x.seq > ${LAST_STAFF_SEQ}) AS waiting_since,
              (SELECT left(x.body, 160) FROM nzi_console.portal_messages x WHERE (x.organisation_id, x.thread_id) = (t.organisation_id, t.thread_id) AND x.author_principal = 'portal' ORDER BY x.seq DESC LIMIT 1) AS preview,
              EXISTS (SELECT 1 FROM nzi_console.portal_messages x WHERE (x.organisation_id, x.thread_id) = (t.organisation_id, t.thread_id) AND x.author_principal = 'portal' AND x.review_request AND x.seq > ${LAST_STAFF_SEQ}) AS review_request,
              row_number() OVER (ORDER BY t.last_message_at DESC, t.thread_id) AS recency
         FROM nzi_console.portal_threads t
         JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (t.organisation_id, t.client_id)
         JOIN nzi_console.portal_thread_subjects s ON (s.organisation_id, s.subject_code) = (t.organisation_id, t.subject_code)
         LEFT JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (t.organisation_id, t.job_id)
        WHERE coalesce(t.owner_id, ${CLIENT_CRM_SQL}) = $1) q
      WHERE q.unread > 0 OR q.recency <= ${RECENT_THREADS}
      ORDER BY (q.unread > 0) DESC, q.last_message_at DESC, q.thread_id`, [userId])).rows;
  const threads: CrmThread[] = threadRows.map((row) => ({
    threadId: row.thread_id, clientId: row.client_id, client: row.client_name, jobId: row.job_id, jobNumber: row.job_number, title: row.title, subjectLabel: row.subject_label,
    lastMessageAt: iso(row.last_message_at)!, unread: row.unread, waitingSince: row.unread > 0 ? iso(row.waiting_since) : null, preview: row.preview,
    srs: row.srs_readiness, reviewRequest: row.review_request, reportReview: row.report_version_id !== null,
  }));
  const unreadThreads = threads.filter((thread) => thread.unread > 0);

  // The latest completed assessment of each of the CRM's active clients that is under review: its next review date.
  const reviewDates = (await db.query<{ client_id: string; client_name: string; next_review_date: Date | string }>(
    `SELECT c.client_id, c.name AS client_name, a.next_review_date FROM nzi_console.srs_assessments a
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (a.organisation_id, a.client_id)
      WHERE ${CLIENT_CRM_SQL} = $1 AND c.status = 'active' AND a.status = 'complete' AND a.review_cadence <> 'off' AND a.next_review_date IS NOT NULL
        AND a.assessment_id = ${LATEST_ASSESSMENT_SQL("a")}`, [userId])).rows.map((row) => ({ clientId: row.client_id, client: row.client_name, date: dateOnlyOrNull(row.next_review_date)! }));
  const [year, month, dayOfMonth] = today.split("-").map(Number) as [number, number, number];
  // Day arithmetic on the operating day, anchored at UTC midnight so no offset can move it.
  const monthEnd = utcDay(new Date(Date.UTC(year, month, 0)));
  const horizon = utcDay(new Date(Date.UTC(year, month - 1, dayOfMonth + DEADLINE_DAYS)));

  // When each of the CRM's reports last moved: how long one at a stage has waited.
  const reportMoved = new Map((await db.query<{ job_id: string; moved_at: Date | string }>(
    `SELECT v.job_id, max(greatest(v.created_at, v.published_at, v.sent_to_review_at, v.client_approved_at)) AS moved_at
       FROM nzi_console.report_versions v WHERE v.job_id = ANY($1::text[]) GROUP BY v.job_id`, [[...mine]])).rows.map((row) => [row.job_id, iso(row.moved_at)!]));

  const tasks = await listOpenTasks(db, userId);
  const redBox = dedupeRedBox([
    ...jobs.filter((job) => job.overdue).map((job): RedBoxItem => ({
      subject: `job:${job.job_id}`, kind: "job-overdue", since: dayStart(dateOnlyOrNull(job.due_date)!), clientId: job.client_id, client: job.client_name,
      jobId: job.job_id, jobNumber: job.job_number, threadId: null, taskId: null, date: dateOnlyOrNull(job.due_date), stage: null, unread: 0, preview: null })),
    ...reports.filter((row) => CLIENT_ANSWERED.has(row.stage) || TO_VALIDATE_OR_ISSUE.has(row.stage)).map((row): RedBoxItem => ({
      subject: `job:${row.jobId}`, kind: CLIENT_ANSWERED.has(row.stage) ? "report-answered" : "awaiting-approval", since: reportMoved.get(row.jobId) ?? dayStart(today),
      clientId: row.clientId, client: row.client, jobId: row.jobId, jobNumber: row.jobNumber, threadId: null, taskId: null, date: null, stage: row.stage, unread: 0, preview: null })),
    ...unreadThreads.map((thread): RedBoxItem => ({
      subject: threadSubject(thread), kind: thread.srs && thread.reviewRequest ? "srs-review-request" : "unread", since: thread.waitingSince ?? thread.lastMessageAt,
      clientId: thread.clientId, client: thread.client, jobId: thread.jobId, jobNumber: thread.jobNumber, threadId: thread.threadId, taskId: null, date: null, stage: null, unread: thread.unread, preview: thread.preview })),
    ...reviewDates.filter((review) => review.date <= today).map((review): RedBoxItem => ({
      subject: `srs:${review.clientId}`, kind: review.date < today ? "srs-review-overdue" : "srs-review-today", since: dayStart(review.date),
      clientId: review.clientId, client: review.client, jobId: null, jobNumber: null, threadId: null, taskId: null, date: review.date, stage: null, unread: 0, preview: null })),
    // Phase 3: a task due today or overdue is its own subject — the CRM's own to-do, not the job's or the client's state.
    ...tasks.filter((task) => task.dueDate !== null && task.dueDate <= today).map((task): RedBoxItem => ({
      subject: `task:${task.taskId}`, kind: "task-due", since: dayStart(task.dueDate!), clientId: task.clientId, client: task.client,
      jobId: task.jobId, jobNumber: task.jobNumber, threadId: null, taskId: task.taskId, date: task.dueDate, stage: null, unread: 0, preview: task.title })),
  ]);

  const deadlines = [...await readDeadlines(db, { userId, today, horizon, reviewDates }),
    ...tasks.filter((task) => task.dueDate !== null && task.dueDate >= today && task.dueDate <= horizon).map((task): CrmDeadline => ({
      kind: "task-due", date: task.dueDate!, clientId: task.clientId, client: task.client, jobId: task.jobId, jobNumber: task.jobNumber, label: task.title, taskId: task.taskId, count: 0 })),
  ].sort(byDate);
  const pulse = await readPulse(db, userId);
  const taskOptions = await readTaskOptions(db, JOB_CRM_SQL, userId);

  const recent = (await db.query<{ job_id: string; job_number: string; job_family: JobFamily; client_id: string; client_name: string; title: string;
    status: CrmRecentJob["status"]; workflow_stage: string; due_date: Date | string | null; last_worked_at: Date | string | null }>(
    `WITH worked AS (
       SELECT coalesce(CASE WHEN a.entity_type = 'job' THEN a.entity_id END, r.job_id, v.job_id) AS job_id, max(a.occurred_at) AS last_worked_at
         FROM nzi_console.audit_events a
         LEFT JOIN nzi_console.job_scope_rows r ON a.entity_type = 'scope_row' AND (r.organisation_id, r.scope_row_id) = (a.organisation_id, a.entity_id)
         LEFT JOIN nzi_console.report_versions v ON a.entity_type = 'report_version' AND (v.organisation_id, v.report_version_id) = (a.organisation_id, a.entity_id)
        WHERE a.actor_id = $1 AND a.principal_type = 'staff' AND a.entity_type IN ('job', 'scope_row', 'report_version')
        GROUP BY 1)
     SELECT j.job_id, j.job_number, j.job_family, j.client_id, c.name AS client_name, j.title, j.status, j.workflow_stage, j.due_date, w.last_worked_at
       FROM nzi_console.jobs j
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
       LEFT JOIN worked w ON w.job_id = j.job_id
      WHERE j.status <> 'cancelled' AND (w.job_id IS NOT NULL OR ${JOB_CRM_SQL} = $1)
      ORDER BY w.last_worked_at DESC NULLS LAST, j.sequence DESC
      LIMIT ${RECENT_JOBS}`, [userId])).rows;

  return {
    userId,
    cards: {
      liveJobs: jobs.reduce((sum, job) => sum + job.live, 0),
      overdueJobs: jobs.reduce((sum, job) => sum + job.overdue, 0),
      awaitingClient: reports.filter((row) => row.stage === "awaiting-client").length,
      toValidateOrIssue: reports.filter((row) => TO_VALIDATE_OR_ISSUE.has(row.stage)).length,
      unreadMessages: unreadThreads.reduce((sum, thread) => sum + thread.unread, 0), unreadClients: new Set(unreadThreads.map((thread) => thread.clientId)).size,
      reviewsDue: reviewDates.filter((review) => review.date <= monthEnd).length,
      needsMeNow: redBox.length,
    },
    recentJobs: recent.map((row) => ({
      jobId: row.job_id, number: row.job_number, family: row.job_family, clientId: row.client_id, client: row.client_name, title: row.title,
      status: row.status, workflowStage: row.workflow_stage, dueDate: dateOnlyOrNull(row.due_date), lastWorkedAt: iso(row.last_worked_at),
    })),
    redBox, threads, deadlines, pulse, tasks, taskOptions,
  };
}

/** The seq of the team's latest message in the thread `t` — what "since the team last replied" is measured from. */
const LAST_STAFF_SEQ = `coalesce((SELECT max(y.seq) FROM nzi_console.portal_messages y WHERE (y.organisation_id, y.thread_id) = (t.organisation_id, t.thread_id) AND y.author_principal = 'staff'), 0)`;

/**
 * What a conversation is about, for the dedupe: the client's SRS readiness conversation is their SRS (with its review date); a
 * report's review comments are the job (with its report stage — the same answer seen twice); any other is itself.
 */
const threadSubject = (thread: CrmThread) => thread.srs ? `srs:${thread.clientId}` : thread.reportReview && thread.jobId ? `job:${thread.jobId}` : `thread:${thread.threadId}`;

type RedBoxItem = Omit<CrmRedBoxRow, "tier" | "also">;
const byUrgency = (a: { tier: number; since: string; subject: string }, b: { tier: number; since: string; subject: string }) =>
  a.tier - b.tier || a.since.localeCompare(b.since) || a.subject.localeCompare(b.subject);

/** One row per subject — its most urgent item, the rest named in `also` — ranked by tier, then oldest waiting. */
export function dedupeRedBox(items: readonly RedBoxItem[]): CrmRedBoxRow[] {
  const bySubject = new Map<string, Array<RedBoxItem & { tier: 1 | 2 | 3 | 4 }>>();
  for (const item of items) bySubject.set(item.subject, [...(bySubject.get(item.subject) ?? []), { ...item, tier: RED_BOX_TIER[item.kind] }]);
  return [...bySubject.values()].map((group) => {
    const [top, ...rest] = [...group].sort(byUrgency);
    // A collapsed row keeps a conversation's thread, so its unread is still one click away.
    const thread = group.find((item) => item.threadId !== null);
    return { ...top!, threadId: top!.threadId ?? thread?.threadId ?? null, unread: top!.unread || (thread?.unread ?? 0), also: [...new Set(rest.map((item) => item.kind))].filter((kind) => kind !== top!.kind) };
  }).sort(byUrgency);
}

/** The next fortnight over the CRM's work, today included, nearest first: review dates, actions due, data-entry windows closing, jobs ending. */
async function readDeadlines(db: Queryable, input: { userId: string; today: string; horizon: string; reviewDates: Array<{ clientId: string; client: string; date: string }> }): Promise<CrmDeadline[]> {
  const { userId, today, horizon } = input;
  const within = (date: string) => date >= today && date <= horizon;
  const actions = (await db.query<{ client_id: string; client_name: string; target_date: Date | string; title: string }>(
    `SELECT a.client_id, c.name AS client_name, a.target_date, coalesce(l.title, a.bespoke_title, '') AS title
       FROM nzi_console.client_strategies a
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (a.organisation_id, a.client_id)
       LEFT JOIN nzi_console.reduction_strategies l ON (l.organisation_id, l.strategy_id) = (a.organisation_id, a.strategy_id)
      WHERE ${CLIENT_CRM_SQL} = $1 AND c.status = 'active' AND a.active AND a.status IN ('agreed', 'in_progress')
        AND a.target_date BETWEEN $2::date AND $3::date`, [userId, today, horizon])).rows;
  const windows = (await db.query<{ job_id: string; job_number: string; title: string; client_id: string; client_name: string; closes_on: string; users: number }>(
    `SELECT j.job_id, j.job_number, j.title, j.client_id, c.name AS client_name,
            to_char((g.data_entry_expires_at AT TIME ZONE 'Europe/London')::date, 'YYYY-MM-DD') AS closes_on, count(DISTINCT g.portal_user_id)::int AS users
       FROM nzi_console.portal_access_grants g
       JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (g.organisation_id, g.job_id)
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
      WHERE ${JOB_CRM_SQL} = $1 AND j.status IN ${LIVE} AND g.revoked_at IS NULL AND g.data_entry_expires_at IS NOT NULL
        AND (g.data_entry_expires_at AT TIME ZONE 'Europe/London')::date BETWEEN $2::date AND $3::date
      GROUP BY 1, 2, 3, 4, 5, 6`, [userId, today, horizon])).rows;
  const ends = (await db.query<{ job_id: string; job_number: string; title: string; client_id: string; client_name: string; due_date: Date | string }>(
    `SELECT j.job_id, j.job_number, j.title, j.client_id, c.name AS client_name, j.due_date
       FROM nzi_console.jobs j JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
      WHERE ${JOB_CRM_SQL} = $1 AND j.status IN ${LIVE} AND j.due_date BETWEEN $2::date AND $3::date`, [userId, today, horizon])).rows;
  const none = { jobId: null, jobNumber: null, count: 0, taskId: null };
  return [
    ...input.reviewDates.filter((review) => within(review.date)).map((review): CrmDeadline => ({ kind: "srs-review", date: review.date, clientId: review.clientId, client: review.client, label: "SRS readiness review", ...none })),
    ...actions.map((row): CrmDeadline => ({ kind: "action-due", date: dateOnlyOrNull(row.target_date)!, clientId: row.client_id, client: row.client_name, label: row.title, ...none })),
    ...windows.map((row): CrmDeadline => ({ kind: "window-closes", date: row.closes_on, clientId: row.client_id, client: row.client_name, jobId: row.job_id, jobNumber: row.job_number, label: row.title, count: row.users, taskId: null })),
    ...ends.map((row): CrmDeadline => ({ kind: "job-end", date: dateOnlyOrNull(row.due_date)!, clientId: row.client_id, client: row.client_name, jobId: row.job_id, jobNumber: row.job_number, label: row.title, count: 0, taskId: null })),
  ].sort(byDate);
}
/** Nearest first; on one day, by client (one with none last), then kind. */
const NO_CLIENT = "\uffff";
const byDate = (a: CrmDeadline, b: CrmDeadline) => a.date.localeCompare(b.date) || (a.client ?? NO_CLIENT).localeCompare(b.client ?? NO_CLIENT) || a.kind.localeCompare(b.kind);

/**
 * The CRM's active clients' readiness: each one's latest completed assessment, rolled up by the one resolver every surface
 * reads (`overallReadiness`) against the framework version it was made against, as the SRS dashboard reads it. A client
 * with no completed assessment is counted, never shown as 0%.
 */
async function readPulse(db: Queryable, userId: string): Promise<CrmControlRoom["pulse"]> {
  const clients = (await db.query<{ client_id: string; client_name: string; assessed: boolean }>(
    `SELECT c.client_id, c.name AS client_name,
            EXISTS (SELECT 1 FROM nzi_console.srs_assessments a WHERE (a.organisation_id, a.client_id) = (c.organisation_id, c.client_id) AND a.status = 'complete') AS assessed
       FROM nzi_console.clients c WHERE ${CLIENT_CRM_SQL} = $1 AND c.status = 'active' ORDER BY c.name, c.client_id`, [userId])).rows;
  const frameworks = new Map<string, SrsFramework | null>();
  const rows: CrmPulseRow[] = [];
  // One client at a time: `db` is a single client inside the tenant transaction (see getSrsFramework).
  for (const client of clients.filter((row) => row.assessed)) {
    const latest = latestAssessed(await listSrsAssessments(db, client.client_id));
    if (!latest) continue;
    if (!frameworks.has(latest.frameworkId)) frameworks.set(latest.frameworkId, await getSrsFramework(db, latest.frameworkId));
    const framework = frameworks.get(latest.frameworkId);
    if (!framework) continue;
    rows.push({ clientId: client.client_id, client: client.client_name, percent: overallReadiness(framework, latest.items).percent, assessedOn: latest.assessedOn });
  }
  rows.sort((a, b) => a.percent - b.percent || a.client.localeCompare(b.client));
  return { rows, notAssessed: clients.length - rows.length };
}
