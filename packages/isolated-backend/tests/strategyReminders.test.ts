import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
// @ts-expect-error — plain ESM runner, sharing its disposable-database guard.
import { assertDisposable } from "../scripts/migrate.mjs";
import { drainOutbox, runReminderTick, scanClientReminders, REMINDER_TOPIC } from "../src/strategyReminderWorker";
import { suppressingMailer, type MailMessage, type Mailer } from "../src/mailer";

/**
 * The reminder channel's load-bearing properties, against a real Postgres — because every
 * one of them is a claim about what the database refuses, not about what a mock was told.
 *
 * The three that matter most:
 *   1. **The 0001 backlog cannot become email.** The outbox has been written by every
 *      command since the first migration and drained by nothing.
 *   2. **The clock cannot double-send.** Running it twice sends once.
 *   3. **A transient failure retries without duplicating a delivered message.**
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const DATABASE_URL = process.env.NZI_TEST_DATABASE_URL;
const ORG = "org-a";
const TODAY = "2026-09-14";

/** Records instead of sending, and can be told to fail — a transport under test control. */
function recordingMailer(): Mailer & { sent: MailMessage[]; failNext: (times: number) => void } {
  const sent: MailMessage[] = [];
  let failures = 0;
  return {
    sent,
    failNext(times: number) { failures = times; },
    async send(message: MailMessage) {
      if (failures > 0) { failures -= 1; throw new Error("451 temporary failure"); }
      sent.push(message);
    },
  };
}

describe("strategy deadline reminders", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let client: pg.Client;

  // Plans are cleared too, not just the queues: `runReminderTick` scans every client with a
  // dated plan, so a strategy left behind by an earlier test would be claimed again the
  // moment the log was emptied, and the counts here would be measuring the wrong thing.
  const resetQueues = async () => {
    await client.query(`DELETE FROM nzi_console.strategy_automation_log`);
    await client.query(`DELETE FROM nzi_console.transactional_outbox`);
    await client.query(`DELETE FROM nzi_console.client_strategy_srs_requirements`);
    await client.query(`DELETE FROM nzi_console.client_strategies`);
  };

  before(async () => {
    assertDisposable(DATABASE_URL!, process.env.NZI_ISOLATED_DATABASE_URL);
    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS nzi_console CASCADE`);
    for (const role of ["nzi_console_app", "nzi_console_worker", "nzi_console_auth"]) {
      await client.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    }
    for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()) {
      await client.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    await client.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'Org A')`, [ORG]);
    await client.query(
      `INSERT INTO nzi_console.clients (organisation_id, client_id, name, status)
       VALUES ($1, 'client-a', 'Northwind Ltd', 'active')`, [ORG]);
    // One consenting contact, one who has not been asked, one who declined, one inactive.
    // `deactivated_at` tracks `status` — 0067 holds the two as one fact, so an inactive
    // contact without a date is a state the table refuses rather than a fixture shortcut.
    for (const [id, name, email, status, consent] of [
      ["c-yes", "Dana Reid", "dana@example.com", "active", "granted"],
      ["c-unknown", "Sam Patel", "sam@example.com", "active", "unknown"],
      ["c-no", "Lee Chan", "lee@example.com", "active", "declined"],
      ["c-gone", "Kit Moss", "kit@example.com", "inactive", "granted"],
    ]) {
      const gone = status === "inactive";
      await client.query(
        `INSERT INTO nzi_console.client_contacts
           (organisation_id, contact_id, client_id, full_name, email, status, email_consent,
            created_by, updated_by, deactivated_by, deactivated_at)
         VALUES ($1,$2,'client-a',$3,$4,$5,$6,'tester','tester',$7,$8)`,
        [ORG, id, name, email, status, consent, gone ? "tester" : null, gone ? new Date().toISOString() : null]);
    }
  });

  after(async () => { await client?.end(); });

  const addStrategy = async (id: string, targetDate: string | null, status = "planned") => {
    await client.query(`BEGIN`);
    await client.query(
      `INSERT INTO nzi_console.client_strategies
         (organisation_id, client_strategy_id, client_id, bespoke_title, bespoke_scope, bespoke_control_level,
          status, target_date, progress_pct, created_by)
       VALUES ($1,$2,'client-a',$3,'1','direct_control',$4,$5::date,$6,'tester')`,
      [ORG, id, `Strategy ${id}`, status, targetDate, status === "complete" ? 100 : 0]);
    await client.query(
      `INSERT INTO nzi_console.client_strategy_srs_requirements (organisation_id, client_strategy_id, framework_id, requirement_id)
       SELECT organisation_id, $2, framework_id, requirement_id
       FROM nzi_console.srs_requirements WHERE organisation_id = $1 ORDER BY requirement_id LIMIT 1`, [ORG, id]);
    await client.query(`COMMIT`);
  };

  it("cannot turn the pre-drainer backlog into email", async () => {
    // Every command since 0001 wrote an outbox row and nothing ever read one. Draining that
    // standing backlog must clear it without delivering anything, and it is safe by
    // construction: delivery is keyed on a handler lookup, and none of these topics has one.
    await resetQueues();
    for (const topic of ["crp.snapshot.reviewed", "client.created", "report.published", "client.strategy.assign"]) {
      await client.query(
        `INSERT INTO nzi_console.transactional_outbox (organisation_id, outbox_id, topic, payload_json, correlation_id)
         VALUES ($1,$2,$3,'{}'::jsonb,'legacy')`, [ORG, `legacy-${topic}`, topic]);
    }
    const mailer = recordingMailer();
    const result = await drainOutbox(client as never, {
      organisationId: ORG, today: TODAY, mailer, delivery: { mode: "send" },
    });
    assert.equal(mailer.sent.length, 0, "the backlog sends nothing");
    assert.equal(result.skipped, 4, "and every row reaches a terminal state rather than being re-read forever");
    const { rows } = await client.query<{ state: string }>(
      `SELECT DISTINCT state FROM nzi_console.transactional_outbox WHERE correlation_id = 'legacy'`);
    assert.deepEqual(rows.map((row) => row.state), ["skipped"],
      "'skipped', not 'sent' — the log must not record a delivery that never happened");
  });

  it("sends once however often the clock runs", async () => {
    await resetQueues();
    await addStrategy("s-overdue", "2026-09-01");
    const mailer = recordingMailer();
    const env = { appEnv: "production", boundaryToken: "live", mailMode: "send" };

    const first = await runReminderTick(client as never, { organisationId: ORG, today: TODAY, mailer, env });
    assert.equal(first.sent, 1, "the first tick sends");
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0]!.to, "dana@example.com", "only the consenting, active contact");

    const second = await runReminderTick(client as never, { organisationId: ORG, today: TODAY, mailer, env });
    assert.equal(second.claimed, 0, "the second tick claims nothing");
    assert.equal(second.sent, 0);
    assert.equal(mailer.sent.length, 1, "and the client's inbox is unchanged");
  });

  it("writes to nobody who has not consented", async () => {
    // `unknown` is an absent decision, and an absent decision is not permission.
    await resetQueues();
    await addStrategy("s-consent", "2026-09-02");
    const mailer = recordingMailer();
    await runReminderTick(client as never, {
      organisationId: ORG, today: TODAY, mailer, env: { appEnv: "production", boundaryToken: "live", mailMode: "send" },
    });
    assert.deepEqual(mailer.sent.map((message) => message.to), ["dana@example.com"]);
  });

  it("retries a transient failure without duplicating a delivered message", async () => {
    await resetQueues();
    await addStrategy("s-flaky", "2026-09-03");
    const mailer = recordingMailer();
    const env = { appEnv: "production", boundaryToken: "live", mailMode: "send" };
    mailer.failNext(1);

    const first = await runReminderTick(client as never, { organisationId: ORG, today: TODAY, mailer, env });
    assert.equal(first.failed, 1, "the send failed");
    assert.equal(mailer.sent.length, 0);
    // The retry is not blocked by its own claim: a claim is permission to send, and an
    // unresolved claim still owes a send.
    await client.query(`UPDATE nzi_console.transactional_outbox SET available_at = now() WHERE topic = $1`, [REMINDER_TOPIC]);
    const second = await drainOutbox(client as never, { organisationId: ORG, today: TODAY, mailer, delivery: { mode: "send" } });
    assert.equal(second.sent, 1, "the retry delivers");
    assert.equal(mailer.sent.length, 1, "exactly once");

    await client.query(`UPDATE nzi_console.transactional_outbox SET state='pending', available_at=now() WHERE topic=$1`, [REMINDER_TOPIC]);
    const third = await drainOutbox(client as never, { organisationId: ORG, today: TODAY, mailer, delivery: { mode: "send" } });
    assert.equal(mailer.sent.length, 1, "and a re-queued row after a successful send delivers nothing further");
    assert.equal(third.sent, 0);
  });

  it("does not tell a client they are late for something they finished", async () => {
    // The gap between the scan and the send is where this goes wrong, so the reminder is
    // re-derived against live state immediately before delivery.
    await resetQueues();
    await addStrategy("s-raced", "2026-09-04");
    const mailer = recordingMailer();
    await scanClientReminders(client as never, { organisationId: ORG, clientId: "client-a", today: TODAY });
    await client.query(
      `UPDATE nzi_console.client_strategies SET status='complete', progress_pct=100
       WHERE organisation_id=$1 AND client_strategy_id='s-raced'`, [ORG]);
    const result = await drainOutbox(client as never, { organisationId: ORG, today: TODAY, mailer, delivery: { mode: "send" } });
    assert.equal(mailer.sent.length, 0, "the completed strategy is not chased");
    assert.equal(result.sent, 0);
    const { rows } = await client.query<{ state: string; last_error: string }>(
      `SELECT state, last_error FROM nzi_console.strategy_automation_log WHERE client_strategy_id='s-raced'`);
    assert.equal(rows[0]!.state, "suppressed");
    assert.match(rows[0]!.last_error, /no longer has a deadline/);
  });

  it("raises nothing for a strategy with no date", async () => {
    await resetQueues();
    await addStrategy("s-undated", null);
    const mailer = recordingMailer();
    const result = await runReminderTick(client as never, {
      organisationId: ORG, today: TODAY, mailer, env: { appEnv: "production", boundaryToken: "live", mailMode: "send" },
    });
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM nzi_console.strategy_automation_log WHERE client_strategy_id='s-undated'`);
    assert.equal(rows[0]!.count, "0", "no date, no reminder — and no invented date");
    assert.equal(result.sent, 0);
  });

  it("records a suppressed send in full rather than skipping the work", async () => {
    // On the isolated boundary the message is still composed and logged; only the delivery
    // is withheld. "We would have sent this" is a claim worth being able to inspect.
    await resetQueues();
    await addStrategy("s-staging", "2026-09-05");
    const seen: MailMessage[] = [];
    const result = await runReminderTick(client as never, {
      organisationId: ORG, today: TODAY,
      mailer: suppressingMailer((message) => seen.push(message)),
      env: { boundaryToken: "isolated-non-production", appEnv: "production", mailMode: "send" },
    });
    assert.equal(result.suppressed, 1);
    assert.equal(result.sent, 0, "nothing went on the wire");
    assert.equal(result.delivery.mode, "suppress");
    const { rows } = await client.query<{ state: string; subject: string; body: string }>(
      `SELECT state, subject, body FROM nzi_console.strategy_automation_log WHERE client_strategy_id='s-staging'`);
    assert.equal(rows[0]!.state, "suppressed");
    assert.match(rows[0]!.subject, /target date/i);
    assert.ok(rows[0]!.body.includes("Northwind Ltd"), "the composed body is on the record");
    assert.equal(seen.length, 1, "and was handed to the transport, which declined to send it");
  });

  it("refuses a second claim for the same reminder at the database level", async () => {
    // The guarantee is the unique index, not the worker's care. Asserted directly, because
    // every other test here depends on it holding.
    await resetQueues();
    await addStrategy("s-unique", "2026-09-06");
    const insert = (id: string) => client.query(
      `INSERT INTO nzi_console.strategy_automation_log
         (organisation_id, automation_log_id, client_strategy_id, client_id, kind, target_date, recipient_email, subject, body)
       VALUES ($1,$2,'s-unique','client-a','overdue','2026-09-06','dana@example.com','s','b')`, [ORG, id]);
    await insert("log-1");
    await assert.rejects(() => insert("log-2"), /duplicate key|unique/i,
      "one reminder per strategy, per kind, per date, per recipient");
  });
});
