import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR, type CommandContext, type V7ReingestJobInput } from "@nzi/contracts";
import { CommandValidationError } from "../src/postgresCommands";
import { withTenantRead, withTenantWrite } from "../src/postgres";
import { getScopeQaReadiness } from "../src/readModels";
import { planReingestAttestation } from "../src/reingestAttest";
import type { PlannedRow } from "../src/v7ClientImport";
import { insert, migratedRowCols } from "../src/v7ClientLoad";
import { reingestV7JobInTransaction, revertV7ReingestInTransaction } from "../src/v7Reingest";
import { runV7ReingestRevert } from "../src/v7ReingestRevertRun";
import { resyncV7JobInTransaction, revertV7ResyncInTransaction, V7_RESYNC_ACTOR, type V7ResyncContext } from "../src/v7Resync";
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

/**
 * RULING-v7-resync-job v2 (Route B, 0225): v7 changed a job's records after migration. The re-sync supersedes the stale rows —
 * switched off and pointed at their replacements, never edited or deleted — inserts v7's current records beside them, and
 * switches off a record gone from v7; the revert flips every row back.
 * The four readers of a job's v7 rows (re-ingest, readiness, revert, attest) each leave a superseded row out, each with a test
 * here that goes red when its exclusion is removed (the mutation controls are recorded with the branch's handoff).
 */
const RS_ORG = "v7-resync";
const JOB_A = "v7-job-a", JOB_B = "v7-job-b", JOB_S = "v7-job-s";
type V7Fixture = { id: string; scope: "1" | "3"; label: string; qty: number; unit: string; reported: number };
const plannedRow = (row: V7Fixture): PlannedRow => ({
  scopeRowId: `v7-row-${row.id}`, legacyDbId: row.id, scope: row.scope, v7Scope: row.scope, sourceLabel: row.label, reportLabel: row.label,
  level1: "v7", level2: "v7", level3: null, level4: null, columnText: null, quantity: row.qty, unit: row.unit, datasetId: null, factorId: null,
  calculatedTco2e: row.reported, reviewStatus: "pending", enabled: true, applyPct: 100, dataConfidence: null, siteId: null,
  isAutoGenerated: false, autoPairKind: null, linkedRowId: null,
  migratedRecord: record({ qty: row.qty, uom: row.unit, reported_tco2e: row.reported, original_id: `7_${row.id}`, enabled: true }) as unknown as PlannedRow["migratedRecord"],
  provenance: {}, lineage: [], counted: true,
});
const GAS: V7Fixture = { id: "1001", scope: "1", label: "Natural gas", qty: 1000, unit: "kWh", reported: 0.2 };
const WATER: V7Fixture = { id: "1002", scope: "3", label: "Water Supply", qty: 10, unit: "cubic metres", reported: 0.0015 };
const REFRIGERANT: V7Fixture = { id: "1003", scope: "1", label: "Refrigerant", qty: 2.19, unit: "tCO2e", reported: 2.19 };
/** v7 now: gas amended, a second gas meter added, the refrigerant record deleted. Water unchanged. */
const GAS_NOW: V7Fixture = { ...GAS, qty: 1200, reported: 0.24 };
const GAS_SITE_2: V7Fixture = { id: "1004", scope: "1", label: "Natural gas (site 2)", qty: 500, unit: "kWh", reported: 0.1 };
const BEFORE = [GAS, WATER, REFRIGERANT].map(plannedRow);
const NOW = [GAS_NOW, WATER, GAS_SITE_2].map(plannedRow);

/** A re-ingest plan for these v7 rows (row id → fixture). */
const planFor = (runId: string, rows: Array<[string, V7Fixture]>): V7ReingestJobInput => ({
  jobId: JOB_A, runId, crosswalkVersion: "v1", crosswalkSha256: CROSSWALK_SHA, vintageDatasetIds: ["v7-vintage-2025"],
  rows: rows.map(([v7RowId, row]) => row.unit === "tCO2e"
    ? { v7RowId, disposition: "REPORTED-TOTAL" as const, categoryCode: "1.refrigerants", scope: "1", sourceLabel: row.label, quantity: null, unit: null, qualityTier: "estimated" as const, v7Tco2e: row.reported, rule: "T1" }
    : row.scope === "3"
      ? { v7RowId, disposition: "RE-INGEST" as const, categoryCode: "3.5", scope: "3.5", sourceLabel: row.label, quantity: row.qty, unit: "m3", datasetId: "v7-vintage-2025", factorId: "water", qualityTier: "measured" as const, v7Tco2e: row.reported, rule: "S3-5" }
      : { v7RowId, disposition: "RE-INGEST" as const, categoryCode: "1.natural-gas", scope: "1", sourceLabel: row.label, quantity: row.qty, unit: "kWh", datasetId: "v7-vintage-2025", factorId: "gas", qualityTier: "measured" as const, v7Tco2e: row.reported, rule: "S1-GAS" }),
});
const PLAN_BEFORE = (runId: string) => planFor(runId, [["v7-row-1001", GAS], ["v7-row-1002", WATER], ["v7-row-1003", REFRIGERANT]]);
const PLAN_NOW = (runId: string) => planFor(runId, [["v7-row-1001-r1", GAS_NOW], ["v7-row-1002", WATER], ["v7-row-1004", GAS_SITE_2]]);

describe("the v7 re-sync supersedes a changed job's v7 rows, and every reader leaves the superseded ones out", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const reingestContext = (): CommandContext => {
    keys += 1;
    return { organisationId: RS_ORG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: `rs-${keys}`, correlationId: `rs-corr-${keys}`,
      reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", RS_ORG, V7_REINGEST_ACTOR) };
  };
  const resyncContext = (over: Partial<V7ResyncContext> = {}): V7ResyncContext =>
    ({ organisationId: RS_ORG, actorId: V7_RESYNC_ACTOR, principal: "system", reason: "v7 amended J000901 after migration (test)", ...over });
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const resync = (rows: readonly PlannedRow[], runId = `v7-resync-${randomUUID()}`, context = resyncContext(), jobId = JOB_A) =>
    withTenantWrite(database.pool, RS_ORG, (client) => resyncV7JobInTransaction(client, { jobId, runId, extractSha256: "f".repeat(64), rows }, context));
  const revertResync = (runId: string) => withTenantWrite(database.pool, RS_ORG, (client) => revertV7ResyncInTransaction(client, { jobId: JOB_A, runId }, resyncContext()));
  const reingest = (plan: V7ReingestJobInput) => withTenantWrite(database.pool, RS_ORG, (client) => reingestV7JobInTransaction(client, plan, reingestContext()));
  const revertReingest = (runId: string) => withTenantWrite(database.pool, RS_ORG, (client) => revertV7ReingestInTransaction(client, { jobId: JOB_A, runId }, reingestContext()));
  const migrated = async (jobId = JOB_A) => (await db.query<{ id: string; enabled: boolean; superseded_by_row_id: string | null; record: string; whole: string }>(
    `SELECT scope_row_id AS id, enabled, superseded_by_row_id, migrated_record::text AS record, (to_jsonb(r) - ARRAY['version', 'updated_at'])::text AS whole
       FROM nzi_console.job_scope_rows r WHERE organisation_id=$1 AND job_id=$2 AND origin='migrated' ORDER BY scope_row_id`, [RS_ORG, jobId])).rows;
  const current = async () => (await migrated()).filter((row) => row.superseded_by_row_id === null);
  const resyncRunStatus = async (runId: string) => (await db.query(`SELECT status FROM nzi_console.v7_resync_runs WHERE run_id=$1`, [runId])).rows[0]?.status ?? null;

  before(async () => {
    database = (await createDisposableDatabase("v7resync"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [RS_ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [RS_ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [RS_ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Resync Test','active')`, [RS_ORG]);
    for (const [jobId, sequence] of [[JOB_A, 901], [JOB_B, 902], [JOB_S, 903]] as const) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
        VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7',$4,$5)`, [RS_ORG, jobId, sequence, String(sequence), `J000${sequence}`]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [RS_ORG, jobId]);
    }
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [RS_ORG]);
    for (const [id, label, unit, kg, scope] of [["gas", "Natural gas", "kWh", 0.2, "1"], ["water", "Water supply", "m3", 0.15, "3"]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6])`,
        [RS_ORG, id, label, unit, kg, scope]);
    }
    // The v7 rows as the import wrote them: through the loader's own insert and column list.
    const load = async (jobId: string, row: PlannedRow) => insert(db, "job_scope_rows", [
      { column: "organisation_id", value: RS_ORG, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
      { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(jobId, row)]);
    for (const row of BEFORE) await load(JOB_A, row);
    await load(JOB_B, plannedRow({ id: "2001", scope: "1", label: "Natural gas", qty: 100, unit: "kWh", reported: 0.02 }));
    await load(JOB_S, plannedRow({ id: "3001", scope: "1", label: "Natural gas", qty: 100, unit: "kWh", reported: 0.02 }));
    await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
                    VALUES ($1,'snap-s',$2,1,1,'sha256:' || repeat('a', 64),'{}'::jsonb,'staff-1')`, [RS_ORG, JOB_S]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("R2: only policy:v7-resync, as the system principal, re-syncs", async () => {
    await assert.rejects(resync(NOW, undefined, resyncContext({ principal: "staff" })), (error) => codes(error).includes("NOT_RESYNC_PRINCIPAL"));
    await assert.rejects(resync(NOW, undefined, resyncContext({ actorId: V7_REINGEST_ACTOR })), (error) => codes(error).includes("NOT_RESYNC_PRINCIPAL"));
    await assert.rejects(resync(NOW, undefined, resyncContext({ reason: "  " })), (error) => codes(error).includes("REASON_REQUIRED"));
    assert.deepEqual((await current()).map((row) => row.id), ["v7-row-1001", "v7-row-1002", "v7-row-1003"], "nothing written");
  });

  let staleRun = "";
  it("R1: a job with a completed re-ingest is refused until the re-ingest is reverted", async () => {
    staleRun = `v7-reingest-${randomUUID()}`;
    await reingest(PLAN_BEFORE(staleRun));
    await assert.rejects(resync(NOW), (error) => codes(error).includes("ALREADY_REINGESTED"));
    await revertReingest(staleRun);
  });

  it("R1: a snapshotted job is refused, by the revert's own snapshot check", async () => {
    await assert.rejects(resync([plannedRow({ id: "3001", scope: "1", label: "Natural gas", qty: 150, unit: "kWh", reported: 0.03 })], undefined, resyncContext(), JOB_S),
      (error) => codes(error).includes("SNAPSHOT_EXISTS"));
    assert.equal((await migrated(JOB_S))[0]!.superseded_by_row_id, null);
  });

  it("R5: a v7 record current on another job is refused — one job's rows only", async () => {
    const other = plannedRow({ id: "2001", scope: "1", label: "Natural gas", qty: 150, unit: "kWh", reported: 0.03 });
    await assert.rejects(resync([...NOW, other]), (error) => codes(error).includes("ROW_OF_ANOTHER_JOB"));
    assert.deepEqual((await migrated(JOB_B)).map((row) => [row.id, row.superseded_by_row_id]), [["v7-row-2001", null]]);
  });

  it("an unchanged job has nothing to re-sync", async () => {
    await assert.rejects(resync(BEFORE), (error) => codes(error).includes("NOTHING_TO_RESYNC"));
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.v7_resync_runs WHERE organisation_id=$1`, [RS_ORG])).rows[0]!.n, 0, "no run recorded");
  });

  let resyncRun = "";
  let beforeRecords = new Map<string, string>();
  let beforeWhole = new Map<string, string>();
  it("R3: the changed row is superseded — switched off, pointed at its replacement, its record untouched — the new one added, the deleted one switched off", async () => {
    const rows0 = await migrated();
    beforeRecords = new Map(rows0.map((row) => [row.id, row.record]));
    beforeWhole = new Map(rows0.map((row) => [row.id, row.whole]));
    resyncRun = `v7-resync-${randomUUID()}`;
    const result = await resync(NOW, resyncRun);
    assert.deepEqual([result.unchanged, result.superseded, result.added, result.withdrawn],
      [1, [{ rowId: "v7-row-1001", replacedBy: "v7-row-1001-r1" }], ["v7-row-1004"], ["v7-row-1003"]]);
    const rows = new Map((await migrated()).map((row) => [row.id, row]));
    assert.deepEqual([rows.get("v7-row-1001")!.enabled, rows.get("v7-row-1001")!.superseded_by_row_id], [false, "v7-row-1001-r1"]);
    assert.deepEqual([rows.get("v7-row-1003")!.enabled, rows.get("v7-row-1003")!.superseded_by_row_id], [false, null], "gone from v7: off, no replacement");
    for (const [id, text] of beforeRecords) assert.equal(rows.get(id)!.record, text, `${id}: v7's record is never edited`);
    assert.deepEqual((await current()).map((row) => [row.id, row.enabled]),
      [["v7-row-1001-r1", true], ["v7-row-1002", true], ["v7-row-1003", false], ["v7-row-1004", true]]);
    assert.equal(JSON.parse(rows.get("v7-row-1001-r1")!.record).qty, 1200, "the current row is v7's amended record");
    const run = (await db.query(`SELECT status, rows_unchanged, rows_superseded, rows_added, rows_withdrawn, extract_sha256 FROM nzi_console.v7_resync_runs WHERE run_id=$1`, [resyncRun])).rows[0]!;
    assert.deepEqual(run, { status: "completed", rows_unchanged: 1, rows_superseded: 1, rows_added: 1, rows_withdrawn: 1, extract_sha256: "f".repeat(64) });
  });

  it("R2: the run is audited by the system principal with ids, booleans and counts — no figures", async () => {
    const events = (await db.query<{ actor_id: string; principal_type: string; action: string; before_json: unknown; after_json: unknown }>(
      `SELECT actor_id, principal_type, action, before_json, after_json FROM nzi_console.audit_events WHERE organisation_id=$1 AND correlation_id=$2`, [RS_ORG, resyncRun])).rows;
    assert.deepEqual(events.map((event) => event.action).sort(),
      ["v7.resync.job", "v7_row_resync_added", "v7_row_resync_added", "v7_row_resync_superseded", "v7_row_resync_withdrawn"]);
    for (const event of events) assert.deepEqual([event.actor_id, event.principal_type], [V7_RESYNC_ACTOR, "system"]);
    const text = JSON.stringify(events.map((event) => [event.before_json, event.after_json]));
    for (const figure of ["1200", "1000", "0.24", "0.2", "500", "0.1", "2.19", "0.0015"]) assert.ok(!text.includes(figure), `no figure (${figure}) in the audit`);
  });

  it("R1: one completed re-sync per job — a second is refused until the first is reverted", async () => {
    await assert.rejects(resync([...NOW.slice(0, 2), plannedRow({ ...GAS_SITE_2, qty: 600, reported: 0.12 })]), (error) => codes(error).includes("ALREADY_RESYNCED"));
  });

  it("0133 stays absolute: a superseded row's record cannot change, it cannot be deleted, and it cannot be switched back on alone", async () => {
    const write = (sql: string) => withTenantWrite(database.pool, RS_ORG, (client) => client.query(sql, ["v7-row-1001"]));
    await assert.rejects(write(`UPDATE nzi_console.job_scope_rows SET migrated_record = migrated_record || '{"qty":1}'::jsonb WHERE scope_row_id=$1`), /only whether it is enabled may change/);
    await assert.rejects(write(`DELETE FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`), /cannot be deleted/);
    await assert.rejects(write(`UPDATE nzi_console.job_scope_rows SET enabled = true WHERE scope_row_id=$1`), /job_scope_rows_superseded_shape/);
    await assert.rejects(write(`UPDATE nzi_console.job_scope_rows SET superseded_by_row_id = NULL WHERE scope_row_id=$1`), /job_scope_rows_import_identity_key/,
      "one current row per v7 record");
    await assert.rejects(write(`UPDATE nzi_console.job_scope_rows SET superseded_by_row_id = 'no-such-row' WHERE scope_row_id=$1`), /job_scope_rows_superseded_by_fk/,
      "a superseded row points at a real replacement");
  });

  it("reader — re-ingest: a plan built before the re-sync is refused, by name", async () => {
    await assert.rejects(reingest(PLAN_BEFORE(`v7-reingest-${randomUUID()}`)), (error) => codes(error).includes("PLAN_SUPERSEDED_ROW"));
  });

  it("reader — readiness: the job's v7 rows are its current ones", async () => {
    const readiness = await withTenantRead(database.pool, RS_ORG, (client) => getScopeQaReadiness(client, JOB_A));
    assert.equal(readiness.migratedRows, 4, "4 current v7 rows, not the 5 stored");
  });

  let currentRun = "";
  it("R4: a plan from the current rows reconciles through the re-ingest's own D7, and commits", async () => {
    currentRun = `v7-reingest-${randomUUID()}`;
    const outcome = await reingest(PLAN_NOW(currentRun));
    assert.equal(outcome.data.nativeTotalTco2e, outcome.data.v7TotalTco2e);
    assert.deepEqual(outcome.data.scopeTotals, { "1": { v7: 0.34, native: 0.34 }, "3": { v7: 0.0015, native: 0.0015 } }, "Σ live = Σ v7 per scope, at v7's current figures");
    assert.equal(outcome.data.v7RowsSwitchedOff, 3);
  });

  it("reader — revert runner: the job's v7 rows are its current ones", async () => {
    const report = await runV7ReingestRevert(database.pool, { organisationId: RS_ORG, jobId: JOB_A, runId: currentRun, reason: "dry run (test)", commit: false });
    assert.deepEqual([report.before.v7Rows, report.before.v7On, report.after.v7Rows, report.after.v7On], [4, 0, 4, 3]);
  });

  describe("against a record that names a superseded row (the J000663 kind of damage)", () => {
    // The stale run's live gas row, switched back on, and an audit event putting the superseded v7 row on the current run's record.
    before(async () => {
      await db.query(`UPDATE nzi_console.job_scope_rows SET enabled = true WHERE organisation_id=$1 AND job_id=$2 AND origin='live' AND reingested_from_row_id='v7-row-1001'`, [RS_ORG, JOB_A]);
      await db.query(`INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,after_json)
                      VALUES ($1,'forged-1',$2,'system','v7_row_superseded','scope_row','v7-row-1001','forged',$3::jsonb)`,
        [RS_ORG, V7_REINGEST_ACTOR, JSON.stringify({ enabled: false, runId: currentRun })]);
    });
    after(async () => {
      await db.query(`DELETE FROM nzi_console.audit_events WHERE organisation_id=$1 AND audit_event_id='forged-1'`, [RS_ORG]);
      await db.query(`UPDATE nzi_console.job_scope_rows SET enabled = false WHERE organisation_id=$1 AND job_id=$2 AND origin='live' AND reingested_from_row_id='v7-row-1001'`, [RS_ORG, JOB_A]);
    });

    it("reader — attest: a superseded row's live rows never enter the attestation", async () => {
      const plan = await withTenantRead(database.pool, RS_ORG, (client) => planReingestAttestation(client, { organisationId: RS_ORG, actorId: "reviewer-1", principal: "staff" }, JOB_A));
      const linked = (await db.query<{ id: string; from: string }>(
        `SELECT scope_row_id AS id, reingested_from_row_id AS from FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' AND enabled`, [JOB_A])).rows;
      const stale = linked.filter((row) => row.from === "v7-row-1001").map((row) => row.id);
      assert.equal(stale.length, 1, "the forged state is in place");
      const inAct = [...plan.attest.map((row) => row.rowId), ...plan.blocked.map((row) => row.rowId), ...plan.excludedRejected.map((row) => row.rowId)];
      assert.equal(inAct.length, 3, "the current run's three rows");
      assert.ok(!inAct.includes(stale[0]!), "and not the superseded row's");
    });

    it("reader — revert: a superseded row on a run's record refuses the revert, by name", async () => {
      await assert.rejects(revertReingest(currentRun), (error) => codes(error).includes("REVERT_SUPERSEDED_ROW"));
      assert.equal(await runStatusOf(currentRun), "completed");
    });
  });
  const runStatusOf = async (runId: string) => (await db.query(`SELECT status FROM nzi_console.v7_reingest_runs WHERE run_id=$1`, [runId])).rows[0]!.status;

  it("R3: the re-sync's revert is refused while a re-ingest stands on the re-synced rows", async () => {
    await assert.rejects(revertResync(resyncRun), (error) => codes(error).includes("ALREADY_REINGESTED"));
    await revertReingest(currentRun);
    assert.equal(await runStatusOf(currentRun), "reverted");
  });

  it("R3: the revert flips it back — the job's original rows byte for byte, each replacement superseded by the row it replaced", async () => {
    const result = await revertResync(resyncRun);
    assert.deepEqual([result.restored, result.switchedOff, result.reenabled], [["v7-row-1001"], ["v7-row-1001-r1", "v7-row-1004"], ["v7-row-1003"]]);
    const rows = new Map((await migrated()).map((row) => [row.id, row]));
    for (const [id, whole] of beforeWhole) assert.equal(rows.get(id)!.whole, whole, `${id}: byte for byte, but for version and updated_at`);
    assert.deepEqual([rows.get("v7-row-1001-r1")!.enabled, rows.get("v7-row-1001-r1")!.superseded_by_row_id], [false, "v7-row-1001"]);
    assert.deepEqual([rows.get("v7-row-1004")!.enabled, rows.get("v7-row-1004")!.superseded_by_row_id], [false, null], "the added row is switched off");
    assert.equal(await resyncRunStatus(resyncRun), "reverted");
    const outcome = await reingest(PLAN_BEFORE(`v7-reingest-${randomUUID()}`));
    assert.equal(outcome.data.v7TotalTco2e, 2.3915, "and the job re-ingests on its old figures again");
    await assert.rejects(revertResync(resyncRun), (error) => codes(error).includes("NOT_COMPLETED"));
  });

  it("a reverted re-sync can be run again: each v7 record's next generation, one current row each", async () => {
    const standing = (await db.query<{ run_id: string }>(`SELECT run_id FROM nzi_console.v7_reingest_runs WHERE job_id=$1 AND status='completed'`, [JOB_A])).rows[0]!.run_id;
    await revertReingest(standing);
    const result = await resync(NOW);
    assert.deepEqual([result.superseded, result.added, result.withdrawn],
      [[{ rowId: "v7-row-1001", replacedBy: "v7-row-1001-r2" }, { rowId: "v7-row-1004", replacedBy: "v7-row-1004-r1" }], [], ["v7-row-1003"]]);
    assert.deepEqual((await current()).map((row) => [row.id, row.enabled]),
      [["v7-row-1001-r2", true], ["v7-row-1002", true], ["v7-row-1003", false], ["v7-row-1004-r1", true]]);
  });
});
