import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type CommandInputMap } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { autoSelectJobDatasets } from "../src/jobDatasetAutoSelect";
import { implausibleWindow, JW13_ACTOR, runJobDatasetBackfill } from "../src/jobDatasetBackfill";
import { createJob } from "../src/postgresCommands";

/**
 * JW-13 step 3 against a real database: job.datasets.autoSelect fills a job with no selection with exactly #413's rule
 * (the GB and GLOBAL editions valid on the window's last day) and job.create's reason; refuses a job holding any
 * selection (ALREADY_SELECTED, untouched), one with no window (NO_WINDOW) and one with no edition (NO_EDITION); audits
 * with the reason; replays on its idempotency key. And the backfill's core: imported CRP jobs only, fill-blank-only,
 * manual fixes (an implausible window refused before the command), a dry run rolled back, the post-condition re-run 0.
 */
type Issue = { field: string; code: string };
const refused = (code: string) => (error: { issues?: Issue[] }) => error.issues?.some((item) => item.code === code) === true;
const REASON = "JW-13 step 3: imported CRP jobs had no datasets; the ruled end-year rule (#413) fills them, fill-blank-only.";

describe("JW-13 step 3: automatic datasets for imported CRP jobs, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "jw13-org-a";
  const RUN = "jw13-org-b";
  let database: DisposableDatabase;
  let keys = 0;
  let legacy = 0;
  const context = (org = ORG, reason: string | undefined = REASON, idempotencyKey?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: JW13_ACTOR, principal: "system", idempotencyKey: idempotencyKey ?? `jw13-${keys}`, correlationId: `corr-jw13-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole("admin", org, JW13_ACTOR) };
  };
  const staff = (org: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: `admin-${org}`, principal: "staff", idempotencyKey: `jw13-staff-${keys}`, correlationId: `corr-jw13-staff-${keys}`, grant: commandGrantForRole("admin", org, `admin-${org}`) };
  };
  const admin = async <T>(work: (db: import("pg").Client) => Promise<T>) => { const db = await database.admin(); try { return await work(db); } finally { await db.end(); } };
  const q = (sql: string, params: unknown[] = []) => admin(async (db) => (await db.query(sql, params)).rows);
  const selections = async (jobId: string) => (await q(`SELECT dataset_id, selection_source, reason, selected_by FROM nzi_console.job_dataset_selections WHERE job_id = $1 ORDER BY dataset_id`, [jobId]));
  /** A CRP job as the v7 import leaves it: a v7 identity and a window, and no dataset selection. */
  const importedJob = async (org: string, period: { from: string; to: string } | null, change: Partial<CommandInputMap["job.create"]> = {}) => {
    const created = (await createJob(database.pool, { clientId: "c1", family: "crp", title: "CRP", workflowStage: "Setup", owner: "Ada", startDate: "2024-04-01", dueDate: "2027-06-30",
      reportingPeriodStart: period?.from ?? "2024-04-01", reportingPeriodEnd: period?.to ?? "2025-03-31", ...change }, staff(org))).data;
    legacy += 1;
    await q(`UPDATE nzi_console.jobs SET source_system = 'nzi-pro-v7', legacy_db_id = $2 WHERE job_id = $1`, [created.jobId, `jw13-${legacy}`]);
    await q(`DELETE FROM nzi_console.job_dataset_selections WHERE job_id = $1`, [created.jobId]);
    // No window: neither the job's reporting period nor its emissions config — as the 4 imported jobs v7 left without dates.
    if (!period) {
      await q(`DELETE FROM nzi_console.job_emissions_config WHERE job_id = $1`, [created.jobId]);
      await q(`UPDATE nzi_console.jobs SET reporting_period_start = NULL, reporting_period_end = NULL WHERE job_id = $1`, [created.jobId]);
    }
    return created;
  };

  before(async () => {
    database = (await createDisposableDatabase("jw13backfill"))!;
    await admin(async (db) => {
      for (const org of [ORG, RUN]) {
        await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
        await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
        await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, 'admin', 'active', $2)`, [org, `admin-${org}`]);
        await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'c1', 'Alpha', 'active')`, [org]);
        const dataset = (id: string, from: string, to: string, country = "GB", status = "active") => db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
          VALUES ($1, $2, $3, '1', $4, $5, $6, $7, 'test', 'test')`, [org, id, `Edition ${id}`, from, to, country, status]);
        await dataset("ds-2024", "2024-01-01", "2024-12-31"); await dataset("ds-2025", "2025-01-01", "2025-12-31"); await dataset("ds-g2025", "2025-01-01", "2025-12-31", "GLOBAL");
        await dataset("ds-fr2025", "2025-01-01", "2025-12-31", "FR"); await dataset("ds-old2025", "2025-01-01", "2025-12-31", "GB", "superseded");
      }
    });
  });
  after(async () => { await database?.end(); });

  describe("job.datasets.autoSelect", () => {
    it("gives an April–March imported job exactly the end-year GB and GLOBAL editions, with job.create's reason, and audits the reason", async () => {
      const job = await importedJob(ORG, { from: "2024-04-01", to: "2025-03-31" });
      assert.deepEqual(await selections(job.jobId), [], "imported with none");
      const done = await autoSelectJobDatasets(database.pool, { jobId: job.jobId }, context());
      const now = await selections(job.jobId);
      assert.deepEqual(now.map((row) => [row.dataset_id, row.selection_source, row.selected_by]), [["ds-2025", "automatic", JW13_ACTOR], ["ds-g2025", "automatic", JW13_ACTOR]],
        "the 2025 editions only — never the start year's, another country's or a superseded one");
      assert.equal(now[0].reason, "Matched the reporting year (the edition valid on the period's last day) and geography.", "job.create's own reason text");
      assert.deepEqual(done.data, { jobId: job.jobId, datasets: [{ datasetId: "ds-2025", name: "Edition ds-2025" }, { datasetId: "ds-g2025", name: "Edition ds-g2025" }], datasetCount: 2 });
      const audit = (await q(`SELECT action, actor_id, principal_type, entity_type, entity_id, reason, after_json, before_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [done.auditEventId]))[0];
      assert.deepEqual([audit.action, audit.actor_id, audit.principal_type, audit.entity_type, audit.entity_id, audit.reason],
        ["job_datasets_auto_selected", JW13_ACTOR, "system", "job", job.jobId, REASON]);
      assert.deepEqual(Object.keys(audit.after_json).sort(), ["datasetCount", "datasets", "jobId"], "job, datasets and a count — nothing else (NZC-120)");
      assert.deepEqual(audit.before_json, { datasetCount: 0 });
      const outbox = await q(`SELECT topic FROM nzi_console.transactional_outbox WHERE correlation_id = $1`, [done.correlationId]);
      assert.deepEqual(outbox.map((row) => row.topic), ["job.datasets.auto_selected"]);
    });

    it("refuses a job that already holds any selection (ALREADY_SELECTED) and leaves it exactly as it was", async () => {
      const job = await importedJob(ORG, { from: "2024-04-01", to: "2025-03-31" });
      await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, 'ds-2024', 'manual', 'Chosen by hand', 't')`, [ORG, job.jobId]);
      const before = await selections(job.jobId);
      await assert.rejects(autoSelectJobDatasets(database.pool, { jobId: job.jobId }, context()), refused("ALREADY_SELECTED"));
      assert.deepEqual(await selections(job.jobId), before, "untouched — the manual choice is not joined by automatic ones");
    });

    it("refuses a job with no window (NO_WINDOW) and one whose window has no edition on its last day (NO_EDITION)", async () => {
      const noWindow = await importedJob(ORG, null);
      await assert.rejects(autoSelectJobDatasets(database.pool, { jobId: noWindow.jobId }, context()), refused("NO_WINDOW"));
      const noEdition = await importedJob(ORG, { from: "2026-01-01", to: "2026-12-31" });
      await assert.rejects(autoSelectJobDatasets(database.pool, { jobId: noEdition.jobId }, context()), refused("NO_EDITION"));
      assert.deepEqual([...(await selections(noWindow.jobId)), ...(await selections(noEdition.jobId))], []);
    });

    it("reads the job's reporting period — the source job.create / job.update use — and refuses a config window that disagrees (WINDOW_MISMATCH)", async () => {
      const drifted = await importedJob(ORG, { from: "2024-04-01", to: "2025-03-31" });
      await q(`UPDATE nzi_console.job_emissions_config SET reporting_to = '2024-12-31' WHERE job_id = $1`, [drifted.jobId]);
      await assert.rejects(autoSelectJobDatasets(database.pool, { jobId: drifted.jobId }, context()), refused("WINDOW_MISMATCH"));
      const configless = await importedJob(ORG, { from: "2024-04-01", to: "2025-03-31" });
      await q(`DELETE FROM nzi_console.job_emissions_config WHERE job_id = $1`, [configless.jobId]);
      await assert.rejects(autoSelectJobDatasets(database.pool, { jobId: configless.jobId }, context()), refused("WINDOW_MISMATCH"));
      assert.deepEqual([...(await selections(drifted.jobId)), ...(await selections(configless.jobId))], []);
    });

    it("needs a reason; replays on its idempotency key; a second run with a new key is refused, changing nothing", async () => {
      const job = await importedJob(ORG, { from: "2025-01-01", to: "2025-12-31" });
      await assert.rejects(autoSelectJobDatasets(database.pool, { jobId: job.jobId }, context(ORG, "")), refused("REQUIRED"));
      const first = await autoSelectJobDatasets(database.pool, { jobId: job.jobId }, context(ORG, REASON, "jw13-same-key"));
      const replay = await autoSelectJobDatasets(database.pool, { jobId: job.jobId }, context(ORG, REASON, "jw13-same-key"));
      assert.equal(replay.replayed, true);
      assert.equal(replay.auditEventId, first.auditEventId);
      await assert.rejects(autoSelectJobDatasets(database.pool, { jobId: job.jobId }, context()), refused("ALREADY_SELECTED"));
      assert.equal((await selections(job.jobId)).length, 2);
      assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE entity_id = $1 AND action = 'job_datasets_auto_selected'`, [job.jobId]))[0].n, 1, "one audit event");
    });

    it("refuses another organisation's job and a job of another family", async () => {
      const other = await importedJob(RUN, { from: "2025-01-01", to: "2025-12-31" });
      await assert.rejects(autoSelectJobDatasets(database.pool, { jobId: other.jobId }, context(ORG)));
      assert.deepEqual(await selections(other.jobId), []);
      // Back to a console job, so the backfill test's population in that organisation is its own.
      await q(`UPDATE nzi_console.jobs SET source_system = NULL, legacy_db_id = NULL WHERE job_id = $1`, [other.jobId]);
      const course = (await createJob(database.pool, { clientId: "c1", family: "consultancy", title: "Advice", workflowStage: "Scope", owner: "Ada", startDate: "2025-02-01", dueDate: "2025-12-31" }, staff(ORG))).data;
      await assert.rejects(autoSelectJobDatasets(database.pool, { jobId: course.jobId }, context()), refused("WRONG_FAMILY"));
    });
  });

  describe("the backfill's core (runJobDatasetBackfill)", () => {
    it("fills imported CRP jobs with none, leaves selected and console jobs alone, lists manual fixes, and re-runs to 0 — dry run rolled back, commit written, then a no-op", async () => {
      const fill = await importedJob(RUN, { from: "2024-04-01", to: "2025-03-31" });
      const calendar = await importedJob(RUN, { from: "2024-01-01", to: "2024-12-31" });
      const held = await importedJob(RUN, { from: "2024-04-01", to: "2025-03-31" });
      await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, 'ds-2024', 'manual', 'Chosen by hand', 't')`, [RUN, held.jobId]);
      const noWindow = await importedJob(RUN, null);
      const noEdition = await importedJob(RUN, { from: "2026-01-01", to: "2026-12-31" });
      const typo = await importedJob(RUN, { from: "2024-01-01", to: "2024-12-31" });
      // v7's `2203-12-31` — and an edition that would match it, so only the plausibility gate stands between it and a fill.
      await q(`UPDATE nzi_console.job_emissions_config SET reporting_to = '2203-12-31' WHERE job_id = $1`, [typo.jobId]);
      await q(`UPDATE nzi_console.jobs SET reporting_period_end = '2203-12-31' WHERE job_id = $1`, [typo.jobId]);
      await q(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence) VALUES ($1, 'ds-forever', 'Forever', '1', '2200-01-01', '2299-12-31', 'GB', 'active', 'test', 'test')`, [RUN]);
      // A console job with no selection is not imported — not this backfill's.
      const consoleJob = (await createJob(database.pool, { clientId: "c1", family: "crp", title: "CRP", workflowStage: "Setup", owner: "Ada", startDate: "2026-01-01", dueDate: "2027-06-30",
        reportingPeriodStart: "2026-01-01", reportingPeriodEnd: "2026-12-31" }, staff(RUN))).data;

      const today = "2026-10-06";
      assert.equal(implausibleWindow({ from: "2027-01-01", to: "2027-12-31" }, today), false, "next year is plausible");
      assert.equal(implausibleWindow({ from: "2028-01-01", to: "2028-12-31" }, today), true);

      const dry = await runJobDatasetBackfill(database.pool, RUN, { commit: false, reason: REASON, today });
      const line = (jobId: string) => { const found = dry.lines.find((item) => item.jobId === jobId); assert.ok(found, `a line for ${jobId}`); return found; };
      assert.equal(dry.candidates, 5, "imported CRP jobs with no selection — the held job and the console job are not candidates");
      assert.equal(dry.alreadySelected, 1);
      assert.deepEqual([line(fill.jobId).result, line(fill.jobId).datasets], ["filled", ["Edition ds-2025", "Edition ds-g2025"]]);
      assert.deepEqual(line(fill.jobId).current, [], "the line shows what the job held before: none");
      assert.deepEqual(line(fill.jobId).window, { from: "2024-04-01", to: "2025-03-31" }, "the window used is the job's reporting period");
      assert.deepEqual(line(fill.jobId).editions.map((e) => [e.datasetId, e.source, e.name, e.version, e.country, e.validFrom, e.validTo]),
        [["ds-2025", "test", "Edition ds-2025", "1", "GB", "2025-01-01", "2025-12-31"], ["ds-g2025", "test", "Edition ds-g2025", "1", "GLOBAL", "2025-01-01", "2025-12-31"]], "the editions chosen, read back");
      assert.deepEqual([line(calendar.jobId).result, line(calendar.jobId).datasets], ["filled", ["Edition ds-2024"]]);
      assert.deepEqual([line(noWindow.jobId).manualKind, line(noEdition.jobId).manualKind, line(typo.jobId).manualKind], ["NO_WINDOW", "NO_EDITION", "IMPLAUSIBLE_WINDOW"]);
      assert.equal(dry.lines.some((item) => item.jobId === consoleJob.jobId), false);
      assert.deepEqual([dry.rerunCandidates, dry.rerunWouldFill], [3, 0], "the post-condition, inside the rolled-back run: only the manual fixes remain");
      assert.deepEqual([...(await selections(fill.jobId)), ...(await selections(calendar.jobId))], [], "a dry run writes nothing");
      assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE correlation_id = $1`, [dry.runId]))[0].n, 0);

      const done = await runJobDatasetBackfill(database.pool, RUN, { commit: true, reason: REASON, today });
      assert.deepEqual(done.lines.filter((line) => line.result === "error"), []);
      assert.deepEqual((await selections(fill.jobId)).map((row) => row.dataset_id), ["ds-2025", "ds-g2025"]);
      assert.deepEqual((await selections(calendar.jobId)).map((row) => row.dataset_id), ["ds-2024"]);
      assert.deepEqual((await selections(held.jobId)).map((row) => [row.dataset_id, row.selection_source]), [["ds-2024", "manual"]], "fill-blank-only: untouched");
      assert.deepEqual([...(await selections(typo.jobId)), ...(await selections(consoleJob.jobId))], [], "the implausible window and the console job are not filled");
      const audits = await q(`SELECT action, reason FROM nzi_console.audit_events WHERE correlation_id = $1`, [done.runId]);
      assert.deepEqual(audits.map((row) => [row.action, row.reason]), [["job_datasets_auto_selected", REASON], ["job_datasets_auto_selected", REASON]]);
      assert.deepEqual([done.rerunCandidates, done.rerunWouldFill], [3, 0]);

      const again = await runJobDatasetBackfill(database.pool, RUN, { commit: true, reason: REASON, today });
      assert.deepEqual([again.candidates, again.alreadySelected, again.lines.filter((line) => line.result === "filled").length, again.rerunWouldFill], [3, 3, 0, 0],
        "re-running fills nothing: the filled jobs are now left alone, the manual fixes listed again");
      assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE correlation_id = $1`, [again.runId]))[0].n, 0);
    });
  });
});
