import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { clientListSpec, defaultListQuery, jobListSpec, type ClientListQuery, type JobListQuery } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { readCrmControlRoom } from "../src/crmControlRoom";
import { listClients, listJobs } from "../src/listReads";
import { withTenantRead } from "../src/postgres";

/**
 * The personalised Control Room, Phase 1 (BRIEF-crm-control-room-redesign), against a real database:
 *
 * - two CRMs see different jobs and clients, routed as the platform routes them (job manager → client manager → client owner;
 *   a conversation's assignee before its client's CRM);
 * - the recent list is the CRM's own last five by *their* last act on the job (the job, a scope row, a report version), newest
 *   first, topped up with their own jobs not yet worked on; never a cancelled job, never another organisation's;
 * - every card counts only the CRM's own;
 * - the Jobs and Clients lists' `crm` filter lands on exactly that CRM's work.
 */

const ORG = "crm-room-org";
const OTHER = "crm-room-other";
const TODAY = "2026-11-10";
const NOW = Date.parse("2026-11-10T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

describe("the personalised Control Room (Phase 1), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const room = (userId: string, org = ORG) => withTenantRead(database.pool, org, (db) => readCrmControlRoom(db, { userId, today: TODAY }));
  const jobsFor = (crm: string) => withTenantRead(database.pool, ORG, (db) => listJobs(db, { ...defaultListQuery(jobListSpec), filters: { crm: [crm] } } as JobListQuery, { today: TODAY }));
  const clientsFor = (crm: string) => withTenantRead(database.pool, ORG, (db) => listClients(db, { ...defaultListQuery(clientListSpec), filters: { crm: [crm] } } as ClientListQuery, { today: TODAY }));

  before(async () => {
    database = (await createDisposableDatabase("crmroom"))!;
    admin = await database.admin();
    for (const org of [ORG, OTHER]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await q(`SELECT nzi_console.provision_organisation($1)`, [org]);
      for (const [user, name] of [["cam", "Cam Manager"], ["dee", "Dee Manager"]]) {
        await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, 'consultant', 'active', $3)`, [org, user, name]);
      }
    }
    const client = (org: string, id: string, manager: string | null, owner: string | null = null) =>
      q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, client_manager_user_id, owner_user_id) VALUES ($1, $2, $3, 'active', $4, $5)`, [org, id, `Client ${id}`, manager, owner]);
    await client(ORG, "c-cam", "cam");
    await client(ORG, "c-own", null, "cam");     // no manager: the owner is the CRM
    await client(ORG, "c-dee", "dee", "cam");    // the manager wins over the owner
    await client(OTHER, "c-far", "cam");         // the same user id in another organisation

    let sequence = 1;
    const job = (org: string, id: string, clientId: string, fields: { status: string; due?: string | null; manager?: string | null; family?: string }) =>
      q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, due_date, client_manager_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Data entry', $8, $9)`,
        [org, id, clientId, sequence++, fields.family ?? "crp", `Job ${id}`, fields.status, fields.due ?? null, fields.manager ?? null]);
    await job(ORG, "j1", "c-cam", { status: "open", due: "2026-10-31" });               // cam's, overdue
    await job(ORG, "j2", "c-cam", { status: "open", due: "2026-12-31" });               // cam's
    await job(ORG, "j3", "c-dee", { status: "open", due: "2026-12-31", manager: "cam" }); // the job's manager beats the client's
    await job(ORG, "j4", "c-own", { status: "draft", due: "2027-01-31" });              // cam's by the owner
    await job(ORG, "j5", "c-cam", { status: "open", due: "2026-12-31", manager: "dee" }); // dee's, on cam's client
    await job(ORG, "j6", "c-dee", { status: "open", due: "2026-12-31" });               // dee's
    await job(ORG, "j7", "c-cam", { status: "complete", due: "2026-09-30" });           // cam's, not live, not overdue
    await job(ORG, "j8", "c-cam", { status: "cancelled", due: "2026-09-30" });          // cam's, never shown
    await job(OTHER, "jf", "c-far", { status: "open", due: "2026-01-01" });             // another organisation's

    // Reports: j1 validated (ready to publish), j2 published and unanswered (awaiting the client), j6 published (dee's).
    const report = async (id: string, jobId: string, status: string) => {
      const hash = `sha256:${"a".repeat(64)}`;
      await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
               VALUES ($1, $2, $3, 1, 1, $4, '{}'::jsonb, 'cam')`, [ORG, `snap-${id}`, jobId, hash]);
      await q(`INSERT INTO nzi_console.report_versions (organisation_id, report_version_id, job_id, status, manifest_version, reviewed_snapshot_id, data_hash) VALUES ($1, $2, $3, $4, 1, $5, $6)`,
        [ORG, id, jobId, status, `snap-${id}`, hash]);
    };
    await report("rv-j1", "j1", "validated");
    await report("rv-j2", "j2", "published");
    await report("rv-j6", "j6", "published");
    await q(`INSERT INTO nzi_console.job_scope_rows (organisation_id, scope_row_id, job_id, scope, source_label, report_label, level_1, level_2) VALUES ($1, 'sr-j6', 'j6', '1', 'Gas', 'Gas', 'Fuels', 'Gaseous fuels')`, [ORG]);

    // Cam's acts: on dee's job j6 through a scope row (1h ago), on j1 itself (2h, and an older one), on j2 through its report
    // (3h), on the cancelled j8 (just now). Dee's later act on j4 is dee's, not cam's; a portal act is no one's work.
    let event = 0;
    const act = (org: string, actor: string, entityType: string, entityId: string, at: string, principal = "staff") =>
      q(`INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, occurred_at)
         VALUES ($1, $2, $3, $4, 'test.act', $5, $6, $2, $7)`, [org, `ae-${++event}`, actor, principal, entityType, entityId, at]);
    await act(ORG, "cam", "scope_row", "sr-j6", hoursAgo(1));
    await act(ORG, "cam", "job", "j1", hoursAgo(2));
    await act(ORG, "cam", "job", "j1", hoursAgo(240));
    await act(ORG, "cam", "report_version", "rv-j2", hoursAgo(3));
    await act(ORG, "cam", "job", "j8", hoursAgo(0.1));
    await act(ORG, "dee", "job", "j4", hoursAgo(0.5));
    await act(ORG, "cam", "job", "j7", hoursAgo(0.2), "portal");
    await act(OTHER, "cam", "job", "jf", hoursAgo(0.3));

    // Conversations: cam's client thread (2 client messages since the team's reply), cam's owned client (1), a thread on cam's client
    // assigned to dee (dee's), dee's client (2).
    const thread = (id: string, clientId: string, owner: string | null, authors: Array<"portal" | "staff">) => async () => {
      await q(`INSERT INTO nzi_console.portal_threads (organisation_id, thread_id, client_id, scope, subject_code, title, state, owner_id, started_by_principal, started_by_id)
               VALUES ($1, $2, $3, 'client', 'general', 'A question', 'awaiting_nzi', $4, 'portal', 'pu-1')`, [ORG, id, clientId, owner]);
      for (const [index, author] of authors.entries()) {
        await q(`INSERT INTO nzi_console.portal_messages (organisation_id, message_id, thread_id, seq, author_principal, author_id, body) VALUES ($1, $2, $3, $4, $5, $6, 'Hello')`,
          [ORG, `${id}-m${index + 1}`, id, index + 1, author, author === "portal" ? "pu-1" : "cam"]);
      }
    };
    await thread("th-cam", "c-cam", null, ["portal", "staff", "portal", "portal"])();
    await thread("th-own", "c-own", null, ["portal"])();
    await thread("th-assigned", "c-cam", "dee", ["portal"])();
    await thread("th-dee", "c-dee", null, ["portal", "portal"])();

    // SRS: cam's client due this month, cam's owned client next month, dee's client overdue.
    const [framework] = (await q(`SELECT framework_id, version FROM nzi_console.srs_frameworks WHERE organisation_id = $1 ORDER BY version DESC LIMIT 1`, [ORG])).rows;
    const assessed = (id: string, clientId: string, next: string) =>
      q(`INSERT INTO nzi_console.srs_assessments (organisation_id, assessment_id, client_id, framework_id, framework_version, status, started_on, assessed_on, assessed_by, completed_at, review_cadence, next_review_date)
         VALUES ($1, $2, $3, $4, $5, 'complete', '2025-11-20', '2025-11-20', 'cam', now(), 'custom', $6::date)`, [ORG, id, clientId, framework.framework_id, framework.version, next]);
    await assessed("a-cam", "c-cam", "2026-11-25");
    await assessed("a-own", "c-own", "2026-12-05");
    await assessed("a-dee", "c-dee", "2026-10-01");
  });

  after(async () => { await admin?.end(); await database?.end(); });

  it("the recent list is the CRM's own last five by their last act, newest first, then their own jobs not yet worked on", async () => {
    const recent = (await room("cam")).recentJobs;
    assert.deepEqual(recent.map((job) => job.jobId), ["j6", "j1", "j2", "j7", "j4"]);
    assert.equal(recent[0]!.lastWorkedAt, hoursAgo(1), "a scope row's act is the job's");
    assert.equal(recent[1]!.lastWorkedAt, hoursAgo(2), "the latest act, not the first");
    assert.equal(recent[2]!.lastWorkedAt, hoursAgo(3), "a report version's act is the job's");
    assert.equal(recent[3]!.lastWorkedAt, null, "a portal act on j7 is not the CRM's work");
    assert.equal(recent[4]!.lastWorkedAt, null, "dee's act on j4 is not cam's");
    assert.ok(!recent.some((job) => job.jobId === "j8"), "a cancelled job is never shown, even just worked on");
    assert.deepEqual(recent[1], { jobId: "j1", number: "J000001", family: "crp", clientId: "c-cam", client: "Client c-cam", title: "Job j1", status: "open", workflowStage: "Data entry", dueDate: "2026-10-31", lastWorkedAt: hoursAgo(2) });
  });

  it("two CRMs see different work", async () => {
    assert.deepEqual((await room("dee")).recentJobs.map((job) => job.jobId), ["j4", "j6", "j5"], "dee's act on cam's j4 first, then dee's own jobs, newest first");
    assert.deepEqual((await room("cam", OTHER)).recentJobs.map((job) => job.jobId), ["jf"], "the other organisation's cam sees only their own organisation");
  });

  it("the cards count only the CRM's own", async () => {
    assert.deepEqual((await room("cam")).cards, {
      liveJobs: 4, overdueJobs: 1,        // j1 j2 j3 j4; j1 overdue (j7 is complete, j8 cancelled)
      awaitingClient: 1,                  // j2
      toValidateOrIssue: 1,               // j1
      unreadMessages: 3, unreadClients: 2, // th-cam 2, th-own 1; th-assigned is dee's
      reviewsDue: 1,                      // c-cam this month; c-own is next month
    });
    assert.deepEqual((await room("dee")).cards, {
      liveJobs: 2, overdueJobs: 0, awaitingClient: 1, toValidateOrIssue: 0, unreadMessages: 3, unreadClients: 2, reviewsDue: 1,
    });
    assert.deepEqual((await room("nobody")).cards, { liveJobs: 0, overdueJobs: 0, awaitingClient: 0, toValidateOrIssue: 0, unreadMessages: 0, unreadClients: 0, reviewsDue: 0 });
  });

  it("the lists' crm filter lands on exactly that CRM's jobs and clients", async () => {
    const camJobs = await jobsFor("cam");
    assert.deepEqual(camJobs.rows.map((row) => row.id).sort(), ["j1", "j2", "j3", "j4", "j7"], "cancelled stays hidden by default");
    assert.deepEqual((await jobsFor("dee")).rows.map((row) => row.id).sort(), ["j5", "j6"]);
    assert.deepEqual(camJobs.filterOptions.crm, [], "never a control: no options are offered");
    assert.deepEqual((await clientsFor("cam")).rows.map((row) => row.id).sort(), ["c-cam", "c-own"]);
    assert.deepEqual((await clientsFor("dee")).rows.map((row) => row.id), ["c-dee"]);
    assert.equal((await withTenantRead(database.pool, ORG, (db) => listJobs(db, defaultListQuery(jobListSpec), { today: TODAY }))).total, 7, "without it, every job but the cancelled one");
  });
});
