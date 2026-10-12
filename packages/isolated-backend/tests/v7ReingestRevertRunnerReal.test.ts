import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR, type CommandContext, type V7ReingestJobInput } from "@nzi/contracts";
import { CommandValidationError } from "../src/postgresCommands";
import { withTenantWrite } from "../src/postgres";
import { reingestV7JobInTransaction } from "../src/v7Reingest";
import { runV7ReingestRevert, v7ReingestRevertContext } from "../src/v7ReingestRevertRun";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * The revert runner (scripts/v7-reingest-revert.ts → runV7ReingestRevert), against a real database, on J000663's shape after
 * the review edits — two of three re-ingested rows with their provenance stripped:
 *   - the context is policy:v7-reingest as the system principal, so the attest-only guard's exemption applies and the revert's
 *     deactivations reach every re-ingested row (end to end, through the merged guard);
 *   - a dry run is the whole revert, its post-condition included, rolled back: it reports the counts the commit would leave,
 *     read inside the transaction, and writes nothing;
 *   - a reason is required; an unknown run is refused; the commit reverts every row.
 */
const ORG = "v7-revert-runner";
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

describe("the v7 re-ingest revert runner: as the re-ingest principal, dry run by default, all or nothing", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const runId = `v7-reingest-${randomUUID()}`;
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0]!.n);
  const state = async () => ({
    liveOn: await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' AND enabled`, [JOB]),
    v7On: await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='migrated' AND enabled`, [JOB]),
    status: (await db.query(`SELECT status FROM nzi_console.v7_reingest_runs WHERE run_id=$1`, [runId])).rows[0]!.status as string,
    revertEvents: await count(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE correlation_id=$1`, [`${runId}:revert`]),
  });
  const revert = (over: Partial<Parameters<typeof runV7ReingestRevert>[1]> = {}) =>
    runV7ReingestRevert(database.pool, { organisationId: ORG, jobId: JOB, runId, reason: "re-review after the J000663 edits", commit: false, ...over });

  before(async () => {
    database = (await createDisposableDatabase("v7revertrunner"))!;
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
    const reingest: CommandContext = { organisationId: ORG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: runId, correlationId: runId,
      reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", ORG, V7_REINGEST_ACTOR) };
    await withTenantWrite(database.pool, ORG, (client) => reingestV7JobInTransaction(client, plan(runId), reingest));
    // As J000663 after the review edits: two rows' re-ingest provenance and category gone.
    await db.query(`UPDATE nzi_console.job_scope_rows SET provenance_json = (provenance_json - 'reingest') || '{"capturedVia":"manual"}'::jsonb, category_code = NULL, version = version + 1
                    WHERE job_id=$1 AND origin='live' AND reingested_from_row_id IN ('v7-gas','v7-refrigerant')`, [JOB]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("runs as policy:v7-reingest, the system principal — the one the attest-only guard exempts", () => {
    const context = v7ReingestRevertContext(ORG, runId, "why");
    assert.deepEqual([context.actorId, context.principal, context.reason], [V7_REINGEST_ACTOR, "system", "why"]);
  });

  it("a dry run reports what the commit would leave — read inside the transaction — and writes nothing", async () => {
    const report = await revert();
    assert.equal(report.committed, false);
    assert.deepEqual([report.liveRowsSwitchedOff, report.v7RowsSwitchedOn], [3, 3], "every row, the provenance-stripped two included");
    assert.deepEqual(report.before, { linkedLiveRows: 3, linkedLiveOn: 3, v7Rows: 4, v7On: 0, runStatus: "completed" });
    assert.deepEqual(report.after, { linkedLiveRows: 3, linkedLiveOn: 0, v7Rows: 4, v7On: 3, runStatus: "reverted" });
    assert.deepEqual(await state(), { liveOn: 3, v7On: 0, status: "completed", revertEvents: 0 }, "rolled back: nothing written");
  });

  it("refuses without a reason (the command's own check), and an unknown run — writing nothing", async () => {
    await assert.rejects(revert({ reason: "  ", commit: true }), (error) => codes(error).includes("REQUIRED"));
    await assert.rejects(runV7ReingestRevert(database.pool, { organisationId: ORG, jobId: JOB, runId: `v7-reingest-${randomUUID()}`, reason: "x", commit: true }),
      (error) => codes(error).includes("NOT_FOUND"));
    assert.deepEqual(await state(), { liveOn: 3, v7On: 0, status: "completed", revertEvents: 0 });
  });

  it("--commit reverts every row through the guard, as the dry run said", async () => {
    const report = await revert({ commit: true });
    assert.deepEqual([report.committed, report.liveRowsSwitchedOff, report.v7RowsSwitchedOn], [true, 3, 3]);
    assert.deepEqual(report.after, { linkedLiveRows: 3, linkedLiveOn: 0, v7Rows: 4, v7On: 3, runStatus: "reverted" });
    const written = await state();
    assert.deepEqual([written.liveOn, written.v7On, written.status], [0, 3, "reverted"]);
    assert.ok(written.revertEvents > 0, "audited under the revert's correlation id");
  });
});
