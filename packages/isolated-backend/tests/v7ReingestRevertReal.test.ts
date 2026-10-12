import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR, type CommandContext, type V7ReingestJobInput } from "@nzi/contracts";
import { CommandValidationError } from "../src/postgresCommands";
import { withTenantWrite } from "../src/postgres";
import { reingestV7JobInTransaction, revertV7ReingestInTransaction } from "../src/v7Reingest";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * RULING-v7-reingest-row-protection 2 (12 Oct), on the J000663 finding: an ordinary save on two re-ingested rows stripped their
 * re-ingest provenance, and the revert — which found its rows by that provenance — would have reversed 78 of 80 and still
 * marked the run reverted. Fixed: the revert finds the run's v7 rows by its own append-only audit events and its live rows by
 * their `reingested_from_row_id` link, and is all or nothing — every row the run created off and every one of its v7 rows back
 * on, read back inside the transaction, or nothing is reverted and the run stays completed.
 */
const ORG = "v7-revert";
const JOB = "v7-job";
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

describe("the v7 re-ingest's revert finds its rows by their link, all or nothing", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (actorId: string, principal: "system" | "staff", reason = "test"): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId, principal, idempotencyKey: `${actorId}-${keys}`, correlationId: `corr-${keys}`, reason, grant: commandGrantForRole("admin", ORG, actorId) };
  };
  const reingest = () => context(V7_REINGEST_ACTOR, "system", "v7 re-ingest (test)");
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

  before(async () => {
    database = (await createDisposableDatabase("v7revert"))!;
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
  it("commits: each live row linked to its v7 row", async () => {
    firstRun = `v7-reingest-${randomUUID()}`;
    const outcome = await commit(firstRun);
    assert.equal(outcome.data.nativeTotalTco2e, outcome.data.v7TotalTco2e);
    assert.deepEqual([await liveOn(), await v7On()], [3, 0]);
  });

  it("J000663's damage, reproduced: two rows' re-ingest provenance and category stripped as the old save did", async () => {
    await db.query(`UPDATE nzi_console.job_scope_rows SET provenance_json = (provenance_json - 'reingest') || '{"capturedVia":"manual","capturedAs":"staff"}'::jsonb,
                      category_code = NULL, version = version + 1
                    WHERE job_id=$1 AND origin='live' AND reingested_from_row_id IN ('v7-gas','v7-refrigerant')`, [JOB]);
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' AND provenance_json->'reingest'->>'runId' = $2`, [JOB, firstRun]), 1,
      "the provenance a revert keyed on survives on one row of three");
  });

  it("the revert finds every row by its link — the provenance-stripped two included — and reverses all of them", async () => {
    const outcome = await revert(firstRun);
    assert.deepEqual([outcome.data.liveRowsSwitchedOff, outcome.data.v7RowsSwitchedOn], [3, 3], "3 of 3, not the 1 the provenance would have found");
    assert.deepEqual([await liveOn(), await v7On()], [0, 3], "every live row off; every v7 row the run switched off back on — the disabled one stays off");
    assert.equal(await runStatus(firstRun), "reverted");
  });

  let secondRun = "";
  it("the re-ingest re-runs after the revert, restoring the pristine rows: crosswalk category and re-ingest provenance on every one", async () => {
    secondRun = `v7-reingest-${randomUUID()}`;
    await commit(secondRun);
    assert.deepEqual([await liveOn(), await v7On()], [3, 0]);
    for (const [v7, category] of [["v7-gas", "1.natural-gas"], ["v7-water", "3.5"], ["v7-refrigerant", "1.refrigerants"]] as const) {
      const row = await liveFor(v7);
      assert.deepEqual([row.enabled, row.review_status, row.category_code, row.site_id, row.provenance.reingest?.runId], [true, "pending", category, null, secondRun], v7);
    }
  });

  it("all or nothing: when a v7 row would not come back on, nothing is reverted and the run stays completed", async () => {
    // A v7 row whose switch-on silently does not take (a stand-in for anything that leaves the revert short).
    await db.query(`CREATE FUNCTION public.test_hold_v7_gas_off() RETURNS trigger LANGUAGE plpgsql AS $$
                      BEGIN IF NEW.scope_row_id = 'v7-gas' THEN NEW.enabled := false; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER test_hold_v7_gas_off BEFORE UPDATE ON nzi_console.job_scope_rows FOR EACH ROW EXECUTE FUNCTION public.test_hold_v7_gas_off()`);
    try {
      await assert.rejects(revert(secondRun), (error) => codes(error).includes("REVERT_INCOMPLETE"));
    } finally {
      await db.query(`DROP TRIGGER test_hold_v7_gas_off ON nzi_console.job_scope_rows`);
      await db.query(`DROP FUNCTION public.test_hold_v7_gas_off()`);
    }
    assert.deepEqual([await liveOn(), await v7On(), await runStatus(secondRun)], [3, 0, "completed"], "the whole revert rolled back");
  });

  it("all or nothing: a run whose record and its own v7 rows disagree in number is not reverted", async () => {
    await db.query(`UPDATE nzi_console.v7_reingest_runs SET rows_by_disposition_json = jsonb_set(rows_by_disposition_json, '{RE-INGEST}', '3') WHERE run_id=$1`, [secondRun]);
    try {
      await assert.rejects(revert(secondRun), (error) => codes(error).includes("REVERT_INCOMPLETE"));
    } finally {
      await db.query(`UPDATE nzi_console.v7_reingest_runs SET rows_by_disposition_json = jsonb_set(rows_by_disposition_json, '{RE-INGEST}', '2') WHERE run_id=$1`, [secondRun]);
    }
    assert.deepEqual([await liveOn(), await v7On(), await runStatus(secondRun)], [3, 0, "completed"]);
    const outcome = await revert(secondRun);
    assert.deepEqual([outcome.data.liveRowsSwitchedOff, outcome.data.v7RowsSwitchedOn, await runStatus(secondRun)], [3, 3, "reverted"], "and with nothing in the way, it reverts");
  });
});
