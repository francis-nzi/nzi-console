import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { addCalendarMonths, commandGrantForRole, todayInLondon, utcDay, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { updateReminderSettings } from "../src/dueReminders";
import { emailDispatchFromEnv } from "../src/email";
import { VersionConflictError } from "../src/errors";
import { suppressingMailer } from "../src/mailer";
import { withTenantRead } from "../src/postgres";
import { completeSrsAssessment, getSrsAssessment, getSrsFramework, reopenSrsAssessment, setSrsAssessmentItem, startSrsAssessment } from "../src/srsReadiness";
import { readSrsReviewStatus, setSrsReviewSchedule } from "../src/srsReviewReminders";
import { runWorkerTick } from "../src/strategyReminderWorker";

/**
 * The SRS review loop, Phase A (0220), against a real database, with the tick run as the role it really runs as:
 *
 * - completing an assessment sets its review date — annual by default; the CRM changes it (biannual, a date, off) under
 *   srs.manage, versioned and audited, on the latest completed assessment only; the backfill gives every completed one annual;
 * - the reminder is owed at review date − lead and goes **to the CRM** (the client's manager, else its owner) — never to the
 *   client's contacts — once per assessment per review date; a changed date re-arms; off sends nothing; a superseded or
 *   reopened assessment sends nothing;
 * - it goes through the existing outbox and drain, scan and send in separate transactions, audited by reference;
 * - a reopen after the reminder is the existing command — a new version, a draft again (pinned).
 */

const ORG = "srs-review-org";
const TODAY = todayInLondon();
const day = (offset: number) => utcDay(new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000));
const ORIGIN = "https://console.example.test";
const KEYED = { NZI_DATABASE_BOUNDARY: "isolated-non-production", NEXT_PUBLIC_APP_ENV: "staging", RESEND_API_KEY: "re_test_0123456789abcdef", EMAIL_FROM: "Net Zero International <no-reply@netzero.international>" };
const ENV = { appEnv: "staging", boundaryToken: "isolated-non-production" };
let keys = 0;
const context = (role: StaffRole = "admin"): CommandContext => {
  keys += 1;
  return { organisationId: ORG, actorId: "ada", principal: "staff", idempotencyKey: `srsr-${keys}`, correlationId: `corr-srsr-${keys}`, grant: commandGrantForRole(role, ORG, "ada") };
};
const refused = (code: string) => (error: Error & { issues?: Array<{ code: string }> }) => error.issues?.some((issue) => issue.code === code) === true;

type Posted = { to: string; subject: string; html: string; text: string };
function resend(): typeof fetch & { posted: Posted[] } {
  const posted: Posted[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    posted.push({ to: body.to[0], subject: body.subject, html: body.html, text: body.text });
    return new Response(JSON.stringify({ id: `re-${posted.length}` }), { status: 200 });
  }) as unknown as typeof fetch & { posted: Posted[] };
  impl.posted = posted;
  return impl;
}

describe("SRS review loop — review date + reminder to the CRM (0220), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  let framework: { framework_id: string; version: number };
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const tick = (fetchImpl = resend()) =>
    runWorkerTick(database.pool, { organisationId: ORG, today: TODAY, mailer: suppressingMailer(), email: emailDispatchFromEnv(KEYED, fetchImpl), env: ENV, consoleOrigin: ORIGIN });
  const markers = (assessmentId: string) => q<{ review_date: string; recipient_user_id: string }>(
    `SELECT to_char(review_date, 'YYYY-MM-DD') AS review_date, recipient_user_id FROM nzi_console.srs_review_reminders WHERE assessment_id = $1 ORDER BY review_date`, [assessmentId]);
  const review = (clientId: string) => withTenantRead(database.pool, ORG, (db) => readSrsReviewStatus(db, { clientId, today: TODAY }));
  const versionOf = async (assessmentId: string) => (await q<{ version: number }>(`SELECT version FROM nzi_console.srs_assessments WHERE assessment_id = $1`, [assessmentId]))[0]!.version;
  /** A client with a completed assessment, as a fixture: its review date given outright. */
  const completed = async (clientId: string, assessmentId: string, input: { assessedOn?: string; cadence?: string; next?: string | null; manager?: string | null; owner?: string | null; addClient?: boolean }) => {
    if (input.addClient !== false) {
      await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, client_manager_user_id, owner_user_id) VALUES ($1, $2, $3, 'active', $4, $5)`,
        [ORG, clientId, `Client ${clientId}`, input.manager === undefined ? "cam" : input.manager, input.owner ?? null]);
      // Every client has a consenting contact with an address: the reminder must never reach them.
      await q(`INSERT INTO nzi_console.client_contacts (organisation_id, contact_id, client_id, full_name, email, status, email_consent, created_by, updated_by)
               VALUES ($1, $2, $3, 'Grace Client', $4, 'active', 'granted', 'seed', 'seed')`, [ORG, `k-${clientId}`, clientId, `grace.${clientId}@netzero.international`]);
    }
    const assessedOn = input.assessedOn ?? day(-300);
    const cadence = input.cadence ?? "custom";
    await q(`INSERT INTO nzi_console.srs_assessments (organisation_id, assessment_id, client_id, framework_id, framework_version, status, started_on, assessed_on, assessed_by, completed_at, review_cadence, next_review_date)
             VALUES ($1, $2, $3, $4, $5, 'complete', $6::date, $6::date, 'ada', now(), $7, $8::date)`,
      [ORG, assessmentId, clientId, framework.framework_id, framework.version, assessedOn, cadence, input.next === undefined ? day(3) : input.next]);
  };

  before(async () => {
    database = (await createDisposableDatabase("srsreview", {
      // A completed assessment from before 0220 (hooked after 0218), assessed on a leap day: the backfill gives it annual, 28 Feb the year after.
      onMigration: async (filename, client) => {
        if (!filename.startsWith("0218_")) return;
        await client.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'SRS Review House')`, [ORG]);
        await client.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
        await client.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'legacy', 'Legacy', 'active')`, [ORG]);
        const [fw] = (await client.query(`SELECT framework_id, version FROM nzi_console.srs_frameworks WHERE organisation_id = $1 ORDER BY version DESC LIMIT 1`, [ORG])).rows;
        await client.query(`INSERT INTO nzi_console.srs_assessments (organisation_id, assessment_id, client_id, framework_id, framework_version, status, started_on, assessed_on, assessed_by, completed_at)
          VALUES ($1, 'legacy-done', 'legacy', $2, $3, 'complete', '2024-02-29', '2024-02-29', 'v7', now()),
                 ($1, 'legacy-draft', 'legacy', $2, $3, 'draft', '2024-06-01', NULL, 'v7', NULL)`, [ORG, fw.framework_id, fw.version]);
      },
    }))!;
    admin = await database.admin();
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email) VALUES
      ($1, 'ada', 'admin', 'active', 'Ada Admin', 'ada@netzero.international'),
      ($1, 'cam', 'consultant', 'active', 'Cam Manager', 'cam@netzero.international'),
      ($1, 'olly', 'consultant', 'active', 'Olly Owner', 'olly@netzero.international'),
      ($1, 'gone', 'consultant', 'suspended', 'Gone Member', 'gone@netzero.international')`, [ORG]);
    framework = (await q<{ framework_id: string; version: number }>(`SELECT framework_id, version FROM nzi_console.srs_frameworks WHERE organisation_id = $1 ORDER BY version DESC LIMIT 1`, [ORG]))[0]!;

    await completed("due", "a-due", {});                                        // review in 3 days: owed on the default 7
    await completed("overdue", "a-overdue", { next: day(-10) });                // past its date and never reminded: still owed
    await completed("owner-only", "a-owner", { manager: null, owner: "olly" }); // no manager: the owner is the CRM
    await completed("far", "a-far", { next: day(30) });                         // not yet
    // Off: never — assessed long enough ago that annual would be overdue, so off is the only thing stopping it.
    await completed("off", "a-off", { cadence: "off", next: null, assessedOn: day(-400) });
    await completed("no-crm", "a-nocrm", { manager: null, owner: null });       // nobody to tell: blocked, surfaced
    await completed("inactive-crm", "a-inactive", { manager: "gone" });         // a disabled member: blocked
    // Superseded: an older completed assessment due now, under a later one not yet due — only the latest is reviewed.
    await completed("superseded", "a-old", { assessedOn: day(-700), next: day(-1) });
    await completed("superseded", "a-new", { assessedOn: day(-20), next: day(200), addClient: false });
    // A reassessment in progress: the completed one is no longer the latest, so its review is under way.
    await completed("drafting", "a-drafting-done", { next: day(1) });
    await q(`INSERT INTO nzi_console.srs_assessments (organisation_id, assessment_id, client_id, framework_id, framework_version, status, started_on, assessed_by)
             VALUES ($1, 'a-drafting-new', 'drafting', $2, $3, 'draft', $4::date, 'ada')`, [ORG, framework.framework_id, framework.version, day(-2)]);
  });
  after(async () => { await admin?.end(); await database?.end(); });

  it("0220: the backfill gives every completed assessment annual (29 Feb + 12 months = 28 Feb), a draft nothing; the shape is held", async () => {
    const rows = await q(`SELECT assessment_id, review_cadence, to_char(next_review_date, 'YYYY-MM-DD') AS next FROM nzi_console.srs_assessments WHERE client_id = 'legacy' ORDER BY assessment_id`);
    assert.deepEqual(rows, [{ assessment_id: "legacy-done", review_cadence: "annual", next: "2025-02-28" }, { assessment_id: "legacy-draft", review_cadence: null, next: null }]);
    assert.equal(addCalendarMonths("2024-02-29", 12), "2025-02-28", "the contract's month arithmetic is Postgres's");
    await assert.rejects(q(`UPDATE nzi_console.srs_assessments SET review_cadence = NULL, next_review_date = NULL WHERE assessment_id = 'legacy-done'`), /srs_assessments_review_shape/);
    await assert.rejects(q(`UPDATE nzi_console.srs_assessments SET review_cadence = 'off' WHERE assessment_id = 'legacy-done'`), /srs_assessments_review_shape/, "off is exactly no date");
    await assert.rejects(q(`UPDATE nzi_console.srs_assessments SET review_cadence = 'weekly' WHERE assessment_id = 'legacy-done'`), /check constraint/);
  });

  it("the worker reads the schedule columns and not the notes; it marks, never unmarks; the console cannot mark", async () => {
    const [grants] = await q<Record<string, boolean>>(`SELECT
      has_column_privilege('nzi_console_worker', 'nzi_console.srs_assessments', 'next_review_date', 'SELECT') AS schedule,
      has_column_privilege('nzi_console_worker', 'nzi_console.srs_assessments', 'notes', 'SELECT') AS notes,
      has_table_privilege('nzi_console_worker', 'nzi_console.srs_assessments', 'UPDATE') AS edit,
      has_table_privilege('nzi_console_worker', 'nzi_console.srs_review_reminders', 'INSERT') AS mark,
      has_table_privilege('nzi_console_worker', 'nzi_console.srs_review_reminders', 'DELETE') AS unmark,
      has_table_privilege('nzi_console_app', 'nzi_console.srs_review_reminders', 'INSERT') AS app_mark`);
    assert.deepEqual(grants, { schedule: true, notes: false, edit: false, mark: true, unmark: false, app_mark: false });
  });

  it("completing an assessment sets its review date — annual, from the assessed date — and audits it", async () => {
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, client_manager_user_id) VALUES ($1, 'fresh', 'Fresh Ltd', 'active', 'cam')`, [ORG]);
    const started = await startSrsAssessment(database.pool, { clientId: "fresh" }, context());
    const id = started.data.assessmentId;
    const fw = (await withTenantRead(database.pool, ORG, (db) => getSrsFramework(db)))!;
    for (const requirement of fw.requirements.filter((entry) => entry.active)) {
      await setSrsAssessmentItem(database.pool, { assessmentId: id, requirementId: requirement.id, maturity: 2, evidenceKind: "note", evidenceNote: "Workshop", expectedVersion: 0 }, context());
    }
    const done = await completeSrsAssessment(database.pool, { assessmentId: id, expectedVersion: await versionOf(id) }, context());
    assert.deepEqual([done.data.reviewCadence, done.data.nextReviewDate], ["annual", addCalendarMonths(TODAY, 12)]);
    const [audit] = await q(`SELECT after_json FROM nzi_console.audit_events WHERE action = 'srs_assessment_completed' AND entity_id = $1`, [id]);
    assert.deepEqual([audit!.after_json.reviewCadence, audit!.after_json.nextReviewDate], ["annual", addCalendarMonths(TODAY, 12)]);
    const status = (await review("fresh"))!;
    assert.deepEqual([status.assessmentId, status.cadence, status.nextReviewDate], [id, "annual", addCalendarMonths(TODAY, 12)]);
    assert.deepEqual(status.reminder, { state: "reminders-off" }, "the Admin switch is off: said so, not silently dropped");

    // A reopened, re-completed assessment keeps the cadence it had: biannual stays biannual from the new assessed date.
    await setSrsReviewSchedule(database.pool, { assessmentId: id, cadence: "biannual", expectedVersion: await versionOf(id) }, context());
    await reopenSrsAssessment(database.pool, { assessmentId: id, expectedVersion: await versionOf(id) }, context());
    const again = await completeSrsAssessment(database.pool, { assessmentId: id, expectedVersion: await versionOf(id) }, context());
    assert.deepEqual([again.data.reviewCadence, again.data.nextReviewDate], ["biannual", addCalendarMonths(TODAY, 6)]);
  });

  it("the CRM sets the cadence, a date or off — srs.manage, versioned, audited, the latest completed assessment only", async () => {
    const v = () => versionOf("a-far");
    const biannual = await setSrsReviewSchedule(database.pool, { assessmentId: "a-far", cadence: "biannual", expectedVersion: await v() }, context());
    assert.equal(biannual.data.nextReviewDate, addCalendarMonths(day(-300), 6));
    const custom = await setSrsReviewSchedule(database.pool, { assessmentId: "a-far", cadence: "custom", customDate: day(40), expectedVersion: await v() }, context());
    assert.equal(custom.data.nextReviewDate, day(40));
    const [audit] = await q(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE action = 'srs_assessment_review_set' AND entity_id = 'a-far' ORDER BY occurred_at DESC LIMIT 1`);
    assert.deepEqual(audit!.before_json, { cadence: "biannual", nextReviewDate: addCalendarMonths(day(-300), 6) });
    assert.deepEqual([audit!.after_json.cadence, audit!.after_json.nextReviewDate], ["custom", day(40)]);

    await assert.rejects(setSrsReviewSchedule(database.pool, { assessmentId: "a-far", cadence: "annual", expectedVersion: await v() }, context("viewer")), /srs\.manage|permission|not allowed/i);
    await assert.rejects(setSrsReviewSchedule(database.pool, { assessmentId: "a-far", cadence: "annual", expectedVersion: (await v()) + 1 }, context()), VersionConflictError);
    await assert.rejects(setSrsReviewSchedule(database.pool, { assessmentId: "a-far", cadence: "custom", customDate: day(-1), expectedVersion: await v() }, context()), refused("IN_PAST"));
    await assert.rejects(setSrsReviewSchedule(database.pool, { assessmentId: "a-far", cadence: "custom", customDate: day(40), expectedVersion: await v() }, context()), refused("UNCHANGED"));
    await assert.rejects(setSrsReviewSchedule(database.pool, { assessmentId: "a-old", cadence: "annual", expectedVersion: await versionOf("a-old") }, context()), refused("NOT_LATEST"));
    await assert.rejects(setSrsReviewSchedule(database.pool, { assessmentId: "a-drafting-new", cadence: "annual", expectedVersion: await versionOf("a-drafting-new") }, context()), refused("NOT_COMPLETE"));
    await assert.rejects(setSrsReviewSchedule(database.pool, { assessmentId: "a-far", cadence: "custom", expectedVersion: await v() }, context()), refused("INVALID"), "custom needs its date");
    // Back where the fixture had it: 30 days out.
    await setSrsReviewSchedule(database.pool, { assessmentId: "a-far", cadence: "custom", customDate: day(30), expectedVersion: await v() }, context());
  });

  it("off by default: the tick considers nothing and sends nothing", async () => {
    const result = await tick();
    assert.deepEqual(result.srsReviewReminders.ok && result.srsReviewReminders.summary, { enabled: false, owed: 0, enqueued: 0, blocked: { "no-crm": 0, "crm-inactive": 0, "no-email": 0 }, refused: 0 });
    assert.equal((await q(`SELECT 1 FROM nzi_console.email_messages WHERE template_code = 'srs.review.due'`)).length, 0);
  });

  it("switched on, the scan enqueues what is owed — to the CRM, never the client — and sends nothing", async () => {
    const [row] = await q<{ version: number }>(`SELECT version FROM nzi_console.organisation_reminder_settings WHERE organisation_id = $1`, [ORG]);
    await updateReminderSettings(database.pool, { enabled: true, defaultLeadDays: 7, expectedVersion: row?.version ?? null }, context());
    const fetchImpl = resend();
    const result = await tick(fetchImpl);
    assert.ok(result.srsReviewReminders.ok, result.srsReviewReminders.ok ? "" : result.srsReviewReminders.error);
    // due, overdue and owner-only go; no-crm and inactive-crm are owed and blocked; far, off, superseded and drafting are not owed.
    assert.deepEqual(result.srsReviewReminders.summary, { enabled: true, owed: 5, enqueued: 3, blocked: { "no-crm": 1, "crm-inactive": 1, "no-email": 0 }, refused: 0 });
    assert.equal(fetchImpl.posted.length, 0, "enqueued only: the email drain ran before the scan, in its own transaction");
    const queued = await q<{ to_email: string; status: string }>(`SELECT to_email, status FROM nzi_console.email_messages WHERE template_code = 'srs.review.due' ORDER BY to_email`);
    assert.deepEqual(queued.map((mail) => [mail.to_email, mail.status]), [
      ["cam@netzero.international", "queued"], ["cam@netzero.international", "queued"], ["olly@netzero.international", "queued"],
    ]);
    assert.equal((await q(`SELECT 1 FROM nzi_console.email_messages WHERE to_email LIKE 'grace.%'`)).length, 0, "no client contact is written to");
    assert.equal((await q(`SELECT 1 FROM nzi_console.transactional_outbox WHERE topic = 'email.send' AND state = 'pending'`)).length, 3, "into the existing outbox");
    assert.deepEqual(await markers("a-due"), [{ review_date: day(3), recipient_user_id: "cam" }]);
    assert.deepEqual(await markers("a-owner"), [{ review_date: day(3), recipient_user_id: "olly" }], "no manager: the client's owner");
    for (const id of ["a-far", "a-off", "a-old", "a-new", "a-drafting-done", "a-nocrm", "a-inactive"]) assert.deepEqual(await markers(id), [], `${id}: no reminder`);
  });

  it("is audited by template and user id — never the address", async () => {
    const audits = await q<{ actor_id: string; principal_type: string; entity_id: string; after_json: Record<string, unknown> }>(
      `SELECT actor_id, principal_type, entity_id, after_json FROM nzi_console.audit_events WHERE action = 'srs_review_reminder_enqueued' ORDER BY entity_id`);
    assert.deepEqual(audits.map((row) => row.entity_id), ["a-due", "a-overdue", "a-owner"]);
    for (const row of audits) {
      assert.deepEqual([row.actor_id, row.principal_type, row.after_json.templateCode], ["worker:srs-review-reminders", "system", "srs.review.due"]);
      assert.ok(!JSON.stringify(row.after_json).includes("@"), "no address in the audit trail");
      assert.deepEqual(Object.keys(row.after_json).sort(), ["emailMessageId", "leadDays", "recipientUserId", "reviewDate", "templateCode"]);
    }
  });

  it("the existing drain sends them on the next tick: a date and a link into the SRS area, no score", async () => {
    const fetchImpl = resend();
    const result = await tick(fetchImpl);
    assert.deepEqual(result.emails.ok && result.emails.summary, { sent: 3, stubbed: 0, retried: 0, failed: 0 });
    const mail = fetchImpl.posted.find((posted) => posted.subject.includes("Client due"))!;
    assert.equal(mail.to, "cam@netzero.international");
    assert.match(mail.text, /^Hello Cam,/);
    assert.match(mail.html, /href="https:\/\/console\.example\.test\/clients\/due\?area=srs"/);
    assert.ok(!/maturity|of 4|score/i.test(mail.text), "no assessment detail in the email");
    assert.ok(result.srsReviewReminders.ok && result.srsReviewReminders.summary.enqueued === 0, "nothing more owed");
  });

  it("fires once per assessment per review date: a further tick sends nothing", async () => {
    const fetchImpl = resend();
    const result = await tick(fetchImpl);
    // Only the two blocked ones are still owed: the three sent are marked for their date and no longer candidates.
    assert.deepEqual(result.srsReviewReminders.ok && result.srsReviewReminders.summary, { enabled: true, owed: 2, enqueued: 0, blocked: { "no-crm": 1, "crm-inactive": 1, "no-email": 0 }, refused: 0 });
    assert.equal(fetchImpl.posted.length, 0);
    assert.equal((await q(`SELECT 1 FROM nzi_console.email_messages WHERE template_code = 'srs.review.due'`)).length, 3);
  });

  it("the SRS area says where each reminder stands — sent, scheduled, or blocked and why", async () => {
    assert.equal((await review("due"))!.reminder.state, "sent");
    assert.deepEqual((await review("far"))!.reminder, { state: "scheduled", reviewDate: day(30), remindOn: day(23), leadDays: 7, blocked: null });
    assert.deepEqual((await review("no-crm"))!.reminder, { state: "due", reviewDate: day(3), leadDays: 7, blocked: "no-crm" });
    assert.deepEqual((await review("off"))!.reminder, { state: "off" });
    assert.equal(await review("drafting"), null, "a reassessment in progress: no review date to show");
  });

  it("re-arms when the CRM moves the date; off sends nothing", async () => {
    await setSrsReviewSchedule(database.pool, { assessmentId: "a-due", cadence: "custom", customDate: day(5), expectedVersion: await versionOf("a-due") }, context());
    await setSrsReviewSchedule(database.pool, { assessmentId: "a-nocrm", cadence: "off", expectedVersion: await versionOf("a-nocrm") }, context());
    await q(`UPDATE nzi_console.clients SET client_manager_user_id = 'cam' WHERE client_id = 'no-crm'`);
    const result = await tick();
    assert.ok(result.srsReviewReminders.ok && result.srsReviewReminders.summary.enqueued === 1);
    assert.deepEqual((await markers("a-due")).map((marker) => marker.review_date), [day(3), day(5)], "one reminder per date — the first kept as the record");
    assert.deepEqual(await markers("a-nocrm"), [], "off: nothing, even once the CRM is put right");
  });

  it("a blocked reminder is not burned: once the CRM is put right, it goes", async () => {
    await q(`UPDATE nzi_console.memberships SET status = 'active' WHERE user_id = 'gone'`);
    const result = await tick();
    assert.ok(result.srsReviewReminders.ok && result.srsReviewReminders.summary.enqueued === 1);
    assert.deepEqual(await markers("a-inactive"), [{ review_date: day(3), recipient_user_id: "gone" }]);
  });

  it("then the CRM reopens through the existing command — a new version, a draft — and a draft is never reminded", async () => {
    const before = await versionOf("a-overdue");
    const reopened = await reopenSrsAssessment(database.pool, { assessmentId: "a-overdue", expectedVersion: before }, context());
    assert.equal(reopened.data.version, before + 1);
    const assessment = (await withTenantRead(database.pool, ORG, (db) => getSrsAssessment(db, "a-overdue")))!;
    assert.deepEqual([assessment.status, assessment.assessedOn], ["draft", null]);
    await setSrsReviewSchedule(database.pool, { assessmentId: "a-far", cadence: "custom", customDate: day(1), expectedVersion: await versionOf("a-far") }, context());
    await q(`UPDATE nzi_console.srs_assessments SET next_review_date = $1::date WHERE assessment_id = 'a-overdue'`, [day(2)]);
    const result = await tick();
    assert.ok(result.srsReviewReminders.ok && result.srsReviewReminders.summary.enqueued === 1, "a-far, moved into its window, goes; the reopened draft does not");
    assert.deepEqual((await markers("a-overdue")).map((marker) => marker.review_date), [day(-10)]);
  });

  it("the scan and the send are separate transactions: a failing scan writes nothing and the drain still sends", async () => {
    await completed("late", "a-late", {});
    await q(`REVOKE INSERT ON nzi_console.srs_review_reminders FROM nzi_console_worker`);
    try {
      const fetchImpl = resend();
      const result = await tick(fetchImpl);
      assert.equal(result.srsReviewReminders.ok, false);
      assert.match(!result.srsReviewReminders.ok ? result.srsReviewReminders.error : "", /permission denied for table srs_review_reminders/);
      assert.ok(result.emails.ok, "the email drain is not touched by the scan");
      assert.equal(fetchImpl.posted.length, 1, "the reminder the last tick queued still went");
      assert.equal((await q(`SELECT 1 FROM nzi_console.email_messages WHERE status = 'queued'`)).length, 0, "the failed scan's email rolled back with it");
      assert.deepEqual(await markers("a-late"), []);
    } finally {
      await q(`GRANT INSERT ON nzi_console.srs_review_reminders TO nzi_console_worker`);
    }
  });
});
