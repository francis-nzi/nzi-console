import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { messageContentFor, messageTemplateDefinition, renderEmailTemplate } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { readActiveMessageTemplate } from "../src/messageTemplates";
import { withTenantRead, withTenantWrite } from "../src/postgres";
import { sendTemplatedEmail } from "../src/templatedEmail";
import { MESSAGE_TEMPLATES_RUN_PREFIX } from "../src/v7MessageTemplatesLoad";

/**
 * 0180 (email programme phase 3, R4): the staff invitation's saved wording moves from {{link}} to {{inviteLink}}, so every
 * row stays sendable once the registry declares only `inviteLink`. Seeded the way the rows really arrive — after 0179 and
 * before 0180 — and then read as the deploy leaves them.
 */

const ORG = "invite-token-org";
const OTHER = "invite-token-other";
const RUN = `${MESSAGE_TEMPLATES_RUN_PREFIX}seeded`;

describe("0180: {{link}} → {{inviteLink}} in saved staff invitations", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("invitetoken", {
      onMigration: async (filename, client) => {
        if (filename !== "0179_message_template_html.sql") return;
        for (const org of [ORG, OTHER]) await client.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
        // An organisation's own wording, both parts, with the old token twice in the HTML.
        await client.query(`INSERT INTO nzi_console.message_templates (organisation_id, template_key, subject, body, html_body, created_by, updated_by)
          VALUES ($1, 'staff.invitation', 'Join {{link}}?', 'Start: {{link}} by {{expiresAt}}', '<a href="{{link}}">{{link}}</a> {{expiresAt}}', 'ada', 'ada')`, [ORG]);
        // Wording a v7 import wrote, deactivated — the loader must still read it as the import's.
        await client.query(`INSERT INTO nzi_console.message_templates (organisation_id, template_key, subject, body, active, source_system, legacy_db_id, legacy_values, created_by, updated_by)
          VALUES ($1, 'staff.invitation', 'Welcome', 'Your link: {{link}}', false, 'nzi-pro-v7', '7', '{}'::jsonb, $2, $2)`, [OTHER, RUN]);
        // Another key whose wording happens to contain the text: not the staff invitation, so not touched.
        await client.query(`INSERT INTO nzi_console.message_templates (organisation_id, template_key, subject, body, created_by, updated_by)
          VALUES ($1, 'strategy.reminder.overdue', 'Late', 'Literal {{link}} text {{targetDate}}', 'ada', 'ada')`, [ORG]);
      },
    }))!;
    admin = await database.admin();
  });
  after(async () => { await admin?.end(); await database?.end(); });

  const row = async (org: string, key: string) => (await admin.query(
    `SELECT subject, body, html_body, version, updated_by, active FROM nzi_console.message_templates WHERE organisation_id = $1 AND template_key = $2`, [org, key])).rows[0];

  it("rewrites every {{link}} in a staff invitation's subject, body and HTML, and bumps the version", async () => {
    const own = await row(ORG, "staff.invitation");
    assert.deepEqual([own.subject, own.body, own.html_body], ["Join {{inviteLink}}?", "Start: {{inviteLink}} by {{expiresAt}}", '<a href="{{inviteLink}}">{{inviteLink}}</a> {{expiresAt}}']);
    assert.equal(own.version, 2, "an editor opened before the deploy is told it changed");
    const imported = await row(OTHER, "staff.invitation");
    assert.equal(imported.body, "Your link: {{inviteLink}}");
    assert.equal(imported.active, false, "inactive wording is rewritten too, so reinstating it later still sends");
  });

  it("leaves updated_by alone, so the v7 loader still reads an imported row as the import's", async () => {
    assert.equal((await row(OTHER, "staff.invitation")).updated_by, RUN);
    assert.equal((await row(ORG, "staff.invitation")).updated_by, "ada");
  });

  it("touches no other key", async () => {
    const other = await row(ORG, "strategy.reminder.overdue");
    assert.deepEqual([other.body, other.version], ["Literal {{link}} text {{targetDate}}", 1]);
  });

  it("records each rewrite as an audited template update by the migration, before and after in full", async () => {
    const { rows } = await admin.query(
      `SELECT organisation_id, actor_id, principal_type, entity_id, before_json, after_json FROM nzi_console.audit_events
        WHERE action = 'message_template.updated' AND actor_id = 'migration:0180' ORDER BY organisation_id`);
    assert.deepEqual(rows.map((event) => [event.organisation_id, event.principal_type, event.entity_id]),
      [[ORG, "system", "staff.invitation"], [OTHER, "system", "staff.invitation"]]);
    assert.equal(rows[0].before_json.body, "Start: {{link}} by {{expiresAt}}");
    assert.equal(rows[0].after_json.body, "Start: {{inviteLink}} by {{expiresAt}}");
    assert.equal(rows[0].after_json.version, 2);
  });

  it("leaves the wording valid: it renders and queues under the registry's {{inviteLink}}, with no row refused", async () => {
    const definition = messageTemplateDefinition("staff.invitation")!;
    assert.deepEqual(definition.tokens.map((token) => token.name), ["inviteLink", "expiresAt"]);
    const vars = { inviteLink: "https://console.example.test/enrol#token=abc", expiresAt: "Friday" };
    for (const org of [ORG, OTHER]) {
      const saved = (await admin.query(`SELECT subject, body, html_body FROM nzi_console.message_templates WHERE organisation_id = $1 AND template_key = 'staff.invitation'`, [org])).rows[0];
      const rendered = renderEmailTemplate(definition, messageContentFor(definition, { subject: saved.subject, body: saved.body, html: saved.html_body }), vars);
      assert.ok(rendered.ok, `${org}: ${rendered.ok ? "" : rendered.issues.join(" ")}`);
    }
    assert.ok(await withTenantRead(database.pool, ORG, (db) => readActiveMessageTemplate(db, "staff.invitation")));
    const queued = await withTenantWrite(database.pool, ORG, (db) => sendTemplatedEmail(db, ORG, { templateCode: "staff.invitation", to: "x@netzero.international", vars }));
    const email = (await admin.query(`SELECT subject, text_body FROM nzi_console.email_messages WHERE email_message_id = $1`, [queued.emailMessageId])).rows[0];
    assert.equal(email.subject, "Join https://console.example.test/enrol#token=abc?");
    assert.match(email.text_body, /^Start: https:\/\/console\.example\.test\/enrol#token=abc by Friday/);
  });

  it("a {{link}} saved now is refused: the token is gone from the registry", async () => {
    const definition = messageTemplateDefinition("staff.invitation")!;
    const rendered = renderEmailTemplate(definition, { subject: "S", body: "{{link}}" }, { link: "https://x.example/enrol#token=t" } as never);
    assert.equal(rendered.ok, false);
  });
});
