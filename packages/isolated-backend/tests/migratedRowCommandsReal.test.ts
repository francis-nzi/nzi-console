import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import {
  approveScopeRow, calculateScopeRow, CommandValidationError, createReviewedCrpSnapshot, MIGRATED_PERIOD, MIGRATED_ROW_IMMUTABLE,
  rollforwardScopeRows, updateScopeRow,
} from "../src/postgresCommands";
import { getScopeQaReadiness } from "../src/readModels";
import { withTenantRead } from "../src/postgres";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * Migrated rows at the command layer (docs/CLIENT_JOB_IMPORT_DESIGN.md §5.1, decisions 4 and 7). The 0133 trigger
 * refuses any change to a migrated row whoever writes; here every write command refuses first, by name, and the review
 * gates stop asking a migrated row for the console review it can never have — and ask everything else as before.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "migrated-guards";
const ACTOR = "staff-guard";
const RECORD = { qty: 1000, uom: "kWh", factor: 0.2, ghg_unit: "kgCO2e", original_id: "7_400_4000_5_1", reported_tco2e: 0.2, data_source: "Company Data", enabled: true };

describe("migrated rows in the write commands and the review gates", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = () => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff" as const, idempotencyKey: `guard-${keys}`,
      correlationId: `corr-guard-${keys}`, grant: commandGrantForRole("admin", ORG, ACTOR) };
  };
  const refusedAsMigrated = (error: unknown) => {
    assert.ok(error instanceof CommandValidationError, `expected a command refusal, got ${String(error)}`);
    assert.deepEqual(error.issues.map((issue) => issue.code), [MIGRATED_ROW_IMMUTABLE]);
    return true;
  };
  const migratedRow = (id: string, job: string, over: Record<string, unknown> = {}) => db.query(
    `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,
       calculated_tco2e,review_status,enabled,origin,migrated_record,source_system,legacy_db_id)
     VALUES ($1,$2,$3,'1','Natural gas','Natural gas','Fuels','Gaseous fuels',1000,'kWh',0.2,$4,true,'migrated',$5::jsonb,'nzi-pro-v7',$2)`,
    [ORG, id, job, over.review_status ?? "pending", JSON.stringify(RECORD)]);
  const readiness = (job: string) => withTenantRead(database.pool, ORG, (client) => getScopeQaReadiness(client, job));

  before(async () => {
    database = (await createDisposableDatabase("migratedguards"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Co','active')`, [ORG]);
    for (const [job, sequence, year] of [["job-2023", 1, 2023], ["job-2024", 2, 2024], ["job-mixed", 3, 2025]] as const) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
        VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',$4,$5,$6)`, [ORG, job, sequence, year, `${year}-01-01`, `${year}-12-31`]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`,
        [ORG, job, `${year}-01-01`, `${year}-12-31`]);
    }
    await migratedRow("v7-row-1", "job-2023");
    await migratedRow("v7-row-2", "job-mixed");
  });
  after(async () => { await db?.end(); await database?.end(); });

  // ── The write commands refuse first, and by name ──

  it("refuses to edit, recalculate, approve or reject a migrated row", async () => {
    const fields: any = { jobId: "job-2023", rowId: "v7-row-1", expectedVersion: 1, enabled: true, scope: "1", sourceLabel: "Natural gas",
      reportLabel: "Natural gas", quantity: 2000, unit: "kWh", datasetId: null, factorId: null, factorVersion: null, factorLabel: null, qualityTier: "measured" };
    await assert.rejects(updateScopeRow(database.pool, fields, context()), refusedAsMigrated);
    await assert.rejects(calculateScopeRow(database.pool, { jobId: "job-2023", rowId: "v7-row-1", expectedVersion: 1 }, context()), refusedAsMigrated);
    await assert.rejects(approveScopeRow(database.pool, { jobId: "job-2023", rowIds: ["v7-row-1"], expectedReviewVersion: 1 }, context()), refusedAsMigrated);
    const kept = await db.query(`SELECT quantity::float AS q, review_status, version FROM nzi_console.job_scope_rows WHERE scope_row_id='v7-row-1'`);
    assert.deepEqual(kept.rows, [{ q: 1000, review_status: "pending", version: 1 }]);
  });

  it("never rolls a migrated row forward into a live one", async () => {
    const outcome = await rollforwardScopeRows(database.pool, { jobId: "job-2024", priorJobId: "job-2023", rowIds: ["v7-row-1"] }, context());
    assert.deepEqual([outcome.data.rolledForward, outcome.data.skipped], [0, 1]);
    const created = await db.query(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE job_id='job-2024'`);
    assert.equal(created.rows[0]!.n, 0);
  });

  // ── The review counts ask nothing of a migrated row (decision 7); the job is an imported period (decision 12) ──

  const liveRow = (id: string, job: string) => db.query(
    `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,calculated_tco2e)
     VALUES ($1,$2,$3,'2','Electricity','Electricity','UK electricity','Grid',500,'kWh',0.1)`, [ORG, id, job]);
  const freezeCodes = async (job: string) => {
    try {
      await createReviewedCrpSnapshot(database.pool, { jobId: job, expectedJobVersion: 1 }, context());
      return [];
    } catch (error) {
      return error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
    }
  };

  it("counts no console review against a migrated row, still counts a live one, and never calls an imported period ready", async () => {
    const migratedOnly = await readiness("job-2023");
    assert.deepEqual([migratedOnly.pending, migratedOnly.qualityMissing, migratedOnly.independentReviewPending], [0, 0, 0]);
    assert.deepEqual([migratedOnly.migratedRows, migratedOnly.readyForReporting], [1, false], "decision 12: an imported period is never snapshot-ready");

    await liveRow("live-1", "job-mixed");
    const mixed = await readiness("job-mixed");
    assert.deepEqual([mixed.pending, mixed.qualityMissing, mixed.independentReviewPending, mixed.migratedRows, mixed.readyForReporting], [1, 1, 1, 1, false],
      "the live row beside it is counted as usual");
  });

  it("refuses to freeze any job holding a migrated row — enabled or not — and leaves a live job's gates as they were (decision 12)", async () => {
    assert.deepEqual(await freezeCodes("job-2023"), [MIGRATED_PERIOD]);
    assert.deepEqual(await freezeCodes("job-mixed"), [MIGRATED_PERIOD], "one migrated row beside live ones is enough");
    await db.query(`UPDATE nzi_console.job_scope_rows SET enabled=false WHERE scope_row_id='v7-row-2'`); // 0133 permits exactly this
    assert.deepEqual(await freezeCodes("job-mixed"), [MIGRATED_PERIOD], "a disabled migrated row still makes it an imported period");

    await liveRow("live-2", "job-2024");
    assert.deepEqual(await freezeCodes("job-2024"), ["QA_INCOMPLETE"], "a live-only job meets the freeze's gates as before");
    const live = await readiness("job-2024");
    assert.equal(live.migratedRows, 0);
  });

  it("still asks a migrated row for its figure", async () => {
    // Only reachable by bypassing 0133 as the owner: a migrated row with no figure is not something the import writes.
    await db.query(`ALTER TABLE nzi_console.job_scope_rows DISABLE TRIGGER job_scope_rows_migrated_immutable`);
    try {
      await db.query(`UPDATE nzi_console.job_scope_rows SET calculated_tco2e=NULL WHERE scope_row_id='v7-row-1'`);
    } finally {
      await db.query(`ALTER TABLE nzi_console.job_scope_rows ENABLE TRIGGER job_scope_rows_migrated_immutable`);
    }
    const figureless = await readiness("job-2023");
    assert.deepEqual([figureless.calculationMissing, figureless.readyForReporting], [1, false]);
  });
});
