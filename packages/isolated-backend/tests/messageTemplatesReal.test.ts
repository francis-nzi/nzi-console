import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticRows } from "./support/v7SyntheticExtract";
import {
  createMessageTemplate, deactivateMessageTemplate, listMessageTemplates, readActiveMessageTemplate, reinstateMessageTemplate, updateMessageTemplate,
} from "../src/messageTemplates";
import { withTenantRead } from "../src/postgres";
import type { V7Row, V7Table } from "../src/v7ClientExtract";
import { htmlToText, loadV7MessageTemplates, MESSAGE_TEMPLATES_RUN_PREFIX, planV7MessageTemplates } from "../src/v7MessageTemplatesLoad";

/**
 * Message templates (admin Phase F1; ruled `phaseF-comms-crm-plan.md`, F-Q2/F-Q3) against a real database: 0149's
 * guarantees (a key set once, nothing deleted, tenant-confined, the worker reading), the commands (admin.templates; a
 * registry key only, declared tokens only, the link an invitation needs), and load:v7-message-templates (known keys only,
 * a token the key does not supply refusing the template, HTML to text, a person's wording kept, R4).
 */
const ORG = "templates-org";
const OTHER = "templates-other";
const LOAD = "templates-load";
type Rows = ReturnType<typeof syntheticRows>;
const extract = (mutate?: (rows: Rows) => void): Partial<Record<V7Table, V7Row[]>> => { const rows = syntheticRows(); mutate?.(rows); return syntheticExtract(rows); };

describe("planning the message-template import (no database)", () => {
  it("reports v7 keys with no console send-site, and refuses v7's staff invite for the tokens the console never supplies", () => {
    const plan = planV7MessageTemplates(extract());
    assert.deepEqual(plan.values, []);
    assert.deepEqual(plan.unknownKeys, ["quote_send", "portal_welcome", "introduction"]);
    assert.deepEqual(plan.refused, [{ v7Key: "team_member_invite", reason: "uses {{full_name}}, {{temporary_password}}, which staff.invitation does not supply" }]);
  });

  it("takes a known key's wording, renaming tokens, turning HTML into text — and refuses one that drops a required token", () => {
    const plan = planV7MessageTemplates(extract((rows) => {
      rows.message_templates.push({ template_id: "9", template_key: "strategy.reminder.overdue", channel: "email", subject_template: "Late: {{strategyTitle}}",
        body_template: "<p>Hello {{firstName}},</p><p>{{clientName}} &amp; you missed {{targetDate}}.<br/>Thanks</p>", is_active: "t" });
      rows.message_templates[0]!.body_template = "<p>Your link expires {{invite_expires_at}}.</p>";
    }));
    assert.deepEqual(plan.values.map((value) => [value.v7Key, value.templateKey, value.subject, value.body, value.convertedFromHtml]), [
      ["strategy.reminder.overdue", "strategy.reminder.overdue", "Late: {{strategyTitle}}", "Hello {{firstName}},\n\n{{clientName}} & you missed {{targetDate}}.\nThanks", true],
    ]);
    assert.deepEqual(plan.refused, [{ v7Key: "team_member_invite", reason: "The body must include {{link}} — the single-use enrolment link." }]);
  });

  it("converts HTML lists, entities and whitespace", () => {
    assert.equal(htmlToText("<h2>Hi</h2>\n<ul><li>One</li><li>Two &lt;3</li></ul><p>  spaced   out  </p>"), "Hi\n\n- One\n- Two <3\n\nspaced out");
  });
});

describe("message templates, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let counter = 0;
  const context = (actor: string, role: StaffRole, org = ORG, reason?: string): CommandContext => {
    counter += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: `tpl-${counter}`, correlationId: `corr-tpl-${counter}`, ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const as = async (role: "nzi_console_app" | "nzi_console_worker", org: string, sql: string, params: unknown[] = []) => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('app.organisation_id', $1, true)`, [org]);
      const rows = (await client.query(sql, params)).rows;
      await client.query("COMMIT");
      return rows;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  };
  const refused = (field: string, code: string) => (error: Error & { issues?: Array<{ field: string; code: string }> }) => error.issues?.some((issue) => issue.field === field && issue.code === code) === true;

  before(async () => {
    database = (await createDisposableDatabase("messagetemplates"))!;
    for (const org of [ORG, OTHER, LOAD]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES
        ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'cal', 'consultant', 'active', 'Cal Consultant')`, [org]);
    }
  });
  after(async () => { await database?.end(); });

  describe("the commands (admin.templates)", () => {
    it("words a registry key, audited in full; refuses a key no send-site uses, an undeclared token and a missing link", async () => {
      const made = await createMessageTemplate(database.pool, { templateKey: "strategy.reminder.overdue", subject: "Overdue: {{strategyTitle}}", body: "Dear {{firstName}}, {{targetDate}} has passed." }, context("ada", "admin"));
      assert.deepEqual([made.data.templateKey, made.data.active, made.data.version], ["strategy.reminder.overdue", true, 1]);
      await assert.rejects(createMessageTemplate(database.pool, { templateKey: "quote.send", subject: "S", body: "B" }, context("ada", "admin")), refused("templateKey", "UNKNOWN_KEY"));
      await assert.rejects(createMessageTemplate(database.pool, { templateKey: "strategy.reminder.approaching", subject: "S", body: "Hi {{password}}" }, context("ada", "admin")), refused("body", "UNKNOWN_TOKEN"));
      await assert.rejects(createMessageTemplate(database.pool, { templateKey: "staff.invitation", subject: "Join", body: "Welcome. Until {{expiresAt}}." }, context("ada", "admin")), refused("body", "MISSING_TOKEN"));
      await assert.rejects(createMessageTemplate(database.pool, { templateKey: "strategy.reminder.overdue", subject: "Again", body: "Again" }, context("ada", "admin")), refused("templateKey", "DUPLICATE"));
      await assert.rejects(createMessageTemplate(database.pool, { templateKey: "strategy.reminder.approaching", subject: "S", body: "B" }, context("cal", "consultant")), /admin\.templates|permission/i);
    });

    it("edits against the version, refuses an unchanged edit, and goes back to the built-in wording by deactivating (with a reason) — never deleting", async () => {
      const edited = await updateMessageTemplate(database.pool, { templateKey: "strategy.reminder.overdue", expectedVersion: 1, subject: "Overdue: {{strategyTitle}}", body: "Dear {{firstName}}, {{targetDate}} has gone." }, context("ada", "admin"));
      assert.equal(edited.data.version, 2);
      await assert.rejects(updateMessageTemplate(database.pool, { templateKey: "strategy.reminder.overdue", expectedVersion: 2, subject: "Overdue: {{strategyTitle}}", body: "Dear {{firstName}}, {{targetDate}} has gone." }, context("ada", "admin")), refused("body", "UNCHANGED"));
      await assert.rejects(updateMessageTemplate(database.pool, { templateKey: "strategy.reminder.overdue", expectedVersion: 1, subject: "x", body: "y" }, context("ada", "admin")), /version/i);
      const [audit] = await q(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'message_template.updated'`, [ORG]);
      assert.deepEqual([audit.before_json.body, audit.after_json.body], ["Dear {{firstName}}, {{targetDate}} has passed.", "Dear {{firstName}}, {{targetDate}} has gone."]);

      assert.deepEqual(await withTenantRead(database.pool, ORG, (db) => readActiveMessageTemplate(db, "strategy.reminder.overdue")), { subject: "Overdue: {{strategyTitle}}", body: "Dear {{firstName}}, {{targetDate}} has gone." });
      await assert.rejects(deactivateMessageTemplate(database.pool, { templateKey: "strategy.reminder.overdue", expectedVersion: 2 }, context("ada", "admin")), /Command validation failed/, "a reason is required");
      const off = await deactivateMessageTemplate(database.pool, { templateKey: "strategy.reminder.overdue", expectedVersion: 2 }, context("ada", "admin", ORG, "Back to the standard wording"));
      assert.equal(await withTenantRead(database.pool, ORG, (db) => readActiveMessageTemplate(db, "strategy.reminder.overdue")), null, "inactive → the built-in wording");
      const listed = await withTenantRead(database.pool, ORG, (db) => listMessageTemplates(db));
      assert.deepEqual(listed.map((row) => [row.key, row.inUse, row.saved?.active ?? null]), [
        ["strategy.reminder.approaching", "built-in", null], ["strategy.reminder.overdue", "built-in", false], ["staff.invitation", "built-in", null]]);
      await reinstateMessageTemplate(database.pool, { templateKey: "strategy.reminder.overdue", expectedVersion: off.data.version }, context("ada", "admin"));
      assert.equal((await withTenantRead(database.pool, ORG, (db) => listMessageTemplates(db)))[1]!.inUse, "own");
    });
  });

  describe("0149's guarantees", () => {
    it("sets a key once, deletes nothing, is tenant-confined — and the worker may read but not write", async () => {
      await assert.rejects(as("nzi_console_app", ORG, `UPDATE nzi_console.message_templates SET template_key = 'staff.invitation'`), /permission denied/);
      await assert.rejects(as("nzi_console_app", ORG, `UPDATE nzi_console.message_templates SET channel = 'sms'`), /permission denied/);
      await assert.rejects(as("nzi_console_app", ORG, `DELETE FROM nzi_console.message_templates`), /permission denied/);
      assert.equal((await as("nzi_console_app", OTHER, `SELECT count(*)::int AS n FROM nzi_console.message_templates`))[0].n, 0);
      assert.equal((await as("nzi_console_worker", ORG, `SELECT count(*)::int AS n FROM nzi_console.message_templates`))[0].n, 1, "the reminder worker reads its organisation's wording");
      assert.equal((await as("nzi_console_worker", OTHER, `SELECT count(*)::int AS n FROM nzi_console.message_templates`))[0].n, 0, "and only its own organisation's");
      await assert.rejects(as("nzi_console_worker", ORG, `UPDATE nzi_console.message_templates SET subject = 'x'`), /permission denied/);
    });
  });

  describe("load:v7-message-templates", () => {
    const withOverdue = () => extract((rows) => {
      rows.message_templates.push({ template_id: "9", template_key: "strategy.reminder.overdue", channel: "email", subject_template: "Late: {{strategyTitle}}",
        body_template: "<p>Hello {{firstName}},</p><p>{{targetDate}} has passed.</p>", is_active: "t" });
    });

    it("inserts onto known keys only, reports the rest, and keeps an organisation's own wording", async () => {
      await createMessageTemplate(database.pool, { templateKey: "staff.invitation", subject: "Join us", body: "Here: {{link}}" }, context("ada", "admin", LOAD));
      const dry = await loadV7MessageTemplates(database.pool, LOAD, planV7MessageTemplates(withOverdue()), { commit: false });
      assert.equal(dry.inserted, 1);
      assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.message_templates WHERE organisation_id = $1`, [LOAD]))[0].n, 1, "a dry run writes nothing");
      const outcome = await loadV7MessageTemplates(database.pool, LOAD, planV7MessageTemplates(withOverdue()), { commit: true, runId: `${MESSAGE_TEMPLATES_RUN_PREFIX}first` });
      assert.deepEqual([outcome.inserted, outcome.stamped, outcome.updated, outcome.refused, outcome.builtIn], [1, 0, 0, [], ["strategy.reminder.approaching"]]);
      assert.deepEqual(outcome.notes, ["strategy.reminder.overdue (v7 strategy.reminder.overdue): v7's HTML body converted to plain text — read it in the console before relying on it"]);
      const [row] = await q(`SELECT subject, body, active, source_system FROM nzi_console.message_templates WHERE organisation_id = $1 AND template_key = 'strategy.reminder.overdue'`, [LOAD]);
      assert.deepEqual([row.subject, row.body, row.active, row.source_system], ["Late: {{strategyTitle}}", "Hello {{firstName}},\n\n{{targetDate}} has passed.", true, "nzi-pro-v7"]);
      const [own] = await q(`SELECT subject FROM nzi_console.message_templates WHERE organisation_id = $1 AND template_key = 'staff.invitation'`, [LOAD]);
      assert.equal(own.subject, "Join us", "the organisation's own wording untouched");
      const audit = JSON.stringify(await q(`SELECT after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'message_templates.imported'`, [LOAD]));
      assert.ok(audit.includes("\"inserted\":1") && !audit.includes("Late:"), "the import's audit is counts, not wording");
    });

    it("re-run unchanged writes nothing; v7 changed and still as imported → v7 wins; edited here since → refused (R4)", async () => {
      const unchanged = await loadV7MessageTemplates(database.pool, LOAD, planV7MessageTemplates(withOverdue()), { commit: true, runId: `${MESSAGE_TEMPLATES_RUN_PREFIX}second` });
      assert.deepEqual([unchanged.inserted, unchanged.updated, unchanged.unchanged], [0, 0, 1]);
      const changed = () => extract((rows) => {
        rows.message_templates.push({ template_id: "9", template_key: "strategy.reminder.overdue", channel: "email", subject_template: "Overdue: {{strategyTitle}}",
          body_template: "{{firstName}}: {{targetDate}} has passed.", is_active: "t" });
      });
      const won = await loadV7MessageTemplates(database.pool, LOAD, planV7MessageTemplates(changed()), { commit: true, runId: `${MESSAGE_TEMPLATES_RUN_PREFIX}third` });
      assert.equal(won.updated, 1);
      const [held] = await q(`SELECT version FROM nzi_console.message_templates WHERE organisation_id = $1 AND template_key = 'strategy.reminder.overdue'`, [LOAD]);
      await updateMessageTemplate(database.pool, { templateKey: "strategy.reminder.overdue", expectedVersion: held.version, subject: "Ours: {{strategyTitle}}", body: "Ours {{targetDate}}." }, context("ada", "admin", LOAD));
      const conflict = await loadV7MessageTemplates(database.pool, LOAD, planV7MessageTemplates(withOverdue()), { commit: true, runId: `${MESSAGE_TEMPLATES_RUN_PREFIX}fourth` });
      assert.deepEqual(conflict.refused, ["strategy.reminder.overdue: changed in v7 since the last load, and edited here since (R4)"]);
    });
  });
});
