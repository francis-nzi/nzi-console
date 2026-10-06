import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { automaticDatasetsFor, fallbackReason, jobDatasetUpdates, ON_DAY_REASON } from "../src/datasetSelection";
import { autoSelectJobDatasets } from "../src/jobDatasetAutoSelect";
import { updateJob } from "../src/jobUpdate";
import { createJob } from "../src/postgresCommands";
import { listDatasetRegistry, listJobDatasetOptions, listJobFactorOptions } from "../src/readModels";
import { withTenantRead } from "../src/postgres";

/**
 * DATASET-CURRENCY §1 (ruled 6 Oct) against a real database, through job.create — the live path: per series, the edition
 * valid on the window's last day, else the latest already published; a GB series never borrows a GLOBAL edition; a draft
 * edition is not published; DESNZ, the preferred UK source, ordered first and pre-picked on a tie; and a fallback
 * edition is the rule, so the dataset list does not warn that it fails to cover the window.
 */
describe("automatic datasets: the reporting year's edition, else the latest available — per series", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "fallback-org";
  let database: DisposableDatabase;
  let keys = 0;
  const staff = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: "admin-fb", principal: "staff", idempotencyKey: `fb-${keys}`, correlationId: `corr-fb-${keys}`, grant: commandGrantForRole("admin", ORG, "admin-fb") };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const crpJob = async (from: string, to: string) => (await createJob(database.pool, { clientId: "c1", family: "crp", title: "CRP", workflowStage: "Setup", owner: "Ada",
    startDate: from, dueDate: "2028-06-30", reportingPeriodStart: from, reportingPeriodEnd: to }, staff())).data.jobId;
  const picks = async (jobId: string) => (await q(`SELECT dataset_id, reason FROM nzi_console.job_dataset_selections WHERE job_id = $1 AND selection_source = 'automatic' ORDER BY dataset_id`, [jobId]))
    .map((row) => [row.dataset_id, row.reason]);

  before(async () => {
    database = (await createDisposableDatabase("datasetfallback"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'admin-fb', 'admin', 'active', 'Ada')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'c1', 'Alpha', 'active')`, [ORG]);
    // Only this test's datasets are in play.
    await q(`UPDATE nzi_console.emission_factor_datasets SET status = 'superseded' WHERE organisation_id = $1`, [ORG]);
    const dataset = (id: string, year: number, country = "GB", status = "active", source = "test") => q(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
       VALUES ($1, $2, 'upload.csv', $2, $3, $4, $5, $6, $7, 'test')`, [ORG, id, `${year}-01-01`, `${year}-12-31`, country, status, source]);
    await dataset("uk-ghg-gb-2024", 2024, "GB", "active", "DESNZ"); await dataset("uk-ghg-gb-2025", 2025, "GB", "active", "DESNZ");
    await dataset("uk-ghg-gb-2026", 2026, "GB", "draft", "DESNZ");           // loaded but not published: never picked
    await dataset("nzi-gb-2025", 2025); await dataset("ceda-gb-2025", 2025); await dataset("ice-gb-2026", 2026);
    await dataset("mix-2025", 2025, "GB"); await dataset("mix-2026", 2026, "GLOBAL");   // one series key, two countries
    for (const [datasetId, factorId] of [["mix-2025", "mix-gas"], ["ceda-gb-2025", "ceda-gas"], ["uk-ghg-gb-2025", "uk-ghg-gas"], ["nzi-gb-2025", "nzi-gas"]]) {
      await q(`INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES ($1, $2, $3, 'Natural gas', 'kWh', 0.18, ARRAY['1'])`, [ORG, datasetId, factorId]);
    }
  });
  after(async () => { await database?.end(); });

  it("a reporting year with its editions published takes each series' own; later editions and drafts are not picked", async () => {
    const jobId = await crpJob("2025-01-01", "2025-12-31");
    assert.deepEqual(await picks(jobId), [
      ["ceda-gb-2025", ON_DAY_REASON], ["mix-2025", ON_DAY_REASON], ["nzi-gb-2025", ON_DAY_REASON], ["uk-ghg-gb-2025", ON_DAY_REASON],
    ], "never the 2024 edition beside its 2025, never ICE 2026 or the GLOBAL 2026 before their time");
  });

  it("a reporting year not yet published takes each series' latest — GB from GB, never a GLOBAL substitute — and says so", async () => {
    const jobId = await crpJob("2027-01-01", "2027-12-31");
    assert.deepEqual(await picks(jobId), [
      ["ceda-gb-2025", fallbackReason(2025)], ["ice-gb-2026", fallbackReason(2026)],
      ["mix-2025", fallbackReason(2025)],     // the GB series falls back to its own 2025 …
      ["mix-2026", fallbackReason(2026)],     // … beside, not replaced by, the GLOBAL series' 2026
      ["nzi-gb-2025", fallbackReason(2025)], ["uk-ghg-gb-2025", fallbackReason(2025)],   // the draft 2026 DESNZ is not published
    ]);
  });

  it("orders the preferred source first: DESNZ for the UK", async () => {
    const chosen = await withTenantRead(database.pool, ORG, (db) => automaticDatasetsFor(db, ORG, { from: "2025-01-01", to: "2025-12-31" }, "GB"));
    assert.equal(chosen[0]!.datasetId, "uk-ghg-gb-2025");
    assert.deepEqual(chosen.map((d) => [d.datasetId, d.fallback]), [["uk-ghg-gb-2025", false], ["nzi-gb-2025", false], ["ceda-gb-2025", false], ["mix-2025", false]]);
  });

  it("the factor picker marks DESNZ preferred and lists it first where two selected datasets offer the same factor", async () => {
    const jobId = await crpJob("2025-04-01", "2026-03-31");   // April–March: the 2026 window's DESNZ is a draft, so 2025's
    const options = (await withTenantRead(database.pool, ORG, (db) => listJobFactorOptions(db, jobId))).filter((o) => o.label === "Natural gas");
    assert.deepEqual(options.map((o) => o.datasetLabel), ["DESNZ GB 2025", "NZI GB 2025", "CEDA GB 2025", "test GB 2025"],
      "each factor names its dataset as source · country · year — never the imported 'upload.csv'");
    assert.deepEqual(options.map((o) => [o.datasetId, o.preferred]), [["uk-ghg-gb-2025", true], ["nzi-gb-2025", false], ["ceda-gb-2025", false], ["mix-2025", false]],
      "the preferred source, then the registry's order, then an unregistered source — never alphabetical by id");
  });

  it("a fallback edition is the rule, not a coverage gap; a manual edition that misses the window still warns", async () => {
    const jobId = await crpJob("2027-01-01", "2027-12-31");
    await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, 'uk-ghg-gb-2024', 'manual', 'by hand', 't')`, [ORG, jobId]);
    const listed = await withTenantRead(database.pool, ORG, (db) => listJobDatasetOptions(db, jobId));
    const warnings = (id: string) => listed.find((d) => d.datasetId === id)!.warnings;
    assert.deepEqual(warnings("uk-ghg-gb-2025"), [], "the automatic fallback edition");
    assert.equal(listed.find((d) => d.datasetId === "uk-ghg-gb-2025")!.label, "DESNZ GB 2025", "the job's datasets panel names it by source · country · year");
    assert.deepEqual(listed.filter((d) => d.selected).map((d) => d.datasetId).slice(0, 2), ["uk-ghg-gb-2025", "uk-ghg-gb-2024"], "the preferred source's datasets first — the automatic edition and the manual one");
    assert.equal(listed.findIndex((d) => !d.selected) > listed.map((d) => d.selected).lastIndexOf(true), true, "selected before unselected");
    const registry = await withTenantRead(database.pool, ORG, (db) => listDatasetRegistry(db));
    assert.equal(registry.datasets.find((d) => d.id === "ice-gb-2026")!.label, "ICE GB 2026", "and so does the Datasets board");
    assert.deepEqual(registry.datasets.filter((d) => d.validFrom.startsWith("2025")).map((d) => d.label).slice(0, 3), ["DESNZ GB 2025", "NZI GB 2025", "CEDA GB 2025"], "the board lists each year newest first, the preferred source first");
    assert.equal(registry.datasets.find((d) => d.id === "ice-gb-2026")!.name, "upload.csv", "the imported name is left as it was");
    assert.ok(warnings("uk-ghg-gb-2024").some((w) => /complete reporting period/.test(w)), "the manual one still warns");
  });

  // TICKET-dataset-selection-job-country: the rule selects for the job's country (its config row) and GLOBAL — never GB
  // for a job of another country. Last, so the IE and GLOBAL editions it adds leave the GB tests above as they were.
  describe("the job's own country", () => {
    const automatic = async (jobId: string) => (await q(`SELECT dataset_id FROM nzi_console.job_dataset_selections WHERE job_id = $1 AND selection_source = 'automatic' ORDER BY dataset_id`, [jobId])).map((row) => row.dataset_id);
    const ieJob = async (from: string, to: string) => {
      // job.create writes GB today (where a client's country comes from is unruled), so the job is moved to IE by hand.
      const jobId = await crpJob(from, to);
      await q(`UPDATE nzi_console.job_emissions_config SET country_code = 'IE' WHERE job_id = $1`, [jobId]);
      await q(`DELETE FROM nzi_console.job_dataset_selections WHERE job_id = $1`, [jobId]);
      return jobId;
    };
    const autoSelect = (jobId: string) => autoSelectJobDatasets(database.pool, { jobId }, { ...staff(), reason: "Backfill" });
    const version = async (jobId: string) => (await q(`SELECT version FROM nzi_console.jobs WHERE job_id = $1`, [jobId]))[0]!.version as number;
    before(async () => {
      const dataset = (id: string, year: number, country: string, source = "test") => q(
        `INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
         VALUES ($1, $2, 'upload.csv', $2, $3, $4, $5, 'active', $6, 'test')`, [ORG, id, `${year}-01-01`, `${year}-12-31`, country, source]);
      await dataset("seai-ie-2024", 2024, "IE"); await dataset("seai-ie-2025", 2025, "IE");
      await dataset("mix-ie-2025", 2025, "IE");   // an IE edition of a series GB also publishes ("mix")
      await dataset("glob-2025", 2025, "GLOBAL");
    });

    it("an IE job takes IE and GLOBAL editions, never GB — the backfill's autoSelect reads the config row's country", async () => {
      const jobId = await ieJob("2025-01-01", "2025-12-31");
      const done = await autoSelect(jobId);
      assert.deepEqual(done.data.datasets.map((d) => d.datasetId), ["glob-2025", "mix-ie-2025", "seai-ie-2025"], "IE's own series and GLOBAL — no DESNZ GB, no GB 'mix'");
    });

    it("job.update re-derives an IE job's datasets for IE, previewed and written alike", async () => {
      const jobId = await ieJob("2025-01-01", "2025-12-31");
      await autoSelect(jobId);
      const moved = await updateJob(database.pool, { jobId, expectedVersion: await version(jobId), reportingPeriodStart: "2027-01-01", reportingPeriodEnd: "2027-12-31" }, { ...staff(), reason: "Moved to 2027" });
      const expected = ["glob-2025", "mix-2026", "mix-ie-2025", "seai-ie-2025"];   // each IE and GLOBAL series' latest, as fallbacks
      assert.deepEqual(moved.data.datasets!.automaticAdded.map((d) => d.datasetId).sort(), expected, "the plan");
      assert.deepEqual(await automatic(jobId), expected, "the write");
    });

    it("the newer-edition banner offers an IE job its IE series' new edition", async () => {
      const jobId = await ieJob("2026-01-01", "2026-12-31");
      await autoSelect(jobId);
      assert.ok((await automatic(jobId)).includes("seai-ie-2025"), "on the 2025 IE edition, as a fallback");
      await q(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
               VALUES ($1, 'seai-ie-2026', 'upload.csv', 'seai-ie-2026', '2026-01-01', '2026-12-31', 'IE', 'active', 'test', 'test')`, [ORG]);
      const updates = await withTenantRead(database.pool, ORG, (db) => jobDatasetUpdates(db, ORG, jobId));
      assert.deepEqual(updates.map((u) => [u.fromDatasetId, u.toDatasetId]), [["seai-ie-2025", "seai-ie-2026"]]);
    });

    it("an IE job with no IE or GLOBAL edition by its last day is left for a person — a GB edition is no fallback", async () => {
      await q(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
               VALUES ($1, 'nzi-gb-2023', 'upload.csv', 'nzi-gb-2023', '2023-01-01', '2023-12-31', 'GB', 'active', 'test', 'test')`, [ORG]);
      const jobId = await ieJob("2023-01-01", "2023-12-31");
      await assert.rejects(() => autoSelect(jobId),
        (error: any) => error.issues?.[0]?.code === "NO_EDITION" && /No active IE or GLOBAL dataset/.test(error.issues[0].message));
      assert.deepEqual(await automatic(jobId), []);
    });

    it("a GB job is unchanged: GB and GLOBAL only, never an IE edition", async () => {
      const jobId = await crpJob("2025-01-01", "2025-12-31");
      assert.deepEqual(await automatic(jobId), ["ceda-gb-2025", "glob-2025", "mix-2025", "nzi-gb-2025", "uk-ghg-gb-2025"]);
      const chosen = await withTenantRead(database.pool, ORG, (db) => automaticDatasetsFor(db, ORG, { from: "2025-01-01", to: "2025-12-31" }, "GB"));
      assert.equal(chosen[0]!.datasetId, "uk-ghg-gb-2025", "DESNZ still first for GB");
    });
  });
});
