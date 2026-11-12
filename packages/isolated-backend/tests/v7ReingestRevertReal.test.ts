import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, V7_IMPORT_SUMMARY_ROW_KEYS, V7_REINGEST_ACTOR, type CommandContext, type V7ImportSummary, type V7ReingestJobInput } from "@nzi/contracts";
import { AuthorizationError } from "../src/auth";
import { CommandValidationError } from "../src/postgresCommands";
import { withTenantRead, withTenantWrite } from "../src/postgres";
import { getScopeQaReadiness } from "../src/readModels";
import { planReingestAttestation } from "../src/reingestAttest";
import type { PlannedRow } from "../src/v7ClientImport";
import { insert, migratedRowCols } from "../src/v7ClientLoad";
import { reingestV7JobInTransaction, revertV7ReingestInTransaction } from "../src/v7Reingest";
import { runV7ReingestRevert } from "../src/v7ReingestRevertRun";
import { resyncV7JobInTransaction, revertV7ResyncInTransaction, V7_RESYNC_ACTOR, type V7ResyncContext } from "../src/v7Resync";
import { rehearseV7Resync } from "../src/v7ResyncRehearsal";
import { listV7ImportSessions, readV7ImportView, summariseV7JobForImport, uploadV7ImportSummary, V7_IMPORT_ACTOR } from "../src/v7ImportSummary";
import { clearV7ImportDecision, listV7ImportFactorOptions, listV7ImportWorkbench, readV7ImportWorkbench, setV7ImportDecision } from "../src/v7ImportDecision";
import { ingestV7ImportJob, readV7ImportIngestState, recordV7ImportRehearsal, rehearseV7ImportIngest, summariseV7JobAsTheChainSees, v7ImportDecisionsSha256 } from "../src/v7ImportIngest";
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

/**
 * The rehearsal (src/v7ResyncRehearsal.ts): revert the standing re-ingest → re-sync → re-plan → re-ingest, in one transaction that
 * is always rolled back. It must report what the routine would do and write nothing — proved here against a fingerprint of every
 * table in the console's schema, taken before and after.
 */
describe("the v7 re-sync rehearsal runs the whole routine in one transaction, and writes nothing", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const RH_ORG = "v7-rehearse";
  let database: DisposableDatabase;
  let db: pg.Client;
  const withoutRun = ({ runId: _runId, ...rest }: V7ReingestJobInput) => rest;
  const rehearse = (rows: readonly PlannedRow[], plan: Omit<V7ReingestJobInput, "runId">) => rehearseV7Resync(database.pool, {
    organisationId: RH_ORG, jobId: JOB_A, reason: "rehearsal (test)", resyncRunId: `v7-resync-${randomUUID()}`, extractSha256: "e".repeat(64),
    rows, plan, reingestRunId: `v7-reingest-${randomUUID()}` });
  /** Every table of the console's schema, row for row: equal before and after means nothing was written. */
  const fingerprint = async () => {
    const tables = (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'nzi_console' ORDER BY tablename`)).rows.map((row) => row.t);
    const prints: Record<string, string> = {};
    for (const table of tables) prints[table] = (await db.query<{ p: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS p FROM nzi_console.${table} t`)).rows[0]!.p;
    return prints;
  };
  let standing = "";

  before(async () => {
    database = (await createDisposableDatabase("v7rehearse"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [RH_ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [RH_ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [RH_ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Rehearsal Test','active')`, [RH_ORG]);
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
      VALUES ($1,$2,'c1',901,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7','901','J000901')`, [RH_ORG, JOB_A]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [RH_ORG, JOB_A]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [RH_ORG]);
    for (const [id, label, unit, kg, scope] of [["gas", "Natural gas", "kWh", 0.2, "1"], ["water", "Water supply", "m3", 0.15, "3"]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6])`,
        [RH_ORG, id, label, unit, kg, scope]);
    }
    for (const row of BEFORE) await insert(db, "job_scope_rows", [
      { column: "organisation_id", value: RH_ORG, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
      { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(JOB_A, row)]);
    // The job as J000669 stands: re-ingested on its old v7 figures, a completed run in the way of the re-sync.
    standing = `v7-reingest-${randomUUID()}`;
    await withTenantWrite(database.pool, RH_ORG, (client) => reingestV7JobInTransaction(client, { ...PLAN_BEFORE(standing) },
      { organisationId: RH_ORG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: standing, correlationId: standing,
        reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", RH_ORG, V7_REINGEST_ACTOR) }));
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("reports every step — revert, re-sync, re-plan — and the re-ingest's own refusal of a row the crosswalk does not cover", async () => {
    const before = await fingerprint();
    const report = await rehearse(NOW, withoutRun(PLAN_BEFORE("x")));
    assert.deepEqual(report.revert, { runId: standing, liveRowsSwitchedOff: 3, v7RowsSwitchedOn: 3 });
    assert.deepEqual(report.resync, { unchanged: 1, superseded: [{ rowId: "v7-row-1001", replacedBy: "v7-row-1001-r1" }], added: ["v7-row-1004"], withdrawn: ["v7-row-1003"] });
    assert.deepEqual(report.v7ScopeTotals, { "1": { rows: 2, v7: 0.34 }, "3": { rows: 1, v7: 0.0015 } }, "Σ v7 over the current rows");
    assert.deepEqual([report.replan!.carried, report.replan!.unchanged, report.replan!.dropped, report.replan!.needsCrosswalk],
      [[{ from: "v7-row-1001", to: "v7-row-1001-r1" }], 1, ["v7-row-1003"], [{ rowId: "v7-row-1004", why: "new in v7: crosswalk v1 has no row for it" }]]);
    assert.equal(report.reingest, null);
    assert.equal(report.refusal?.stage, "reingest");
    assert.ok(report.refusal!.issues.some((issue) => issue.code === "PLAN_INCOMPLETE"), JSON.stringify(report.refusal));
    assert.equal(report.rolledBack, true);
    assert.deepEqual(await fingerprint(), before, "nothing written — not the revert, not the re-sync, not the re-ingest");
  });

  it("carries a superseded row onto its replacement at v7's current figures, and reconciles Σ live = Σ v7 per scope through the re-ingest's D7", async () => {
    const before = await fingerprint();
    // The crosswalk covers every current record: the re-plan moves the amended gas row to its replacement and its new figures.
    const plan = withoutRun(planFor("x", [["v7-row-1001", GAS], ["v7-row-1002", WATER], ["v7-row-1004", GAS_SITE_2]]));
    const report = await rehearse(NOW, plan);
    assert.equal(report.refusal, null, JSON.stringify(report.refusal));
    const carried = report.replan!.rows.find((row) => row.v7RowId === "v7-row-1001-r1")!;
    assert.deepEqual([carried.v7Tco2e, carried.quantity, carried.categoryCode, carried.factorId], [0.24, 1200, "1.natural-gas", "gas"], "v7's current figures, the crosswalk's mapping");
    assert.deepEqual(report.reingest!.scopeTotals, { "1": { v7: 0.34, native: 0.34 }, "3": { v7: 0.0015, native: 0.0015 } });
    assert.equal(report.reingest!.v7TotalTco2e, report.reingest!.nativeTotalTco2e);
    assert.deepEqual(await fingerprint(), before, "a re-ingest that would commit is still rolled back");
    assert.equal((await db.query(`SELECT status FROM nzi_console.v7_reingest_runs WHERE run_id=$1`, [standing])).rows[0]!.status, "completed", "the standing run stands");
  });

  it("never guesses: a row whose factor v7 changed needs the crosswalk, and the re-ingest refuses", async () => {
    const before = await fingerprint();
    const moved = plannedRow(GAS_NOW);
    const now = [{ ...moved, migratedRecord: { ...(moved.migratedRecord as unknown as Record<string, unknown>), original_id: "7_other" } as unknown as PlannedRow["migratedRecord"] }, ...NOW.slice(1)];
    const report = await rehearse(now, withoutRun(planFor("x", [["v7-row-1001", GAS], ["v7-row-1002", WATER], ["v7-row-1004", GAS_SITE_2]])));
    assert.deepEqual(report.replan!.needsCrosswalk, [{ rowId: "v7-row-1001-r1", why: "v7 changed its original_id (was v7-row-1001)" }]);
    assert.equal(report.replan!.carried.length, 0);
    assert.equal(report.refusal?.stage, "reingest");
    assert.deepEqual(await fingerprint(), before);
  });

  it("stops at the first step that refuses, and still writes nothing — the revert it ran included", async () => {
    const before = await fingerprint();
    const report = await rehearse(BEFORE, withoutRun(PLAN_BEFORE("x")));
    assert.deepEqual([report.revert?.runId, report.refusal?.stage, report.refusal?.issues.map((issue) => issue.code)], [standing, "resync", ["NOTHING_TO_RESYNC"]]);
    assert.deepEqual([report.replan, report.reingest], [null, null]);
    assert.deepEqual(await fingerprint(), before);
  });
});

/**
 * The import workbench, Phase 1 (BRIEF-v7-import-workbench-phase1; 0226, matrix v14): the reconciliation summary of one job,
 * made read-only from v7's records now against the console's current rows, uploaded under import.manage and read back for the
 * import view. Diff-at-the-edge: the summary carries ids, codes, statuses and tCO2e — no label, name, quantity or activity row.
 */
describe("the import workbench's reconciliation summary: made read-only, carries no PII, uploaded under import.manage, read for the view", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const IM_ORG = "v7-import", OTHER_ORG = "v7-import-other", JOB_P = "v7-job-p";
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (role: "admin" | "consultant" = "admin", actorId = V7_IMPORT_ACTOR, organisationId = IM_ORG): CommandContext => {
    keys += 1;
    return { organisationId, actorId, principal: actorId === V7_IMPORT_ACTOR ? "system" : "staff", idempotencyKey: `im-${keys}`, correlationId: `im-corr-${keys}`,
      grant: commandGrantForRole(role, organisationId, actorId) };
  };
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const summarise = (rows: readonly PlannedRow[], jobId = JOB_A, legacyJobNumber = "J000901") => withTenantRead(database.pool, IM_ORG, (client) =>
    summariseV7JobForImport(client, { organisationId: IM_ORG, jobId, legacyJobNumber, extractSha256: "c".repeat(64), rows, generatedAt: "2026-11-12T09:00:00.000Z" }));
  const upload = (summary: unknown, jobId = JOB_A, ctx = context()) => uploadV7ImportSummary(database.pool, { jobId, summary: summary as V7ImportSummary }, ctx);
  const fingerprint = async () => {
    const tables = (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'nzi_console' ORDER BY tablename`)).rows.map((row) => row.t);
    const prints: Record<string, string> = {};
    for (const table of tables) prints[table] = (await db.query<{ p: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS p FROM nzi_console.${table} t`)).rows[0]!.p;
    return prints;
  };
  /** A paired pair (an auto-generated pair, 0036): 5001 names 5002 as its partner. */
  const PAIR_A: PlannedRow = { ...plannedRow({ id: "5001", scope: "1", label: "Company car (fuel)", qty: 100, unit: "litres", reported: 0.25 }), linkedRowId: "v7-row-5002", isAutoGenerated: true };
  const PAIR_B: PlannedRow = plannedRow({ id: "5002", scope: "3", label: "Company car (WTT)", qty: 100, unit: "litres", reported: 0.06 });
  const byId = (summary: V7ImportSummary) => new Map(summary.rows.map((row) => [row.legacyDbId, row]));

  before(async () => {
    database = (await createDisposableDatabase("v7import"))!;
    db = await database.admin();
    for (const org of [IM_ORG, OTHER_ORG]) {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [org]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
    }
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [IM_ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Import Test','active')`, [IM_ORG]);
    for (const [jobId, sequence] of [[JOB_A, 901], [JOB_B, 902], [JOB_P, 905]] as const) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
        VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7',$4,$5)`, [IM_ORG, jobId, sequence, String(sequence), `J000${sequence}`]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [IM_ORG, jobId]);
    }
    const load = async (jobId: string, row: PlannedRow) => insert(db, "job_scope_rows", [
      { column: "organisation_id", value: IM_ORG, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
      { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(jobId, row)]);
    for (const row of BEFORE) await load(JOB_A, row);
    await load(JOB_B, plannedRow({ id: "2001", scope: "1", label: "Natural gas", qty: 100, unit: "kWh", reported: 0.02 }));
    await load(JOB_P, PAIR_B);
    await load(JOB_P, PAIR_A);
  });
  after(async () => { await db?.end(); await database?.end(); });

  let summary: V7ImportSummary;
  it("the emitter classifies each row as the re-sync would — matched, changed, new, withdrawn — and writes nothing", async () => {
    const before = await fingerprint();
    summary = await summarise(NOW);
    const rows = byId(summary);
    assert.deepEqual([...rows.entries()].map(([id, row]) => [id, row.status]),
      [["1001", "changed"], ["1002", "matched"], ["1004", "new"], ["1003", "withdrawn"]]);
    assert.deepEqual([rows.get("1001")!.consoleFigure, rows.get("1001")!.v7Figure, rows.get("1001")!.consoleRowId], [0.2, 0.24, "v7-row-1001"]);
    assert.ok(rows.get("1001")!.changedFields.includes("migrated_record") && !rows.get("1001")!.changedFields.some((field) => field.startsWith("migrated_record.")),
      "the figures moved, nothing the crosswalk keyed on");
    assert.deepEqual([rows.get("1004")!.consoleRowId, rows.get("1003")!.v7Figure, rows.get("1003")!.code], [null, null, null]);
    assert.deepEqual(summary.counts, { matched: 1, changed: 1, needsMapping: 0, new: 1, withdrawn: 1, linkedPairChanged: 0 });
    assert.deepEqual(summary.scopeTotals, {
      "1": { consoleRows: 2, consoleTco2e: 2.39, v7Rows: 2, v7Tco2e: 0.34 }, "2": { consoleRows: 0, consoleTco2e: 0, v7Rows: 0, v7Tco2e: 0 }, "3": { consoleRows: 1, consoleTco2e: 0.0015, v7Rows: 1, v7Tco2e: 0.0015 } });
    assert.equal(summary.verdict, "needs-mapping", "a new row needs a mapping");
    assert.deepEqual(await fingerprint(), before, "the emitter writes nothing");
  });

  it("a row whose factor v7 changed needs the mapping, not a carry", async () => {
    const moved = plannedRow(WATER);
    const water = { ...moved, migratedRecord: { ...(moved.migratedRecord as unknown as Record<string, unknown>), original_id: "7_other" } as unknown as PlannedRow["migratedRecord"] };
    const row = byId(await summarise([plannedRow(GAS), water, plannedRow(REFRIGERANT)])).get("1002")!;
    assert.equal(row.status, "needs-mapping");
    assert.ok(row.changedFields.includes("migrated_record.original_id"), JSON.stringify(row.changedFields));
    assert.equal(row.code, "7_other", "the factor code v7 names now");
  });

  it("a changed row of a linked pair blocks on the pair — the same row the re-sync refuses by name", async () => {
    const changedPair = [{ ...PAIR_A, quantity: 120, calculatedTco2e: 0.3,
      migratedRecord: { ...(PAIR_A.migratedRecord as unknown as Record<string, unknown>), qty: 120, reported_tco2e: 0.3 } as unknown as PlannedRow["migratedRecord"] }, PAIR_B];
    const pairSummary = await summarise(changedPair, JOB_P, "J000905");
    assert.deepEqual(pairSummary.rows.map((row) => [row.legacyDbId, row.status, row.pairRef]), [["5001", "linked-pair-changed", "v7-row-5002"], ["5002", "matched", "v7-row-5001"]]);
    assert.equal(pairSummary.verdict, "blocked-on-pairs");
    await assert.rejects(withTenantWrite(database.pool, IM_ORG, (client) => resyncV7JobInTransaction(client,
      { jobId: JOB_P, runId: `v7-resync-${randomUUID()}`, extractSha256: "c".repeat(64), rows: changedPair },
      { organisationId: IM_ORG, actorId: V7_RESYNC_ACTOR, principal: "system", reason: "consistency (test)" })),
    (error) => codes(error).includes("V7_LINKED_ROW_CHANGED") && JSON.stringify((error as CommandValidationError).issues).includes("v7-row-5001"));
  });

  it("carries no PII: every row is the closed key set, and no label, unit or quantity appears anywhere in it", () => {
    for (const row of summary.rows) assert.deepEqual(Object.keys(row).sort(), [...V7_IMPORT_SUMMARY_ROW_KEYS].sort());
    const text = JSON.stringify(summary);
    for (const leaked of ["Natural gas", "Water Supply", "Refrigerant", "kWh", "cubic metres", "1200", "Import Test"]) assert.ok(!text.includes(leaked), `no ${leaked} in the summary`);
    // The fixture's category levels are the label "v7": none reaches a row (the per-scope totals' own key is `v7`, a field name).
    assert.ok(!JSON.stringify(summary.rows).includes("\"v7\""), "no category level in the rows");
  });

  it("the store has no column for PII: v7_import_rows holds ids, codes, statuses, booleans and tCO2e only", async () => {
    const columns = (await db.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema='nzi_console' AND table_name='v7_import_rows' ORDER BY column_name`)).rows.map((row) => row.c);
    assert.deepEqual(columns, ["changed_fields", "code", "console_enabled", "console_row_id", "console_scope", "console_tco2e", "legacy_db_id", "ordinal", "organisation_id",
      "pair_group", "pair_quantity_consistent", "pair_ref", "scope", "session_id", "source_system", "status", "v7_enabled", "v7_tco2e"], "0228 adds an id and a boolean (summary /2)");
  });

  it("the upload refuses a summary carrying anything beyond the closed shape — a label on a row — naming the key, never its value", async () => {
    const leaky = { ...summary, rows: summary.rows.map((row, at) => (at === 0 ? { ...row, sourceLabel: "Natural gas" } : row)) };
    await assert.rejects(upload(leaky), (error) => codes(error).includes("UNKNOWN_FIELD") && !JSON.stringify((error as CommandValidationError).issues).includes("Natural gas"));
    await assert.rejects(upload({ ...summary, clientName: "Import Test" }), (error) => codes(error).includes("UNKNOWN_FIELD"));
  });

  it("the upload validates one job and the sha: another job's summary, a bad sha and totals that do not follow from the rows are refused", async () => {
    await assert.rejects(upload(summary, JOB_B), (error) => codes(error).includes("JOB_MISMATCH"), "the summary names JOB_A");
    await assert.rejects(upload({ ...summary, jobId: JOB_B }, JOB_B), (error) => codes(error).includes("JOB_MISMATCH"), "J000901's summary is not J000902's");
    await assert.rejects(upload({ ...summary, extractSha256: "not-a-sha" }), (error) => codes(error).includes("BAD_EXTRACT_SHA256"));
    await assert.rejects(upload({ ...summary, counts: { ...summary.counts, matched: 4 } }), (error) => codes(error).includes("TOTALS_DISAGREE"));
    await assert.rejects(upload({ ...summary, verdict: "clean" }), (error) => codes(error).includes("TOTALS_DISAGREE"));
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.v7_import_sessions`)).rows[0]!.n, 0, "nothing stored");
  });

  it("access: a caller without import.manage is refused — a consultant — and nothing is stored", async () => {
    await assert.rejects(upload(summary, JOB_A, context("consultant", "staff-consultant")), (error) => error instanceof AuthorizationError && error.permission === "import.manage");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.v7_import_sessions`)).rows[0]!.n, 0);
  });

  let sessionId = "";
  it("stores the summary under import.manage, as the system principal, audited by the job with counts only — and changes nothing on the job", async () => {
    const rowsBefore = (await db.query(`SELECT md5(string_agg(r::text, '|' ORDER BY scope_row_id)) AS p FROM nzi_console.job_scope_rows r`)).rows[0]!.p;
    const outcome = await upload(summary);
    sessionId = outcome.data.sessionId;
    assert.deepEqual([outcome.data.rows, outcome.data.verdict, outcome.data.counts], [4, "needs-mapping", summary.counts]);
    assert.equal((await db.query(`SELECT md5(string_agg(r::text, '|' ORDER BY scope_row_id)) AS p FROM nzi_console.job_scope_rows r`)).rows[0]!.p, rowsBefore, "no job row touched");
    const audit = (await db.query<{ action: string; actor_id: string; entity_id: string; after_json: unknown }>(
      `SELECT action, actor_id, entity_id, after_json FROM nzi_console.audit_events WHERE organisation_id=$1 AND action='import.summary.uploaded'`, [IM_ORG])).rows;
    assert.deepEqual(audit.map((event) => [event.action, event.actor_id, event.entity_id]), [["import.summary.uploaded", V7_IMPORT_ACTOR, JOB_A]]);
    for (const figure of ["0.24", "2.39", "0.0015"]) assert.ok(!JSON.stringify(audit[0]!.after_json).includes(figure), `no figure (${figure}) in the audit`);
    await assert.rejects(upload(summary), (error) => codes(error).includes("ALREADY_UPLOADED"), "the same summary is stored once");
  });

  it("an admin may upload too (system-or-admin)", async () => {
    const outcome = await upload({ ...summary, generatedAt: "2026-11-12T10:00:00.000Z" }, JOB_A, context("admin", "staff-admin"));
    assert.equal(outcome.data.verdict, "needs-mapping");
  });

  it("the read model gives the view each status, the per-scope Σ and the verdict — the latest summary, with the earlier one counted", async () => {
    const view = (await withTenantRead(database.pool, IM_ORG, (client) => readV7ImportView(client, JOB_A)))!;
    assert.deepEqual(view.rows, summary.rows, "the rows come back exactly as uploaded, in order");
    assert.deepEqual([view.session.scopeTotals, view.session.verdict, view.session.counts, view.session.jobNumber, view.earlierSessions],
      [summary.scopeTotals, "needs-mapping", summary.counts, "J000901", 1]);
    const listed = await withTenantRead(database.pool, IM_ORG, (client) => listV7ImportSessions(client));
    assert.deepEqual(listed.map((entry) => [entry.jobId, entry.generatedAt]), [[JOB_A, "2026-11-12T10:00:00.000Z"]], "one line per job: its latest");
    assert.equal(await withTenantRead(database.pool, IM_ORG, (client) => readV7ImportView(client, JOB_B)), null, "a job with no summary has none");
    assert.deepEqual(await withTenantRead(database.pool, OTHER_ORG, (client) => listV7ImportSessions(client)), [], "another organisation sees none");
    assert.ok(sessionId);
  });

  it("disposable but never silently editable: the app can neither update nor delete a summary", async () => {
    const write = (sql: string) => withTenantWrite(database.pool, IM_ORG, (client) => client.query(sql, [sessionId]));
    await assert.rejects(write(`UPDATE nzi_console.v7_import_rows SET status = 'matched' WHERE session_id = $1`), /permission denied/);
    await assert.rejects(write(`DELETE FROM nzi_console.v7_import_rows WHERE session_id = $1`), /permission denied/);
    await assert.rejects(write(`UPDATE nzi_console.v7_import_sessions SET verdict = 'clean' WHERE session_id = $1`), /permission denied/);
    await assert.rejects(write(`DELETE FROM nzi_console.v7_import_sessions WHERE session_id = $1`), /permission denied/);
  });
});

/**
 * The import workbench, Phase 2 (BRIEF-v7-import-workbench-phase2; 0228): a person resolves each row a summary flagged — maps a
 * new row to a category and factor, confirms a withdrawn row goes off — and the decision is kept against the job, keyed on the
 * row's import identity, so it survives a fresh summary. A mapping is validated when saved. Nothing is written to a job's rows,
 * and the audit carries ids and the kind, never a figure.
 */
describe("the import workbench's decisions: keyed on the import identity, validated at save, superseded never deleted, writing nothing to a job's rows", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const DX_ORG = "v7-decide", OTHER_ORG = "v7-decide-other", JOB_P = "v7-job-p";
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (role: "admin" | "consultant" = "admin", actorId = "staff-admin", organisationId = DX_ORG): CommandContext => {
    keys += 1;
    return { organisationId, actorId, principal: actorId === V7_IMPORT_ACTOR ? "system" : "staff", idempotencyKey: `dx-${keys}`, correlationId: `dx-corr-${keys}`,
      grant: commandGrantForRole(role, organisationId, actorId) };
  };
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const summarise = (rows: readonly PlannedRow[], generatedAt: string, jobId = JOB_A, legacyJobNumber = "J000901") => withTenantRead(database.pool, DX_ORG, (client) =>
    summariseV7JobForImport(client, { organisationId: DX_ORG, jobId, legacyJobNumber, extractSha256: "d".repeat(64), rows, generatedAt }));
  const upload = async (rows: readonly PlannedRow[], generatedAt: string, jobId = JOB_A, legacyJobNumber = "J000901") =>
    uploadV7ImportSummary(database.pool, { jobId, summary: await summarise(rows, generatedAt, jobId, legacyJobNumber) }, context("admin", V7_IMPORT_ACTOR));
  const identity = (legacyDbId: string, jobId = JOB_A) => ({ jobId, sourceSystem: "nzi-pro-v7" as const, legacyDbId });
  const map = (legacyDbId: string, categoryCode: string, factorId: string, extra: Record<string, unknown> = {}, ctx = context()) =>
    setV7ImportDecision(database.pool, { ...identity(legacyDbId), kind: "map", categoryCode, datasetId: "ds-1", factorId, ...extra }, ctx);
  const withdraw = (legacyDbId: string, extra: Record<string, unknown> = {}, ctx = context()) =>
    setV7ImportDecision(database.pool, { ...identity(legacyDbId), kind: "withdraw", ...extra }, ctx);
  const workbench = (org = DX_ORG, jobId = JOB_A) => withTenantRead(database.pool, org, (client) => readV7ImportWorkbench(client, org, jobId));
  const resolutionOf = async (legacyDbId: string) => (await workbench())!.resolutions.find((entry) => entry.legacyDbId === legacyDbId)!;
  const decisionRows = () => db.query<{ legacy_db_id: string; kind: string; factor_id: string | null; superseded: boolean; supersedes: string | null; decision_id: string }>(
    `SELECT legacy_db_id, kind, factor_id, superseded_at IS NOT NULL AS superseded, supersedes_decision_id AS supersedes, decision_id FROM nzi_console.v7_import_decisions
      WHERE organisation_id = $1 AND job_id = $2 ORDER BY decided_at, decision_id`, [DX_ORG, JOB_A]).then((result) => result.rows);
  const jobRows = async () => (await db.query<{ p: string }>(`SELECT md5(coalesce(string_agg(r::text, '|' ORDER BY scope_row_id), '')) AS p FROM nzi_console.job_scope_rows r`)).rows[0]!.p;
  const PAIR_A: PlannedRow = { ...plannedRow({ id: "5001", scope: "1", label: "Company car (fuel)", qty: 100, unit: "litres", reported: 0.25 }), linkedRowId: "v7-row-5002", isAutoGenerated: true };
  const PAIR_B: PlannedRow = plannedRow({ id: "5002", scope: "3", label: "Company car (WTT)", qty: 100, unit: "litres", reported: 0.06 });

  before(async () => {
    database = (await createDisposableDatabase("v7decide"))!;
    db = await database.admin();
    for (const org of [DX_ORG, OTHER_ORG]) {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [org]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
    }
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [DX_ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Decision Test','active')`, [DX_ORG]);
    for (const [jobId, sequence] of [[JOB_A, 901], [JOB_P, 905]] as const) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
        VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7',$4,$5)`, [DX_ORG, jobId, sequence, String(sequence), `J000${sequence}`]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [DX_ORG, jobId]);
    }
    const load = async (jobId: string, row: PlannedRow) => insert(db, "job_scope_rows", [
      { column: "organisation_id", value: DX_ORG, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
      { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(jobId, row)]);
    for (const row of BEFORE) await load(JOB_A, row);
    await load(JOB_P, PAIR_B);
    await load(JOB_P, PAIR_A);
    // The library: two natural-gas factors (members of 1.natural-gas by the DESNZ family map, 0210), an LPG factor (Other Stationary
    // Fuels), a Scope 3 water factor, and a retired natural-gas factor.
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
      VALUES ($1,'ds-1','Synthetic GB','2025.1','2025-01-01','2026-12-31','GB','active','Synthetic','OGL')`, [DX_ORG]);
    for (const [factorId, label, unit, scope, levels, active] of [
      ["f-gas", "Natural gas — gross CV", "kWh", "1", ["Fuels", "Gaseous fuels", "Natural gas"], true],
      ["f-gas-net", "Natural gas — net CV", "kWh", "1", ["Fuels", "Gaseous fuels", "Natural gas"], true],
      ["f-lpg", "LPG", "litres", "1", ["Fuels", "Gaseous fuels", "LPG"], true],
      ["f-water", "Water supply", "cubic metres", "3", ["Water supply", "Water supply", null], true],
      ["f-gas-old", "Natural gas — withdrawn edition", "kWh", "1", ["Fuels", "Gaseous fuels", "Natural gas"], false],
    ] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels,active)
        VALUES ($1,'ds-1',$2,$3,$4,0.2,ARRAY[$5::text],$6::text[],$7)`, [DX_ORG, factorId, label, unit, scope, levels, active]);
    }
    // v7 now (as Phase 1's block): 1001 changed, 1002 matched, 1004 new, 1003 withdrawn.
    await upload(NOW, "2026-11-12T09:00:00.000Z");
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("the picker offers a category's own factors, by the rules the save applies — and a family-less category its whole scope, with the notice", async () => {
    const gas = (await withTenantRead(database.pool, DX_ORG, (client) => listV7ImportFactorOptions(client, DX_ORG, "1.natural-gas")))!;
    assert.deepEqual([gas.options.map((option) => option.factorId).sort(), gas.notice], [["f-gas", "f-gas-net"], null], "no LPG, no retired edition");
    const wide = (await withTenantRead(database.pool, DX_ORG, (client) => listV7ImportFactorOptions(client, DX_ORG, "3.10")))!;
    assert.ok(wide.options.some((option) => option.factorId === "f-water") && wide.notice !== null);
    assert.equal(await withTenantRead(database.pool, DX_ORG, (client) => listV7ImportFactorOptions(client, DX_ORG, "9.nope")), null);
  });

  it("an invalid mapping is refused at save — category of another scope, a factor of another scope, outside the category, retired or unknown — and nothing is stored", async () => {
    const refused = async (work: Promise<unknown>, code: string) => assert.rejects(work, (error) => codes(error).includes(code), code);
    await refused(map("1004", "3.6", "f-water"), "CATEGORY_SCOPE");
    await refused(map("1004", "1.nope", "f-gas"), "CATEGORY_UNKNOWN");
    await refused(map("1004", "1.natural-gas", "f-water"), "FACTOR_NOT_IN_SCOPE");
    await refused(map("1004", "1.natural-gas", "f-lpg"), "FACTOR_NOT_IN_CATEGORY");
    await refused(map("1004", "1.natural-gas", "f-gas-old"), "FACTOR_NOT_ACTIVE");
    await refused(map("1004", "1.natural-gas", "f-missing"), "FACTOR_NOT_ACTIVE");
    // The kind must fit the row: a new row is mapped, a withdrawn row confirmed, a matched or changed row needs nothing.
    await refused(withdraw("1004"), "KIND_DOES_NOT_FIT");
    await refused(map("1003", "1.natural-gas", "f-gas"), "KIND_DOES_NOT_FIT");
    await refused(map("1002", "3.6", "f-water"), "NOTHING_TO_RESOLVE");
    await refused(map("1001", "1.natural-gas", "f-gas"), "NOTHING_TO_RESOLVE");
    await refused(map("9999", "1.natural-gas", "f-gas"), "NOT_IN_SUMMARY");
    await refused(withdraw("1003", { categoryCode: "1.natural-gas" }), "NO_PAYLOAD");
    // Closed, as the summary is: a label on a decision is refused, naming the key and never its value.
    await assert.rejects(map("1004", "1.natural-gas", "f-gas", { sourceLabel: "Natural gas (site 2)" }),
      (error) => codes(error).includes("UNKNOWN_FIELD") && !JSON.stringify((error as CommandValidationError).issues).includes("site 2"));
    assert.deepEqual(await decisionRows(), [], "nothing stored");
  });

  /** The pair moved: parent 5001's quantity went from 100 to 120 in the previous system; its T&D row 5002 did not follow. */
  const movedParent = (qty: number): PlannedRow => ({ ...PAIR_A, quantity: qty, calculatedTco2e: 0.3,
    migratedRecord: { ...(PAIR_A.migratedRecord as unknown as Record<string, unknown>), qty, reported_tco2e: 0.3 } as unknown as PlannedRow["migratedRecord"] });
  const carryP = (legacyDbId: string, extra: Record<string, unknown> = {}, ctx = context()) =>
    setV7ImportDecision(database.pool, { ...identity(legacyDbId, JOB_P), kind: "carry", carryOption: "A", ...extra }, ctx);
  let carried = "";
  it("summary /2 groups a pair by its T&D row, and checks the T&D quantity against its parents in the extract — an id and a boolean", async () => {
    const summary = await summarise([movedParent(120), PAIR_B], "2026-11-12T09:00:00.000Z", JOB_P, "J000905");
    assert.deepEqual(summary.rows.map((row) => [row.legacyDbId, row.status, row.pairGroup, row.pairQuantityConsistent]),
      [["5001", "linked-pair-changed", "v7-row-5002", false], ["5002", "matched", "v7-row-5002", false]], "120 litres against a T&D row of 100");
    const level = await summarise([movedParent(100), PAIR_B], "2026-11-12T09:00:00.000Z", JOB_P, "J000905").catch(() => null);
    assert.equal(level?.rows.every((row) => row.pairQuantityConsistent === true), true, "the extract's own pair, level");
    await upload([movedParent(120), PAIR_B], "2026-11-12T09:00:00.000Z", JOB_P, "J000905");
    const stored = (await db.query(`SELECT legacy_db_id, pair_group, pair_quantity_consistent FROM nzi_console.v7_import_rows r JOIN nzi_console.v7_import_sessions s USING (organisation_id, session_id)
      WHERE s.job_id = $1 ORDER BY ordinal`, [JOB_P])).rows;
    assert.deepEqual(stored, [{ legacy_db_id: "5001", pair_group: "v7-row-5002", pair_quantity_consistent: false }, { legacy_db_id: "5002", pair_group: "v7-row-5002", pair_quantity_consistent: false }]);
    assert.equal((await db.query(`SELECT summary_format FROM nzi_console.v7_import_sessions WHERE job_id = $1`, [JOB_P])).rows[0]!.summary_format, "nzi.import-summary/2");
    const view = (await workbench(DX_ORG, JOB_P))!;
    assert.deepEqual([view.resolvedVerdict, view.groups], ["blocked-on-pairs", [{ pairGroup: "v7-row-5002", members: ["5001", "5002"], quantityConsistent: false, moved: true, carried: false }]]);
  });

  it("a pair member resolves under its own status: 5001 moved only in its figures, so it needs no mapping — its pair needs carrying", async () => {
    await assert.rejects(setV7ImportDecision(database.pool, { ...identity("5001", JOB_P), kind: "map", categoryCode: "1.natural-gas", datasetId: "ds-1", factorId: "f-gas" }, context()),
      (error) => codes(error).includes("NOTHING_TO_RESOLVE"));
    await assert.rejects(carryP("5001", { carryOption: "C" }), (error) => codes(error).includes("INVALID"), "C is deferred: A only");
    await assert.rejects(carryP("5001", { categoryCode: "1.natural-gas" }), (error) => codes(error).includes("NO_PAYLOAD"));
    await assert.rejects(setV7ImportDecision(database.pool, { ...identity("1004"), kind: "carry", carryOption: "A" }, context()), (error) => codes(error).includes("NOT_A_PAIR"));
  });

  it("the carry (A) is written for every member of the group at once — the unchanged T&D row included — and the group carries; nothing touches a job's rows", async () => {
    const rowsBefore = await jobRows();
    const outcome = await carryP("5001", { expectedDecisionId: null });
    carried = outcome.data.decisionId!;
    assert.deepEqual([outcome.data.kind, outcome.data.carryOption, outcome.data.pairGroup, outcome.data.members], ["carry", "A", "v7-row-5002", ["5001", "5002"]]);
    const written = (await db.query(`SELECT legacy_db_id, carry_option, for_pair_group, for_status FROM nzi_console.v7_import_decisions WHERE job_id = $1 AND superseded_at IS NULL ORDER BY legacy_db_id`, [JOB_P])).rows;
    assert.deepEqual(written, [{ legacy_db_id: "5001", carry_option: "A", for_pair_group: "v7-row-5002", for_status: "linked-pair-changed" },
      { legacy_db_id: "5002", carry_option: "A", for_pair_group: "v7-row-5002", for_status: "matched" }]);
    assert.equal(await jobRows(), rowsBefore, "no job row touched");
    const view = (await workbench(DX_ORG, JOB_P))!;
    assert.deepEqual([view.resolvedVerdict, view.groups[0]!.carried], ["ready-to-ingest", true]);
    await assert.rejects(carryP("5002"), (error) => codes(error).includes("UNCHANGED"), "any member names the group; it already carries");
    const audit = (await db.query<{ after_json: unknown }>(`SELECT after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'import.decision.set' AND entity_id = $2`, [DX_ORG, JOB_P])).rows;
    assert.equal(audit.length, 1);
    assert.ok(!/:\s*-?\d/.test(JSON.stringify(audit[0]!.after_json).replace(/v7-decision-[0-9a-f-]{36}/g, "")), "no figure in the audit");
  });

  it("the carry survives a fresh summary of the same pair; a clear takes it off every member, and the job is blocked on the pair again", async () => {
    await upload([movedParent(120), PAIR_B], "2026-11-12T10:00:00.000Z", JOB_P, "J000905");
    assert.equal((await workbench(DX_ORG, JOB_P))!.resolvedVerdict, "ready-to-ingest");
    const t2 = (await db.query<{ decision_id: string }>(`SELECT decision_id FROM nzi_console.v7_import_decisions WHERE job_id = $1 AND legacy_db_id = '5002' AND superseded_at IS NULL`, [JOB_P])).rows[0]!.decision_id;
    const cleared = await clearV7ImportDecision(database.pool, { ...identity("5002", JOB_P), expectedDecisionId: t2 }, context());
    assert.deepEqual(cleared.data.members.sort(), ["5001", "5002"]);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.v7_import_decisions WHERE job_id = $1 AND superseded_at IS NULL`, [JOB_P])).rows[0]!.n, 0);
    assert.equal((await workbench(DX_ORG, JOB_P))!.resolvedVerdict, "blocked-on-pairs", "hold is always open: nothing recorded, the job stays blocked");
    assert.ok(carried);
  });

  it("access: a caller without import.manage is refused — a consultant — and nothing is stored", async () => {
    await assert.rejects(map("1004", "1.natural-gas", "f-gas", {}, context("consultant", "staff-consultant")), (error) => error instanceof AuthorizationError && error.permission === "import.manage");
    await assert.rejects(clearV7ImportDecision(database.pool, { ...identity("1004"), expectedDecisionId: `v7-decision-${randomUUID()}` }, context("consultant", "staff-consultant")),
      (error) => error instanceof AuthorizationError && error.permission === "import.manage");
    assert.deepEqual(await decisionRows(), []);
  });

  let mapped = "", confirmed = "";
  it("saves a mapping keyed on the import identity, audited by the job with ids and the kind — no figure — and writes nothing to the job's rows", async () => {
    const rowsBefore = await jobRows();
    const outcome = await map("1004", "1.natural-gas", "f-gas", { expectedDecisionId: null });
    mapped = outcome.data.decisionId!;
    assert.deepEqual([outcome.data.legacyDbId, outcome.data.kind, outcome.data.categoryCode, outcome.data.factorId, outcome.data.superseded], ["1004", "map", "1.natural-gas", "f-gas", []]);
    const stored = (await db.query(`SELECT job_id, source_system, legacy_db_id, kind, category_code, dataset_id, factor_id, for_status, for_scope, for_code, decided_by
      FROM nzi_console.v7_import_decisions WHERE decision_id = $1`, [mapped])).rows[0];
    assert.deepEqual(stored, { job_id: JOB_A, source_system: "nzi-pro-v7", legacy_db_id: "1004", kind: "map", category_code: "1.natural-gas", dataset_id: "ds-1", factor_id: "f-gas",
      for_status: "new", for_scope: "1", for_code: "7_1004", decided_by: "staff-admin" });
    assert.equal(await jobRows(), rowsBefore, "no job row touched");
    const audit = (await db.query<{ action: string; entity_type: string; entity_id: string; after_json: unknown }>(
      `SELECT action, entity_type, entity_id, after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'import.decision.set' AND entity_id = $2`, [DX_ORG, JOB_A])).rows;
    assert.deepEqual(audit.map((event) => [event.entity_type, event.entity_id]), [["job", JOB_A]]);
    const text = JSON.stringify(audit[0]!.after_json);
    assert.ok(text.includes("f-gas") && text.includes("1004"), "ids and codes");
    // Probed with the random ids taken out (a uuid can hold "500"), and no value in it is a number at all.
    const idless = text.replace(/v7-decision-[0-9a-f-]{36}/g, "");
    for (const figure of ["0.1", "500", "0.24", "1200"]) assert.ok(!idless.includes(figure), `no figure (${figure}) in the audit`);
    assert.ok(!/:\s*-?\d/.test(idless), "no numeric value in the audit");
    assert.equal((await resolutionOf("1004")).resolution, "resolved");
  });

  it("the verdict recomputes to ready-to-ingest only once every row that differs is resolved and valid", async () => {
    assert.equal((await workbench())!.resolvedVerdict, "needs-confirmation", "the withdrawn row is still to confirm");
    const rowsBefore = await jobRows();
    confirmed = (await withdraw("1003")).data.decisionId!;
    assert.equal(await jobRows(), rowsBefore, "a confirmed withdrawal switches nothing off now — that is ingest's");
    const view = (await workbench())!;
    assert.equal(view.resolvedVerdict, "ready-to-ingest");
    assert.deepEqual(view.resolutions.map((entry) => [entry.legacyDbId, entry.resolution]),
      [["1001", "auto-accepted"], ["1002", "matched"], ["1004", "resolved"], ["1003", "resolved"]]);
    const listed = await withTenantRead(database.pool, DX_ORG, (client) => listV7ImportWorkbench(client, DX_ORG));
    assert.deepEqual(listed.find((entry) => entry.jobId === JOB_A) && [listed.find((entry) => entry.jobId === JOB_A)!.resolvedVerdict, listed.find((entry) => entry.jobId === JOB_A)!.resolved,
      listed.find((entry) => entry.jobId === JOB_A)!.toResolve], ["ready-to-ingest", 2, 2]);
    // A mapping that stops validating (its factor retired) no longer resolves its row, on the next read.
    await db.query(`UPDATE nzi_console.emission_factors SET active = false WHERE organisation_id = $1 AND factor_id = 'f-gas'`, [DX_ORG]);
    try {
      const lapsed = (await workbench())!;
      assert.equal(lapsed.resolvedVerdict, "needs-mapping");
      const entry = lapsed.resolutions.find((row) => row.legacyDbId === "1004")!;
      assert.deepEqual([entry.resolution, Boolean(entry.invalid)], ["stale", true]);
    } finally {
      await db.query(`UPDATE nzi_console.emission_factors SET active = true WHERE organisation_id = $1 AND factor_id = 'f-gas'`, [DX_ORG]);
    }
  });

  it("a decision is re-made by superseding the one it replaces — kept, linked, never edited; a stale screen and an unchanged decision are refused", async () => {
    await assert.rejects(map("1004", "1.natural-gas", "f-gas"), (error) => codes(error).includes("UNCHANGED"));
    await assert.rejects(map("1004", "1.natural-gas", "f-gas-net", { expectedDecisionId: `v7-decision-${randomUUID()}` }), (error) => codes(error).includes("DECISION_MOVED"));
    const remade = await map("1004", "1.natural-gas", "f-gas-net", { expectedDecisionId: mapped });
    assert.deepEqual(remade.data.superseded, [mapped]);
    const trail = (await decisionRows()).filter((row) => row.legacy_db_id === "1004");
    assert.deepEqual(trail.map((row) => [row.factor_id, row.superseded, row.supersedes]), [["f-gas", true, null], ["f-gas-net", false, mapped]]);
    mapped = remade.data.decisionId!;
    assert.equal((await resolutionOf("1004")).decision?.factorId, "f-gas-net");
  });

  it("survives a re-uploaded summary — keyed on the identity, not the session — and stands down when the row has moved since", async () => {
    await upload(NOW, "2026-11-12T11:00:00.000Z");
    const fresh = (await workbench())!;
    assert.equal(fresh.earlierSessions, 1);
    assert.equal(fresh.resolvedVerdict, "ready-to-ingest", "the decisions apply to the fresh summary");
    assert.notEqual(fresh.resolutions.find((entry) => entry.legacyDbId === "1004")!.decision!.sessionId, fresh.session.sessionId, "decided against the earlier summary");
    // The previous system moves 1004's factor: the mapping was made for the row as it stood, so it no longer resolves it.
    const moved = plannedRow(GAS_SITE_2);
    const recoded = { ...moved, migratedRecord: { ...(moved.migratedRecord as unknown as Record<string, unknown>), original_id: "7_other" } as unknown as PlannedRow["migratedRecord"] };
    await upload([plannedRow(GAS_NOW), plannedRow(WATER), recoded], "2026-11-12T12:00:00.000Z");
    assert.deepEqual([(await resolutionOf("1004")).resolution, (await workbench())!.resolvedVerdict], ["stale", "needs-mapping"]);
    // And back: the row stands as decided again, so the decision applies again.
    await upload(NOW, "2026-11-12T13:00:00.000Z");
    assert.equal((await workbench())!.resolvedVerdict, "ready-to-ingest");
  });

  it("a clear returns the row to unresolved, superseding its decision and keeping it", async () => {
    await assert.rejects(clearV7ImportDecision(database.pool, { ...identity("1003"), expectedDecisionId: mapped }, context()), (error) => codes(error).includes("DECISION_MOVED"));
    const cleared = await clearV7ImportDecision(database.pool, { ...identity("1003"), expectedDecisionId: confirmed }, context());
    assert.deepEqual([cleared.data.superseded, cleared.data.decisionId], [[confirmed], null]);
    assert.deepEqual([(await resolutionOf("1003")).resolution, (await workbench())!.resolvedVerdict], ["unresolved", "needs-confirmation"]);
    assert.deepEqual((await decisionRows()).filter((row) => row.legacy_db_id === "1003").map((row) => [row.kind, row.superseded]), [["withdraw", true]], "kept, superseded");
    await assert.rejects(clearV7ImportDecision(database.pool, { ...identity("1003"), expectedDecisionId: confirmed }, context()), (error) => codes(error).includes("NO_DECISION"));
    const audit = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'import.decision.cleared' AND entity_id = $2`, [DX_ORG, JOB_A])).rows[0]!.n;
    assert.equal(audit, 1);
  });

  it("another organisation sees no decisions", async () => {
    assert.equal((await withTenantRead(database.pool, OTHER_ORG, (client) => client.query(`SELECT count(*)::int AS n FROM nzi_console.v7_import_decisions`))).rows[0]!.n, 0);
    assert.deepEqual(await withTenantRead(database.pool, OTHER_ORG, (client) => listV7ImportWorkbench(client, OTHER_ORG)), []);
    assert.equal(await workbench(OTHER_ORG), null);
  });

  it("the store holds no PII and keeps its trail: no label column; the app cannot delete, truncate, edit a decision or supersede one twice", async () => {
    const columns = (await db.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema='nzi_console' AND table_name='v7_import_decisions' ORDER BY column_name`)).rows.map((row) => row.c);
    assert.deepEqual(columns, ["carry_option", "category_code", "correlation_id", "dataset_id", "decided_at", "decided_by", "decision_id", "factor_id", "for_code", "for_pair_group", "for_scope", "for_status", "job_id",
      "kind", "legacy_db_id", "organisation_id", "reason", "session_id", "source_system", "superseded_at", "superseded_by", "supersedes_decision_id"]);
    const write = (sql: string, id = mapped) => withTenantWrite(database.pool, DX_ORG, (client) => client.query(sql, [id]));
    await assert.rejects(write(`DELETE FROM nzi_console.v7_import_decisions WHERE decision_id = $1`), /permission denied/);
    await assert.rejects(withTenantWrite(database.pool, DX_ORG, (client) => client.query(`TRUNCATE nzi_console.v7_import_decisions`)), /permission denied/);
    await assert.rejects(write(`UPDATE nzi_console.v7_import_decisions SET factor_id = 'f-lpg' WHERE decision_id = $1`), /permission denied/);
    await assert.rejects(write(`UPDATE nzi_console.v7_import_decisions SET superseded_at = now(), superseded_by = 'x' WHERE decision_id = $1`, confirmed), /already superseded/);
  });
});

/**
 * The import workbench, Phase 3 (BRIEF-v7-import-workbench-phase3; 0229): ingest one job from its resolved decisions. The plan is
 * the committed plan re-planned onto v7's current records and completed from each `map`; a `withdraw` is the re-sync switching
 * the row off; a `carry` lets its pair through the re-sync. Revert → re-sync → re-plan → re-ingest, D7 the hard floor — rehearsed
 * first in one rolled-back transaction, then kept. Refused unless the job is ready to ingest.
 */
describe("the import workbench's ingest: decisions drive revert → re-sync → re-plan → re-ingest, D7 the floor, refused unless ready", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const IG_ORG = "v7-ingest", JOB_P = "v7-job-p";
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (role: "admin" | "consultant" = "admin", actorId = V7_IMPORT_ACTOR, reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: IG_ORG, actorId, principal: actorId.startsWith("policy:") ? "system" : "staff", idempotencyKey: `ig-${keys}`, correlationId: `ig-corr-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole(role, IG_ORG, actorId) };
  };
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const withoutRun = ({ runId: _runId, ...rest }: V7ReingestJobInput) => rest;
  const run = (over: Partial<Parameters<typeof rehearseV7ImportIngest>[1]> = {}) => ({ organisationId: IG_ORG, jobId: JOB_A, legacyJobNumber: "J000901",
    reason: "ingest J000901 from its decisions (test)", extractSha256: "e".repeat(64), rows: NOW, basePlan: withoutRun(PLAN_BEFORE("x")), ...over });
  const identity = (legacyDbId: string) => ({ jobId: JOB_A, sourceSystem: "nzi-pro-v7" as const, legacyDbId });
  const decide = (input: Record<string, unknown>) => setV7ImportDecision(database.pool, { ...identity(String(input.legacyDbId)), ...input } as never, context("admin", "staff-admin"));
  const decisionsSha = async () => v7ImportDecisionsSha256((await withTenantRead(database.pool, IG_ORG, (client) =>
    client.query<{ decision_id: string }>(`SELECT decision_id FROM nzi_console.v7_import_decisions WHERE job_id = $1 AND superseded_at IS NULL`, [JOB_A]))).rows.map((row) => ({ decisionId: row.decision_id }) as never));
  const fingerprint = async () => {
    const tables = (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'nzi_console' ORDER BY tablename`)).rows.map((row) => row.t);
    const prints: Record<string, string> = {};
    for (const table of tables) prints[table] = (await db.query<{ p: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS p FROM nzi_console.${table} t`)).rows[0]!.p;
    return prints;
  };
  let sessionId = "", standing = "";

  before(async () => {
    database = (await createDisposableDatabase("v7ingest"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [IG_ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [IG_ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [IG_ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Ingest Test','active')`, [IG_ORG]);
    for (const [jobId, sequence] of [[JOB_A, 901], [JOB_P, 905]] as const) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
        VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7',$4,$5)`, [IG_ORG, jobId, sequence, String(sequence), `J000${sequence}`]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [IG_ORG, jobId]);
    }
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [IG_ORG]);
    // gas and lpg are members of their categories by the DESNZ family map (0210); lpg is priced per litre.
    for (const [id, label, unit, kg, scope, levels] of [["gas", "Natural gas", "kWh", 0.2, "1", ["Fuels", "Gaseous fuels", "Natural gas"]], ["water", "Water supply", "m3", 0.15, "3", []],
      ["lpg", "LPG", "litres", 0.2, "1", ["Fuels", "Gaseous fuels", "LPG"]]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6::text],$7::text[])`,
        [IG_ORG, id, label, unit, kg, scope, levels]);
    }
    for (const row of BEFORE) await insert(db, "job_scope_rows", [
      { column: "organisation_id", value: IG_ORG, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
      { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(JOB_A, row)]);
    // The job as J000669 stands: re-ingested on its old figures, a completed run the chain must revert first.
    standing = `v7-reingest-${randomUUID()}`;
    await withTenantWrite(database.pool, IG_ORG, (client) => reingestV7JobInTransaction(client, { ...PLAN_BEFORE(standing) },
      { organisationId: IG_ORG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: standing, correlationId: standing,
        reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", IG_ORG, V7_REINGEST_ACTOR) }));
    // v7 now: 1001 changed (figures only), 1002 matched, 1004 new, 1003 withdrawn — summarised and uploaded.
    // Summarised as the chain sees it: the standing run reverted under a savepoint, rolled back.
    const before = await fingerprint();
    const summary = await withTenantWrite(database.pool, IG_ORG, (client) => summariseV7JobAsTheChainSees(client,
      { organisationId: IG_ORG, jobId: JOB_A, legacyJobNumber: "J000901", extractSha256: "e".repeat(64), rows: NOW, generatedAt: "2026-11-12T09:00:00.000Z" }));
    assert.deepEqual(await fingerprint(), before, "summarising as the chain sees it keeps nothing");
    assert.deepEqual(summary.rows.map((row) => [row.legacyDbId, row.status]), [["1001", "changed"], ["1002", "matched"], ["1004", "new"], ["1003", "withdrawn"]],
      "the re-ingest's switch-off is not read as v7 moving");
    const plain = await withTenantRead(database.pool, IG_ORG, (client) => summariseV7JobForImport(client,
      { organisationId: IG_ORG, jobId: JOB_A, legacyJobNumber: "J000901", extractSha256: "e".repeat(64), rows: NOW, generatedAt: "2026-11-12T09:00:00.000Z" }));
    assert.ok(!plain.rows.some((row) => row.status === "withdrawn"), "a plain comparison of a re-ingested job misses the withdrawal: why the chain's view is used");
    sessionId = (await uploadV7ImportSummary(database.pool, { jobId: JOB_A, summary }, context())).data.sessionId;
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("refused unless ready to ingest: with rows unresolved the rehearsal stops before anything runs, and the ingest is refused — nothing written", async () => {
    const before = await fingerprint();
    const { report, record } = await rehearseV7ImportIngest(database.pool, run());
    assert.deepEqual([report.refusal?.stage, report.refusal?.issues.map((issue) => issue.code), report.revert, record], ["ready", ["NOT_READY_TO_INGEST"], null, null]);
    await assert.rejects(ingestV7ImportJob(database.pool, { jobId: JOB_A, sessionId, extractSha256: "e".repeat(64), decisionsSha256: await decisionsSha() }, run(),
      context("admin", V7_IMPORT_ACTOR, "ingest (test)")), (error) => codes(error).includes("NOT_READY_TO_INGEST"));
    // Another extract than the summary's is refused too: decisions are for what was summarised.
    const other = await rehearseV7ImportIngest(database.pool, run({ extractSha256: "f".repeat(64) }));
    assert.deepEqual(other.report.refusal?.issues.map((issue) => issue.code), ["EXTRACT_NOT_SUMMARISED"]);
    assert.deepEqual(await fingerprint(), before);
  });

  let mapped = "";
  it("D7 is the hard floor: a valid mapping that does not reconcile to v7 is refused at the re-ingest, in the rehearsal and the ingest alike", async () => {
    await decide({ legacyDbId: "1003", kind: "withdraw" });
    // LPG is a legitimate Other Stationary Fuels factor — saved — but it is priced per litre and v7 recorded kWh.
    mapped = (await decide({ legacyDbId: "1004", kind: "map", categoryCode: "1.other-stationary-fuels", datasetId: "v7-vintage-2025", factorId: "lpg" })).data.decisionId!;
    const before = await fingerprint();
    const { report, record } = await rehearseV7ImportIngest(database.pool, run());
    assert.equal(report.refusal?.stage, "reingest", JSON.stringify(report.refusal));
    assert.deepEqual([record?.outcome, record?.refusedStage, record?.scopeTotals], ["refused", "reingest", null]);
    assert.deepEqual(await fingerprint(), before, "the rehearsal writes nothing");
    await assert.rejects(ingestV7ImportJob(database.pool, { jobId: JOB_A, sessionId, extractSha256: "e".repeat(64), decisionsSha256: await decisionsSha() }, run(),
      context("admin", V7_IMPORT_ACTOR, "ingest (test)")), (error) => error instanceof CommandValidationError);
    assert.deepEqual(await fingerprint(), before, "the refused ingest writes nothing");
  });

  let rehearsed: Awaited<ReturnType<typeof rehearseV7ImportIngest>>["record"] = null;
  it("the rehearsal: the committed plan carries what it covers, each map fills what it cannot, and Σ live = Σ v7 per scope — rolled back, then recorded", async () => {
    mapped = (await decide({ legacyDbId: "1004", kind: "map", categoryCode: "1.natural-gas", datasetId: "v7-vintage-2025", factorId: "gas", expectedDecisionId: mapped })).data.decisionId!;
    const before = await fingerprint();
    const { report, record } = await rehearseV7ImportIngest(database.pool, run());
    assert.equal(report.refusal, null, JSON.stringify(report.refusal));
    assert.deepEqual(report.revert?.runId, standing, "the standing re-ingest reverted first");
    assert.deepEqual(report.resync, { unchanged: 1, superseded: [{ rowId: "v7-row-1001", replacedBy: "v7-row-1001-r1" }], added: ["v7-row-1004"], withdrawn: ["v7-row-1003"] });
    assert.deepEqual(record?.counts, { resync: { unchanged: 1, superseded: 1, added: 1, withdrawn: 1 }, plan: { committed: 2, decided: 1 } });
    assert.deepEqual(record?.scopeTotals, { "1": { v7Tco2e: 0.34, liveTco2e: 0.34 }, "2": { v7Tco2e: 0, liveTco2e: 0 }, "3": { v7Tco2e: 0.0015, liveTco2e: 0.0015 } });
    assert.equal(record?.outcome, "would-commit");
    assert.deepEqual(await fingerprint(), before, "the rehearsal writes nothing");
    rehearsed = record;
    // Recorded for the view; a consultant (no import.manage) may not record one.
    await assert.rejects(recordV7ImportRehearsal(database.pool, { jobId: JOB_A, rehearsal: record! }, context("consultant", "staff-consultant")),
      (error) => error instanceof AuthorizationError && error.permission === "import.manage");
    await assert.rejects(recordV7ImportRehearsal(database.pool, { jobId: JOB_A, rehearsal: { ...record!, sourceLabel: "Natural gas (site 2)" } as never }, context()),
      (error) => codes(error).includes("UNKNOWN_FIELD"), "closed, as the summary is");
    const stored = await recordV7ImportRehearsal(database.pool, { jobId: JOB_A, rehearsal: record! }, context());
    const state = await withTenantRead(database.pool, IG_ORG, (client) => readV7ImportIngestState(client, JOB_A, { sessionId, decisionsSha256: record!.decisionsSha256 }));
    assert.deepEqual([state.rehearsal?.ingestId, state.rehearsal?.outcome, state.rehearsal?.current, state.rehearsal?.scopeTotals, state.ingest],
      [stored.data.ingestId, "would-commit", true, record!.scopeTotals, null]);
  });

  it("the ingest refuses a stale run: another summary or decisions than the rehearsal's, and a caller without import.manage", async () => {
    const input = { jobId: JOB_A, sessionId, extractSha256: "e".repeat(64), decisionsSha256: rehearsed!.decisionsSha256 };
    await assert.rejects(ingestV7ImportJob(database.pool, { ...input, decisionsSha256: "0".repeat(64) }, run(), context("admin", V7_IMPORT_ACTOR, "ingest (test)")),
      (error) => codes(error).includes("DECISIONS_MOVED"));
    await assert.rejects(ingestV7ImportJob(database.pool, { ...input, sessionId: `v7-import-${randomUUID()}` }, run(), context("admin", V7_IMPORT_ACTOR, "ingest (test)")),
      (error) => codes(error).includes("SUMMARY_MOVED"));
    await assert.rejects(ingestV7ImportJob(database.pool, input, run(), context("consultant", "staff-consultant", "ingest (test)")),
      (error) => error instanceof AuthorizationError && error.permission === "import.manage");
    await assert.rejects(ingestV7ImportJob(database.pool, input, run(), context()), (error) => codes(error).includes("REASON_REQUIRED") || codes(error).includes("REQUIRED"), "a reason is required");
  });

  it("the ingest commits the chain: the standing run reverted, the job re-synced, re-ingested from the decisions and reconciled — audited without figures", async () => {
    const outcome = await ingestV7ImportJob(database.pool, { jobId: JOB_A, sessionId, extractSha256: "e".repeat(64), decisionsSha256: rehearsed!.decisionsSha256 }, run(),
      context("admin", V7_IMPORT_ACTOR, "ingest J000901 from its decisions (test)"));
    const { reingestRunId, resyncRunId } = outcome.data;
    assert.deepEqual([outcome.data.resync, outcome.data.plan], [{ unchanged: 1, superseded: 1, added: 1, withdrawn: 1 }, { committed: 2, decided: 1 }]);
    const runs = (await db.query(`SELECT run_id, status, crosswalk_version FROM nzi_console.v7_reingest_runs WHERE job_id = $1 ORDER BY created_at`, [JOB_A])).rows;
    assert.deepEqual(runs.map((row) => [row.run_id, row.status]), [[standing, "reverted"], [reingestRunId, "completed"]]);
    assert.equal(runs[1]!.crosswalk_version, "v1+workbench");
    assert.equal((await db.query(`SELECT status FROM nzi_console.v7_resync_runs WHERE run_id = $1`, [resyncRunId])).rows[0]!.status, "completed");
    // A map drives the category and factor; the withdrawn row is off; the live rows reproduce v7 per scope.
    const live = (await db.query<{ from: string; category_code: string; factor_id: string | null; tco2e: string }>(
      `SELECT reingested_from_row_id AS from, category_code, factor_id, calculated_tco2e::text AS tco2e FROM nzi_console.job_scope_rows
        WHERE job_id = $1 AND origin = 'live' AND enabled ORDER BY reingested_from_row_id`, [JOB_A])).rows;
    assert.deepEqual(live.map((row) => [row.from, row.category_code, row.factor_id]),
      [["v7-row-1001-r1", "1.natural-gas", "gas"], ["v7-row-1002", "3.5", "water"], ["v7-row-1004", "1.natural-gas", "gas"]]);
    assert.equal((await db.query(`SELECT enabled FROM nzi_console.job_scope_rows WHERE scope_row_id = 'v7-row-1003'`)).rows[0]!.enabled, false, "withdrawn: off");
    const lineage = (await db.query<{ lineage: string }>(`SELECT lineage_json::text AS lineage FROM nzi_console.job_scope_rows WHERE reingested_from_row_id = 'v7-row-1004' AND enabled`)).rows[0]!.lineage;
    assert.ok(lineage.includes(`workbench:${mapped}`), "the live row's lineage names the decision that placed it");
    const audit = (await db.query<{ after_json: unknown }>(`SELECT after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'import.ingested' AND entity_id = $2`, [IG_ORG, JOB_A])).rows;
    assert.equal(audit.length, 1);
    for (const figure of ["0.34", "0.24", "0.1", "1200", "500"]) assert.ok(!JSON.stringify(audit[0]!.after_json).replace(/v7-[a-z]+-[0-9a-f-]{36}/g, "").includes(figure), `no figure (${figure}) in the audit`);
    const state = await withTenantRead(database.pool, IG_ORG, (client) => readV7ImportIngestState(client, JOB_A, null));
    assert.deepEqual([state.ingest?.reingestRunId, state.ingest?.runStatus, state.ingest?.outcome, state.ingest?.rowsPending, state.ingest?.scopeTotals],
      [reingestRunId, "completed", "committed", 3, rehearsed!.scopeTotals], "ingested, awaiting a reviewer's attest");
  });

  it("the store keeps its record: no update, no delete for the app", async () => {
    const write = (sql: string) => withTenantWrite(database.pool, IG_ORG, (client) => client.query(sql));
    await assert.rejects(write(`UPDATE nzi_console.v7_import_ingests SET outcome = 'refused'`), /permission denied/);
    await assert.rejects(write(`DELETE FROM nzi_console.v7_import_ingests`), /permission denied/);
  });

  it("a carried pair goes through the re-sync (RULING-v7-import-pair-carry, A); an uncarried one is still refused by name", async () => {
    const PAIR_A: PlannedRow = { ...plannedRow({ id: "5001", scope: "1", label: "Grid electricity", qty: 100, unit: "kWh", reported: 0.25 }), linkedRowId: "v7-row-5002", isAutoGenerated: false };
    const PAIR_B: PlannedRow = { ...plannedRow({ id: "5002", scope: "3", label: "T&D losses", qty: 100, unit: "kWh", reported: 0.02 }), isAutoGenerated: true };
    for (const row of [PAIR_B, PAIR_A]) await insert(db, "job_scope_rows", [
      { column: "organisation_id", value: IG_ORG, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
      { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(JOB_P, row)]);
    const moved = [{ ...PAIR_A, quantity: 120, calculatedTco2e: 0.3,
      migratedRecord: { ...(PAIR_A.migratedRecord as unknown as Record<string, unknown>), qty: 120, reported_tco2e: 0.3 } as unknown as PlannedRow["migratedRecord"] }, PAIR_B];
    const resyncP = (carriedPairGroups?: string[]) => withTenantWrite(database.pool, IG_ORG, (client) => resyncV7JobInTransaction(client,
      { jobId: JOB_P, runId: `v7-resync-${randomUUID()}`, extractSha256: "c".repeat(64), rows: moved, ...(carriedPairGroups ? { carriedPairGroups } : {}) },
      { organisationId: IG_ORG, actorId: V7_RESYNC_ACTOR, principal: "system", reason: "carry (test)" }));
    await assert.rejects(resyncP(), (error) => codes(error).includes("V7_LINKED_ROW_CHANGED"));
    await assert.rejects(resyncP(["v7-row-9999"]), (error) => codes(error).includes("V7_LINKED_ROW_CHANGED"), "another group's carry does not carry this one");
    const done = await resyncP(["v7-row-5002"]);
    assert.deepEqual(done.superseded, [{ rowId: "v7-row-5001", replacedBy: "v7-row-5001-r1" }]);
    const replacement = (await db.query(`SELECT linked_row_id FROM nzi_console.job_scope_rows WHERE scope_row_id = 'v7-row-5001-r1'`)).rows[0]!;
    assert.equal(replacement.linked_row_id, "v7-row-5002", "the migrated copy stays the previous system's record, link and all; the live rows carry none");
  });
});