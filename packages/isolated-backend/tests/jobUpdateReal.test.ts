import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, reportingYearForPeriod, type CommandContext, type CommandInputMap, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticHeaders, syntheticRows } from "./support/v7SyntheticExtract";
import { JOB_TABLE_CLASSIFICATION, jobLinkedTables, periodBoundData, planJobUpdate, updateJob } from "../src/jobUpdate";
import { completeMilestone, rescheduleMilestones, setMilestone } from "../src/milestoneCommands";
import { createJob } from "../src/postgresCommands";
import { withTenantRead } from "../src/postgres";
import { planV7ClientImport } from "../src/v7ClientImport";
import { loadV7ClientPlan } from "../src/v7ClientLoad";
import { loadV7Milestones, planV7Milestones } from "../src/v7MilestoneLoad";
import { listJobDateDifferences, resolveJobDate, V7_DATE_SYNC_ACTOR } from "../src/v7JobDates";

/**
 * job.update (ruled job-update-plan.md, J1–J6) against a real database: start date, reporting period and template; the
 * period refused once period-bound data exists — the classification fail-closed at run time and complete by test; the
 * window and automatic datasets moved and re-derived, manual ones kept with recomputed warnings, both sets audited;
 * imported jobs keep their dates (template allowed); closed jobs refused; a reason for a period change; the year
 * re-derived by job.create's helper; milestones re-anchored by PR 3's applyReschedule under one job-version bump.
 */
type Issue = { field: string; code: string };
const issue = (field: string, code?: string) => (error: { issues?: Issue[] }) =>
  error.issues?.some((item) => item.field === field && (code === undefined || item.code === code)) === true;

describe("job.update, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "ju-org-a";
  const OTHER = "ju-org-b";
  let database: DisposableDatabase;
  let keys = 0;
  const context = (org = ORG, role: StaffRole = "admin", reason?: string, idempotencyKey?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: `${role}-${org}`, principal: "staff", idempotencyKey: idempotencyKey ?? `ju-${keys}`, correlationId: `corr-ju-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, `${role}-${org}`) };
  };
  const admin = async <T>(work: (db: import("pg").Client) => Promise<T>) => { const db = await database.admin(); try { return await work(db); } finally { await db.end(); } };
  const q = (sql: string, params: unknown[] = []) => admin(async (db) => (await db.query(sql, params)).rows);
  const jobRow = async (jobId: string) => (await q(`SELECT start_date::text AS start, reporting_period_start::text AS ps, reporting_period_end::text AS pe, reporting_year, milestone_template_id, version FROM nzi_console.jobs WHERE job_id = $1`, [jobId]))[0];
  const rows = (jobId: string) => q(`SELECT kind, due_date::text AS due, due_source, version, completed_at FROM nzi_console.job_milestones WHERE job_id = $1 ORDER BY kind`, [jobId]);
  const crpJob = async (change: Partial<CommandInputMap["job.create"]> = {}, org = ORG) => (await createJob(database.pool, {
    clientId: "c1", family: "crp", title: "CRP", workflowStage: "Setup", owner: "Ada", startDate: "2025-02-01", dueDate: "2026-06-30",
    reportingPeriodStart: "2025-01-01", reportingPeriodEnd: "2025-12-31", ...change }, context(org))).data;

  before(async () => {
    database = (await createDisposableDatabase("jobupdate"))!;
    await admin(async (db) => {
      for (const org of [ORG, OTHER]) {
        await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
        await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
        for (const role of ["admin", "consultant", "finance"]) {
          await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $2)`, [org, `${role}-${org}`, role]);
        }
        await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'c1', 'Alpha', 'active')`, [org]);
        const dataset = (id: string, from: string, to: string, country = "GB") => db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
          VALUES ($1, $2, $2, '1', $3, $4, $5, 'active', 'test', 'test')`, [org, id, from, to, country]);
        await dataset("ds-2025", "2025-01-01", "2025-12-31"); await dataset("ds-2026", "2026-01-01", "2026-12-31"); await dataset("ds-manual", "2025-01-01", "2025-12-31", "FR");
        await db.query(`INSERT INTO nzi_console.milestone_templates (organisation_id, template_id, name, is_default, created_by, updated_by) VALUES ($1, 'mt:std', 'Standard', true, 's', 's'), ($1, 'mt:short', 'Short', false, 's', 's')`, [org]);
        for (const [t, kind, off] of [["mt:std", "data_collection", 10], ["mt:std", "first_draft", 20], ["mt:std", "final_report", 30], ["mt:short", "data_collection", 5]] as const) {
          await db.query(`INSERT INTO nzi_console.milestone_template_items (organisation_id, template_id, kind, label, days_offset, created_by, updated_by) VALUES ($1, $2, $3, $3, $4, 's', 's')`, [org, t, kind, off]);
        }
      }
    });
  });
  after(async () => { await database?.end(); });

  describe("J1: the period-bound classification", () => {
    it("classifies every table with a foreign key to jobs — explicitly, and with nothing stale", async () => {
      const linked = (await withTenantRead(database.pool, ORG, jobLinkedTables)).map((entry) => entry.table);
      const unclassified = linked.filter((table) => !(table in JOB_TABLE_CLASSIFICATION));
      assert.deepEqual(unclassified, [], "a new table linked to jobs must be classified in JOB_TABLE_CLASSIFICATION before it ships");
      assert.deepEqual(Object.keys(JOB_TABLE_CLASSIFICATION).filter((table) => !linked.includes(table)), [], "every classified table still links to jobs");
    });

    it("is fail-closed at run time: an unclassified table with a row for the job blocks the move", async () => {
      const job = await crpJob();
      await admin(async (db) => {
        await db.query(`CREATE TABLE nzi_console.ju_unclassified (organisation_id text NOT NULL, job_id text NOT NULL, FOREIGN KEY (organisation_id, job_id) REFERENCES nzi_console.jobs (organisation_id, job_id))`);
        await db.query(`GRANT SELECT ON nzi_console.ju_unclassified TO nzi_console_app`);
        await db.query(`INSERT INTO nzi_console.ju_unclassified VALUES ($1, $2)`, [ORG, job.jobId]);
      });
      try {
        const findings = await withTenantRead(database.pool, ORG, (db) => periodBoundData(db, ORG, job.jobId));
        assert.deepEqual(findings.map((finding) => [finding.table, finding.rows, finding.classified]), [["ju_unclassified", 1, false]]);
        await assert.rejects(updateJob(database.pool, { jobId: job.jobId, expectedVersion: 1, reportingPeriodStart: "2026-01-01", reportingPeriodEnd: "2026-12-31" }, context(ORG, "admin", "Wrong year")), issue("reportingPeriodStart", "PERIOD_HAS_DATA"));
        // An unclassified table the role cannot read is also blocking — never skipped.
        await admin((db) => db.query(`REVOKE SELECT ON nzi_console.ju_unclassified FROM nzi_console_app`));
        const unreadable = await withTenantRead(database.pool, ORG, (db) => periodBoundData(db, ORG, job.jobId));
        assert.deepEqual(unreadable.map((finding) => [finding.table, finding.rows]), [["ju_unclassified", null]]);
      } finally {
        await admin((db) => db.query(`DROP TABLE nzi_console.ju_unclassified`));
      }
    });

    // Addendum B.3 (ruled 25 Nov 2026, 0238): a period with data may move — with a reason, its datasets re-chosen and its rows
    // re-priced (baselineYearPendingReal covers the re-pricing). J1's PERIOD_HAS_DATA stays for data nobody has classified.
    it("moves a period over classified, period-bound data with a reason — and says why it needs one", async () => {
      const job = await crpJob();
      await q(`INSERT INTO nzi_console.job_intensity_values (organisation_id, job_id, reporting_year, metric_key, value, recorded_by) VALUES ($1, $2, 2025, 'floor_area', 100, 't')`, [ORG, job.jobId]);
      await assert.rejects(updateJob(database.pool, { jobId: job.jobId, expectedVersion: 1, reportingPeriodStart: "2026-01-01", reportingPeriodEnd: "2026-12-31" }, context()),
        (error: { issues?: Array<Issue & { message: string }> }) => error.issues?.some((item) => item.code === "REQUIRED" && /data is recorded for it/.test(item.message)) === true);
      const moved = await updateJob(database.pool, { jobId: job.jobId, expectedVersion: 1, reportingPeriodStart: "2026-01-01", reportingPeriodEnd: "2026-12-31" }, context(ORG, "admin", "Wrong year"));
      assert.deepEqual([moved.data.version, moved.data.schedule.reportingYear], [2, 2026]);
    });
  });

  describe("the start date and the milestones (J6)", () => {
    it("moves only uncompleted template rows, under exactly one job-version bump; each moved row versions once; one audit event", async () => {
      const job = await crpJob();
      const initial = Object.fromEntries((await rows(job.jobId)).map((row) => [row.kind, row]));
      await setMilestone(database.pool, { jobId: job.jobId, kind: "first_draft", dueDate: "2025-04-01", expectedVersion: initial.first_draft.version }, context());
      await completeMilestone(database.pool, { jobId: job.jobId, kind: "final_report", completedAt: "2025-03-01", expectedVersion: initial.final_report.version }, context());
      const beforeJob = await jobRow(job.jobId);
      const updated = await updateJob(database.pool, { jobId: job.jobId, expectedVersion: beforeJob.version, startDate: "2025-03-01" }, context());
      const afterJob = await jobRow(job.jobId);
      assert.equal(afterJob.version, beforeJob.version + 1, "exactly one bump");
      assert.equal(afterJob.reporting_year, 2025, "the year does not move with the start");
      const now = Object.fromEntries((await rows(job.jobId)).map((row) => [row.kind, row]));
      assert.deepEqual([now.data_collection.due, now.data_collection.version], ["2025-03-11", 2], "the template row moved, once");
      assert.deepEqual([now.first_draft.due, now.first_draft.due_source], ["2025-04-01", "manual"], "set by hand — stays");
      assert.deepEqual([now.final_report.due, !!now.final_report.completed_at], ["2025-03-03", true], "completed — stays");
      assert.deepEqual(updated.data.reschedule!.map((step) => [step.kind, step.action]), [["data_collection", "move"], ["first_draft", "keep"], ["final_report", "keep"]]);
      const audits = await q(`SELECT action, before_json, after_json FROM nzi_console.audit_events WHERE correlation_id = $1`, [updated.correlationId]);
      assert.deepEqual(audits.map((audit) => audit.action), ["job.updated"], "one audit event");
      assert.deepEqual([audits[0].before_json.schedule.startDate, audits[0].after_json.schedule.startDate], ["2025-02-01", "2025-03-01"]);
    });

    it("changes the template as a reschedule would, and job.milestone.reschedule still behaves as before", async () => {
      const job = await crpJob();
      const v = (await jobRow(job.jobId)).version;
      const changed = await updateJob(database.pool, { jobId: job.jobId, expectedVersion: v, milestoneTemplateId: "mt:short" }, context());
      assert.deepEqual(changed.data.reschedule!.map((step) => [step.kind, step.action]), [["data_collection", "move"], ["first_draft", "clear"], ["final_report", "clear"]]);
      assert.equal((await jobRow(job.jobId)).milestone_template_id, "mt:short");
      const again = await rescheduleMilestones(database.pool, { jobId: job.jobId, milestoneTemplateId: "mt:std", expectedVersion: v + 1 }, context());
      assert.deepEqual(again.data.preview.map((step) => step.action), ["move", "move", "move"], "the cleared kinds are dated again");
      assert.equal((await jobRow(job.jobId)).version, v + 2);
    });
  });

  describe("a period that straddles two calendar years (R1, ruled 24 Nov: one edition per calendar year the period touches)", () => {
    const automatic = async (jobId: string) => (await q(`SELECT dataset_id FROM nzi_console.job_dataset_selections WHERE job_id = $1 AND selection_source = 'automatic' AND dataset_id LIKE 'ds-%' ORDER BY dataset_id`, [jobId])).map((row) => row.dataset_id);

    it("job.create selects one edition per calendar year the period touches — before, an April–March job got none, then only the end year's", async () => {
      const job = await crpJob({ reportingPeriodStart: "2025-04-01", reportingPeriodEnd: "2026-03-31", startDate: "2025-04-01" });
      assert.deepEqual(await automatic(job.jobId), ["ds-2025", "ds-2026"], "2025's edition for Apr–Dec, 2026's for Jan–Mar — both years, never none");
      const calendar = await crpJob();
      assert.deepEqual(await automatic(calendar.jobId), ["ds-2025"], "a calendar-year job is unchanged");
    });

    it("job.update re-derives the same way when the window moves to straddle a year end", async () => {
      const job = await crpJob();
      await updateJob(database.pool, { jobId: job.jobId, expectedVersion: 1, reportingPeriodStart: "2025-07-01", reportingPeriodEnd: "2026-06-30" }, context(ORG, "admin", "July–June financial year"));
      assert.deepEqual(await automatic(job.jobId), ["ds-2025", "ds-2026"]);
    });

    it("two years resolving to one edition make one selection, not two — the later year unpublished falls back to the earlier's (job.create and job.update)", async () => {
      // 2027 has no edition: its months fall back to ds-2026, the one 2026 itself takes. One row covers both years, and no error.
      const created = await crpJob({ reportingPeriodStart: "2026-04-01", reportingPeriodEnd: "2027-03-31", startDate: "2026-04-01", dueDate: "2027-06-30" });
      assert.deepEqual(await automatic(created.jobId), ["ds-2026"]);
      const reason = (await q(`SELECT reason FROM nzi_console.job_dataset_selections WHERE job_id = $1 AND dataset_id = 'ds-2026'`, [created.jobId]))[0].reason;
      assert.match(reason, /not published yet; the latest available \(2026\)/, "the shared edition records the fallback it is for the end year");
      const moved = await crpJob();
      await updateJob(database.pool, { jobId: moved.jobId, expectedVersion: 1, reportingPeriodStart: "2026-04-01", reportingPeriodEnd: "2027-03-31" }, context(ORG, "admin", "April–March, into an unpublished year"));
      assert.deepEqual(await automatic(moved.jobId), ["ds-2026"]);
    });

    it("an edition the rule chose for its year is not listed as a coverage gap; a manual one that does not cover the window still is", async () => {
      const { listJobDatasetOptions } = await import("../src/readModels");
      const job = await crpJob({ reportingPeriodStart: "2025-04-01", reportingPeriodEnd: "2026-03-31", startDate: "2025-04-01" });
      // The manual pick is one the rule does not make (the automatic set is ds-2025 and ds-2026 now): a 2025-only edition, chosen by hand.
      await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, warnings_json, selected_by) VALUES ($1, $2, 'ds-manual', 'manual', 'Client asked', '[]', 't')`, [ORG, job.jobId]);
      const options = await withTenantRead(database.pool, ORG, (db) => listJobDatasetOptions(db, job.jobId));
      const warn = (id: string) => options.find((option) => option.datasetId === id)?.warnings ?? null;
      for (const id of ["ds-2025", "ds-2026"]) assert.deepEqual(warn(id)?.filter((w) => w.includes("reporting period")), [], `${id}, chosen automatically for its year, is the rule, not a gap`);
      assert.ok(warn("ds-manual")?.some((w) => w.includes("Does not cover the complete reporting period")), "a manual edition that does not cover the window still warns");
    });
  });

  describe("the reporting period (J1, J2, J5; NZC-092)", () => {
    it("needs a reason; re-derives the year by job.create's helper; moves the window; re-derives automatic datasets; keeps manual ones with recomputed warnings — auditing both sets", async () => {
      const job = await crpJob();
      await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, warnings_json, selected_by) VALUES ($1, $2, 'ds-manual', 'manual', 'Client asked', '[]', 't')`, [ORG, job.jobId]);
      const input = { jobId: job.jobId, expectedVersion: 1, reportingPeriodStart: "2026-01-01", reportingPeriodEnd: "2026-12-31" };
      await assert.rejects(updateJob(database.pool, input, context()), issue("reason", "REQUIRED"));
      const done = await updateJob(database.pool, input, context(ORG, "admin", "The engagement covers 2026, not 2025"));
      const jobNow = await jobRow(job.jobId);
      assert.deepEqual([jobNow.ps, jobNow.pe, jobNow.reporting_year, jobNow.version], ["2026-01-01", "2026-12-31", reportingYearForPeriod("2026-12-31"), 2]);
      const window = (await q(`SELECT reporting_from::text AS f, reporting_to::text AS t, version FROM nzi_console.job_emissions_config WHERE job_id = $1`, [job.jobId]))[0];
      assert.deepEqual([window.f, window.t, window.version], ["2026-01-01", "2026-12-31", 2]);
      const selections = await q(`SELECT dataset_id, selection_source, warnings_json FROM nzi_console.job_dataset_selections WHERE job_id = $1 AND dataset_id LIKE 'ds-%' ORDER BY dataset_id`, [job.jobId]);
      assert.deepEqual(selections.map((row) => [row.dataset_id, row.selection_source]), [["ds-2026", "automatic"], ["ds-manual", "manual"]], "2025's automatic dataset deleted, 2026's derived; the manual one kept");
      assert.deepEqual(selections.find((row) => row.dataset_id === "ds-manual").warnings_json, ["Dataset does not cover the complete reporting period.", "Dataset geography FR differs from job geography GB."]);
      const audit = (await q(`SELECT before_json, after_json, reason FROM nzi_console.audit_events WHERE audit_event_id = $1`, [done.auditEventId]))[0];
      assert.deepEqual(audit.before_json.automaticDatasets.map((d: { datasetId: string }) => d.datasetId).filter((id: string) => id.startsWith("ds-")), ["ds-2025"], "the deleted automatic set");
      assert.deepEqual(audit.after_json.datasets.automaticAdded.map((d: { datasetId: string }) => d.datasetId).filter((id: string) => id.startsWith("ds-")), ["ds-2026"], "the re-derived set");
      assert.deepEqual([audit.before_json.window, audit.after_json.datasets.window.after], [{ from: "2025-01-01", to: "2025-12-31" }, { from: "2026-01-01", to: "2026-12-31" }]);
      assert.equal(audit.reason, "The engagement covers 2026, not 2025");
      assert.deepEqual(audit.before_json.manualWarnings, [{ datasetId: "ds-manual", warnings: ["Dataset geography FR differs from job geography GB."] }]);
      // The anchor moved (the later of start and period start), so the template rows re-anchored.
      assert.equal((await rows(job.jobId)).find((row) => row.kind === "data_collection").due, "2026-01-11");
    });

    it("refuses a period on a family with none; allows that family's start date", async () => {
      const course = (await createJob(database.pool, { clientId: "c1", family: "consultancy", title: "Advice", workflowStage: "Scope", owner: "Ada", startDate: "2025-02-01", dueDate: "2025-12-31" }, context())).data;
      await assert.rejects(updateJob(database.pool, { jobId: course.jobId, expectedVersion: 1, reportingPeriodStart: "2025-01-01", reportingPeriodEnd: "2025-12-31" }, context(ORG, "admin", "x")), issue("reportingPeriodStart", "NO_PERIOD_FOR_FAMILY"));
      assert.equal((await updateJob(database.pool, { jobId: course.jobId, expectedVersion: 1, startDate: "2025-03-01" }, context())).data.version, 2);
    });
  });

  describe("guards and governance", () => {
    it("refuses a closed job (JOB_CLOSED), no change (NO_CHANGE), bad dates, a stale version, and an inactive template", async () => {
      const job = await crpJob();
      await assert.rejects(updateJob(database.pool, { jobId: job.jobId, expectedVersion: 1, startDate: "2025-02-01" }, context()), issue("jobId", "NO_CHANGE"));
      await assert.rejects(updateJob(database.pool, { jobId: job.jobId, expectedVersion: 1, startDate: "2026-07-01" }, context()), (error: { issues?: Issue[] }) => (error.issues?.length ?? 0) > 0, "start after the job's end");
      await assert.rejects(updateJob(database.pool, { jobId: job.jobId, expectedVersion: 7, startDate: "2025-03-01" }, context()), /version|changed/i);
      await q(`UPDATE nzi_console.milestone_templates SET active = false WHERE organisation_id = $1 AND template_id = 'mt:short'`, [ORG]);
      await assert.rejects(updateJob(database.pool, { jobId: job.jobId, expectedVersion: 1, milestoneTemplateId: "mt:short" }, context()), issue("milestoneTemplateId", "INACTIVE"));
      await q(`UPDATE nzi_console.milestone_templates SET active = true WHERE organisation_id = $1 AND template_id = 'mt:short'`, [ORG]);
      await q(`UPDATE nzi_console.jobs SET status = 'complete' WHERE job_id = $1`, [job.jobId]);
      await assert.rejects(updateJob(database.pool, { jobId: job.jobId, expectedVersion: 1, startDate: "2025-03-01" }, context()), issue("jobId", "JOB_CLOSED"));
    });

    it("is job.manage (finance refused), never reaches another organisation, and replays an idempotent retry", async () => {
      const job = await crpJob();
      await assert.rejects(updateJob(database.pool, { jobId: job.jobId, expectedVersion: 1, startDate: "2025-03-01" }, context(ORG, "finance")), /job\.manage|permission|capabilit|scope/i);
      const theirs = await crpJob({}, OTHER);
      await assert.rejects(updateJob(database.pool, { jobId: theirs.jobId, expectedVersion: 1, startDate: "2025-03-01" }, context()), /not in your organisation/i);
      const first = await updateJob(database.pool, { jobId: job.jobId, expectedVersion: 1, startDate: "2025-03-01" }, context(ORG, "admin", undefined, "ju-same"));
      const again = await updateJob(database.pool, { jobId: job.jobId, expectedVersion: 1, startDate: "2025-03-01" }, context(ORG, "admin", undefined, "ju-same"));
      assert.deepEqual([again.replayed, again.auditEventId, (await jobRow(job.jobId)).version], [true, first.auditEventId, 2]);
    });

    it("previews exactly what the command applies", async () => {
      const job = await crpJob();
      const preview = await withTenantRead(database.pool, ORG, (db) => planJobUpdate(db, ORG, { jobId: job.jobId, startDate: "2025-03-01" }, { lock: false }));
      const applied = await updateJob(database.pool, { jobId: job.jobId, expectedVersion: 1, startDate: "2025-03-01" }, context());
      assert.deepEqual(preview!.plan.reschedule, applied.data.reschedule);
      assert.deepEqual(preview!.plan.issues, []);
    });
  });
});

describe("job.update on imported jobs (J3), and the v7 loaders after it", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "net-zero-international";
  let database: DisposableDatabase;
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const clientPlan = () => planV7ClientImport({ extract: syntheticExtract(), headers: syntheticHeaders(), extractSha256: "s" });
  const grant = commandGrantForRole("admin", ORG, "ada");
  let n = 0;
  const context = (reason?: string): CommandContext => ({ organisationId: ORG, actorId: "ada", principal: "staff", idempotencyKey: `jui-${++n}`, correlationId: `jui-${n}`, grant, ...(reason ? { reason } : {}) });

  before(async () => {
    database = (await createDisposableDatabase("jobupdateimported"))!;
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada')`, [ORG]);
    await loadV7ClientPlan(database.pool, clientPlan(), { commit: true, runId: "clients-1" });
    await loadV7Milestones(database.pool, ORG, planV7Milestones(syntheticExtract().job_plan), { commit: true });
    await q(`INSERT INTO nzi_console.milestone_templates (organisation_id, template_id, name, created_by, updated_by) VALUES ($1, 'mt:ju', 'Console template', 's', 's')`, [ORG]);
    await q(`INSERT INTO nzi_console.milestone_template_items (organisation_id, template_id, kind, label, days_offset, created_by, updated_by) VALUES ($1, 'mt:ju', 'final_report', 'Final', 90, 's', 's')`, [ORG]);
  });
  after(async () => { await database?.end(); });

  // Job 106 (J000616): a v7 CRP job with a period and no v7 plan — the template dates it from the period start.
  const job106 = async () => (await q(`SELECT version, start_date::text AS start, reporting_period_start::text AS ps, reporting_period_end::text AS pe FROM nzi_console.jobs WHERE job_id = 'v7-job-106'`))[0];
  const owners = async (jobId: string) => (await q(`SELECT date_key, owner, cause FROM nzi_console.job_date_owners WHERE job_id = $1 ORDER BY owner_no`, [jobId])).map((row) => [row.date_key, row.owner, row.cause]);
  const differences = (jobId: string) => withTenantRead(database.pool, ORG, (db) => listJobDateDifferences(db, ORG, jobId));

  // Addendum B (ruled 25 Nov 2026, 0238) retires J3: an imported job's dates are editable here, and the console then owns them.
  it("lets an imported job's template change, then its start date and period — the console owning each date it edits", async () => {
    const version = (await job106()).version;
    const updated = await updateJob(database.pool, { jobId: "v7-job-106", expectedVersion: version, milestoneTemplateId: "mt:ju" }, context());
    assert.deepEqual(updated.data.reschedule!.map((step) => [step.kind, step.action, step.to]), [["data_collection", "unchanged", null], ["first_draft", "unchanged", null], ["final_report", "generate", "2024-03-31"]]);
    assert.equal(updated.data.version, version + 1);
    assert.deepEqual(updated.data.ownedDates, [], "a template change owns no date");

    const started = await updateJob(database.pool, { jobId: "v7-job-106", expectedVersion: updated.data.version, startDate: "2024-02-01" }, context());
    assert.deepEqual(started.data.ownedDates, ["start_date"]);
    // Its period holds migrated rows: a move needs the reason (B.3).
    await assert.rejects(updateJob(database.pool, { jobId: "v7-job-106", expectedVersion: started.data.version, reportingPeriodStart: "2024-02-01", reportingPeriodEnd: "2025-01-31" }, context()), issue("reason", "REQUIRED"));
    const moved = await updateJob(database.pool, { jobId: "v7-job-106", expectedVersion: started.data.version, reportingPeriodStart: "2024-02-01", reportingPeriodEnd: "2025-01-31" }, context("The client's year runs February to January"));
    assert.deepEqual(moved.data.ownedDates, ["reporting_period"]);
    assert.deepEqual(await owners("v7-job-106"), [["start_date", "console", "edited"], ["reporting_period", "console", "edited"]]);
  });

  it("the client loader's re-run reads every client as unchanged after it, and keeps the console's dates — flagging V7's", async () => {
    const outcome = await loadV7ClientPlan(database.pool, clientPlan(), { commit: true, runId: "clients-2" });
    assert.deepEqual(outcome.clients.filter((client) => client.state !== "unchanged").map((client) => [client.clientId, client.state, client.refusal]), []);
    const held = await job106();
    assert.deepEqual([held.start, held.ps, held.pe], ["2024-02-01", "2024-02-01", "2025-01-31"], "a later sync never overwrites a date the console owns");
    const flagged = await differences("v7-job-106");
    assert.deepEqual(flagged.filter((d) => d.dateKey === "reporting_period").map((d) => [d.owner, d.console, d.v7]),
      [["console", { from: "2024-02-01", to: "2025-01-31" }, { from: "2024-01-01", to: "2024-12-31" }]]);
  });

  it("a sync follows V7 for a date the console never edited, through job.update, audited as the sync", async () => {
    const changed = syntheticRows();
    changed.jobs.find((row) => row.job_id === "106")!.reporting_period_start = "2024-01-01";
    changed.jobs.find((row) => row.job_id === "100")!.start_date = "2024-01-08";
    const before = (await q(`SELECT start_date::text AS start, status FROM nzi_console.jobs WHERE job_id = 'v7-job-100'`))[0];
    await loadV7ClientPlan(database.pool, planV7ClientImport({ extract: syntheticExtract(changed), headers: syntheticHeaders(), extractSha256: "s2" }), { commit: true, runId: "clients-3" });
    const after = (await q(`SELECT start_date::text AS start FROM nzi_console.jobs WHERE job_id = 'v7-job-100'`))[0];
    // J000612 is complete, so job.update refuses it: the sync leaves it and shows the difference instead (owner V7).
    if (before.status === "complete") {
      assert.equal(after.start, before.start);
      assert.ok((await differences("v7-job-100")).some((d) => d.dateKey === "start_date" && d.owner === "v7"));
    } else {
      assert.equal(after.start, "2024-01-08");
      assert.ok((await q(`SELECT 1 FROM nzi_console.audit_events WHERE entity_id = 'v7-job-100' AND action = 'job.updated' AND actor_id = $1`, [V7_DATE_SYNC_ACTOR])).length === 1);
    }
  });

  it("'Keep the console's' acknowledges V7's period; 'Use the previous system's dates' applies it (with the reason) and V7 owns it again", async () => {
    const [period] = (await differences("v7-job-106")).filter((d) => d.dateKey === "reporting_period");
    const kept = await resolveJobDate(database.pool, { jobId: "v7-job-106", expectedVersion: (await job106()).version, dateKey: "reporting_period", observationNo: period!.observationNo, choice: "console" }, context());
    assert.equal(kept.data.choice, "console");
    assert.deepEqual((await differences("v7-job-106")).filter((d) => d.dateKey === "reporting_period"), [], "acknowledged — no longer flagged");
    await assert.rejects(resolveJobDate(database.pool, { jobId: "v7-job-106", expectedVersion: (await job106()).version, dateKey: "reporting_period", observationNo: period!.observationNo, choice: "v7" }, context()), issue("reason", "REQUIRED"));
    await resolveJobDate(database.pool, { jobId: "v7-job-106", expectedVersion: (await job106()).version, dateKey: "reporting_period", observationNo: period!.observationNo, choice: "v7" }, context("Back to the previous system's year"));
    const back = await job106();
    assert.deepEqual([back.ps, back.pe], ["2024-01-01", "2024-12-31"]);
    assert.deepEqual((await owners("v7-job-106")).at(-1), ["reporting_period", "v7", "use-v7"]);
    // V7 owns the period again, so the next sync follows V7's change — through job.update, audited as the sync.
    const changed = syntheticRows();
    Object.assign(changed.jobs.find((row) => row.job_id === "106")!, { reporting_period_start: "2024-03-01", reporting_period_end: "2025-02-28" });
    const synced = await loadV7ClientPlan(database.pool, planV7ClientImport({ extract: syntheticExtract(changed), headers: syntheticHeaders(), extractSha256: "s4" }), { commit: true, runId: "clients-4" });
    assert.deepEqual(synced.clients.filter((client) => client.state === "refused").map((client) => client.refusal), [], "a V7 date change no longer refuses the client");
    const followed = await job106();
    assert.deepEqual([followed.ps, followed.pe], ["2024-03-01", "2025-02-28"], "an unedited (V7-owned) date follows V7 on every sync");
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE entity_id = 'v7-job-106' AND action = 'job.updated' AND actor_id = $1`, [V7_DATE_SYNC_ACTOR]))[0].n, 1);
    // …and a stale observation is never accepted unseen.
    await assert.rejects(resolveJobDate(database.pool, { jobId: "v7-job-106", expectedVersion: (await job106()).version, dateKey: "reporting_period", observationNo: period!.observationNo + 999, choice: "console" }, context()), issue("observationNo", "OBSERVATION_MOVED"));
  });

  it("the PR 2 backfill refuses a kind job.update generated here, when v7 also records it", async () => {
    const changed = syntheticRows();
    changed.job_plan.push({ ...changed.job_plan.find((row) => row.job_id === "103")!, job_id: "106", final_report_due: "2025-06-30" });
    const outcome = await loadV7Milestones(database.pool, ORG, planV7Milestones(syntheticExtract(changed).job_plan), { commit: true });
    assert.ok(outcome.conflicts.some((conflict) => conflict.jobNumber === "J000616" && conflict.kind === "final_report" && /made in the console/.test(conflict.reason)), JSON.stringify(outcome.conflicts));
  });
});
