import type { JobFamily, JobScreenReadModel } from "./readModels";
import type { Queryable } from "./postgres";
import { CLIENT_CRM_SQL, JOB_CRM_SQL } from "./crmRouting";
import { dateOnlyOrNull } from "./dates";
import { STAFF_UNREAD } from "./portalConversations";
import { listReportStatusRegister } from "./reportStatusRegister";
import { LATEST_ASSESSMENT_SQL } from "./srsReviewReminders";

/**
 * The personalised Control Room, Phase 1 (BRIEF-crm-control-room-redesign): the signed-in CRM's own work — quiet counts and
 * the last five jobs they worked on. Read-only; nothing here writes, and nothing is stored that the platform does not
 * already keep.
 *
 * **Whose work.** A job or a client is a CRM's by the routing the platform already uses (crmRouting.ts). A conversation is
 * theirs by its assignee, else its client's CRM (as the message notification routes it).
 *
 * **Last worked on** is the CRM's own latest audit event on the job — the job itself, one of its scope rows or one of its
 * report versions. It is what they did, not what anyone did, and it needs nothing new stored.
 */

const LIVE = "('draft','open','on-hold')";
/** Report stages the team acts on next to get a report out: validate it, publish it, or give the final approval. */
const TO_VALIDATE_OR_ISSUE = new Set(["ready-to-validate", "ready-to-publish", "awaiting-final-approval"]);
export const RECENT_JOBS = 5;

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
};
export type CrmControlRoom = { userId: string; cards: CrmControlRoomCards; recentJobs: CrmRecentJob[] };

const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();

/** `today` is the operating day (`todayInLondon`): overdue and "this month" are judged against it, never the database clock. */
export async function readCrmControlRoom(db: Queryable, input: { userId: string; today: string }): Promise<CrmControlRoom> {
  const { userId, today } = input;
  const jobs = (await db.query<{ job_id: string; live: number; overdue: number }>(
    `SELECT j.job_id, (j.status IN ${LIVE})::int AS live, (j.status IN ${LIVE} AND j.due_date < $2::date)::int AS overdue
       FROM nzi_console.jobs j JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
      WHERE ${JOB_CRM_SQL} = $1`, [userId, today])).rows;
  const mine = new Set(jobs.map((job) => job.job_id));
  const reports = (await listReportStatusRegister(db)).filter((row) => mine.has(row.jobId));

  const [unread] = (await db.query<{ messages: number; clients: number }>(
    `SELECT coalesce(sum(u.unread), 0)::int AS messages, count(DISTINCT u.client_id) FILTER (WHERE u.unread > 0)::int AS clients
       FROM (SELECT t.client_id, (${STAFF_UNREAD})::int AS unread
               FROM nzi_console.portal_threads t JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (t.organisation_id, t.client_id)
              WHERE coalesce(t.owner_id, ${CLIENT_CRM_SQL}) = $1) u`, [userId])).rows;

  const [reviews] = (await db.query<{ due: number }>(
    `SELECT count(*)::int AS due FROM nzi_console.srs_assessments a
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (a.organisation_id, a.client_id)
      WHERE ${CLIENT_CRM_SQL} = $1 AND c.status = 'active' AND a.status = 'complete' AND a.review_cadence <> 'off'
        AND a.next_review_date <= (date_trunc('month', $2::date) + interval '1 month - 1 day')::date
        AND a.assessment_id = ${LATEST_ASSESSMENT_SQL("a")}`, [userId, today])).rows;

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
      unreadMessages: unread?.messages ?? 0, unreadClients: unread?.clients ?? 0,
      reviewsDue: reviews?.due ?? 0,
    },
    recentJobs: recent.map((row) => ({
      jobId: row.job_id, number: row.job_number, family: row.job_family, clientId: row.client_id, client: row.client_name, title: row.title,
      status: row.status, workflowStage: row.workflow_stage, dueDate: dateOnlyOrNull(row.due_date), lastWorkedAt: iso(row.last_worked_at),
    })),
  };
}
