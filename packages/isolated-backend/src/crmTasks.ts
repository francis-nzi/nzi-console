import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import { dateOnlyOrNull } from "./dates";
import { VersionConflictError } from "./errors";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * CRM tasks (BRIEF-crm-control-room-p3-tasks, 0223): the staff to-do list behind the Control Room's My tasks. A task is an
 * internal record — assigned to a member of staff, optionally on a job (which carries its client) or a client — never
 * client-facing and never in a report; it is not a reduction action.
 *
 * Every write is a staff command under `task.manage` (matrix v13), run through the house runner — one transaction, the
 * permission check, the audit event by the task's id, the outbox and idempotency. Only the task's assignee or creator may
 * change it (access.ts). Each change is versioned against what the caller last read; a task is done, never deleted.
 */

export type CrmTask = {
  taskId: string; title: string; notes: string; dueDate: string | null; status: "open" | "done";
  assignedUserId: string; assigneeName: string | null; createdBy: string;
  jobId: string | null; jobNumber: string | null; clientId: string | null; client: string | null;
  version: number;
};
export type TaskResult = { taskId: string; version: number; status: "open" | "done"; assignedUserId: string; dueDate: string | null };

const refuse = (field: string, code: string, message: string) => new CommandValidationError([{ field, code, message }]);
const cleanNotes = (notes: string | null | undefined) => (notes ?? "").trim();

/** An active member of this organisation — who a task may be for. */
async function requireActiveMember(db: Queryable, organisationId: string, userId: string): Promise<void> {
  const member = (await db.query(`SELECT 1 FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2 AND status = 'active'`, [organisationId, userId])).rows[0];
  if (!member) throw refuse("assignedUserId", "NOT_FOUND", "That member of staff was not found.");
}

/** What a task is about: a job carries its own client (and must agree with any client named); a client alone stands. */
async function resolveLinks(db: Queryable, organisationId: string, input: { jobId?: string | null; clientId?: string | null }): Promise<{ jobId: string | null; clientId: string | null }> {
  const jobId = input.jobId?.trim() || null, clientId = input.clientId?.trim() || null;
  if (jobId) {
    const job = (await db.query<{ client_id: string }>(`SELECT client_id FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [organisationId, jobId])).rows[0];
    if (!job) throw refuse("jobId", "NOT_FOUND", "That job was not found.");
    if (clientId && clientId !== job.client_id) throw refuse("clientId", "MISMATCH", "That job is for a different client.");
    return { jobId, clientId: job.client_id };
  }
  if (clientId && !(await db.query(`SELECT 1 FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [organisationId, clientId])).rows[0]) {
    throw refuse("clientId", "NOT_FOUND", "Client was not found.");
  }
  return { jobId: null, clientId };
}

type Locked = { task_id: string; title: string; notes: string; due_date: Date | string | null; status: "open" | "done"; assigned_user_id: string; version: number };
async function lockTask(db: Queryable, context: CommandContext, taskId: string, expectedVersion: number): Promise<Locked> {
  const row = (await db.query<Locked>(
    `SELECT task_id, title, notes, due_date, status, assigned_user_id, version FROM nzi_console.crm_tasks WHERE organisation_id = $1 AND task_id = $2 FOR UPDATE`,
    [context.organisationId, taskId])).rows[0];
  if (!row) throw refuse("taskId", "NOT_FOUND", "That task was not found.");
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}
const result = (row: { task_id: string; version: number; status: "open" | "done"; assigned_user_id: string; due_date: Date | string | null }): TaskResult =>
  ({ taskId: row.task_id, version: row.version, status: row.status, assignedUserId: row.assigned_user_id, dueDate: dateOnlyOrNull(row.due_date) });
const RETURNING = "RETURNING task_id, version, status, assigned_user_id, due_date";

/** Add a task: for the creator unless an active colleague is named; on a job or a client when given. */
export function createTask(pool: PoolLike, input: CommandInputMap["task.create"], context: CommandContext): Promise<StoredOutcome<TaskResult>> {
  return runPostgresCommand(pool, "task.create", input, context, async (db) => {
    const assignee = input.assignedUserId?.trim() || context.actorId;
    await requireActiveMember(db, context.organisationId, assignee);
    const links = await resolveLinks(db, context.organisationId, input);
    const taskId = randomUUID();
    const saved = (await db.query<Parameters<typeof result>[0]>(
      `INSERT INTO nzi_console.crm_tasks (organisation_id, task_id, assigned_user_id, job_id, client_id, title, notes, due_date, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $9) ${RETURNING}`,
      [context.organisationId, taskId, assignee, links.jobId, links.clientId, input.title.trim(), cleanNotes(input.notes), input.dueDate ?? null, context.actorId])).rows[0]!;
    // Audited by id; the event's after is the result — state, assignee and due date, never the title or notes.
    return { data: result(saved), entityType: "crm_task", entityId: taskId, topic: "task.created" };
  });
}

/** Edit an open task: its title or notes, reschedule it (a due date, or none), or reassign it to an active colleague. */
export function updateTask(pool: PoolLike, input: CommandInputMap["task.update"], context: CommandContext): Promise<StoredOutcome<TaskResult & { rescheduled: boolean; reassigned: boolean }>> {
  return runPostgresCommand(pool, "task.update", input, context, async (db) => {
    const task = await lockTask(db, context, input.taskId, input.expectedVersion);
    if (task.status !== "open") throw refuse("taskId", "DONE", "This task is done. Reopen it to change it.");
    const title = input.title === undefined ? task.title : input.title.trim();
    const notes = input.notes === undefined ? task.notes : cleanNotes(input.notes);
    const dueDate = input.dueDate === undefined ? dateOnlyOrNull(task.due_date) : input.dueDate;
    const assignee = input.assignedUserId === undefined ? task.assigned_user_id : input.assignedUserId.trim();
    const rescheduled = dueDate !== dateOnlyOrNull(task.due_date), reassigned = assignee !== task.assigned_user_id;
    if (title === task.title && notes === task.notes && !rescheduled && !reassigned) throw refuse("taskId", "UNCHANGED", "That is what the task already says.");
    if (reassigned) await requireActiveMember(db, context.organisationId, assignee);
    const saved = (await db.query<Parameters<typeof result>[0]>(
      `UPDATE nzi_console.crm_tasks SET title = $3, notes = $4, due_date = $5::date, assigned_user_id = $6, version = version + 1, updated_at = now(), updated_by = $7
        WHERE organisation_id = $1 AND task_id = $2 ${RETURNING}`,
      [context.organisationId, input.taskId, title, notes, dueDate, assignee, context.actorId])).rows[0]!;
    return { data: { ...result(saved), rescheduled, reassigned }, entityType: "crm_task", entityId: input.taskId, topic: "task.updated",
      before: { dueDate: dateOnlyOrNull(task.due_date), assignedUserId: task.assigned_user_id, titleChanged: title !== task.title, notesChanged: notes !== task.notes } };
  });
}

/** Mark an open task done, or reopen a done one. Each is its own audited transition. */
function setStatus(key: "task.complete" | "task.reopen", to: "open" | "done") {
  return (pool: PoolLike, input: CommandInputMap[typeof key], context: CommandContext): Promise<StoredOutcome<TaskResult>> =>
    runPostgresCommand(pool, key, input, context, async (db) => {
      const task = await lockTask(db, context, input.taskId, input.expectedVersion);
      if (task.status === to) throw refuse("taskId", to === "done" ? "ALREADY_DONE" : "ALREADY_OPEN", to === "done" ? "This task is already done." : "This task is already open.");
      const saved = (await db.query<Parameters<typeof result>[0]>(
        `UPDATE nzi_console.crm_tasks SET status = $3, completed_at = CASE WHEN $3 = 'done' THEN now() END, completed_by = CASE WHEN $3 = 'done' THEN $4 END,
                version = version + 1, updated_at = now(), updated_by = $4
          WHERE organisation_id = $1 AND task_id = $2 ${RETURNING}`,
        [context.organisationId, input.taskId, to, context.actorId])).rows[0]!;
      return { data: result(saved), entityType: "crm_task", entityId: input.taskId, topic: to === "done" ? "task.completed" : "task.reopened",
        before: { status: task.status } };
    });
}
export const completeTask = setStatus("task.complete", "done");
export const reopenTask = setStatus("task.reopen", "open");

/** One CRM's open tasks, soonest due first (undated last), with what each is about — the widget's and the drawer's read. */
export async function listOpenTasks(db: Queryable, userId: string): Promise<CrmTask[]> {
  const rows = (await db.query<{ task_id: string; title: string; notes: string; due_date: Date | string | null; status: "open" | "done"; assigned_user_id: string; assignee_name: string | null;
    created_by: string; job_id: string | null; job_number: string | null; client_id: string | null; client_name: string | null; version: number }>(
    `SELECT t.task_id, t.title, t.notes, t.due_date, t.status, t.assigned_user_id, m.display_name AS assignee_name, t.created_by,
            t.job_id, j.job_number, t.client_id, c.name AS client_name, t.version
       FROM nzi_console.crm_tasks t
       LEFT JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (t.organisation_id, t.assigned_user_id)
       LEFT JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (t.organisation_id, t.job_id)
       LEFT JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (t.organisation_id, t.client_id)
      WHERE t.assigned_user_id = $1 AND t.status = 'open'
      ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC, t.task_id`, [userId])).rows;
  return rows.map((row) => ({
    taskId: row.task_id, title: row.title, notes: row.notes, dueDate: dateOnlyOrNull(row.due_date), status: row.status,
    assignedUserId: row.assigned_user_id, assigneeName: row.assignee_name, createdBy: row.created_by,
    jobId: row.job_id, jobNumber: row.job_number, clientId: row.client_id, client: row.client_name, version: row.version,
  }));
}

/** Who a task can be given to (the organisation's active staff), and the CRM's live jobs a quick-add can name. */
export async function readTaskOptions(db: Queryable, jobCrmSql: string, userId: string): Promise<{ staff: Array<{ userId: string; displayName: string }>; jobs: Array<{ jobId: string; jobNumber: string; client: string }> }> {
  const staff = (await db.query<{ user_id: string; display_name: string | null }>(
    `SELECT user_id, display_name FROM nzi_console.memberships WHERE status = 'active' ORDER BY lower(coalesce(display_name, user_id))`)).rows;
  const jobs = (await db.query<{ job_id: string; job_number: string; client_name: string }>(
    `SELECT j.job_id, j.job_number, c.name AS client_name FROM nzi_console.jobs j JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
      WHERE ${jobCrmSql} = $1 AND j.status IN ('draft', 'open', 'on-hold') ORDER BY j.sequence DESC`, [userId])).rows;
  return {
    staff: staff.map((member) => ({ userId: member.user_id, displayName: member.display_name ?? member.user_id })),
    jobs: jobs.map((job) => ({ jobId: job.job_id, jobNumber: job.job_number, client: job.client_name })),
  };
}
