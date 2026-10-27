import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { commandGrantForRole, DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE, messageTemplateDefinition, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { emailDispatchFromEnv } from "../src/email";
import { suppressingMailer } from "../src/mailer";
import { createMessageTemplate, deactivateMessageTemplate, listMessageTemplates, readActiveMessageTemplate, updateMessageTemplate } from "../src/messageTemplates";
import { withTenantRead, withTenantWrite, withTenantWorker } from "../src/postgres";
import { drainOutbox } from "../src/strategyReminderWorker";
import { sendTemplatedEmail, TemplatedEmailError } from "../src/templatedEmail";

/**
 * Message templates, phase 2 of the email programme, against a real database: 0179's HTML body (written through the
 * commands, audited, held by the column grant), and `sendTemplatedEmail` — the organisation's wording or the built-in,
 * rendered strictly, queued through phase 1's `sendEmail` with `template_code` set, and still held by the isolation gate.
 */

const ORG = "tpl-email-a";
const TODAY = "2026-10-24";
const KEYED = {
  NZI_DATABASE_BOUNDARY: "isolated-non-production", NEXT_PUBLIC_APP_ENV: "staging",
  RESEND_API_KEY: "re_test_0123456789abcdef", EMAIL_FROM: "Net Zero International <no-reply@netzero.international>",
};
const RESET = { displayName: "Grace Example", resetLink: "https://console.example.test/portal/reset#token=fresh-token", expiresAt: "Friday 30 October 2026, 17:00" };

function resend(): typeof fetch & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ id: `re-${calls.length}` }), { status: 200 });
  }) as unknown as typeof fetch & { calls: Array<Record<string, unknown>> };
  impl.calls = calls;
  return impl;
}

describe("templated email (phase 2), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let counter = 0;
  const context = (role: StaffRole = "admin", reason?: string): CommandContext => {
    counter += 1;
    return { organisationId: ORG, actorId: "ada", principal: "staff", idempotencyKey: `tple-${counter}`, correlationId: `corr-tple-${counter}`, ...(reason ? { reason } : {}), grant: commandGrantForRole(role, ORG, "ada") };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const send = (input: Parameters<typeof sendTemplatedEmail>[2]) => withTenantWrite(database.pool, ORG, (db) => sendTemplatedEmail(db, ORG, input));
  const message = async (id: string) => (await q(
    `SELECT template_code, to_email, subject, text_body, html_body, status, last_error FROM nzi_console.email_messages WHERE email_message_id = $1`, [id]))[0];
  const refused = (field: string, code: string) => (error: Error & { issues?: Array<{ field: string; code: string }> }) =>
    error.issues?.some((issue) => issue.field === field && issue.code === code) === true;

  before(async () => {
    database = (await createDisposableDatabase("templatedemail"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin')`, [ORG]);
    // A known company name, so both parts can be checked for the organisation's signature (F-Q7: never the template's; 5-1).
    await q(`UPDATE nzi_console.organisation_profiles SET display_name = 'Net Zero International Ltd' WHERE organisation_id = $1`, [ORG]);
  });
  beforeEach(async () => {
    await q(`DELETE FROM nzi_console.transactional_outbox WHERE organisation_id = $1`, [ORG]);
    await q(`DELETE FROM nzi_console.email_messages WHERE organisation_id = $1`, [ORG]);
  });
  after(async () => { await database?.end(); });

  describe("the HTML body (0179) through the commands", () => {
    it("is written, read back, audited before and after, and changes on its own as an edit", async () => {
      const html = "<p>Hello {{displayName}}, reset here: <a href=\"{{resetLink}}\">reset</a></p>";
      const made = await createMessageTemplate(database.pool, {
        templateKey: "password.reset.portal", subject: "Reset", body: "Hello {{displayName}}: {{resetLink}}", html,
      }, context());
      assert.equal(made.data.html, html);
      assert.deepEqual(await withTenantRead(database.pool, ORG, (db) => readActiveMessageTemplate(db, "password.reset.portal")),
        { subject: "Reset", body: "Hello {{displayName}}: {{resetLink}}", html });

      // Only the HTML changes — the app role's column grant must cover it (a relaxed write path proved on the real grants).
      const edited = await updateMessageTemplate(database.pool, {
        templateKey: "password.reset.portal", expectedVersion: 1, subject: "Reset", body: "Hello {{displayName}}: {{resetLink}}", html: "<p>{{resetLink}}</p>",
      }, context());
      assert.equal(edited.data.version, 2);
      const [audit] = await q(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'message_template.updated'`, [ORG]);
      assert.deepEqual([audit.before_json.html, audit.after_json.html], [html, "<p>{{resetLink}}</p>"]);

      // Clearing it is an edit too: back to the HTML part made from the text.
      const cleared = await updateMessageTemplate(database.pool, {
        templateKey: "password.reset.portal", expectedVersion: 2, subject: "Reset", body: "Hello {{displayName}}: {{resetLink}}", html: null,
      }, context());
      assert.equal(cleared.data.html, null);
      await assert.rejects(updateMessageTemplate(database.pool, {
        templateKey: "password.reset.portal", expectedVersion: 3, subject: "Reset", body: "Hello {{displayName}}: {{resetLink}}",
      }, context()), refused("body", "UNCHANGED"), "absent and null are the same: no HTML body of its own");
      const row = (await withTenantRead(database.pool, ORG, listMessageTemplates)).find((entry) => entry.key === "password.reset.portal")!;
      assert.equal(row.htmlPart, true);
      assert.equal(row.saved?.html, null);
    });

    it("refuses unsafe HTML, a link at rest, HTML on a plain-text key, and anyone without admin.templates", async () => {
      await assert.rejects(createMessageTemplate(database.pool, { templateKey: "message.notification", subject: "S", body: "{{threadLink}}", html: "<p>{{threadLink}}</p><script>x</script>" }, context()), refused("html", "UNSAFE_HTML"));
      await assert.rejects(createMessageTemplate(database.pool, { templateKey: "message.notification", subject: "S", body: "{{threadLink}} https://console.example.test/enrol#token=abc" }, context()), refused("body", "LINK_AT_REST"));
      await assert.rejects(createMessageTemplate(database.pool, { templateKey: "strategy.reminder.overdue", subject: "S", body: "{{targetDate}}", html: "<p>x</p>" }, context()), refused("html", "NOT_SENT_AS_HTML"));
      await assert.rejects(createMessageTemplate(database.pool, { templateKey: "message.notification", subject: "S", body: "{{threadLink}}" }, context("consultant")), /admin\.templates|permission/i);
      assert.equal((await q(`SELECT 1 FROM nzi_console.message_templates WHERE organisation_id = $1 AND template_key = 'message.notification'`, [ORG])).length, 0);
    });

    it("the database bounds the column: a blank HTML body cannot be stored", async () => {
      await assert.rejects(q(`UPDATE nzi_console.message_templates SET html_body = '  ' WHERE organisation_id = $1`, [ORG]), /check constraint/);
    });
  });

  describe("sendTemplatedEmail", () => {
    it("renders the built-in, multipart, with the house signature, and queues it through sendEmail with template_code set", async () => {
      const queued = await send({ templateCode: "portal.access.invite", to: "grace@netzero.international", vars: {
        displayName: "Grace", clientName: "Example Manufacturing Ltd", senderName: "Sam Adviser", inviteLink: "https://console.example.test/portal/accept#token=t1", expiresAt: "Friday",
      } });
      assert.equal(queued.enqueued, true);
      const row = await message(queued.emailMessageId);
      assert.equal(row.template_code, "portal.access.invite");
      assert.equal(row.status, "queued");
      assert.equal(row.subject, "Your NZ Insights Pro client portal access for Example Manufacturing Ltd");
      assert.match(row.text_body, /https:\/\/console\.example\.test\/portal\/accept#token=t1/);
      // The text part closes with the house signature (5-1): the company, the website, then the GDPR block.
      assert.ok(row.text_body.endsWith(`\n\n--\nNet Zero International Ltd\nWebsite: netzero.international\n\n${DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE}`), row.text_body);
      assert.match(row.html_body, /href="https:\/\/console\.example\.test\/portal\/accept#token=t1"/);
      assert.match(row.html_body, /font-weight:bold">Net Zero International Ltd<\/p>/);
      const [outbox] = await q(`SELECT topic, payload_json FROM nzi_console.transactional_outbox WHERE organisation_id = $1`, [ORG]);
      assert.deepEqual([outbox.topic, outbox.payload_json], ["email.send", { emailMessageId: queued.emailMessageId }]);
    });

    it("uses the organisation's own wording when it has some, and the built-in again once that is deactivated", async () => {
      const own = await createMessageTemplate(database.pool, {
        templateKey: "password.reset.staff", subject: "Your reset, {{displayName}}", body: "Reset: {{resetLink}} (until {{expiresAt}})",
        html: "<p>Our own words: <a href=\"{{resetLink}}\">reset</a></p>",
      }, context());
      const vars = { displayName: "Sam", resetLink: "https://console.example.test/reset#token=t2", expiresAt: "noon" };
      const first = await message((await send({ templateCode: "password.reset.staff", to: "sam@netzero.international", vars })).emailMessageId);
      assert.equal(first.subject, "Your reset, Sam");
      assert.match(first.html_body, /Our own words/);
      await deactivateMessageTemplate(database.pool, { templateKey: "password.reset.staff", expectedVersion: own.data.version }, context("admin", "Back to standard"));
      const second = await message((await send({ templateCode: "password.reset.staff", to: "sam@netzero.international", vars })).emailMessageId);
      assert.equal(second.subject, messageTemplateDefinition("password.reset.staff")!.builtIn.subject);
    });

    it("refuses a missing token, an unknown one, a non-https link and an unknown template — and writes nothing", async () => {
      const without = { ...RESET } as Record<string, string>;
      delete without.resetLink;
      for (const [templateCode, vars] of [
        ["password.reset.portal", without],
        ["password.reset.portal", { ...RESET, temporaryPassword: "hunter2" }],
        ["password.reset.portal", { ...RESET, resetLink: "http://evil.example/reset" }],
        ["quote.send", RESET],
      ] as const) {
        await assert.rejects(send({ templateCode, to: "grace@netzero.international", vars }), TemplatedEmailError, `${templateCode} ${JSON.stringify(Object.keys(vars))}`);
      }
      assert.equal((await q(`SELECT 1 FROM nzi_console.email_messages WHERE organisation_id = $1`, [ORG])).length, 0);
      assert.equal((await q(`SELECT 1 FROM nzi_console.transactional_outbox WHERE organisation_id = $1`, [ORG])).length, 0);
    });

    it("never names a value in its refusal — a link or a name stays out of the error", async () => {
      const error = await send({ templateCode: "password.reset.portal", to: "grace@netzero.international", vars: { ...RESET, resetLink: "http://evil.example/secret-token" } })
        .then(() => null, (caught: Error) => caught);
      assert.ok(error instanceof TemplatedEmailError);
      assert.ok(!error.message.includes("secret-token"));
    });

    it("keeps phase 1's queue rules: one per idempotency key, and the isolation gate still stubs a non-NZI recipient", async () => {
      const once = await send({ templateCode: "message.notification", to: "client@example.com", idempotencyKey: "notify:thread-1:7",
        vars: { displayName: "Client", clientName: "Example Ltd", threadLink: "https://console.example.test/portal/messages" } });
      const again = await send({ templateCode: "message.notification", to: "client@example.com", idempotencyKey: "notify:thread-1:7",
        vars: { displayName: "Client", clientName: "Example Ltd", threadLink: "https://console.example.test/portal/messages" } });
      assert.deepEqual(again, { emailMessageId: once.emailMessageId, enqueued: false });

      const fetchImpl = resend();
      await withTenantWorker(database.pool, ORG, (db) => drainOutbox(db, {
        organisationId: ORG, today: TODAY, mailer: suppressingMailer(), delivery: { mode: "suppress", reason: "test" }, email: emailDispatchFromEnv(KEYED, fetchImpl),
      }));
      assert.equal(fetchImpl.calls.length, 0, "a client address on the isolated boundary is never posted");
      const row = await message(once.emailMessageId);
      assert.equal(row.status, "stubbed");
      assert.equal(row.template_code, "message.notification", "the template code survives resolution");
      assert.equal(row.html_body, null, "and the body is still cleared at rest (phase 1)");
    });

    it("sends both parts to Resend for an NZI recipient", async () => {
      await send({ templateCode: "password.reset.portal", to: "grace@netzero.international", vars: RESET });
      const fetchImpl = resend();
      await withTenantWorker(database.pool, ORG, (db) => drainOutbox(db, {
        organisationId: ORG, today: TODAY, mailer: suppressingMailer(), delivery: { mode: "suppress", reason: "test" }, email: emailDispatchFromEnv(KEYED, fetchImpl),
      }));
      assert.equal(fetchImpl.calls.length, 1);
      const [call] = fetchImpl.calls;
      assert.match(String(call!.text), /fresh-token/);
      assert.match(String(call!.html), /href="https:\/\/console\.example\.test\/portal\/reset#token=fresh-token"/);
    });
  });
});
