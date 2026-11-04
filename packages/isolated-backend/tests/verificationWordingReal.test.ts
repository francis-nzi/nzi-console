import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * 0208, against a real database: NZI offers emissions verification, not assurance (NZC-170), and so does the wording that is *stored*.
 *  1. an organisation provisioned now is seeded with the new wording (the seeding function was re-created);
 *  2. put the rows back as they stood (old wording, in an ACTIVE - published - framework) and run the migration's own SQL: the SRS level and
 *     requirement, and a saved message template, are rewritten by exact string; each row is audited with its before and after;
 *  3. a template's version is bumped and its updated_by left; a template with no such wording is untouched;
 *  4. the published-framework triggers are back on afterwards - a published version is still never edited;
 *  5. running it again changes nothing, and no identifier (the level key, the requirement's source key) is touched.
 */
const ORG = "vw-org";
const OLD_LEVEL = { label: "Assured", definition: "Independently assured or externally verified, and ready to withstand scrutiny." };
const OLD_REQ = { title: "GHG inventory independently assured", help: "Whether the inventory has been externally verified or assured, by whom, and to what standard." };

describe("0208: stored wording says verification", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const migration = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../migrations/0208_verification_wording.sql"), "utf8");
  const level4 = async () => (await q(`SELECT key, label, definition, framework_id FROM nzi_console.srs_maturity_levels WHERE organisation_id = $1 AND level = 4`, [ORG]))[0]!;
  const m13 = async () => (await q(`SELECT title, help_text, nzi_source_key, framework_id FROM nzi_console.srs_requirements WHERE organisation_id = $1 AND requirement_id = 's2-m13'`, [ORG]))[0]!;
  const audits = () => q(`SELECT action, entity_type, entity_id, before_json, after_json, actor_id, principal_type FROM nzi_console.audit_events WHERE actor_id = 'migration:0208' AND organisation_id = '${ORG}' ORDER BY entity_type, entity_id`);

  before(async () => {
    database = (await createDisposableDatabase("verifywording"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("an organisation provisioned after 0208 is seeded with the new wording", async () => {
    assert.deepEqual([(await level4()).label, (await level4()).definition], ["Verified", "Independently verified, and ready to withstand scrutiny."]);
    assert.deepEqual([(await m13()).title, (await m13()).help_text], ["GHG inventory independently verified", "Whether the inventory has been externally verified, by whom, and to what standard."]);
    assert.equal((await q(`SELECT status FROM nzi_console.srs_frameworks WHERE organisation_id = $1`, [ORG]))[0]!.status, "active", "a published framework, which the app can never edit");
  });

  it("rewrites the stored wording by exact string, audits every row, and leaves identifiers, other rows and the triggers alone", async () => {
    // Put the rows back as they stood before 0208. A published framework is protected by two triggers; lift them just to stage the old state.
    await db.query(`ALTER TABLE nzi_console.srs_maturity_levels DISABLE TRIGGER srs_maturity_levels_follow_their_draft`);
    await db.query(`ALTER TABLE nzi_console.srs_requirements DISABLE TRIGGER srs_requirements_follow_their_draft`);
    await db.query(`UPDATE nzi_console.srs_maturity_levels SET label = $2, definition = $3 WHERE organisation_id = $1 AND level = 4`, [ORG, OLD_LEVEL.label, OLD_LEVEL.definition]);
    await db.query(`UPDATE nzi_console.srs_requirements SET title = $2, help_text = $3 WHERE organisation_id = $1 AND requirement_id = 's2-m13'`, [ORG, OLD_REQ.title, OLD_REQ.help]);
    await db.query(`ALTER TABLE nzi_console.srs_maturity_levels ENABLE TRIGGER srs_maturity_levels_follow_their_draft`);
    await db.query(`ALTER TABLE nzi_console.srs_requirements ENABLE TRIGGER srs_requirements_follow_their_draft`);
    const untouchedBefore = await q(`SELECT level, label, definition FROM nzi_console.srs_maturity_levels WHERE organisation_id = $1 AND level < 4 ORDER BY level`, [ORG]);
    await db.query(`INSERT INTO nzi_console.message_templates (organisation_id, template_key, subject, body, html_body, created_by, updated_by)
      VALUES ($1,'message.notification','Your assurance update','Hello {{firstName}}, the assured figures are ready. We assure you. {{threadLink}}','<p>Assured and <b>Assurance</b> {{threadLink}}</p>','import','import'),
             ($1,'password.reset.portal','Reset {{resetLink}}','Hello {{firstName}}, reset: {{resetLink}} {{expiresAt}}',NULL,'import','import')`, [ORG]);
    const templateBefore = (await q(`SELECT version, updated_by FROM nzi_console.message_templates WHERE template_key = 'message.notification'`))[0]!;
    const untouchedTemplate = (await q(`SELECT version, subject FROM nzi_console.message_templates WHERE template_key = 'password.reset.portal'`))[0]!;
    assert.equal((await audits()).length, 0, "nothing audited yet");

    await db.query(migration); // the file itself, as written

    assert.deepEqual([(await level4()).label, (await level4()).definition], ["Verified", "Independently verified, and ready to withstand scrutiny."]);
    assert.deepEqual([(await m13()).title, (await m13()).help_text], ["GHG inventory independently verified", "Whether the inventory has been externally verified, by whom, and to what standard."]);
    assert.equal((await level4()).key, "assured", "the level's key is an identifier and stays");
    assert.equal((await m13()).nzi_source_key, "footprint.assurance", "the requirement's source key is an identifier and stays");
    assert.deepEqual(await q(`SELECT level, label, definition FROM nzi_console.srs_maturity_levels WHERE organisation_id = $1 AND level < 4 ORDER BY level`, [ORG]), untouchedBefore, "other levels untouched");

    const template = (await q(`SELECT subject, body, html_body, version, updated_by FROM nzi_console.message_templates WHERE template_key = 'message.notification'`))[0]!;
    assert.equal(template.subject, "Your verification update");
    assert.equal(template.body, "Hello {{firstName}}, the verified figures are ready. We verify you. {{threadLink}}");
    assert.equal(template.html_body, "<p>Verified and <b>Verification</b> {{threadLink}}</p>");
    assert.deepEqual([template.version, template.updated_by], [templateBefore.version + 1, templateBefore.updated_by], "version bumped; updated_by left as it was");
    assert.deepEqual((await q(`SELECT version, subject FROM nzi_console.message_templates WHERE template_key = 'password.reset.portal'`))[0], untouchedTemplate, "a template with no such wording is untouched");

    // One audit event per row changed, system principal, before and after in full.
    const events = await audits();
    assert.deepEqual(events.map((e) => [e.action, e.entity_type]), [
      ["message_template.updated", "message_template"], ["srs_framework.wording_updated", "srs_maturity_level"], ["srs_framework.wording_updated", "srs_requirement"]]);
    assert.ok(events.every((e) => e.principal_type === "system" && e.actor_id === "migration:0208"));
    const byType = Object.fromEntries(events.map((e) => [e.entity_type, e]));
    assert.deepEqual([byType.srs_maturity_level.before_json.label, byType.srs_maturity_level.after_json.label], ["Assured", "Verified"]);
    assert.deepEqual([byType.srs_requirement.before_json.title, byType.srs_requirement.after_json.title], [OLD_REQ.title, "GHG inventory independently verified"]);
    assert.match(byType.message_template.before_json.body, /assured figures/);
    assert.match(byType.message_template.after_json.body, /verified figures/);

    // The published-framework triggers are back on: a published version is still never edited.
    await assert.rejects(q(`UPDATE nzi_console.srs_requirements SET title = 'Edited' WHERE organisation_id = $1 AND requirement_id = 's2-m13'`, [ORG]), /never edited/);
    await assert.rejects(q(`UPDATE nzi_console.srs_maturity_levels SET label = 'Edited' WHERE organisation_id = $1 AND level = 4`, [ORG]), /never edited/);
    assert.deepEqual((await q(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN ('srs_requirements_follow_their_draft','srs_maturity_levels_follow_their_draft') ORDER BY tgname`)).map((r) => r.tgenabled), ["O", "O"]);
  });

  it("running it again changes nothing: no further audit rows, no further version bump", async () => {
    const before = { audits: (await audits()).length, version: (await q(`SELECT version FROM nzi_console.message_templates WHERE template_key = 'message.notification'`))[0]!.version };
    await db.query(migration);
    assert.equal((await audits()).length, before.audits);
    assert.equal((await q(`SELECT version FROM nzi_console.message_templates WHERE template_key = 'message.notification'`))[0]!.version, before.version);
  });
});
