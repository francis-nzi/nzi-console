import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type MilestoneTemplateItemInput, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  createMilestoneTemplate, deactivateMilestoneTemplate, listMilestoneTemplates, reinstateMilestoneTemplate, setDefaultMilestoneTemplate,
  updateMilestoneTemplate,
} from "../src/milestoneTemplates";
import { createJobType } from "../src/jobTypes";
import { withTenantRead } from "../src/postgres";

/**
 * Admin Phase C2 against a real database: the milestone_template.* commands behind admin.templates — a template and its
 * schedule written together in one version, one item per kind, an item never deleted (a dropped kind is kept, not
 * included), the default moved atomically and never deactivated (Q6), a reason to move the default or deactivate,
 * versioned and idempotent, audited before and after — inside one organisation.
 */
const ORG_A = "mt-org-a";
const ORG_B = "mt-org-b";

type Issue = { field: string; code: string };
const issue = (field: string, code?: string) => (error: { issues?: Issue[] }) =>
  error.issues?.some((item) => item.field === field && (code === undefined || item.code === code)) === true;
const schedule = (dc: number | null, fd: number | null, fr: number | null): MilestoneTemplateItemInput[] => [
  ...(dc === null ? [] : [{ kind: "data_collection" as const, label: "Data collection", daysOffset: dc, included: true }]),
  ...(fd === null ? [] : [{ kind: "first_draft" as const, label: "First draft", daysOffset: fd, included: true }]),
  ...(fr === null ? [] : [{ kind: "final_report" as const, label: "Final report", daysOffset: fr, included: true }]),
];

describe("milestone templates, against the database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (org = ORG_A, role: StaffRole = "admin", reason?: string, idempotencyKey?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: `${role}-${org}`, principal: "staff", idempotencyKey: idempotencyKey ?? `mt-${keys}`, correlationId: `corr-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, `${role}-${org}`) };
  };
  const cards = (org = ORG_A) => withTenantRead(database.pool, org, listMilestoneTemplates);
  const card = async (name: string, org = ORG_A) => (await cards(org)).find((item) => item.name === name)!;
  const admin = async <T>(work: (db: import("pg").Client) => Promise<T>) => { const db = await database.admin(); try { return await work(db); } finally { await db.end(); } };

  before(async () => {
    database = (await createDisposableDatabase("milestonetemplates"))!;
    await admin(async (db) => {
      for (const org of [ORG_A, ORG_B]) {
        await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
        await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
        for (const role of ["admin", "consultant"]) {
          await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $2)`, [org, `${role}-${org}`, role]);
        }
      }
      await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'c1', 'Alpha', 'active')`, [ORG_A]);
    });
  });
  after(async () => { await database?.end(); });

  it("adds a template with its schedule in one command, and audits what it became", async () => {
    const made = await createMilestoneTemplate(database.pool, { name: "  Standard   CRP ", description: "The usual", items: schedule(14, 35, 56) }, context());
    assert.match(made.data.templateId, /^milestone-template:[0-9a-f-]{36}$/);
    const standard = await card("Standard CRP");
    assert.deepEqual([standard.isDefault, standard.active, standard.version, standard.provenance], [false, true, 1, "added"]);
    assert.deepEqual(standard.items.map((item) => [item.kind, item.daysOffset, item.included]), [["data_collection", 14, true], ["first_draft", 35, true], ["final_report", 56, true]]);
    const audit = await admin(async (db) => (await db.query(`SELECT action, entity_type, after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [made.auditEventId])).rows[0]);
    assert.deepEqual([audit.action, audit.entity_type, audit.after_json.name, audit.after_json.items.length], ["milestone_template.created", "milestone_template", "Standard CRP", 3]);
  });

  it("allows a template that schedules only some kinds — a training course with just a final report", async () => {
    await createMilestoneTemplate(database.pool, { name: "Training", items: schedule(null, null, 7) }, context());
    assert.deepEqual((await card("Training")).items.map((item) => item.kind), ["final_report"]);
  });

  it("refuses a template with nothing scheduled, a kind twice, a bad offset, a name another template holds (any case, inactive included)", async () => {
    await assert.rejects(createMilestoneTemplate(database.pool, { name: "Empty", items: [] }, context()), issue("items", "REQUIRED"));
    await assert.rejects(createMilestoneTemplate(database.pool, { name: "Off", items: [{ kind: "first_draft", label: "Draft", daysOffset: 10, included: false }] }, context()), issue("items", "REQUIRED"));
    await assert.rejects(createMilestoneTemplate(database.pool, { name: "Twice", items: [...schedule(1, null, null), ...schedule(2, null, null)] }, context()), issue("items.data_collection", "DUPLICATE"));
    await assert.rejects(createMilestoneTemplate(database.pool, { name: "Late", items: schedule(null, null, 4000) }, context()), issue("items.final_report.daysOffset"));
    await assert.rejects(createMilestoneTemplate(database.pool, { name: "Half", items: schedule(null, 2.5, null) }, context()), issue("items.first_draft.daysOffset"));
    await assert.rejects(createMilestoneTemplate(database.pool, { name: "standard crp", items: schedule(1, 2, 3) }, context()), issue("name", "DUPLICATE"));
  });

  it("is admin.templates — a consultant cannot change a template", async () => {
    await assert.rejects(createMilestoneTemplate(database.pool, { name: "Mine", items: schedule(1, 2, 3) }, context(ORG_A, "consultant")), /admin\.templates|permission|capabilit/i);
  });

  it("replays an idempotent retry instead of adding twice", async () => {
    const first = await createMilestoneTemplate(database.pool, { name: "Express CRP", items: schedule(7, 18, 28) }, context(ORG_A, "admin", undefined, "mt-same"));
    const again = await createMilestoneTemplate(database.pool, { name: "Express CRP", items: schedule(7, 18, 28) }, context(ORG_A, "admin", undefined, "mt-same"));
    assert.equal(again.replayed, true);
    assert.equal(again.data.templateId, first.data.templateId);
  });

  it("edits the template and its schedule as one versioned change — a dropped kind is kept, not deleted — and refuses a stale edit", async () => {
    const express = await card("Express CRP");
    const edited = await updateMilestoneTemplate(database.pool, {
      templateId: express.templateId, name: "Express CRP", expectedVersion: 1,
      items: [{ kind: "data_collection", label: "Data in", daysOffset: 5, included: true }, { kind: "final_report", label: "Final report", daysOffset: 28, included: true }],
    }, context());
    assert.equal(edited.data.version, 2);
    const now = await card("Express CRP");
    assert.deepEqual(now.items.map((item) => [item.kind, item.label, item.daysOffset, item.included]),
      [["data_collection", "Data in", 5, true], ["first_draft", "First draft", 18, false], ["final_report", "Final report", 28, true]], "the dropped first draft is kept, not included");
    const versions = await admin(async (db) => (await db.query(`SELECT kind, version FROM nzi_console.milestone_template_items WHERE template_id = $1 ORDER BY kind`, [express.templateId])).rows);
    assert.deepEqual(versions.map((row) => [row.kind, row.version]), [["data_collection", 2], ["final_report", 1], ["first_draft", 2]], "an unchanged item keeps its version");
    const audit = await admin(async (db) => (await db.query(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [edited.auditEventId])).rows[0]);
    assert.deepEqual([audit.before_json.items[1].included, audit.after_json.items[1].included], [true, false]);
    await assert.rejects(updateMilestoneTemplate(database.pool, { templateId: express.templateId, name: "Express CRP", items: schedule(1, 2, 3), expectedVersion: 1 }, context()), /version|changed/i);
    // And the kind comes back when it is scheduled again — the same row, included once more.
    await updateMilestoneTemplate(database.pool, { templateId: express.templateId, name: "Express CRP", items: schedule(5, 18, 28), expectedVersion: 2 }, context());
    assert.deepEqual((await card("Express CRP")).items.map((item) => item.included), [true, true, true]);
  });

  it("moves the default atomically, only with a reason, only to an active template", async () => {
    const standard = await card("Standard CRP");
    await assert.rejects(setDefaultMilestoneTemplate(database.pool, { templateId: standard.templateId, expectedVersion: standard.version }, context()), issue("reason"));
    const first = await setDefaultMilestoneTemplate(database.pool, { templateId: standard.templateId, expectedVersion: standard.version }, context(ORG_A, "admin", "The house schedule"));
    assert.equal(first.data.previousDefaultId, null, "the organisation had no default");
    const express = await card("Express CRP");
    const moved = await setDefaultMilestoneTemplate(database.pool, { templateId: express.templateId, expectedVersion: express.version }, context(ORG_A, "admin", "Faster turnaround is now standard"));
    assert.equal(moved.data.previousDefaultId, standard.templateId);
    const defaults = (await cards()).filter((item) => item.isDefault).map((item) => item.name);
    assert.deepEqual(defaults, ["Express CRP"], "exactly one default, and it is listed first");
    assert.equal((await cards())[0]!.name, "Express CRP");
    const audit = await admin(async (db) => (await db.query(`SELECT action, reason, before_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [moved.auditEventId])).rows[0]);
    assert.deepEqual([audit.action, audit.reason, audit.before_json.defaultTemplateId], ["milestone_template.default_set", "Faster turnaround is now standard", standard.templateId]);
    await assert.rejects(setDefaultMilestoneTemplate(database.pool, { templateId: express.templateId, expectedVersion: moved.data.version }, context(ORG_A, "admin", "Again")), issue("templateId", "ALREADY_DEFAULT"));
  });

  it("never deactivates the default (Q6), deactivates others only with a reason, reports what still names them — and reinstates", async () => {
    const express = await card("Express CRP");
    await assert.rejects(deactivateMilestoneTemplate(database.pool, { templateId: express.templateId, expectedVersion: express.version }, context(ORG_A, "admin", "No")), issue("templateId", "DEFAULT_PROTECTED"));
    const standard = await card("Standard CRP");
    await createJobType(database.pool, { name: "Carbon Report", family: "crp", milestoneTemplateId: standard.templateId }, context());
    await admin((db) => db.query(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, detail_json, milestone_template_id)
      VALUES ($1, 'j1', 'c1', 9001, 'crp', 'A job', 'open', 'Setup', '{}'::jsonb, $2)`, [ORG_A, standard.templateId]));
    await assert.rejects(deactivateMilestoneTemplate(database.pool, { templateId: standard.templateId, expectedVersion: standard.version }, context()), issue("reason"));
    const done = await deactivateMilestoneTemplate(database.pool, { templateId: standard.templateId, expectedVersion: standard.version }, context(ORG_A, "admin", "Replaced by Express"));
    assert.deepEqual([done.data.active, done.data.jobs, done.data.jobTypes], [false, 1, 1]);
    const inactive = await card("Standard CRP");
    assert.deepEqual([inactive.active, inactive.jobTypes.map((type) => type.name), inactive.jobs], [false, ["Carbon Report"], 1], "still shown on what names it");
    await assert.rejects(setDefaultMilestoneTemplate(database.pool, { templateId: standard.templateId, expectedVersion: inactive.version }, context(ORG_A, "admin", "Back")), issue("templateId", "INACTIVE"));
    await assert.rejects(createMilestoneTemplate(database.pool, { name: "STANDARD CRP", items: schedule(1, 2, 3) }, context()), issue("name", "DUPLICATE"), "an inactive template still holds its name");
    const back = await reinstateMilestoneTemplate(database.pool, { templateId: standard.templateId, expectedVersion: inactive.version }, context());
    assert.deepEqual([back.data.active, back.data.version], [true, inactive.version + 1]);
  });

  it("never reaches another organisation's template, and each organisation has its own default", async () => {
    const theirs = await createMilestoneTemplate(database.pool, { name: "Standard CRP", items: schedule(10, 20, 30) }, context(ORG_B));
    await setDefaultMilestoneTemplate(database.pool, { templateId: theirs.data.templateId, expectedVersion: 1 }, context(ORG_B, "admin", "Their default"));
    await assert.rejects(updateMilestoneTemplate(database.pool, { templateId: theirs.data.templateId, name: "Hijacked", items: schedule(1, 2, 3), expectedVersion: 2 }, context()), issue("templateId", "NOT_FOUND"));
    assert.deepEqual((await cards(ORG_B)).map((item) => [item.name, item.isDefault]), [["Standard CRP", true]]);
    assert.equal((await cards()).filter((item) => item.isDefault).length, 1, "A's default is untouched");
  });
});
