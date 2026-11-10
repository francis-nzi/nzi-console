import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext, type PortalCommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { AuthorizationError } from "../src/auth";
import { readCrmControlRoom } from "../src/crmControlRoom";
import { completeTask, createTask, reopenTask, updateTask } from "../src/crmTasks";
import { VersionConflictError } from "../src/errors";
import { withTenantRead } from "../src/postgres";
import { CommandValidationError } from "../src/postgresCommands";

/**
 * CRM tasks (BRIEF-crm-control-room-p3-tasks, 0222 + matrix v13 0223) against a real database:
 *
 * - a task is created (for the creator by default, or a colleague), rescheduled, reassigned, completed and reopened — each a
 *   versioned command, audited by the task's id, in the caller's organisation; a stale version is refused; a done task leaves
 *   the open list and is never deleted;
 * - only the task's assignee or creator may change it — a third member of staff (Admin included) is refused, as is another
 *   organisation and any portal principal; a Viewer holds no task.manage;
 * - the Control Room reads only the CRM's own open tasks; a task due today or overdue is in the Red box (tier 3, after the
 *   client waiting on the CRM), an upcoming one in the deadlines; a done one in neither.
 */

const ORG = "tasks-org";
const OTHER = "tasks-other";
const TODAY = "2026-11-10";

describe("CRM tasks, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  let keys = 0;
  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const as = (actorId: string, role: StaffRole = "consultant", organisationId = ORG): CommandContext => {
    keys += 1;
    return { organisationId, actorId, principal: "staff", idempotencyKey: `task-${keys}`, correlationId: `corr-task-${keys}`, grant: commandGrantForRole(role, organisationId, actorId) };
  };
  const portal = (): PortalCommandContext => { keys += 1; return { organisationId: ORG, actorId: "pu-1", principal: "portal", portal: { portalUserId: "pu-1", clientId: "c-cam" }, idempotencyKey: `task-${keys}`, correlationId: `corr-task-${keys}` }; };
  const room = (userId: string) => withTenantRead(database.pool, ORG, (db) => readCrmControlRoom(db, { userId, today: TODAY }));
  const row = async (taskId: string) => (await q(`SELECT * FROM nzi_console.crm_tasks WHERE task_id = $1`, [taskId])).rows[0];
  const events = async (taskId: string) => (await q(`SELECT action, actor_id, entity_type, before_json, after_json FROM nzi_console.audit_events WHERE entity_id = $1 ORDER BY occurred_at, audit_event_id`, [taskId])).rows;
  const refusal = async (promise: Promise<unknown>) => {
    try { await promise; return "accepted"; } catch (error) {
      return error instanceof CommandValidationError ? error.issues.map((issue) => issue.code).join(",") : error instanceof VersionConflictError ? "VERSION_CONFLICT" : error instanceof AuthorizationError ? "DENIED" : (error as Error).message;
    }
  };

  before(async () => {
    database = (await createDisposableDatabase("crmtasks"))!;
    admin = await database.admin();
    for (const org of [ORG, OTHER]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await q(`SELECT nzi_console.provision_organisation($1)`, [org]);
    }
    for (const [user, role, status] of [["cam", "consultant", "active"], ["dee", "consultant", "active"], ["ada", "admin", "active"], ["vic", "viewer", "active"], ["gone", "consultant", "suspended"]]) {
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, $4, $5)`, [ORG, user, role, status, `${user} name`]);
    }
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'cam', 'consultant', 'active', 'Cam elsewhere')`, [OTHER]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, client_manager_user_id) VALUES ($1, 'c-cam', 'Cam Co', 'active', 'cam'), ($1, 'c-dee', 'Dee Co', 'active', 'dee')`, [ORG]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, due_date) VALUES ($1, 'j1', 'c-cam', 1, 'crp', 'Footprint', 'open', 'Data entry', '2027-03-31')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'c-far', 'Far Co', 'active')`, [OTHER]);
  });
  after(async () => { await admin?.end(); await database?.end(); });

  let taskId = "";
  it("a task is created for its creator by default, on a job that carries its client, and audited by its id", async () => {
    const created = await createTask(database.pool, { title: "  Chase the gas bills  ", dueDate: "2026-11-12", jobId: "j1" }, as("cam"));
    taskId = created.data.taskId;
    assert.deepEqual(created.data, { taskId, version: 1, status: "open", assignedUserId: "cam", dueDate: "2026-11-12" });
    const stored = await row(taskId);
    assert.equal(stored.title, "Chase the gas bills", "trimmed");
    assert.equal(stored.client_id, "c-cam", "the job carries its client");
    assert.equal(stored.created_by, "cam");
    const [event] = await events(taskId);
    assert.equal(event.action, "task.created");
    assert.equal(event.entity_type, "crm_task");
    assert.equal(event.actor_id, "cam");
    assert.equal(JSON.stringify(event.after_json).includes("gas bills"), false, "the title is working text, not recorded in the event");
  });

  it("a task can be given to an active colleague, never to someone inactive or outside the organisation, and its links are checked", async () => {
    assert.equal((await createTask(database.pool, { title: "For dee", assignedUserId: "dee" }, as("cam"))).data.assignedUserId, "dee");
    assert.equal(await refusal(createTask(database.pool, { title: "For gone", assignedUserId: "gone" }, as("cam"))), "NOT_FOUND");
    assert.equal(await refusal(createTask(database.pool, { title: "Nowhere", jobId: "no-such-job" }, as("cam"))), "NOT_FOUND");
    assert.equal(await refusal(createTask(database.pool, { title: "Mixed", jobId: "j1", clientId: "c-dee" }, as("cam"))), "MISMATCH");
    assert.equal(await refusal(createTask(database.pool, { title: "Far", clientId: "c-far" }, as("cam"))), "NOT_FOUND", "another organisation's client is not found");
    assert.equal(await refusal(createTask(database.pool, { title: " " }, as("cam"))), "INVALID");
    assert.equal(await refusal(createTask(database.pool, { title: "Bad day", dueDate: "2026-02-30" }, as("cam"))), "INVALID");
  });

  it("rescheduled and reassigned through versioned updates, each audited; a stale version and a no-op are refused", async () => {
    const moved = await updateTask(database.pool, { taskId, expectedVersion: 1, dueDate: "2026-11-09" }, as("cam"));
    assert.deepEqual([moved.data.version, moved.data.rescheduled, moved.data.reassigned, moved.data.dueDate], [2, true, false, "2026-11-09"]);
    assert.equal(await refusal(updateTask(database.pool, { taskId, expectedVersion: 1, title: "Late" }, as("cam"))), "VERSION_CONFLICT");
    assert.equal(await refusal(updateTask(database.pool, { taskId, expectedVersion: 2, dueDate: "2026-11-09" }, as("cam"))), "UNCHANGED");
    const handed = await updateTask(database.pool, { taskId, expectedVersion: 2, assignedUserId: "dee" }, as("cam"));
    assert.deepEqual([handed.data.version, handed.data.assignedUserId, handed.data.reassigned], [3, "dee", true]);
    const audit = await events(taskId);
    assert.deepEqual(audit.map((event) => event.action), ["task.created", "task.updated", "task.updated"]);
    assert.deepEqual(audit[1].before_json, { dueDate: "2026-11-12", assignedUserId: "cam", titleChanged: false, notesChanged: false });
    assert.equal(audit[2].before_json.assignedUserId, "cam");
    assert.equal(audit[2].after_json.assignedUserId, "dee");
    // Handed back, so the rest of the suite reads it as cam's.
    await updateTask(database.pool, { taskId, expectedVersion: 3, assignedUserId: "cam" }, as("dee"));
  });

  it("only its assignee or creator may change it: a third colleague, Admin included, another organisation and a portal user are refused", async () => {
    assert.equal(await refusal(updateTask(database.pool, { taskId, expectedVersion: 4, title: "Mine now" }, as("ada", "admin"))), "DENIED", "Admin is not the task's");
    assert.equal(await refusal(completeTask(database.pool, { taskId, expectedVersion: 4 }, as("ada", "admin"))), "DENIED");
    assert.equal(await refusal(updateTask(database.pool, { taskId, expectedVersion: 4, title: "Far" }, as("cam", "consultant", OTHER))), "DENIED", "the same user id elsewhere does not see it");
    assert.equal(await refusal(createTask(database.pool, { title: "A viewer's" }, as("vic", "viewer"))), "DENIED", "the Viewer holds no task.manage");
    assert.equal(await refusal(createTask(database.pool, { title: "From the portal" }, portal() as unknown as CommandContext)), "DENIED");
    assert.equal(await refusal(updateTask(database.pool, { taskId, expectedVersion: 4, title: "From the portal" }, portal() as unknown as CommandContext)), "DENIED");
    assert.equal((await row(taskId)).version, 4, "nothing moved");
  });

  it("completed and reopened — each audited — never deleted; a done task cannot be edited until reopened", async () => {
    const done = await completeTask(database.pool, { taskId, expectedVersion: 4 }, as("cam"));
    assert.deepEqual([done.data.status, done.data.version], ["done", 5]);
    const stored = await row(taskId);
    assert.equal(stored.completed_by, "cam");
    assert.ok(stored.completed_at);
    assert.equal(await refusal(completeTask(database.pool, { taskId, expectedVersion: 5 }, as("cam"))), "ALREADY_DONE");
    assert.equal(await refusal(updateTask(database.pool, { taskId, expectedVersion: 5, title: "After" }, as("cam"))), "DONE");
    assert.ok(!(await room("cam")).tasks.some((task) => task.taskId === taskId), "a done task leaves the open list");
    const reopened = await reopenTask(database.pool, { taskId, expectedVersion: 5 }, as("cam"));
    assert.deepEqual([reopened.data.status, reopened.data.version], ["open", 6]);
    assert.equal((await row(taskId)).completed_at, null);
    assert.deepEqual((await events(taskId)).map((event) => event.action).slice(-2), ["task.completed", "task.reopened"]);
    // Nobody holds DELETE: the console's role cannot remove one.
    await q("BEGIN");
    try {
      await q(`SET LOCAL ROLE nzi_console_app`);
      await q(`SELECT set_config('app.organisation_id', $1, true)`, [ORG]);
      await assert.rejects(q(`DELETE FROM nzi_console.crm_tasks WHERE task_id = $1`, [taskId]), /permission denied/);
    } finally { await q("ROLLBACK"); }
  });

  it("the Control Room reads only the CRM's own open tasks; due today or overdue is in the Red box at tier 3, upcoming in the deadlines", async () => {
    // cam: taskId (due 9 Nov — overdue), one due today, one next week, one with no date, one done. dee: one due today.
    const today = (await createTask(database.pool, { title: "Call Cam Co", dueDate: TODAY, clientId: "c-cam" }, as("cam"))).data.taskId;
    const next = (await createTask(database.pool, { title: "Draft the plan", dueDate: "2026-11-16" }, as("cam"))).data.taskId;
    const undated = (await createTask(database.pool, { title: "Someday" }, as("cam"))).data.taskId;
    const finished = (await createTask(database.pool, { title: "Already done", dueDate: TODAY }, as("cam"))).data.taskId;
    await completeTask(database.pool, { taskId: finished, expectedVersion: 1 }, as("cam"));
    await createTask(database.pool, { title: "Dee's", dueDate: TODAY }, as("dee"));
    // A client waiting on cam (tier 2) ranks above every task; an unanswered message is enough.
    await q(`INSERT INTO nzi_console.portal_threads (organisation_id, thread_id, client_id, scope, subject_code, title, state, started_by_principal, started_by_id, message_count, last_message_at)
             VALUES ($1, 'th-1', 'c-cam', 'client', 'general', 'Hello', 'awaiting_nzi', 'portal', 'pu-1', 1, now())`, [ORG]);
    await q(`INSERT INTO nzi_console.portal_messages (organisation_id, message_id, thread_id, seq, author_principal, author_id, body) VALUES ($1, 'th-1-m1', 'th-1', 1, 'portal', 'pu-1', 'Hi')`, [ORG]);

    const cam = await room("cam");
    assert.deepEqual(cam.tasks.map((task) => task.taskId), [taskId, today, next, undated], "soonest due first, undated last; not dee's, not the done one");
    assert.deepEqual(cam.tasks.find((task) => task.taskId === today), {
      taskId: today, title: "Call Cam Co", notes: "", dueDate: TODAY, status: "open", assignedUserId: "cam", assigneeName: "cam name", createdBy: "cam",
      jobId: null, jobNumber: null, clientId: "c-cam", client: "Cam Co", version: 1,
    });
    assert.deepEqual(cam.redBox.map((row) => [row.subject, row.kind, row.tier]), [
      ["thread:th-1", "unread", 2], [`task:${taskId}`, "task-due", 3], [`task:${today}`, "task-due", 3],
    ], "the client waiting first; then the tasks, oldest due first");
    assert.equal(cam.redBox[1]!.preview, "Chase the gas bills");
    assert.equal(cam.cards.needsMeNow, 3);
    assert.deepEqual(cam.deadlines.filter((row) => row.kind === "task-due").map((row) => [row.taskId, row.date]), [[today, TODAY], [next, "2026-11-16"]],
      "today and upcoming; the overdue one is the Red box's, the undated and the done ones are no deadline");
    assert.deepEqual(cam.taskOptions.staff.map((member) => member.userId), ["ada", "cam", "dee", "vic"], "active staff only");
    assert.deepEqual(cam.taskOptions.jobs, [{ jobId: "j1", jobNumber: "J000001", client: "Cam Co" }]);
    assert.deepEqual((await room("dee")).tasks.map((task) => task.title), ["Dee's", "For dee"]);
  });
});
