import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { emailDispatchFromEnv, EmailValidationError, EMAIL_SEND_TOPIC, sendEmail, type EmailDispatch } from "../src/email";
import { suppressingMailer } from "../src/mailer";
import { withTenantWrite, withTenantWorker } from "../src/postgres";
import { drainOutbox } from "../src/strategyReminderWorker";

/**
 * The email pipe against a real Postgres (phase 1): `sendEmail` enqueues and sends nothing; the outbox drainer resolves each
 * row to `sent` (with Resend's id), `stubbed` or `failed`; a redelivered outbox row cannot send twice; and the table's own
 * rules — tenant isolation, grants, and a body that does not outlive its send — are the database's, not the code's.
 */

const ORG = "org-email-a";
const OTHER = "org-email-b";
const TODAY = "2026-10-23";
const ISOLATED = { NZI_DATABASE_BOUNDARY: "isolated-non-production", NEXT_PUBLIC_APP_ENV: "staging" };
const KEYED = { ...ISOLATED, RESEND_API_KEY: "re_test_0123456789abcdef", EMAIL_FROM: "Net Zero International <no-reply@netzero.international>" };
const NOT_DELIVERY = { mode: "suppress" as const, reason: "test" };

type Call = { body: Record<string, unknown>; headers: Record<string, string> };
function resend(status: number | (() => number)): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
    const code = typeof status === "function" ? status() : status;
    return new Response(JSON.stringify(code < 300 ? { id: `re-${calls.length}` } : { message: "refused" }), { status: code });
  }) as unknown as typeof fetch & { calls: Call[] };
  impl.calls = calls;
  return impl;
}

describe("email outbox (phase 1)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;

  const enqueue = (input: Parameters<typeof sendEmail>[2], org = ORG) =>
    withTenantWrite(database.pool, org, (db) => sendEmail(db, org, input));
  const drain = (email: EmailDispatch | undefined, org = ORG) =>
    withTenantWorker(database.pool, org, (db) =>
      drainOutbox(db, { organisationId: org, today: TODAY, mailer: suppressingMailer(), delivery: NOT_DELIVERY, email }));
  const message = async (id: string) => (await admin.query<{
    status: string; provider_message_id: string | null; attempts: number; last_error: string | null; html_body: string | null;
    text_body: string | null; to_email: string; resolved_at: Date | null;
  }>(`SELECT status, provider_message_id, attempts, last_error, html_body, text_body, to_email, resolved_at
      FROM nzi_console.email_messages WHERE email_message_id = $1`, [id])).rows[0]!;
  const outbox = async (id: string) => (await admin.query<{ state: string; attempts: number; topic: string; payload_json: unknown }>(
    `SELECT state, attempts, topic, payload_json FROM nzi_console.transactional_outbox WHERE payload_json->>'emailMessageId' = $1`, [id])).rows;
  const ready = () => admin.query(`UPDATE nzi_console.transactional_outbox SET available_at = now() - interval '1 second'`);

  before(async () => {
    database = (await createDisposableDatabase("emailoutbox"))!;
    admin = await database.admin();
    for (const org of [ORG, OTHER]) {
      await admin.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [org]);
    }
  });
  beforeEach(async () => {
    await admin.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await admin.query(`DELETE FROM nzi_console.transactional_outbox`);
    await admin.query(`DELETE FROM nzi_console.email_messages`);
  });
  after(async () => { await admin?.end(); await database?.end(); });

  it("sendEmail writes the log row and the email.send outbox row, and sends nothing", async () => {
    const queued = await enqueue({ to: "Francis@NetZero.International", subject: "Test", html: "<p>Hi</p>", text: "Hi" });
    assert.equal(queued.enqueued, true);
    const row = await message(queued.emailMessageId);
    assert.equal(row.status, "queued");
    assert.equal(row.to_email, "francis@netzero.international");
    assert.equal(row.html_body, "<p>Hi</p>");
    const [entry, ...rest] = await outbox(queued.emailMessageId);
    assert.equal(rest.length, 0);
    assert.equal(entry!.topic, EMAIL_SEND_TOPIC);
    assert.equal(entry!.state, "pending");
    // The payload names the message, never the address: the log row is the one place the recipient lives.
    assert.deepEqual(entry!.payload_json, { emailMessageId: queued.emailMessageId });
  });

  it("enqueues once per idempotency key", async () => {
    const first = await enqueue({ to: "a@netzero.international", subject: "S", text: "B", idempotencyKey: "invite:u-1:1" });
    const second = await enqueue({ to: "a@netzero.international", subject: "S", text: "B", idempotencyKey: "invite:u-1:1" });
    assert.deepEqual(second, { emailMessageId: first.emailMessageId, enqueued: false });
    assert.equal((await admin.query(`SELECT 1 FROM nzi_console.transactional_outbox`)).rows.length, 1);
    assert.equal((await admin.query(`SELECT 1 FROM nzi_console.email_messages`)).rows.length, 1);
  });

  it("refuses an invalid send before anything is written", async () => {
    await assert.rejects(enqueue({ to: "a@netzero.international", subject: "", text: "B" }), EmailValidationError);
    await assert.rejects(enqueue({ to: "a@netzero.international", subject: "S" }), EmailValidationError);
    assert.equal((await admin.query(`SELECT 1 FROM nzi_console.email_messages`)).rows.length, 0);
    assert.equal((await admin.query(`SELECT 1 FROM nzi_console.transactional_outbox`)).rows.length, 0);
  });

  it("with no key, the drain records the send as stubbed and makes no HTTP call", async () => {
    const fetchImpl = resend(200);
    const queued = await enqueue({ to: "francis@netzero.international", subject: "S", text: "B" });
    const summary = await drain(emailDispatchFromEnv({ ...ISOLATED }, fetchImpl));
    assert.deepEqual(summary.emails, { sent: 0, stubbed: 1, retried: 0, failed: 0 });
    assert.equal(fetchImpl.calls.length, 0);
    const row = await message(queued.emailMessageId);
    assert.equal(row.status, "stubbed");
    assert.equal(row.last_error, "RESEND_API_KEY is not set.");
    assert.equal(row.text_body, null, "the body does not outlive the send");
    assert.ok(row.resolved_at);
    assert.equal((await outbox(queued.emailMessageId))[0]!.state, "sent");
  });

  it("with a key, posts to Resend once and records the provider id; redelivery does not send again", async () => {
    const fetchImpl = resend(200);
    const dispatch = emailDispatchFromEnv(KEYED, fetchImpl);
    const queued = await enqueue({ to: "francis@netzero.international", subject: "Hello", html: "<p>Hi</p>", replyTo: "team@netzero.international" });
    const summary = await drain(dispatch);
    assert.deepEqual(summary.emails, { sent: 1, stubbed: 0, retried: 0, failed: 0 });
    assert.equal(fetchImpl.calls.length, 1);
    const [call] = fetchImpl.calls;
    assert.equal(call!.headers["Idempotency-Key"], queued.emailMessageId);
    assert.deepEqual(call!.body, {
      from: "Net Zero International <no-reply@netzero.international>", to: ["francis@netzero.international"], subject: "Hello",
      html: "<p>Hi</p>", reply_to: "team@netzero.international",
    });
    const row = await message(queued.emailMessageId);
    assert.equal(row.status, "sent");
    assert.equal(row.provider_message_id, "re-1");
    assert.equal(row.attempts, 1);
    assert.equal(row.html_body, null);

    // The outbox redelivers the same row (a lost settle, a second worker): the log row is resolved, so nothing is sent.
    await admin.query(`UPDATE nzi_console.transactional_outbox SET state = 'pending'`);
    const again = await drain(dispatch);
    assert.equal(fetchImpl.calls.length, 1, "a redelivery does not double-send");
    assert.equal(again.skipped, 1);
    assert.equal((await outbox(queued.emailMessageId))[0]!.state, "skipped");
  });

  it("a refused post is failed, final, and never retried or resent", async () => {
    const fetchImpl = resend(422);
    const dispatch = emailDispatchFromEnv(KEYED, fetchImpl);
    const queued = await enqueue({ to: "francis@netzero.international", subject: "S", text: "B" });
    const summary = await drain(dispatch);
    assert.deepEqual(summary.emails, { sent: 0, stubbed: 0, retried: 0, failed: 1 });
    const row = await message(queued.emailMessageId);
    assert.equal(row.status, "failed");
    assert.match(row.last_error!, /HTTP 422/);
    assert.equal(row.text_body, null);
    assert.equal((await outbox(queued.emailMessageId))[0]!.state, "failed");

    await admin.query(`UPDATE nzi_console.transactional_outbox SET state = 'pending'`);
    await drain(dispatch);
    assert.equal(fetchImpl.calls.length, 1, "a redelivered failure does not post again");
  });

  it("an outage retries with backoff, keeps the body until it resolves, and sends once when the provider recovers", async () => {
    let status = 503;
    const fetchImpl = resend(() => status);
    const dispatch = emailDispatchFromEnv(KEYED, fetchImpl);
    const queued = await enqueue({ to: "francis@netzero.international", subject: "S", text: "B" });

    assert.deepEqual((await drain(dispatch)).emails, { sent: 0, stubbed: 0, retried: 1, failed: 0 });
    let row = await message(queued.emailMessageId);
    assert.equal(row.status, "queued");
    assert.equal(row.attempts, 1);
    assert.equal(row.text_body, "B", "a retry still needs its body");
    const [entry] = await outbox(queued.emailMessageId);
    assert.equal(entry!.state, "pending");
    assert.equal(entry!.attempts, 1);
    // Backed off: not picked up again until it is due.
    assert.deepEqual((await drain(dispatch)).emails, { sent: 0, stubbed: 0, retried: 0, failed: 0 });

    status = 200;
    await ready();
    assert.deepEqual((await drain(dispatch)).emails, { sent: 1, stubbed: 0, retried: 0, failed: 0 });
    row = await message(queued.emailMessageId);
    assert.equal(row.status, "sent");
    assert.equal(row.attempts, 2);
    // Both posts carried the same key, so a send that landed during the outage is returned rather than repeated by Resend.
    assert.deepEqual(fetchImpl.calls.map((call) => call.headers["Idempotency-Key"]), [queued.emailMessageId, queued.emailMessageId]);
  });

  it("gives up as failed after the last attempt", async () => {
    const fetchImpl = resend(500);
    const dispatch = emailDispatchFromEnv(KEYED, fetchImpl);
    const queued = await enqueue({ to: "francis@netzero.international", subject: "S", text: "B" });
    for (let attempt = 0; attempt < 4; attempt += 1) { await ready(); await drain(dispatch); }
    const row = await message(queued.emailMessageId);
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 4);
    assert.equal(fetchImpl.calls.length, 4);
    assert.equal((await outbox(queued.emailMessageId))[0]!.state, "failed");
  });

  it("on the isolated boundary, a recipient outside the NZI domain is stubbed with the reason, never posted", async () => {
    const fetchImpl = resend(200);
    const queued = await enqueue({ to: "someone@client.example", subject: "S", text: "B" });
    await drain(emailDispatchFromEnv(KEYED, fetchImpl));
    assert.equal(fetchImpl.calls.length, 0);
    const row = await message(queued.emailMessageId);
    assert.equal(row.status, "stubbed");
    assert.match(row.last_error!, /sends only to @netzero\.international/);
  });

  it("a drainer with no email dispatch leaves email rows pending, and still skips the topic-less backlog", async () => {
    const queued = await enqueue({ to: "francis@netzero.international", subject: "S", text: "B" });
    await admin.query(
      `INSERT INTO nzi_console.transactional_outbox (organisation_id, outbox_id, topic, payload_json, correlation_id)
       VALUES ($1, 'legacy-1', 'job.created', '{}'::jsonb, 'c')`, [ORG]);
    const summary = await drain(undefined);
    assert.equal(summary.skipped, 1);
    assert.equal((await outbox(queued.emailMessageId))[0]!.state, "pending", "an email is never skipped for want of a handler");
    assert.equal((await message(queued.emailMessageId)).status, "queued");
  });

  it("is tenant-isolated: another organisation neither sees nor drains the row", async () => {
    const fetchImpl = resend(200);
    const queued = await enqueue({ to: "francis@netzero.international", subject: "S", text: "B" });
    const seen = await withTenantWorker(database.pool, OTHER, (db) =>
      db.query(`SELECT 1 FROM nzi_console.email_messages WHERE email_message_id = $1`, [queued.emailMessageId]));
    assert.equal(seen.rows.length, 0);
    await drain(emailDispatchFromEnv(KEYED, fetchImpl), OTHER);
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal((await message(queued.emailMessageId)).status, "queued");
  });

  it("the database refuses a resolved row that keeps its body, a queued row without one, and a sent row without an id", async () => {
    const queued = await enqueue({ to: "francis@netzero.international", subject: "S", text: "B" });
    const id = queued.emailMessageId;
    await assert.rejects(admin.query(`UPDATE nzi_console.email_messages SET status='stubbed', resolved_at=now() WHERE email_message_id=$1`, [id]),
      /email_messages_resolved_has_no_body/);
    await assert.rejects(admin.query(`UPDATE nzi_console.email_messages SET text_body=NULL WHERE email_message_id=$1`, [id]),
      /email_messages_queued_has_body/);
    await assert.rejects(admin.query(
      `UPDATE nzi_console.email_messages SET status='sent', text_body=NULL, resolved_at=now() WHERE email_message_id=$1`, [id]),
      /email_messages_sent_has_provider_id/);
  });

  it("grants: the console enqueues but cannot resolve; nobody deletes", async () => {
    const queued = await enqueue({ to: "francis@netzero.international", subject: "S", text: "B" });
    await assert.rejects(withTenantWrite(database.pool, ORG, (db) =>
      db.query(`UPDATE nzi_console.email_messages SET attempts = 1 WHERE email_message_id = $1`, [queued.emailMessageId])), /permission denied/);
    for (const as of [withTenantWrite, withTenantWorker]) {
      await assert.rejects(as(database.pool, ORG, (db) =>
        db.query(`DELETE FROM nzi_console.email_messages WHERE email_message_id = $1`, [queued.emailMessageId])), /permission denied/);
    }
  });
});
