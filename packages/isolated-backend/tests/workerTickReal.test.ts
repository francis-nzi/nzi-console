import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { emailDispatchFromEnv, sendEmail } from "../src/email";
import { suppressingMailer } from "../src/mailer";
import { withTenantWorker, withTenantWrite } from "../src/postgres";
import { runReminderTick, runWorkerTick } from "../src/strategyReminderWorker";

/**
 * The reminder worker's tick, as the role it really runs as (BUILD-fix-worker-tick-permission). The reminder tests run the tick
 * as the superuser, which is how "permission denied for table strategy_levers" reached staging unseen: the plan read joins
 * `strategy_levers` and `client_strategy_srs_requirements`, and the worker was granted neither until 0183. Here the tick runs
 * through `withTenantWorker` — `nzi_console_worker`, row security and all — over a real plan (a library strategy with levers,
 * an SRS alignment) and queued email; and a forced reminder-side failure is shown not to stop the email drain.
 */

const ORG = "tick-org";
const TODAY = "2026-10-26";
const KEYED = { NZI_DATABASE_BOUNDARY: "isolated-non-production", NEXT_PUBLIC_APP_ENV: "staging", RESEND_API_KEY: "re_test_0123456789abcdef", EMAIL_FROM: "Net Zero International <no-reply@netzero.international>" };
const ENV = {};
// Every table the tick touches, with what it does there (0183 asserts the same set at deploy).
const TICK_TABLES: Array<[string, string]> = [
  ["clients", "SELECT"], ["client_strategies", "SELECT"], ["reduction_strategies", "SELECT"], ["strategy_levers", "SELECT"],
  ["client_strategy_srs_requirements", "SELECT"], ["client_contacts", "SELECT"], ["message_templates", "SELECT"],
  ["strategy_automation_log", "SELECT"], ["strategy_automation_log", "INSERT"], ["strategy_automation_log", "UPDATE"],
  ["transactional_outbox", "SELECT"], ["transactional_outbox", "INSERT"], ["transactional_outbox", "UPDATE"],
  ["email_messages", "SELECT"], ["email_messages", "UPDATE"],
  // Actions A3 (0190): the reminder switch, the sent-marker, and the enqueue into email_messages with its audit event.
  ["organisation_reminder_settings", "SELECT"], ["strategy_due_reminders", "SELECT"], ["strategy_due_reminders", "INSERT"],
  ["email_messages", "INSERT"], ["audit_events", "INSERT"],
];

function resend(): typeof fetch & { posted: string[] } {
  const posted: string[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(init.body as string).to[0]);
    return new Response(JSON.stringify({ id: `re-${posted.length}` }), { status: 200 });
  }) as unknown as typeof fetch & { posted: string[] };
  impl.posted = posted;
  return impl;
}

describe("the reminder worker's tick, as nzi_console_worker", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const queue = (to: string) => withTenantWrite(database.pool, ORG, (db) => sendEmail(db, ORG, { to, subject: "Test send", text: "Hello" }));
  const status = async (id: string) => (await q(`SELECT status FROM nzi_console.email_messages WHERE email_message_id = $1`, [id]))[0]!.status;

  before(async () => {
    database = (await createDisposableDatabase("workertick"))!;
    admin = await database.admin();
    // The insert provisions the organisation's library: levers, reduction strategies with their levers, SRS requirements.
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'client-t', 'Tick Client Ltd', 'active')`, [ORG]);
    // Reminders are off until an admin turns them on (A3, 0190): this tick is about a running reminder scan.
    await q(`INSERT INTO nzi_console.organisation_reminder_settings (organisation_id, enabled, updated_by) VALUES ($1, true, 'tester')`, [ORG]);
    await q(`INSERT INTO nzi_console.client_contacts (organisation_id, contact_id, client_id, full_name, email, status, email_consent, created_by, updated_by)
      VALUES ($1, 'contact-t', 'client-t', 'Dana Reid', 'dana@client.example', 'active', 'granted', 'tester', 'tester')`, [ORG]);
    const [library] = await q<{ strategy_id: string }>(
      `SELECT s.strategy_id FROM nzi_console.reduction_strategies s JOIN nzi_console.strategy_levers sl USING (organisation_id, strategy_id)
        WHERE s.organisation_id = $1 LIMIT 1`, [ORG]);
    assert.ok(library, "provisioning gave the organisation a library strategy with a lever");
    // A strategy on a plan must advance an SRS requirement, checked at commit: the two rows are one transaction.
    await q(`BEGIN`);
    await q(`INSERT INTO nzi_console.client_strategies (organisation_id, client_strategy_id, client_id, strategy_id, status, target_date, progress_pct, created_by)
      VALUES ($1, 'plan-t', 'client-t', $2, 'agreed', '2026-10-20'::date, 0, 'tester')`, [ORG, library!.strategy_id]);
    await q(`INSERT INTO nzi_console.client_strategy_srs_requirements (organisation_id, client_strategy_id, framework_id, requirement_id)
      SELECT organisation_id, 'plan-t', framework_id, requirement_id FROM nzi_console.srs_requirements WHERE organisation_id = $1 ORDER BY requirement_id LIMIT 1`, [ORG]);
    await q(`COMMIT`);
  });
  beforeEach(async () => {
    await q(`DELETE FROM nzi_console.transactional_outbox`);
    await q(`DELETE FROM nzi_console.email_messages`);
    await q(`DELETE FROM nzi_console.strategy_automation_log`);
  });
  after(async () => { await admin?.end(); await database?.end(); });

  it("the worker role holds every privilege its tick needs", async () => {
    const missing = [];
    for (const [table, privilege] of TICK_TABLES) {
      const [row] = await q<{ ok: boolean }>(`SELECT has_table_privilege('nzi_console_worker', $1, $2) AS ok`, [`nzi_console.${table}`, privilege]);
      if (!row!.ok) missing.push(`${privilege} on ${table}`);
    }
    assert.deepEqual(missing, []);
  });

  it("a whole tick over a real plan and queued email completes, and reports both parts", async () => {
    const nzi = await queue("francis@netzero.international");
    const client = await queue("someone@client.example");
    const fetchImpl = resend();
    const tick = await runWorkerTick(database.pool, { organisationId: ORG, today: TODAY, mailer: suppressingMailer(), email: emailDispatchFromEnv(KEYED, fetchImpl), env: ENV });

    assert.ok(tick.emails.ok, tick.emails.ok ? "" : tick.emails.error);
    assert.ok(tick.reminders.ok, tick.reminders.ok ? "" : tick.reminders.error);
    assert.deepEqual(tick.emails.ok && tick.emails.summary, { sent: 1, stubbed: 1, retried: 0, failed: 0 });
    assert.deepEqual(fetchImpl.posted, ["francis@netzero.international"], "only the NZI address is posted on the isolated boundary");
    assert.equal(await status(nzi.emailMessageId), "sent");
    assert.equal(await status(client.emailMessageId), "stubbed");
    // The reminder scan read the plan — levers and SRS alignment included — claimed the overdue reminder, and the drain
    // resolved it (suppressed on this boundary: reminders never send from staging).
    assert.ok(tick.reminders.ok && tick.reminders.summary.scanned >= 1 && tick.reminders.summary.claimed === 1);
    const [log] = await q(`SELECT state FROM nzi_console.strategy_automation_log WHERE client_strategy_id = 'plan-t'`);
    assert.equal(log!.state, "suppressed");
  });

  describe("a reminder-side failure", () => {
    // The staging fault, reproduced: the worker loses SELECT on strategy_levers, as it never had it before 0183.
    beforeEach(async () => { await q(`REVOKE SELECT ON nzi_console.strategy_levers FROM nzi_console_worker`); });
    after(async () => { await q(`GRANT SELECT ON nzi_console.strategy_levers TO nzi_console_worker`); });

    it("the old one-transaction tick (scan, then drain) never dispatched the email — the staging symptom", async () => {
      const queued = await queue("francis@netzero.international");
      const fetchImpl = resend();
      await assert.rejects(() => withTenantWorker(database.pool, ORG, (db) => runReminderTick(db, {
        organisationId: ORG, today: TODAY, mailer: suppressingMailer(), env: ENV, email: emailDispatchFromEnv(KEYED, fetchImpl),
      })), /permission denied for table strategy_levers/);
      assert.equal(fetchImpl.posted.length, 0, "the scan threw first, so nothing was posted to Resend");
      assert.equal(await status(queued.emailMessageId), "queued", "and the email stayed queued");
    });

    it("the split tick still dispatches the email, and reports the reminder failure instead of throwing", async () => {
      const queued = await queue("francis@netzero.international");
      const fetchImpl = resend();
      const tick = await runWorkerTick(database.pool, { organisationId: ORG, today: TODAY, mailer: suppressingMailer(), email: emailDispatchFromEnv(KEYED, fetchImpl), env: ENV });
      assert.ok(tick.emails.ok);
      assert.equal(await status(queued.emailMessageId), "sent");
      assert.deepEqual(fetchImpl.posted, ["francis@netzero.international"]);
      assert.equal(tick.reminders.ok, false);
      assert.match(!tick.reminders.ok ? tick.reminders.error : "", /permission denied for table strategy_levers/);
      assert.equal((await q(`SELECT 1 FROM nzi_console.strategy_automation_log`)).length, 0, "the failed scan rolled back alone");
    });
  });

  it("an email-side failure does not stop the reminders", async () => {
    await queue("francis@netzero.international");
    await q(`REVOKE UPDATE ON nzi_console.email_messages FROM nzi_console_worker`);
    try {
      const tick = await runWorkerTick(database.pool, { organisationId: ORG, today: TODAY, mailer: suppressingMailer(), email: emailDispatchFromEnv(KEYED, resend()), env: ENV });
      assert.equal(tick.emails.ok, false);
      assert.ok(tick.reminders.ok && tick.reminders.summary.claimed === 1, "the scan still ran and claimed");
    } finally {
      await q(`GRANT UPDATE ON nzi_console.email_messages TO nzi_console_worker`);
    }
  });
});
