import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticRows } from "./support/v7SyntheticExtract";
import { getAdminOverview } from "../src/adminOverview";
import { updateJobType } from "../src/jobTypes";
import { createMilestoneTemplate, setDefaultMilestoneTemplate, updateMilestoneTemplate } from "../src/milestoneTemplates";
import { withTenantRead } from "../src/postgres";
import type { V7Row, V7Table } from "../src/v7ClientExtract";
import { JOBS_CONFIG_RUN_PREFIX, loadV7JobsConfig, planV7JobsConfig, type JobsConfigOutcome } from "../src/v7JobsConfigLoad";

/**
 * The v7 jobs-configuration import (admin Phase C4): identity, then the natural key (file type key, VAT rate, normalised
 * name), else insert; one default or the entity is refused (Q6); the first three template items → DC/FD/FR, the rest
 * reported (Q5); R4 re-runs; seeded-only reported; one transaction with a savepoint per entity. Planning is pure; the
 * load runs as the application role.
 */
const ORG = "net-zero-international"; // 0139 provisions the two system file types here
const OTHER = "jc-org-b";
type Rows = ReturnType<typeof syntheticRows>;
const extract = (mutate?: (rows: Rows) => void): Partial<Record<V7Table, V7Row[]>> => { const rows = syntheticRows(); mutate?.(rows); return syntheticExtract(rows); };
const entity = (outcome: JobsConfigOutcome, name: string) => outcome.entities.find((item) => item.entity === name)!;

describe("planning the jobs-configuration import (no database)", () => {
  const plan = planV7JobsConfig(extract());

  it("reads VAT rates with their one default, rates to two places", () => {
    assert.deepEqual(plan.vatRates.values.map((rate) => [rate.name, rate.ratePct, rate.isDefault]), [["20% Standard Rate", 20, true], ["No VAT", 0, false], ["5%", 5, false]]);
    assert.equal(plan.vatRates.refused, null);
  });

  it("maps a template's first three items, in v7's sort order, to data collection, first draft and final report — and reports the rest", () => {
    const standard = plan.templates.values.find((template) => template.name === "Standard CRP")!;
    assert.deepEqual(standard.items.map((item) => [item.kind, item.label, item.daysOffset]),
      [["data_collection", "Data collection", 14], ["first_draft", "First draft", 35], ["final_report", "Final report", 56]], "by sort_order, not row order");
    assert.deepEqual(standard.extras, { items: ["Client sign-off"], jobsTicked: 2 });
    const express = plan.templates.values.find((template) => template.name === "Express")!;
    assert.deepEqual(express.items.map((item) => item.kind), ["data_collection", "first_draft"], "a two-item template has no final report, as in v7");
    assert.equal(plan.templates.values.find((template) => template.name === "Quarterly (retired)")!.active, false);
  });

  it("resolves a job type's family as the client import does — job_family, job_group, then v7's name rule; never is_crp", () => {
    assert.deepEqual(plan.jobTypes.values.map((type) => [type.name, type.family, type.familyFrom]), [
      ["Carbon Reduction Plan", "crp", "job_family"], ["Consultancy - Strategy Workshop", "consultancy", "name rule"],
      ["Life Cycle Assessment", "lca", "name rule"], ["Training Course", "training", "name rule"], ["Footprint Service", "pcf", "job_group"]]);
    const crp = plan.jobTypes.values[0]!;
    assert.deepEqual([crp.defaultPriceExVat, crp.estimatedHours, crp.vatLegacyId, crp.legacyValues.isCrp], [975, 12.5, "1", true]);
  });

  it("refuses an entity with more than one default, or an inactive default — never guessed (Q6) — and says when there is none", () => {
    const two = planV7JobsConfig(extract((rows) => { rows.vat_rates_lookup[1]!.is_default = "t"; }));
    assert.match(two.vatRates.refused!, /2 default VAT rates \(20% Standard Rate, No VAT\)/);
    const inactive = planV7JobsConfig(extract((rows) => { rows.milestone_templates[0]!.is_active = "f"; }));
    assert.match(inactive.templates.refused!, /default milestone template "Standard CRP" is inactive/);
    const none = planV7JobsConfig(extract((rows) => { rows.milestone_templates[0]!.is_default = "f"; }));
    assert.deepEqual([none.templates.refused, none.templates.noDefault], [null, true]);
  });

  it("leaves out — and names — what it cannot place", () => {
    const bad = planV7JobsConfig(extract((rows) => {
      rows.milestone_template_items.push({ item_id: "41", template_id: "4", milestone_name: "Orphan", days_offset: "1", sort_order: "1" });
      rows.milestone_templates.push({ template_id: "5", template_name: "Empty", is_active: "t", is_default: "f" });
      rows.milestone_template_items[0]!.days_offset = "-3";
      rows.job_file_types_lookup.push({ file_type_id: "4", file_type_key: "Bad Key", display_name: "Bad", storage_folder_key: "x", sort_order: "1", is_active: "t" });
      rows.job_types.push({ job_type_id: "6", name: "carbon reduction plan", job_family: "crp", is_crp: "f" });
      rows.vat_rates_lookup.push({ vat_rate_id: "4", name: "Silly", rate_pct: "120", is_default: "f", is_active: "t" });
    }));
    assert.deepEqual(bad.skipped.map((skip) => [skip.table, skip.legacyDbId]).sort(), [
      ["job_file_types_lookup", "4"], ["job_types", "6"], ["milestone_template_items", "41"], ["milestone_templates", "1"], ["milestone_templates", "5"], ["vat_rates_lookup", "4"]]);
    assert.match(bad.skipped.find((skip) => skip.legacyDbId === "1")!.reason, /offset .* the template is left out/);
  });
});

describe("the jobs-configuration import, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  const admin = async <T>(work: (db: import("pg").Client) => Promise<T>) => { const db = await database.admin(); try { return await work(db); } finally { await db.end(); } };
  const q = (sql: string, params: unknown[] = [ORG]) => admin(async (db) => (await db.query(sql, params)).rows);
  let keys = 0;
  const context = (org = ORG, reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: `admin-${org}`, principal: "staff", idempotencyKey: `jc-${keys}`, correlationId: `corr-jc-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole("admin", org, `admin-${org}`) };
  };

  before(async () => {
    database = (await createDisposableDatabase("jobsconfig"))!;
    await admin(async (db) => {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [OTHER]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [OTHER]);
      for (const org of [ORG, OTHER]) await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, 'admin', 'active', 'Ada')`, [org, `admin-${org}`]);
      // What the console already holds in ORG: a VAT rate and a template matched by key, a job type by name, one of its own.
      // A lone rate is the default: since 0145 an organisation holding any rate holds exactly one default, at commit.
      await db.query(`INSERT INTO nzi_console.vat_rates (organisation_id, vat_rate_id, name, rate_pct, is_default, created_by, updated_by) VALUES ($1, 'vat:zero', 'No VAT', 0, true, 'seed', 'seed')`, [ORG]);
      await db.query(`INSERT INTO nzi_console.milestone_templates (organisation_id, template_id, name, created_by, updated_by) VALUES ($1, 'mt:express', 'express', 'seed', 'seed')`, [ORG]);
      for (const [kind, off] of [["data_collection", 5], ["first_draft", 10], ["final_report", 20]] as const) {
        await db.query(`INSERT INTO nzi_console.milestone_template_items (organisation_id, template_id, kind, label, days_offset, created_by, updated_by) VALUES ($1, 'mt:express', $2, $2, $3, 'seed', 'seed')`, [ORG, kind, off]);
      }
      await db.query(`INSERT INTO nzi_console.job_types (organisation_id, job_type_id, name, family, code, milestone_template_id, created_by, updated_by) VALUES
        ($1, 'jt:crp', 'Carbon Reduction Plan', 'crp', 'CRP', 'mt:express', 'seed', 'seed'), ($1, 'jt:own', 'Console only', 'consultancy', NULL, NULL, 'seed', 'seed')`, [ORG]);
    });
  });
  after(async () => { await database?.end(); });

  it("a dry run exercises every write and keeps none", async () => {
    const outcome = await loadV7JobsConfig(database.pool, ORG, planV7JobsConfig(extract()), { commit: false });
    assert.deepEqual(outcome.entities.map((item) => [item.entity, item.inserted + item.stamped, item.failed]),
      [["vat_rates", 3, null], ["milestone_templates", 3, null], ["job_types", 5, null], ["job_file_types", 3, null]]);
    for (const table of ["vat_rates", "milestone_templates", "job_types", "job_file_types"]) {
      assert.deepEqual(await q(`SELECT 1 FROM nzi_console.${table} WHERE organisation_id = $1 AND source_system IS NOT NULL`), [], `${table} kept a row`);
    }
  });

  it("commits: stamps by key and inserts the rest, carries one default, maps items by kind, links VAT, and reports what v7 lacks", async () => {
    const outcome = await loadV7JobsConfig(database.pool, ORG, planV7JobsConfig(extract()), { commit: true, runId: `${JOBS_CONFIG_RUN_PREFIX}first` });
    assert.deepEqual(outcome.entities.map((item) => [item.entity, item.inserted, item.stamped]),
      [["vat_rates", 2, 1], ["milestone_templates", 2, 1], ["job_types", 4, 1], ["job_file_types", 1, 2]]);
    for (const item of outcome.entities) assert.deepEqual([item.parity.consoleActive, item.parity.consoleInactive, item.valueDifferences], [item.parity.v7Active, item.parity.v7Inactive, []], item.entity);

    assert.deepEqual(await q(`SELECT vat_rate_id, name, rate_pct::float AS pct, is_default FROM nzi_console.vat_rates WHERE organisation_id = $1 ORDER BY rate_pct DESC`),
      [{ vat_rate_id: "vat:v7-1", name: "20% Standard Rate", pct: 20, is_default: true }, { vat_rate_id: "vat:v7-3", name: "5%", pct: 5, is_default: false },
        { vat_rate_id: "vat:zero", name: "No VAT", pct: 0, is_default: false }], "No VAT stamped by rate and name — its id kept");

    const items = await q(`SELECT t.name, i.kind, i.label, i.days_offset, i.included FROM nzi_console.milestone_template_items i
      JOIN nzi_console.milestone_templates t USING (organisation_id, template_id) WHERE i.organisation_id = $1 ORDER BY t.name, i.kind`);
    assert.deepEqual(items.filter((row) => row.name === "Express").map((row) => [row.kind, row.label, row.days_offset, row.included]),
      [["data_collection", "Data in", 7, true], ["final_report", "final_report", 20, false], ["first_draft", "Report", 28, true]], "stamped by name: v7's two items; the third kept, not included");
    assert.equal(items.filter((row) => row.name === "Standard CRP").length, 3, "the fourth v7 item is not carried");
    assert.deepEqual(await q(`SELECT name FROM nzi_console.milestone_templates WHERE organisation_id = $1 AND is_default`), [{ name: "Standard CRP" }]);
    assert.match(entity(outcome, "milestone_templates").notes.join(" | "), /"Standard CRP": 1 item\(s\) beyond the third not carried \(Client sign-off\) — undated in v7; 2 job\(s\) ticked them/);

    const crp = (await q(`SELECT job_type_id, family, default_price_ex_vat::float AS price, estimated_hours::float AS hours, vat_rate_id, code, milestone_template_id, legacy_values
      FROM nzi_console.job_types WHERE organisation_id = $1 AND name = 'Carbon Reduction Plan'`))[0];
    assert.deepEqual([crp.job_type_id, crp.family, crp.price, crp.hours, crp.vat_rate_id, crp.code, crp.milestone_template_id, crp.legacy_values.isCrp],
      ["jt:crp", "crp", 975, 12.5, "vat:v7-1", "CRP", "mt:express", true], "stamped: v7's values, its id, code and template link kept; is_crp only in provenance (Q3)");
    assert.deepEqual(entity(outcome, "job_types").seededOnly, ["Console only"], "reported, not archived");
    assert.equal((await q(`SELECT active FROM nzi_console.job_types WHERE organisation_id = $1 AND job_type_id = 'jt:own'`))[0].active, true);

    assert.deepEqual(await q(`SELECT file_type_id, file_type_key, is_system, legacy_db_id FROM nzi_console.job_file_types WHERE organisation_id = $1 ORDER BY sort_order`), [
      { file_type_id: "file-type:client_provided", file_type_key: "client_provided", is_system: true, legacy_db_id: "1" },
      { file_type_id: "file-type:generated_report", file_type_key: "generated_report", is_system: true, legacy_db_id: "2" },
      { file_type_id: "file-type:v7-3", file_type_key: "site_photos", is_system: false, legacy_db_id: "3" }], "the system types stamped by key, never duplicated");
  });

  it("records one audit event per entity, and the admin overview's feed shows them", async () => {
    const events = await q(`SELECT entity_id FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'jobs_config.imported' AND correlation_id = $2 ORDER BY entity_id`,
      [ORG, `${JOBS_CONFIG_RUN_PREFIX}first`]);
    assert.deepEqual(events.map((row) => row.entity_id), ["job_file_types", "job_types", "milestone_templates", "vat_rates"]);
    const overview = await withTenantRead(database.pool, ORG, (db) => getAdminOverview(db, { includeChanges: true, changeLimit: 10 }));
    assert.ok(overview.recentChanges!.filter((change) => change.action === "jobs_config.imported").length === 4);
  });

  it("is idempotent: the same extract again changes nothing", async () => {
    const outcome = await loadV7JobsConfig(database.pool, ORG, planV7JobsConfig(extract()), { commit: true, runId: `${JOBS_CONFIG_RUN_PREFIX}again` });
    for (const item of outcome.entities) assert.deepEqual([item.inserted, item.stamped, item.updated, item.conflicts.length, item.unchanged > 0], [0, 0, 0, 0, true], item.entity);
    assert.deepEqual(await q(`SELECT 1 FROM nzi_console.audit_events WHERE organisation_id = $1 AND correlation_id = $2`, [ORG, `${JOBS_CONFIG_RUN_PREFIX}again`]), []);
  });

  it("R4: v7 wins where the row is still as the import wrote it; a console edit stands, and changed on both sides is refused", async () => {
    const priced = (price: string) => extract((rows) => { rows.job_types[0]!.unit_price_ex_vat = price; });
    const won = await loadV7JobsConfig(database.pool, ORG, planV7JobsConfig(priced("1050")), { commit: true, runId: `${JOBS_CONFIG_RUN_PREFIX}second` });
    assert.equal(entity(won, "job_types").updated, 1);
    const crp = (await q(`SELECT default_price_ex_vat::float AS price, version, name, family, code, vat_rate_id FROM nzi_console.job_types WHERE organisation_id = $1 AND job_type_id = 'jt:crp'`))[0];
    assert.equal(crp.price, 1050);
    await updateJobType(database.pool, { jobTypeId: "jt:crp", name: crp.name, family: crp.family, code: crp.code, defaultPriceExVat: 999, vatRateId: crp.vat_rate_id, milestoneTemplateId: "mt:express", expectedVersion: crp.version }, context());
    const refused = await loadV7JobsConfig(database.pool, ORG, planV7JobsConfig(priced("1100")), { commit: true });
    assert.deepEqual(entity(refused, "job_types").conflicts, ["Carbon Reduction Plan: changed in v7 since the last load, and edited here since"]);
    assert.equal((await q(`SELECT default_price_ex_vat::float AS price FROM nzi_console.job_types WHERE organisation_id = $1 AND job_type_id = 'jt:crp'`))[0].price, 999, "not overwritten");

    // A template edited here (its items with it, C2) is never overwritten either.
    const standard = (await q(`SELECT template_id, version FROM nzi_console.milestone_templates WHERE organisation_id = $1 AND name = 'Standard CRP'`))[0];
    await updateMilestoneTemplate(database.pool, { templateId: standard.template_id, name: "Standard CRP", expectedVersion: standard.version, items: [
      { kind: "data_collection", label: "Data collection", daysOffset: 21, included: true }, { kind: "first_draft", label: "First draft", daysOffset: 35, included: true },
      { kind: "final_report", label: "Final report", daysOffset: 56, included: true }] }, context());
    const moved = await loadV7JobsConfig(database.pool, ORG, planV7JobsConfig(extract((rows) => { rows.milestone_template_items[2]!.days_offset = "40"; })), { commit: true });
    assert.deepEqual(entity(moved, "milestone_templates").conflicts, ["Standard CRP: changed in v7 since the last load, and edited here since"]);
    assert.equal((await q(`SELECT days_offset FROM nzi_console.milestone_template_items WHERE organisation_id = $1 AND template_id = $2 AND kind = 'data_collection'`, [ORG, standard.template_id]))[0].days_offset, 21);
  });

  it("refuses an entity with two defaults whole, and the rest still load", async () => {
    const outcome = await loadV7JobsConfig(database.pool, OTHER, planV7JobsConfig(extract((rows) => { rows.vat_rates_lookup[1]!.is_default = "t"; })), { commit: true });
    assert.match(entity(outcome, "vat_rates").refused!, /2 default VAT rates/);
    assert.deepEqual(await q(`SELECT 1 FROM nzi_console.vat_rates WHERE organisation_id = $1`, [OTHER]), [], "nothing of VAT written");
    assert.equal(entity(outcome, "job_types").inserted, 5);
    assert.match(entity(outcome, "job_types").notes.join(" | "), /v7's VAT rate 1 is not loaded here, so no VAT rate is linked/);
  });

  it("never displaces a default the console chose itself — and a template the console moved the default off counts as edited here", async () => {
    const org = "jc-org-d";
    await admin(async (db) => {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
      await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, 'admin', 'active', 'Ada')`, [org, `admin-${org}`]);
    });
    const own = await createMilestoneTemplate(database.pool, { name: "Our schedule", items: [{ kind: "final_report", label: "Report", daysOffset: 30, included: true }] }, context(org));
    await setDefaultMilestoneTemplate(database.pool, { templateId: own.data.templateId, expectedVersion: 1 }, context(org, "Our own house schedule"));
    const loaded = await loadV7JobsConfig(database.pool, org, planV7JobsConfig(extract()), { commit: true });
    assert.match(entity(loaded, "milestone_templates").notes.join(" | "), /the console's own default template "Our schedule" stands; v7's default "Standard CRP" is loaded as not the default/);
    assert.deepEqual(await q(`SELECT name FROM nzi_console.milestone_templates WHERE organisation_id = $1 AND is_default`, [org]), [{ name: "Our schedule" }]);

    // In OTHER, v7's default was loaded; moving the default off it here is a console edit of that template (R4).
    const ours = await createMilestoneTemplate(database.pool, { name: "Our schedule", items: [{ kind: "final_report", label: "Report", daysOffset: 30, included: true }] }, context(OTHER));
    await setDefaultMilestoneTemplate(database.pool, { templateId: ours.data.templateId, expectedVersion: 1 }, context(OTHER, "Our own house schedule"));
    const again = await loadV7JobsConfig(database.pool, OTHER, planV7JobsConfig(extract((rows) => { rows.milestone_templates[0]!.description = "changed in v7"; })), { commit: true });
    assert.deepEqual(entity(again, "milestone_templates").conflicts, ["Standard CRP: changed in v7 since the last load, and edited here since"]);
    assert.deepEqual(await q(`SELECT name FROM nzi_console.milestone_templates WHERE organisation_id = $1 AND is_default`, [OTHER]), [{ name: "Our schedule" }]);
  });

  it("rolls back only the entity that fails — a savepoint per entity — and the others commit", async () => {
    const org = "jc-org-c";
    await admin(async (db) => {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
      // A type of its own already called "Site photos", under another key: v7's site_photos cannot take the name.
      await db.query(`INSERT INTO nzi_console.job_file_types (organisation_id, file_type_id, file_type_key, display_name, storage_folder_key, created_by, updated_by)
        VALUES ($1, 'ft:own', 'site_pictures', 'Site photos', 'pictures', 's', 's')`, [org]);
    });
    const outcome = await loadV7JobsConfig(database.pool, org, planV7JobsConfig(extract()), { commit: true });
    assert.match(entity(outcome, "job_file_types").failed!, /job_file_types_name_key|duplicate key/);
    assert.deepEqual(await q(`SELECT file_type_key FROM nzi_console.job_file_types WHERE organisation_id = $1 ORDER BY 1`, [org]), [{ file_type_key: "site_pictures" }],
      "nothing of the file types written (this organisation had no system types provisioned)");
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.job_types WHERE organisation_id = $1`, [org]))[0].n, 5, "job types committed");
  });

  it("never touches another organisation, and refuses a run id a re-run would not recognise", async () => {
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.job_types WHERE organisation_id = $1 AND source_system IS NOT NULL`, [OTHER]))[0].n, 5);
    assert.deepEqual((await q(`SELECT job_type_id FROM nzi_console.job_types WHERE organisation_id = $1 AND job_type_id LIKE 'jt:%'`, [OTHER])), [], "ORG's own types stay ORG's");
    await assert.rejects(loadV7JobsConfig(database.pool, ORG, planV7JobsConfig(extract()), { commit: false, runId: "whatever" }), /must start v7-jobs-config-/);
  });
});
