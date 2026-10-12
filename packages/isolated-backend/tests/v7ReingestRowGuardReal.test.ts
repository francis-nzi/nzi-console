import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR, type CommandContext, type V7ReingestJobInput } from "@nzi/contracts";
import {
  approveScopeRow, calculateScopeRow, CommandValidationError, rejectScopeRow, REINGESTED_ROW_ATTEST_ONLY, resolveAssuranceGap, updateScopeRow,
} from "../src/postgresCommands";
import { deactivateScopeRow, discardScopeRow, reactivateScopeRow } from "../src/scopeRowState";
import { withTenantWrite } from "../src/postgres";
import { reingestV7JobInTransaction, revertV7ReingestInTransaction } from "../src/v7Reingest";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * RULING-v7-reingest-row-protection 1 (12 Oct), on the J000663 finding: an ordinary save on two re-ingested rows stripped their
 * crosswalk category and their re-ingest provenance. A re-ingested row — known by its `reingested_from_row_id` link, never by
 * its provenance — is attest-only: every server write to it is refused, naming the remedy (revert, then re-run with a
 * corrected plan); gap resolution, approve/reject, the revert and the re-ingest's own create, calculate and re-run still go
 * through. (Two more write paths are pinned in their own suites: the dataset-edition move, jobDatasetUpdateReal; portal
 * acceptance, portalRecordArchivedSiteReal.)
 */
const ORG = "v7-guard";
const JOB = "v7-job";
const STAFF = "staff-consultant";
const REVIEWER = "staff-reviewer";
const CROSSWALK_SHA = "d4c14407379377d20aeccebd9256eaf7ef7124846b07e05b3a0bf4afd233c8f2";
const record = (over: Record<string, unknown>) => ({ qty: 0, uom: "kWh", factor: 0, ghg_unit: "kgCO2e", original_id: "7_x", reported_tco2e: 0, data_source: "Company Data", enabled: true, ...over });

const V7_ROWS = [
  { id: "v7-gas", scope: "1", label: "Natural gas", qty: 1000, unit: "kWh", reported: 0.2, enabled: true },
  { id: "v7-water", scope: "3", label: "Water Supply", qty: 10, unit: "cubic metres", reported: 0.0015, enabled: true },
  { id: "v7-refrigerant", scope: "1", label: "Refrigerant", qty: 2.19, unit: "tCO2e", reported: 2.19, enabled: true },
  { id: "v7-disabled", scope: "1", label: "Never counted", qty: 5, unit: "kWh", reported: 9.99, enabled: false },
];
const plan = (runId: string): V7ReingestJobInput => ({
  jobId: JOB, runId, crosswalkVersion: "v1", crosswalkSha256: CROSSWALK_SHA, vintageDatasetIds: ["v7-vintage-2025"],
  rows: [
    { v7RowId: "v7-gas", disposition: "RE-INGEST", categoryCode: "1.natural-gas", scope: "1", sourceLabel: "Natural gas", quantity: 1000, unit: "kWh",
      datasetId: "v7-vintage-2025", factorId: "gas", qualityTier: "measured", v7Tco2e: 0.2, rule: "S1-GAS" },
    { v7RowId: "v7-water", disposition: "RE-INGEST", categoryCode: "3.5", scope: "3.5", sourceLabel: "Water Supply", quantity: 10, unit: "m3",
      datasetId: "v7-vintage-2025", factorId: "water", qualityTier: "measured", v7Tco2e: 0.0015, rule: "S3-5" },
    { v7RowId: "v7-refrigerant", disposition: "REPORTED-TOTAL", categoryCode: "1.refrigerants", scope: "1", sourceLabel: "Refrigerant", quantity: null, unit: null,
      qualityTier: "estimated", v7Tco2e: 2.19, rule: "T1" },
  ],
});

describe("re-ingested rows are attest-only: every write refused but review, gap resolution, the revert and the re-run", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (actorId: string, principal: "system" | "staff", reason = "test"): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId, principal, idempotencyKey: `${actorId}-${keys}`, correlationId: `corr-${keys}`, reason, grant: commandGrantForRole("admin", ORG, actorId) };
  };
  const reingest = () => context(V7_REINGEST_ACTOR, "system", "v7 re-ingest (test)");
  const staff = () => context(STAFF, "staff");
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const commit = (runId: string) => withTenantWrite(database.pool, ORG, (client) => reingestV7JobInTransaction(client, plan(runId), reingest()));
  const revert = (runId: string) => withTenantWrite(database.pool, ORG, (client) => revertV7ReingestInTransaction(client, { jobId: JOB, runId }, reingest()));
  /** The live row re-ingested from a v7 row, enabled (the current run's), with what an edit could have changed. */
  const liveFor = async (v7: string) => (await db.query(
    `SELECT scope_row_id AS id, version, enabled, review_status, category_code, site_id, quantity::float AS q, coalesce(override_tco2e, calculated_tco2e)::float AS t,
            provenance_json AS provenance, lineage_json AS lineage
       FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' AND reingested_from_row_id=$2 ORDER BY enabled DESC, created_at DESC LIMIT 1`, [JOB, v7])).rows[0]!;
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0]!.n);
  const liveOn = () => count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' AND enabled`, [JOB]);
  const v7On = () => count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='migrated' AND enabled`, [JOB]);
  const runStatus = async (runId: string) => (await db.query(`SELECT status FROM nzi_console.v7_reingest_runs WHERE run_id=$1`, [runId])).rows[0]!.status;
  const attestOnly = (error: unknown) => {
    assert.deepEqual(codes(error), [REINGESTED_ROW_ATTEST_ONLY]);
    assert.match((error as CommandValidationError).issues[0]!.message, /re-ingested from NZ Insights Pro v7.*attest-only.*revert the re-ingest and re-run it with a corrected plan/);
    return true;
  };

  before(async () => {
    database = (await createDisposableDatabase("v7guard"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','EFF Test','active')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id)
      VALUES ($1,$2,'c1',663,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7','663')`, [ORG, JOB]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [ORG, JOB]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [ORG]);
    for (const [id, label, unit, kg, scope] of [["gas", "Natural gas", "kWh", 0.2, "1"], ["water", "Water supply", "m3", 0.15, "3"]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6])`,
        [ORG, id, label, unit, kg, scope]);
    }
    for (const row of V7_ROWS) {
      await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,
          calculated_tco2e,review_status,enabled,origin,migrated_record,source_system,legacy_db_id)
        VALUES ($1,$2,$3,$4,$5,$5,'v7','v7',$6,$7,$8,'pending',$9,'migrated',$10::jsonb,'nzi-pro-v7',$2)`,
        [ORG, row.id, JOB, row.scope, row.label, row.qty, row.unit, row.reported, row.enabled,
          JSON.stringify(record({ qty: row.qty, uom: row.unit, reported_tco2e: row.reported, enabled: row.enabled }))]);
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  let firstRun = "";
  it("the re-ingest's own create and calculate pass the guard: it commits, each row linked to its v7 row", async () => {
    firstRun = `v7-reingest-${randomUUID()}`;
    const outcome = await commit(firstRun);
    assert.equal(outcome.data.nativeTotalTco2e, outcome.data.v7TotalTco2e);
    assert.deepEqual([await liveOn(), await v7On()], [3, 0]);
    // The register's and the group roll-up's writes are keyed by source_id and group_id, which a re-ingested row never has.
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND reingested_from_row_id IS NOT NULL AND (source_id IS NOT NULL OR group_id IS NOT NULL)`, [JOB]), 0);
  });

  it("as J000663's two rows were before this guard: one row's re-ingest provenance and category stripped, as the old save did", async () => {
    await db.query(`UPDATE nzi_console.job_scope_rows SET provenance_json = (provenance_json - 'reingest') || '{"capturedVia":"manual","capturedAs":"staff"}'::jsonb,
                      category_code = NULL, version = version + 1
                    WHERE job_id=$1 AND origin='live' AND reingested_from_row_id = 'v7-gas'`, [JOB]);
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' AND provenance_json ? 'reingest'`, [JOB]), 2);
  });

  it("every server write a consultant could make is refused — on an intact row and a provenance-stripped one alike — and nothing changes", async () => {
    for (const v7 of ["v7-water", "v7-gas"]) {
      const row = await liveFor(v7);
      const ref = { jobId: JOB, rowId: row.id, expectedVersion: row.version };
      await assert.rejects(updateScopeRow(database.pool, { ...ref, enabled: true, scope: "1", categoryCode: "1.natural-gas", sourceLabel: "Natural gas", quantity: 999, unit: "kWh",
        datasetId: "v7-vintage-2025", factorId: "gas", factorVersion: null, factorLabel: null, qualityTier: "measured" }, staff()), attestOnly, `${v7}: edit`);
      await assert.rejects(calculateScopeRow(database.pool, ref, staff()), attestOnly, `${v7}: recalculate`);
      await assert.rejects(deactivateScopeRow(database.pool, ref, staff()), attestOnly, `${v7}: deactivate outside the revert`);
      await assert.rejects(discardScopeRow(database.pool, ref, staff()), attestOnly, `${v7}: discard`);
      // The exemption is the re-ingest principal, as refuseUnlessReingest: its actor id from a staff session is not it.
      await assert.rejects(calculateScopeRow(database.pool, ref, context(V7_REINGEST_ACTOR, "staff")), attestOnly, `${v7}: the re-ingest's actor id, as staff`);
      assert.deepEqual(await liveFor(v7), row, `${v7}: untouched`);
    }
  });

  it("what review needs still goes through: a gap resolved on the row, approve and reject by an independent reviewer", async () => {
    const water = await liveFor("v7-water"), gas = await liveFor("v7-gas");
    const reviewer = () => context(REVIEWER, "staff");
    const resolved = await resolveAssuranceGap(database.pool, { jobId: JOB, gapKey: `completeness:${gas.id}`, flagType: "completeness", scopeRowId: gas.id,
      reason: "v7 record of account", expectedVersion: 0 }, reviewer());
    assert.equal(resolved.data.version, 1);
    const approved = await approveScopeRow(database.pool, { jobId: JOB, rowIds: [water.id], expectedReviewVersion: water.version }, reviewer());
    assert.equal(approved.data.decision, "approved");
    const rejected = await rejectScopeRow(database.pool, { jobId: JOB, rowIds: [gas.id], expectedReviewVersion: gas.version, reviewerNote: "category stripped" }, reviewer());
    assert.equal(rejected.data.decision, "rejected");
    assert.deepEqual([(await liveFor("v7-water")).review_status, (await liveFor("v7-gas")).review_status], ["approved", "rejected"]);
  });

  it("the revert is not blocked by the guard: it switches every row off through the same deactivate", async () => {
    const outcome = await revert(firstRun);
    assert.deepEqual([outcome.data.liveRowsSwitchedOff, outcome.data.v7RowsSwitchedOn], [3, 3]);
    assert.deepEqual([await liveOn(), await v7On(), await runStatus(firstRun)], [0, 3, "reverted"]);
  });

  it("a reverted run's rows stay attest-only: switching one back on by hand, or discarding it, is refused", async () => {
    const gas = await liveFor("v7-gas");
    assert.equal(gas.enabled, false);
    const ref = { jobId: JOB, rowId: gas.id, expectedVersion: gas.version };
    await assert.rejects(reactivateScopeRow(database.pool, ref, staff()), attestOnly, "it would count beside its v7 row");
    await assert.rejects(discardScopeRow(database.pool, ref, staff()), attestOnly);
  });

  let secondRun = "";
  it("the re-ingest's re-run is not blocked by the guard: the pristine rows again, crosswalk category and re-ingest provenance on every one", async () => {
    secondRun = `v7-reingest-${randomUUID()}`;
    await commit(secondRun);
    assert.deepEqual([await liveOn(), await v7On()], [3, 0]);
    for (const [v7, category] of [["v7-gas", "1.natural-gas"], ["v7-water", "3.5"], ["v7-refrigerant", "1.refrigerants"]] as const) {
      const row = await liveFor(v7);
      assert.deepEqual([row.enabled, row.review_status, row.category_code, row.site_id, row.provenance.reingest?.runId], [true, "pending", category, null, secondRun], v7);
    }
  });
});
