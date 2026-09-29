import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, defaultListQuery, jobTypeListSpec, type CommandContext, type JobTypeListQuery, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createJobType, deactivateJobType, listJobTypePickers, listJobTypesPage, reinstateJobType, updateJobType } from "../src/jobTypes";
import { withTenantRead, withTenantWrite } from "../src/postgres";

/**
 * Admin Phase C1 against a real database: migration 0139's schema for the whole phase (VAT rates, job types, milestone
 * templates and items, job file types, the two job links) with its constraints and grants, and the job_type.* commands
 * behind admin.lookups — never a delete, a reason to deactivate, versioned edits, idempotent replays, before-and-after
 * audit, the family lock (Q4), unique names including inactive types (Q2) — all inside one organisation.
 */
const ORG_A = "jt-org-a";
const ORG_B = "jt-org-b";
const NZI = "net-zero-international";

type Issue = { field: string; code: string };
const issue = (field: string, code?: string) => (error: { issues?: Issue[] }) =>
  error.issues?.some((item) => item.field === field && (code === undefined || item.code === code)) === true;

describe("jobs configuration (0139) and job types, against the database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (org = ORG_A, role: StaffRole = "admin", reason?: string, idempotencyKey?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: `${role}-${org}`, principal: "staff", idempotencyKey: idempotencyKey ?? `jt-${keys}`, correlationId: `corr-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, `${role}-${org}`) };
  };
  const listOf = (org: string, change: Partial<JobTypeListQuery> & { family?: string; status?: string } = {}) => {
    const { family, status, ...rest } = change;
    const query: JobTypeListQuery = { ...defaultListQuery(jobTypeListSpec), ...rest, filters: { ...(family ? { family: [family] } : {}), ...(status ? { status: [status] } : {}) } };
    return withTenantRead(database.pool, org, (db) => listJobTypesPage(db, query));
  };
  const admin = async <T>(work: (db: import("pg").Client) => Promise<T>) => { const db = await database.admin(); try { return await work(db); } finally { await db.end(); } };
  const asApp = <T>(org: string, sql: string, params: unknown[] = []) => withTenantWrite(database.pool, org, (db) => db.query(sql, params) as Promise<T>);

  before(async () => {
    database = (await createDisposableDatabase("jobtypes"))!;
    await admin(async (db) => {
      for (const org of [ORG_A, ORG_B]) {
        await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
        await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
        for (const role of ["admin", "consultant"]) {
          await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $2)`, [org, `${role}-${org}`, role]);
        }
        await db.query(`INSERT INTO nzi_console.vat_rates (organisation_id, vat_rate_id, name, rate_pct, is_default, created_by, updated_by) VALUES
          ($1, 'vat:std', '20% Standard Rate', 20, true, 's', 's'), ($1, 'vat:zero', 'No VAT', 0, false, 's', 's')`, [org]);
        await db.query(`INSERT INTO nzi_console.vat_rates (organisation_id, vat_rate_id, name, rate_pct, active, created_by, updated_by) VALUES ($1, 'vat:old', 'Old 17.5%', 17.5, false, 's', 's')`, [org]);
        await db.query(`INSERT INTO nzi_console.milestone_templates (organisation_id, template_id, name, is_default, created_by, updated_by) VALUES
          ($1, 'mt:std', 'Standard CRP', true, 's', 's'), ($1, 'mt:lca', 'LCA delivery', false, 's', 's')`, [org]);
        await db.query(`INSERT INTO nzi_console.milestone_templates (organisation_id, template_id, name, active, created_by, updated_by) VALUES ($1, 'mt:retired', 'Retired', false, 's', 's')`, [org]);
      }
      await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'c1', 'Alpha', 'active')`, [ORG_A]);
    });
  });
  after(async () => { await database?.end(); });

  describe("migration 0139", () => {
    it("forces row-level security on every new table and grants no DELETE on any", async () => {
      const { rows } = await admin((db) => db.query<{ relname: string; forced: boolean; can_delete: boolean }>(
        `SELECT c.relname, c.relforcerowsecurity AS forced, has_table_privilege('nzi_console_app', c.oid, 'DELETE') AS can_delete
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'nzi_console' AND c.relname = ANY($1) ORDER BY c.relname`,
        [["vat_rates", "job_types", "milestone_templates", "milestone_template_items", "job_file_types"]]));
      assert.deepEqual(rows.map((row) => [row.relname, row.forced, row.can_delete]), [
        ["job_file_types", true, false], ["job_types", true, false], ["milestone_template_items", true, false], ["milestone_templates", true, false], ["vat_rates", true, false]]);
    });

    it("keeps one default VAT rate and one default template per organisation, and a default is always active", async () => {
      await assert.rejects(admin((db) => db.query(`INSERT INTO nzi_console.vat_rates (organisation_id, vat_rate_id, name, rate_pct, is_default, created_by, updated_by) VALUES ($1, 'vat:x', 'X', 5, true, 's', 's')`, [ORG_A])), /vat_rates_one_default/);
      await assert.rejects(admin((db) => db.query(`INSERT INTO nzi_console.milestone_templates (organisation_id, template_id, name, is_default, created_by, updated_by) VALUES ($1, 'mt:x', 'X', true, 's', 's')`, [ORG_A])), /milestone_templates_one_default/);
      await assert.rejects(admin((db) => db.query(`UPDATE nzi_console.milestone_templates SET active = false WHERE organisation_id = $1 AND template_id = 'mt:std'`, [ORG_A])), /milestone_templates_default_is_active/);
      await assert.rejects(admin((db) => db.query(`INSERT INTO nzi_console.vat_rates (organisation_id, vat_rate_id, name, rate_pct, created_by, updated_by) VALUES ($1, 'vat:y', 'Y', 101, 's', 's')`, [ORG_A])), /check/i);
    });

    it("holds a template to one item per kind, within the three kinds, with a bounded offset — and items cannot be deleted", async () => {
      await asApp(ORG_A, `INSERT INTO nzi_console.milestone_template_items (organisation_id, template_id, kind, label, days_offset, created_by, updated_by) VALUES ($1, 'mt:std', 'data_collection', 'Data collection', 14, 't', 't')`, [ORG_A]);
      await assert.rejects(asApp(ORG_A, `INSERT INTO nzi_console.milestone_template_items (organisation_id, template_id, kind, label, days_offset, created_by, updated_by) VALUES ($1, 'mt:std', 'data_collection', 'Again', 20, 't', 't')`, [ORG_A]), /duplicate key/);
      await assert.rejects(asApp(ORG_A, `INSERT INTO nzi_console.milestone_template_items (organisation_id, template_id, kind, label, days_offset, created_by, updated_by) VALUES ($1, 'mt:std', 'kickoff', 'Kick-off', 1, 't', 't')`, [ORG_A]), /check/i);
      await assert.rejects(asApp(ORG_A, `INSERT INTO nzi_console.milestone_template_items (organisation_id, template_id, kind, label, days_offset, created_by, updated_by) VALUES ($1, 'mt:std', 'first_draft', 'Draft', -1, 't', 't')`, [ORG_A]), /check/i);
      await assert.rejects(asApp(ORG_A, `DELETE FROM nzi_console.milestone_template_items WHERE organisation_id = $1`, [ORG_A]), /permission denied/);
    });

    it("provisions v7's two system file types for the import's organisation, protected by construction", async () => {
      const provisioned = await admin(async (db) => (await db.query(`SELECT file_type_key, storage_folder_key, is_system, active FROM nzi_console.job_file_types WHERE organisation_id = $1 ORDER BY sort_order`, [NZI])).rows);
      assert.deepEqual(provisioned, [
        { file_type_key: "client_provided", storage_folder_key: "client-provided", is_system: true, active: true },
        { file_type_key: "generated_report", storage_folder_key: "generated-reports", is_system: true, active: true }]);
      // The key is immutable: the application role holds no UPDATE on it.
      await assert.rejects(asApp(NZI, `UPDATE nzi_console.job_file_types SET file_type_key = 'renamed' WHERE organisation_id = $1 AND file_type_key = 'client_provided'`, [NZI]), /permission denied/);
      // A system type cannot be switched off, and the role can never make a type a system type.
      await assert.rejects(asApp(NZI, `UPDATE nzi_console.job_file_types SET active = false WHERE organisation_id = $1 AND file_type_key = 'client_provided'`, [NZI]), /job_file_types_system_is_active/);
      await assert.rejects(asApp(NZI, `INSERT INTO nzi_console.job_file_types (organisation_id, file_type_id, file_type_key, display_name, storage_folder_key, is_system, created_by, updated_by)
        VALUES ($1, 'ft:x', 'fake_core', 'Fake', 'x', true, 't', 't')`, [NZI]), /permission denied/);
      // An ordinary type can be added, renamed and switched off — never its key, never deleted.
      await asApp(NZI, `INSERT INTO nzi_console.job_file_types (organisation_id, file_type_id, file_type_key, display_name, storage_folder_key, created_by, updated_by)
        VALUES ($1, 'ft:drawings', 'site_drawings', 'Site drawings', 'site-drawings', 't', 't')`, [NZI]);
      await asApp(NZI, `UPDATE nzi_console.job_file_types SET display_name = 'Drawings', active = false WHERE organisation_id = $1 AND file_type_id = 'ft:drawings'`, [NZI]);
      await assert.rejects(asApp(NZI, `DELETE FROM nzi_console.job_file_types WHERE organisation_id = $1 AND file_type_id = 'ft:drawings'`, [NZI]), /permission denied/);
      await assert.rejects(asApp(NZI, `INSERT INTO nzi_console.job_file_types (organisation_id, file_type_id, file_type_key, display_name, storage_folder_key, created_by, updated_by)
        VALUES ($1, 'ft:bad', 'Bad Key', 'Bad', 'x', 't', 't')`, [NZI]), /check/i);
    });

    it("links a job to a type and a template only within its own organisation", async () => {
      const made = await createJobType(database.pool, { name: "Carbon Report — Standard", family: "crp" }, context());
      await admin((db) => db.query(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, detail_json, job_type_id, milestone_template_id)
        VALUES ($1, 'j1', 'c1', 9001, 'crp', 'A job', 'open', 'Setup', '{}'::jsonb, $2, 'mt:std')`, [ORG_A, made.data.jobTypeId]));
      await assert.rejects(admin((db) => db.query(`UPDATE nzi_console.jobs SET job_type_id = 'nope' WHERE organisation_id = $1 AND job_id = 'j1'`, [ORG_A])), /jobs_job_type_fk/);
      await assert.rejects(admin((db) => db.query(`UPDATE nzi_console.jobs SET milestone_template_id = 'nope' WHERE organisation_id = $1 AND job_id = 'j1'`, [ORG_A])), /jobs_milestone_template_fk/);
      assert.deepEqual(await withTenantRead(database.pool, ORG_B, async (db) => (await db.query(`SELECT job_type_id FROM nzi_console.job_types`)).rows), []);
    });
  });

  describe("the commands", () => {
    it("adds a job type as 'added here', trimmed, with its VAT rate and template, and audits what it became", async () => {
      const outcome = await createJobType(database.pool, {
        name: "  Product   LCA ", code: " LCA-PROD ", family: "lca", description: "Cradle-to-gate", defaultPriceExVat: 9800, estimatedHours: 80,
        vatRateId: "vat:std", milestoneTemplateId: "mt:lca",
      }, context());
      assert.match(outcome.data.jobTypeId, /^job-type:[0-9a-f-]{36}$/);
      const row = (await listOf(ORG_A, { search: "Product" })).rows[0]!;
      assert.deepEqual([row.name, row.code, row.family, row.defaultPriceExVat, row.estimatedHours, row.vatRateName, row.vatRatePct, row.milestoneTemplateName, row.provenance, row.inUse],
        ["Product LCA", "LCA-PROD", "lca", 9800, 80, "20% Standard Rate", 20, "LCA delivery", "added", 0]);
      const audit = await admin(async (db) => (await db.query(`SELECT action, entity_type, after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [outcome.auditEventId])).rows[0]);
      assert.deepEqual([audit.action, audit.entity_type], ["job_type.created", "job_type"]);
      assert.deepEqual([audit.after_json.name, audit.after_json.code, audit.after_json.defaultPriceExVat, audit.after_json.milestoneTemplateId, audit.after_json.version],
        ["Product LCA", "LCA-PROD", 9800, "mt:lca", 1], "the audit records what the type became");
    });

    it("replays an idempotent retry instead of adding twice", async () => {
      const first = await createJobType(database.pool, { name: "Training — Half day", family: "training" }, context(ORG_A, "admin", undefined, "jt-same"));
      const again = await createJobType(database.pool, { name: "Training — Half day", family: "training" }, context(ORG_A, "admin", undefined, "jt-same"));
      assert.equal(again.replayed, true);
      assert.equal(again.data.jobTypeId, first.data.jobTypeId);
    });

    it("refuses a name or code another type holds (any case), an inactive or unknown VAT rate or template, and bad amounts", async () => {
      await assert.rejects(createJobType(database.pool, { name: "product lca", family: "lca" }, context()), issue("name", "DUPLICATE"));
      await assert.rejects(createJobType(database.pool, { name: "Other", code: "lca-prod", family: "lca" }, context()), issue("code", "DUPLICATE"));
      await assert.rejects(createJobType(database.pool, { name: "Other", family: "crp", vatRateId: "vat:old" }, context()), issue("vatRateId", "INACTIVE"));
      await assert.rejects(createJobType(database.pool, { name: "Other", family: "crp", milestoneTemplateId: "mt:retired" }, context()), issue("milestoneTemplateId", "INACTIVE"));
      await assert.rejects(createJobType(database.pool, { name: "Other", family: "crp", milestoneTemplateId: "mt:none" }, context()), issue("milestoneTemplateId", "NOT_FOUND"));
      await assert.rejects(createJobType(database.pool, { name: "Other", family: "crp", defaultPriceExVat: 10.005 }, context()), issue("defaultPriceExVat"));
      await assert.rejects(createJobType(database.pool, { name: "Other", family: "crp", estimatedHours: -1 }, context()), issue("estimatedHours"));
      await assert.rejects(createJobType(database.pool, { name: "Other", family: "retail" as never }, context()), issue("family"));
    });

    it("is admin.lookups — a consultant cannot change a job type", async () => {
      await assert.rejects(createJobType(database.pool, { name: "Consultancy day", family: "consultancy" }, context(ORG_A, "consultant")), /admin\.lookups|permission|capabilit/i);
    });

    it("edits as a versioned change with before and after — and refuses a stale edit", async () => {
      const lca = (await listOf(ORG_A, { search: "Product LCA" })).rows[0]!;
      const edited = await updateJobType(database.pool, { jobTypeId: lca.jobTypeId, name: "Product LCA", code: "LCA-PROD", family: "lca", defaultPriceExVat: 9950.5, estimatedHours: 82, vatRateId: "vat:std", milestoneTemplateId: null, expectedVersion: 1 }, context());
      assert.equal(edited.data.version, 2);
      const audit = await admin(async (db) => (await db.query(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [edited.auditEventId])).rows[0]);
      assert.deepEqual([audit.before_json.defaultPriceExVat, audit.before_json.milestoneTemplateId, audit.after_json.defaultPriceExVat, audit.after_json.milestoneTemplateId], [9800, "mt:lca", 9950.5, null]);
      await assert.rejects(updateJobType(database.pool, { jobTypeId: lca.jobTypeId, name: "Product LCA", family: "lca", expectedVersion: 1 }, context()), /version|changed/i);
    });

    it("locks the family while any job uses the type (Q4), but edits everything else", async () => {
      const used = (await listOf(ORG_A, { search: "Standard" })).rows[0]!;
      assert.equal(used.inUse, 1);
      await assert.rejects(updateJobType(database.pool, { jobTypeId: used.jobTypeId, name: used.name, family: "consultancy", expectedVersion: used.version }, context()), issue("family", "LOCKED"));
      const renamed = await updateJobType(database.pool, { jobTypeId: used.jobTypeId, name: "Carbon Report — Standard", family: "crp", defaultPriceExVat: 4500, expectedVersion: used.version }, context());
      assert.equal(renamed.data.version, used.version + 1);
    });

    it("keeps a VAT rate or template the type already holds after it is deactivated, until another is chosen", async () => {
      const made = await createJobType(database.pool, { name: "Net Zero Gold", family: "crp", vatRateId: "vat:zero" }, context());
      await admin((db) => db.query(`UPDATE nzi_console.vat_rates SET active = false WHERE organisation_id = $1 AND vat_rate_id = 'vat:zero'`, [ORG_A]));
      const kept = await updateJobType(database.pool, { jobTypeId: made.data.jobTypeId, name: "Net Zero Gold", family: "crp", vatRateId: "vat:zero", defaultPriceExVat: 2950, expectedVersion: 1 }, context());
      assert.equal(kept.data.version, 2, "an edit that keeps the inactive rate is allowed");
      const row = (await listOf(ORG_A, { search: "Gold" })).rows[0]!;
      assert.deepEqual([row.vatRateName, row.vatRatePct], ["No VAT", 0], "and it still resolves");
    });

    it("deactivates only with a reason, never deletes, reports the jobs still using it — and reinstates", async () => {
      const used = (await listOf(ORG_A, { search: "Standard" })).rows[0]!;
      await assert.rejects(deactivateJobType(database.pool, { jobTypeId: used.jobTypeId, expectedVersion: used.version }, context()), issue("reason"));
      const done = await deactivateJobType(database.pool, { jobTypeId: used.jobTypeId, expectedVersion: used.version }, context(ORG_A, "admin", "Replaced by the Plus tier"));
      assert.deepEqual([done.data.active, done.data.inUse], [false, 1]);
      const job = await admin(async (db) => (await db.query(`SELECT jt.name FROM nzi_console.jobs j JOIN nzi_console.job_types jt ON (jt.organisation_id, jt.job_type_id) = (j.organisation_id, j.job_type_id) WHERE j.job_id = 'j1'`)).rows[0]);
      assert.equal(job.name, "Carbon Report — Standard", "an inactive type still resolves on its jobs");
      await assert.rejects(createJobType(database.pool, { name: "CARBON REPORT — STANDARD", family: "crp" }, context()), issue("name", "DUPLICATE"), "an inactive type still holds its name (Q2)");
      const back = await reinstateJobType(database.pool, { jobTypeId: used.jobTypeId, expectedVersion: done.data.version }, context());
      assert.deepEqual([back.data.active, back.data.version], [true, done.data.version + 1]);
    });

    it("never reaches another organisation's job type", async () => {
      const theirs = await createJobType(database.pool, { name: "Their type", family: "crp" }, context(ORG_B));
      await assert.rejects(updateJobType(database.pool, { jobTypeId: theirs.data.jobTypeId, name: "Hijacked", family: "crp", expectedVersion: 1 }, context()), issue("jobTypeId", "NOT_FOUND"));
      await assert.rejects(createJobType(database.pool, { name: "Cross", family: "crp", vatRateId: "vat:std", milestoneTemplateId: "mt:std" }, context(ORG_B)).then(() => { throw new Error("no"); }, () => undefined).then(() => undefined));
      assert.deepEqual((await listOf(ORG_B)).rows.map((row) => row.name).sort(), ["Cross", "Their type"], "B sees only its own, with its own rates and templates");
    });
  });

  describe("the list the Job types screen reads", () => {
    it("filters by family and status, counts the facets from the data, and sorts by price", async () => {
      const page = await listOf(ORG_A);
      assert.deepEqual(page.filterOptions.status.map((option) => [option.value, option.count]), [["active", 4], ["inactive", 0]]);
      assert.ok((await listOf(ORG_A, { family: "lca" })).rows.every((row) => row.family === "lca"));
      assert.equal((await listOf(ORG_A, { sort: { key: "price", dir: "desc" } })).rows[0]!.name, "Product LCA");
    });

    it("offers the drawer every VAT rate and template, active first, flagging the defaults", async () => {
      const pickers = await withTenantRead(database.pool, ORG_A, listJobTypePickers);
      assert.deepEqual(pickers.vatRates.map((rate) => [rate.name, rate.active, rate.isDefault]), [["20% Standard Rate", true, true], ["Old 17.5%", false, false], ["No VAT", false, false]]);
      assert.deepEqual(pickers.milestoneTemplates.map((template) => [template.name, template.isDefault]), [["Standard CRP", true], ["LCA delivery", false], ["Retired", false]]);
    });
  });
});
