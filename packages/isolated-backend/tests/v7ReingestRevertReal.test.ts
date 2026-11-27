import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  commandGrantForRole, reportLinkFor, SUPERSEDED_PUBLISHED_LABEL, V7_IMPORT_SUMMARY_ROW_KEYS, V7_IMPORT_TWO_DATASET_YEARS_UNREAD, V7_REINGEST_ACTOR,
  type CommandContext, type V7FiguresRowFigures, type V7ImportSummary, type V7ReingestJobInput,
} from "@nzi/contracts";
import { AuthorizationError } from "../src/auth";
import { CommandValidationError, issueReportVersion, validateCrpReport } from "../src/postgresCommands";
import { listReportStatusRegister } from "../src/reportStatusRegister";
import { crpProfessionalManifest } from "@nzi/charts";
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
import { commitV7ImportRefresh, previewV7ImportRefresh, readRefresh, v7ImportRefreshSummarySha256, v7ImportViewSource, type V7ImportRefreshSource } from "../src/v7ImportRefresh";
import { readImportPolicy, setOrganisationImportPolicy } from "../src/organisationSettings";
import { readV7ImportFastPathSignals, refreshV7ImportFastPath, V7_IMPORT_FAST_PATH_REASON } from "../src/v7ImportFastPath";
import { resumeV7ImportBatch, startV7ImportBatch } from "../src/v7ImportBatchCommands";
import { readV7ImportBatch, runV7ImportBatch, V7_IMPORT_BATCH_PACING, v7ImportBatchIdempotencyKey, v7ImportBatchJobOutcome, v7ImportBatchPauseAfter } from "../src/v7ImportBatch";
import { readV7ImportMapping, v7JobIsTotalsOnly } from "../src/v7ImportMapping";
import { acceptV7ImportRows, readV7ImportRows, searchV7ImportFactors } from "../src/v7ImportRows";
import { commandReason, commandReasonHeaders } from "@nzi/api-client";
import { readJobEmissions } from "../src/emissionsAggregation";
import { checkV7Drift, listV7Drift, V7_DRIFT_HISTORY_DEPTH, readConsoleScopeTotals, readV7DriftBanner, refuseDriftedPublish, runV7DriftChecks, type V7FiguresClient, type V7FiguresRead, type V7RowFiguresClient } from "../src/v7Drift";
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
  const context = (role: "admin" | "consultant" | "reviewer" = "admin", actorId = V7_IMPORT_ACTOR, organisationId = IM_ORG): CommandContext => {
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

  it("access: a caller without import.manage is refused — a reviewer (v17: the consultant holds it) — and nothing is stored", async () => {
    await assert.rejects(upload(summary, JOB_A, context("reviewer", "staff-reviewer")), (error) => error instanceof AuthorizationError && error.permission === "import.manage");
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
  const context = (role: "admin" | "consultant" | "reviewer" = "admin", actorId = "staff-admin", organisationId = DX_ORG): CommandContext => {
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

  it("the import rows modal carries a linked pair as one: one item writes the carry for every member — a second member's item is already so — and a caller without import.manage is refused first", async () => {
    // v17: the consultant holds import.manage; a reviewer does not.
    await assert.rejects(acceptV7ImportRows(database.pool, { jobId: JOB_P, items: [{ kind: "carry", legacyDbId: "5001" }] }, context("reviewer", "staff-reviewer")),
      (error) => error instanceof AuthorizationError && error.permission === "import.manage");
    const outcome = await acceptV7ImportRows(database.pool, { jobId: JOB_P, items: [{ kind: "carry", legacyDbId: "5001" }, { kind: "carry", legacyDbId: "5002" }] }, context());
    assert.deepEqual([outcome.written.map((entry) => entry.legacyDbId), outcome.unchanged, outcome.refused], [["5001"], ["5002"], []]);
    const view = (await workbench(DX_ORG, JOB_P))!;
    assert.deepEqual([view.resolvedVerdict, view.groups[0]!.carried], ["ready-to-ingest", true]);
    // Left as the next test finds it: the pair uncarried again.
    const held = (await db.query<{ decision_id: string }>(`SELECT decision_id FROM nzi_console.v7_import_decisions WHERE job_id = $1 AND legacy_db_id = '5001' AND superseded_at IS NULL`, [JOB_P])).rows[0]!.decision_id;
    await clearV7ImportDecision(database.pool, { ...identity("5001", JOB_P), expectedDecisionId: held }, context());
    assert.equal((await workbench(DX_ORG, JOB_P))!.resolvedVerdict, "blocked-on-pairs");
  });

  it("access: a caller without import.manage is refused — a reviewer (v17: the consultant holds it) — and nothing is stored", async () => {
    await assert.rejects(map("1004", "1.natural-gas", "f-gas", {}, context("reviewer", "staff-reviewer")), (error) => error instanceof AuthorizationError && error.permission === "import.manage");
    await assert.rejects(clearV7ImportDecision(database.pool, { ...identity("1004"), expectedDecisionId: `v7-decision-${randomUUID()}` }, context("reviewer", "staff-reviewer")),
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
  const context = (role: "admin" | "consultant" | "reviewer" = "admin", actorId = V7_IMPORT_ACTOR, reason?: string): CommandContext => {
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
    // Recorded for the view; a reviewer (no import.manage — the consultant holds it since v17) may not record one.
    await assert.rejects(recordV7ImportRehearsal(database.pool, { jobId: JOB_A, rehearsal: record! }, context("reviewer", "staff-reviewer")),
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
    await assert.rejects(ingestV7ImportJob(database.pool, input, run(), context("reviewer", "staff-reviewer", "ingest (test)")),
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

/**
 * The import, server-side — Phase B (BRIEF-v7-import-server-side-phase-b): `import.refresh`. The same job, decisions and chain as
 * the ingest above, run as one server command: the rows come from a source (in the service, the view set; here the same planned
 * rows the ingest is given), never from the command's input. A preview is the whole command rolled back; a commit is kept, D7
 * the floor, refused if the summary or decisions moved since the preview. CRM-operable; an organisation may require an Admin to
 * commit. The view-set source itself is exercised in v7ExtractSqlReal.
 */
describe("the import refresh, server-side: one command, a rolled-back preview and a kept commit, D7 the floor", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const RF_ORG = "v7-refresh";
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (role: "admin" | "consultant" | "reviewer" = "consultant", actorId = `staff-${role}`, reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: RF_ORG, actorId, principal: actorId.startsWith("policy:") ? "system" : "staff", idempotencyKey: `rf-${keys}`, correlationId: `rf-corr-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole(role, RF_ORG, actorId) };
  };
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const withoutRun = ({ runId: _runId, ...rest }: V7ReingestJobInput) => rest;
  // The previous system now: what the view set would give for J000901. Mutable, so a test can move it on.
  let current: { sourceSha256: string; rows: readonly PlannedRow[] } = { sourceSha256: "e".repeat(64), rows: NOW };
  const reads: string[] = [];
  const source: V7ImportRefreshSource = async (_db, job) => { reads.push(job.legacyJobNumber); return current; };
  const options = { basePlan: withoutRun(PLAN_BEFORE("x")) };
  const preview = (ctx = context()) => previewV7ImportRefresh(database.pool, source, { jobId: JOB_A, mode: "preview" }, ctx, options);
  const commit = (shas: { summarySha256: string; decisionsSha256: string }, ctx = context("consultant", "staff-consultant", "refresh J000901 from the previous system (test)")) =>
    commitV7ImportRefresh(database.pool, source, { jobId: JOB_A, mode: "commit", ...shas }, ctx, options);
  const decide = (input: Record<string, unknown>) => setV7ImportDecision(database.pool, { jobId: JOB_A, sourceSystem: "nzi-pro-v7", ...input } as never, context("admin", "staff-admin"));
  const fingerprint = async () => {
    const tables = (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'nzi_console' ORDER BY tablename`)).rows.map((row) => row.t);
    const prints: Record<string, string> = {};
    for (const table of tables) prints[table] = (await db.query<{ p: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS p FROM nzi_console.${table} t`)).rows[0]!.p;
    return prints;
  };
  let standing = "";

  before(async () => {
    database = (await createDisposableDatabase("v7refresh"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [RF_ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [RF_ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [RF_ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Refresh Test','active')`, [RF_ORG]);
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
      VALUES ($1,$2,'c1',901,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7','901','J000901')`, [RF_ORG, JOB_A]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [RF_ORG, JOB_A]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [RF_ORG]);
    for (const [id, label, unit, kg, scope, levels] of [["gas", "Natural gas", "kWh", 0.2, "1", ["Fuels", "Gaseous fuels", "Natural gas"]], ["water", "Water supply", "m3", 0.15, "3", []],
      ["lpg", "LPG", "litres", 0.2, "1", ["Fuels", "Gaseous fuels", "LPG"]]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6::text],$7::text[])`,
        [RF_ORG, id, label, unit, kg, scope, levels]);
    }
    for (const row of BEFORE) await insert(db, "job_scope_rows", [
      { column: "organisation_id", value: RF_ORG, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
      { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(JOB_A, row)]);
    standing = `v7-reingest-${randomUUID()}`;
    await withTenantWrite(database.pool, RF_ORG, (client) => reingestV7JobInTransaction(client, { ...PLAN_BEFORE(standing) },
      { organisationId: RF_ORG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: standing, correlationId: standing,
        reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", RF_ORG, V7_REINGEST_ACTOR) }));
    // Decisions are made against a stored summary (Phase 2's resolve); the refresh itself needs none — it reads the rows itself.
    const summary = await withTenantWrite(database.pool, RF_ORG, (client) => summariseV7JobAsTheChainSees(client,
      { organisationId: RF_ORG, jobId: JOB_A, legacyJobNumber: "J000901", extractSha256: "e".repeat(64), rows: NOW, generatedAt: "2026-11-13T09:00:00.000Z" }));
    await uploadV7ImportSummary(database.pool, { jobId: JOB_A, summary }, context("admin", V7_IMPORT_ACTOR));
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("access: import.refresh is the CRM's and Admin's — a Reviewer is refused, in a preview as in a commit, before the source is read", async () => {
    const before = await fingerprint();
    reads.length = 0;
    await assert.rejects(preview(context("reviewer")), (error) => error instanceof AuthorizationError && error.permission === "import.refresh");
    await assert.rejects(commit({ summarySha256: "0".repeat(64), decisionsSha256: "0".repeat(64) }, context("reviewer", "staff-reviewer", "refresh (test)")),
      (error) => error instanceof AuthorizationError && error.permission === "import.refresh");
    assert.deepEqual(reads, [], "nothing was read from the previous system for a caller who may not refresh");
    assert.deepEqual(await fingerprint(), before);
  });

  it("a preview of a job not ready: refused at 'ready' with exactly its exceptions — the chain never runs, and nothing is written, audit included", async () => {
    const before = await fingerprint();
    const seen = await preview();
    assert.deepEqual([seen.outcome, seen.verdict, seen.refusal?.stage, seen.refusal?.issues.map((issue) => issue.code), seen.chain, seen.scopeTotals],
      ["refused", "needs-mapping", "ready", ["NOT_READY_TO_INGEST"], { resync: null, plan: null }, null]);
    assert.deepEqual(seen.exceptions.map((row) => [row.legacyDbId, row.status, row.resolution]), [["1004", "new", "unresolved"], ["1003", "withdrawn", "unresolved"]],
      "only the rows that need a person: the changed row is auto-accepted, the matched one is matched");
    assert.deepEqual(seen.counts, { matched: 1, changed: 1, needsMapping: 0, new: 1, withdrawn: 1, linkedPairChanged: 0 });
    assert.deepEqual(await fingerprint(), before, "a preview writes nothing — no run, no record, no audit, no idempotency row");
  });

  let wrongUnit = "";
  it("D7 the floor: a valid mapping that does not reconcile (LPG per litre against kWh) is refused at the re-ingest — in the preview, and in the commit — nothing written", async () => {
    await decide({ legacyDbId: "1003", kind: "withdraw" });
    wrongUnit = (await decide({ legacyDbId: "1004", kind: "map", categoryCode: "1.other-stationary-fuels", datasetId: "v7-vintage-2025", factorId: "lpg" })).data.decisionId!;
    const before = await fingerprint();
    const seen = await preview();
    assert.deepEqual([seen.outcome, seen.verdict, seen.refusal?.stage, seen.scopeTotals, seen.exceptions], ["refused", "ready-to-ingest", "reingest", null, []], JSON.stringify(seen.refusal));
    assert.ok(seen.chain.resync && seen.chain.plan, "the chain ran as far as the re-ingest");
    assert.deepEqual(await fingerprint(), before, "the preview writes nothing");
    await assert.rejects(commit({ summarySha256: seen.summarySha256, decisionsSha256: seen.decisionsSha256 }), (error) => error instanceof CommandValidationError
      && seen.refusal!.issues.every((issue) => codes(error).includes(issue.code)));
    assert.deepEqual(await fingerprint(), before, "the refused commit writes nothing");
  });

  let shown: Awaited<ReturnType<typeof preview>>;
  it("a reconciling decision set previews 'would commit': the committed plan carries what it covers, each map fills the rest, Σ live = Σ previous system per scope", async () => {
    await decide({ legacyDbId: "1004", kind: "map", categoryCode: "1.natural-gas", datasetId: "v7-vintage-2025", factorId: "gas", expectedDecisionId: wrongUnit });
    const before = await fingerprint();
    shown = await preview(context("consultant"));
    assert.deepEqual([shown.outcome, shown.refusal, shown.exceptions], ["would-commit", null, []]);
    assert.deepEqual(shown.chain, { resync: { unchanged: 1, superseded: 1, added: 1, withdrawn: 1 }, plan: { committed: 2, decided: 1 } });
    assert.deepEqual(shown.scopeTotals, { "1": { v7Tco2e: 0.34, liveTco2e: 0.34 }, "2": { v7Tco2e: 0, liveTco2e: 0 }, "3": { v7Tco2e: 0.0015, liveTco2e: 0.0015 } });
    assert.match(shown.summarySha256, /^[0-9a-f]{64}$/);
    assert.equal(shown.decisionsSha256, v7ImportDecisionsSha256((await withTenantRead(database.pool, RF_ORG, (client) =>
      client.query<{ decision_id: string }>(`SELECT decision_id FROM nzi_console.v7_import_decisions WHERE job_id = $1 AND superseded_at IS NULL`, [JOB_A]))).rows.map((row) => ({ decisionId: row.decision_id }) as never)));
    assert.deepEqual(await fingerprint(), before, "the preview writes nothing");
    assert.deepEqual((await preview()).summarySha256, shown.summarySha256, "the summary's fingerprint is its content, not the moment it was made");
  });

  it("the fingerprint guards: decisions or rows moved since the preview refuse the commit by name; a commit needs a reason; a preview carries no fingerprints — nothing written", async () => {
    const before = await fingerprint();
    const shas = { summarySha256: shown.summarySha256, decisionsSha256: shown.decisionsSha256 };
    await assert.rejects(commit({ ...shas, decisionsSha256: "0".repeat(64) }), (error) => codes(error).includes("DECISIONS_MOVED"));
    const was = current;
    current = { sourceSha256: "f".repeat(64), rows: NOW.map((row) => row.legacyDbId === "1002" ? { ...row,
      migratedRecord: { ...(row.migratedRecord as unknown as Record<string, unknown>), reported_tco2e: 0.002 } as unknown as PlannedRow["migratedRecord"] } : row) };
    try {
      await assert.rejects(commit(shas), (error) => codes(error).includes("SUMMARY_MOVED"), "the previous system moved on since the preview");
    } finally {
      current = was;
    }
    await assert.rejects(commit(shas, context("consultant")), (error) => codes(error).includes("REQUIRED"), "a commit needs a reason");
    await assert.rejects(previewV7ImportRefresh(database.pool, source, { jobId: JOB_A, mode: "preview", ...shas } as never, context(), options), (error) => codes(error).includes("UNKNOWN_FIELD"));
    assert.deepEqual(await fingerprint(), before);
  });

  it("an organisation may require an Admin to commit: then the CRM's commit is refused, the preview is still theirs — and only an Admin sets it", async () => {
    assert.deepEqual(await withTenantRead(database.pool, RF_ORG, (client) => readImportPolicy(client, RF_ORG)), { refreshCommitRequiresAdmin: false, version: 0, updatedBy: null, updatedAt: null }, "off until set");
    await assert.rejects(setOrganisationImportPolicy(database.pool, { refreshCommitRequiresAdmin: true, expectedVersion: 0 }, context("consultant", "staff-consultant", "gate (test)")),
      (error) => error instanceof AuthorizationError && error.permission === "admin.settings");
    await setOrganisationImportPolicy(database.pool, { refreshCommitRequiresAdmin: true, expectedVersion: 0 }, context("admin", "staff-admin", "a second pair of eyes on commits (test)"));
    const before = await fingerprint();
    await assert.rejects(commit({ summarySha256: shown.summarySha256, decisionsSha256: shown.decisionsSha256 }), (error) => error instanceof AuthorizationError && error.permission === "import.refresh");
    assert.equal((await preview(context("consultant"))).outcome, "would-commit");
    assert.deepEqual(await fingerprint(), before);
    const off = await setOrganisationImportPolicy(database.pool, { refreshCommitRequiresAdmin: false, expectedVersion: 1 }, context("admin", "staff-admin", "back to the ruled default (test)"));
    assert.equal(off.data.version, 2);
    const audit = (await db.query<{ before_json: unknown; after_json: { refreshCommitRequiresAdmin: boolean } }>(
      `SELECT before_json, after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'organisation.importPolicy.set' ORDER BY occurred_at`, [RF_ORG])).rows;
    assert.deepEqual(audit.map((row) => [row.before_json, row.after_json.refreshCommitRequiresAdmin]), [[{ refreshCommitRequiresAdmin: false }, true], [{ refreshCommitRequiresAdmin: true }, false]]);
  });

  it("Phase D: a job with decisions is not fast-path — manual edits — even though it would commit; the fast path falls back and writes nothing", async () => {
    const before = await fingerprint();
    const result = await refreshV7ImportFastPath(database.pool, source, JOB_A, context("consultant"), options);
    assert.equal(result.fastPath, "deliberate");
    if (result.fastPath !== "deliberate") return;
    assert.deepEqual([result.because, result.preview.outcome, result.preview.exceptions], [["manual-edits"], "would-commit", []]);
    assert.deepEqual(await fingerprint(), before, "the deliberate fallback is a preview: nothing written");
  });

  it("the CRM commits: the standing run reverted, the job re-synced and re-ingested from its decisions, equal to the previous system per scope — recorded, audited without figures", async () => {
    const outcome = await commit({ summarySha256: shown.summarySha256, decisionsSha256: shown.decisionsSha256 });
    const { reingestRunId, resyncRunId, sessionId, ingestId } = outcome.data;
    assert.deepEqual([outcome.data.mode, outcome.data.resync, outcome.data.plan], ["commit", { unchanged: 1, superseded: 1, added: 1, withdrawn: 1 }, { committed: 2, decided: 1 }]);
    const runs = (await db.query(`SELECT run_id, status, created_by FROM nzi_console.v7_reingest_runs WHERE job_id = $1 ORDER BY created_at`, [JOB_A])).rows;
    assert.deepEqual(runs.map((row) => [row.run_id, row.status]), [[standing, "reverted"], [reingestRunId, "completed"]]);
    assert.equal(runs[1]!.created_by, V7_REINGEST_ACTOR, "the inner re-ingest runs under its own system principal, not the CRM");
    assert.equal((await db.query(`SELECT status FROM nzi_console.v7_resync_runs WHERE run_id = $1`, [resyncRunId])).rows[0]!.status, "completed");
    // Equal to the previous system: the live rows' Σ per scope is the source's Σ over its enabled rows.
    const live = (await db.query<{ scope: string; t: string }>(`SELECT split_part(scope, '.', 1) AS scope, sum(calculated_tco2e)::text AS t FROM nzi_console.job_scope_rows
      WHERE job_id = $1 AND origin = 'live' AND enabled GROUP BY 1 ORDER BY 1`, [JOB_A])).rows.map((row) => [row.scope, Math.round(Number(row.t) * 1e6) / 1e6]);
    const v7 = new Map<string, number>();
    for (const row of NOW) if (row.enabled) v7.set(row.scope.split(".")[0]!, Math.round(((v7.get(row.scope.split(".")[0]!) ?? 0) + Number((row.migratedRecord as unknown as Record<string, unknown>).reported_tco2e)) * 1e6) / 1e6);
    assert.deepEqual(live, [...v7.entries()].sort());
    // Recorded against the summary it ran from, stored as the job's latest; Σ per scope there, as D7 reconciled it.
    const record = (await db.query(`SELECT kind, outcome, session_id, extract_sha256, created_by FROM nzi_console.v7_import_ingests WHERE ingest_id = $1`, [ingestId])).rows[0]!;
    assert.deepEqual(record, { kind: "ingest", outcome: "committed", session_id: sessionId, extract_sha256: "e".repeat(64), created_by: "staff-consultant" });
    const state = await withTenantRead(database.pool, RF_ORG, (client) => readV7ImportIngestState(client, JOB_A, null));
    assert.deepEqual([state.ingest?.ingestId, state.ingest?.runStatus, state.ingest?.scopeTotals], [ingestId, "completed", shown.scopeTotals]);
    assert.equal((await withTenantRead(database.pool, RF_ORG, (client) => readV7ImportView(client, JOB_A)))?.session.sessionId, sessionId, "the import view's latest summary is the one it ran from");
    const audit = (await db.query<{ after_json: unknown; actor_id: string; reason: string }>(
      `SELECT after_json, actor_id, reason FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'import.refreshed' AND entity_id = $2`, [RF_ORG, JOB_A])).rows;
    assert.equal(audit.length, 1, "one audit event: the commit — no preview left one");
    assert.deepEqual([audit[0]!.actor_id, audit[0]!.reason], ["staff-consultant", "refresh J000901 from the previous system (test)"]);
    const text = JSON.stringify(audit[0]!.after_json).replace(/v7-[a-z]+-[0-9a-f-]{36}/g, "");
    for (const figure of ["0.34", "0.24", "0.1", "0.0015", "1200", "500"]) assert.ok(!text.includes(figure), `no figure (${figure}) in the audit`);
    assert.deepEqual(Object.keys(audit[0]!.after_json as object).sort(), ["ingestId", "jobId", "mode", "plan", "reingestRunId", "resync", "resyncRunId", "sessionId"]);
  });

  it("the summary fingerprint ignores when it was made but not what it holds", () => {
    const base = { format: "v7-import-summary/2", jobId: JOB_A, legacyJobNumber: "J000901", extractSha256: "e".repeat(64), generatedAt: "2026-11-13T09:00:00.000Z", rows: [],
      counts: { matched: 0, changed: 0, needsMapping: 0, new: 0, withdrawn: 0, linkedPairChanged: 0 }, scopeTotals: {}, verdict: "clean" } as unknown as V7ImportSummary;
    assert.equal(v7ImportRefreshSummarySha256(base), v7ImportRefreshSummarySha256({ ...base, generatedAt: "2026-11-14T09:00:00.000Z" }));
    assert.notEqual(v7ImportRefreshSummarySha256(base), v7ImportRefreshSummarySha256({ ...base, extractSha256: "f".repeat(64) }));
  });
});

/**
 * Phase D (BRIEF-v7-import-server-side-phase-d; R-4): the fast path. Each organisation holds one J000901 as J000669 stood —
 * migrated, re-ingested by the system — and the previous system now has the gas figures amended (auto-accepted: no decision
 * needed), water and refrigerant unchanged. So it would commit with zero exceptions; each test takes one eligibility away.
 */
describe("the import refresh's fast path: eligible jobs refresh in one action, every other one falls back to the deliberate flow", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (org: string, role: "admin" | "consultant" = "consultant", actorId = `staff-${role}`, reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId, principal: "staff", idempotencyKey: `fp-${keys}`, correlationId: `fp-corr-${keys}`, ...(reason ? { reason } : {}),
      grant: commandGrantForRole(role, org, actorId) };
  };
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const withoutRun = ({ runId: _runId, ...rest }: V7ReingestJobInput) => rest;
  const FP_NOW = [GAS_NOW, WATER, REFRIGERANT].map(plannedRow);
  const source: V7ImportRefreshSource = async () => ({ sourceSha256: "e".repeat(64), rows: FP_NOW });
  const options = { basePlan: withoutRun(PLAN_BEFORE("x")) };
  const fast = (org: string, ctx = context(org), opts: Parameters<typeof refreshV7ImportFastPath>[4] = options) => refreshV7ImportFastPath(database.pool, source, JOB_A, ctx, opts);
  const fingerprint = async () => {
    const tables = (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'nzi_console' ORDER BY tablename`)).rows.map((row) => row.t);
    const prints: Record<string, string> = {};
    for (const table of tables) prints[table] = (await db.query<{ p: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS p FROM nzi_console.${table} t`)).rows[0]!.p;
    return prints;
  };
  const refreshedEvents = async (org: string) => (await db.query<{ actor_id: string; reason: string; after_json: unknown }>(
    `SELECT actor_id, reason, after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'import.refreshed' AND entity_id = $2`, [org, JOB_A])).rows;
  /** A person's edit of one of the job's rows, as any scope-row command audits it (staff principal, entity scope_row). */
  const personEdits = (client: { query: pg.Client["query"] }, org: string) => client.query(
    `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
     SELECT $1, $2, 'staff-consultant', 'staff', 'scopeRow.update', 'scope_row', scope_row_id, $2, 'a correction (test)', '{}'::jsonb
       FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $3 AND origin = 'live' AND enabled LIMIT 1`, [org, randomUUID(), JOB_A]);
  const ORGS = ["fp-eligible", "fp-issued", "fp-edited", "fp-gated", "fp-d7", "fp-race"] as const;

  before(async () => {
    database = (await createDisposableDatabase("v7fastpath"))!;
    db = await database.admin();
    for (const [at, org] of ORGS.entries()) {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [org]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
      await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [org]);
      await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Fast Path Test','active')`, [org]);
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
        VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7','901','J000901')`, [org, JOB_A, 9100 + at]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [org, JOB_A]);
      await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                      VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [org]);
      for (const [id, label, unit, kg, scope, levels] of [["gas", "Natural gas", "kWh", 0.2, "1", ["Fuels", "Gaseous fuels", "Natural gas"]], ["water", "Water supply", "m3", 0.15, "3", []],
        ["lpg", "LPG", "litres", 0.2, "1", ["Fuels", "Gaseous fuels", "LPG"]]] as const) {
        await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6::text],$7::text[])`,
          [org, id, label, unit, kg, scope, levels]);
      }
      for (const row of BEFORE) await insert(db, "job_scope_rows", [
        { column: "organisation_id", value: org, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
        { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(JOB_A, row)]);
      const standing = `v7-reingest-${randomUUID()}`;
      await withTenantWrite(database.pool, org, (client) => reingestV7JobInTransaction(client, { ...PLAN_BEFORE(standing) },
        { organisationId: org, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: standing, correlationId: standing,
          reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", org, V7_REINGEST_ACTOR) }));
    }
    // The eligible job carries a report the previous system issued (0135), as nearly every migrated job does: ruled, it does
    // not count — only a report the console issued does.
    await db.query(`SELECT set_config('app.organisation_id', 'fp-eligible', false)`);
    await db.query(`INSERT INTO nzi_console.legacy_report_versions (organisation_id, legacy_report_id, job_id, kind, source_system, legacy_db_id, version_number, legacy_status,
      finalized_at, content_key_wrapped, imported_by) VALUES ('fp-eligible', 'lr-1', $1, 'report', 'nzi-pro-v7', '77', 1, 'final', now(), '{"ciphertext":"x","iv":"y","tag":"z"}'::jsonb, 'policy:v7-import')`, [JOB_A]);
    // The console issued a report for this one: a published report version, on the reviewed snapshot it froze (the FK).
    await db.query(`SELECT set_config('app.organisation_id', 'fp-issued', false)`);
    await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
      VALUES ('fp-issued', 'snap-1', $1, 1, 1, $2, '{}'::jsonb, 'staff-consultant')`, [JOB_A, `sha256:${"a".repeat(64)}`]);
    await db.query(`INSERT INTO nzi_console.report_versions (organisation_id, report_version_id, job_id, status, manifest_version, reviewed_snapshot_id, data_hash, published_at)
      VALUES ('fp-issued', 'rv-1', $1, 'published', 1, 'snap-1', $2, now())`, [JOB_A, `sha256:${"a".repeat(64)}`]);
    await db.query(`SELECT set_config('app.organisation_id', 'fp-edited', false)`);
    await personEdits(db, "fp-edited");
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("the signals, read as the job stands: nothing issued and nothing edited on a job only the import has written; each fixture moves one", async () => {
    const signals = (org: string) => withTenantRead(database.pool, org, (client) => readV7ImportFastPathSignals(client, org, JOB_A));
    assert.deepEqual(await signals("fp-eligible"), { issuedReport: false, manualEdits: false }, "the re-ingest's own rows — its reported-total override included — are not a person's, and the previous system's report is not the console's");
    assert.deepEqual(await signals("fp-issued"), { issuedReport: true, manualEdits: false });
    assert.deepEqual(await signals("fp-edited"), { issuedReport: false, manualEdits: true });
  });

  it("an eligible job auto-commits: one action, the system reason audited, Σ live = Σ previous system per scope — no human step", async () => {
    const result = await fast("fp-eligible");
    assert.equal(result.fastPath, "refreshed", JSON.stringify(result.fastPath === "deliberate" ? [result.because, result.preview.refusal] : null));
    if (result.fastPath !== "refreshed") return;
    assert.deepEqual([result.preview.outcome, result.preview.exceptions, result.committed.mode], ["would-commit", [], "commit"]);
    assert.deepEqual(result.preview.scopeTotals, { "1": { v7Tco2e: 2.43, liveTco2e: 2.43 }, "2": { v7Tco2e: 0, liveTco2e: 0 }, "3": { v7Tco2e: 0.0015, liveTco2e: 0.0015 } });
    const live = (await db.query<{ scope: string; t: string }>(`SELECT split_part(scope, '.', 1) AS scope, sum(coalesce(override_tco2e, calculated_tco2e))::text AS t FROM nzi_console.job_scope_rows
      WHERE organisation_id = 'fp-eligible' AND job_id = $1 AND origin = 'live' AND enabled GROUP BY 1 ORDER BY 1`, [JOB_A])).rows.map((row) => [row.scope, Math.round(Number(row.t) * 1e6) / 1e6]);
    assert.deepEqual(live, [["1", 2.43], ["3", 0.0015]]);
    const audit = await refreshedEvents("fp-eligible");
    assert.equal(audit.length, 1, "one commit, audited once — the preview left nothing");
    assert.deepEqual([audit[0]!.actor_id, audit[0]!.reason], ["staff-consultant", V7_IMPORT_FAST_PATH_REASON], "the same actor, the fixed system reason");
    assert.ok(result.auditEventId, "the audit id, for the panel");
    const record = (await db.query(`SELECT outcome, created_by FROM nzi_console.v7_import_ingests WHERE ingest_id = $1`, [result.committed.ingestId])).rows[0]!;
    assert.deepEqual(record, { outcome: "committed", created_by: "staff-consultant" }, "recorded in 0229 as any commit is");
  });

  it("once refreshed, the next action finds nothing to do: deliberate, nothing flagged, nothing written", async () => {
    const before = await fingerprint();
    const again = await fast("fp-eligible");
    assert.equal(again.fastPath, "deliberate");
    if (again.fastPath !== "deliberate") return;
    assert.deepEqual([again.preview.verdict, again.preview.refusal?.stage, again.flagged], ["clean", "ready", 0]);
    assert.deepEqual(await fingerprint(), before);
  });

  it("D-ELIG-1 — a report the console issued: never auto-committed; held for a person as issued-report, nothing written", async () => {
    // A console report version needs its reviewed snapshot (the FK). A snapshot blocks a revert, never a read
    // (BRIEF-v7-import-j000663 §A): the fast path reads the job and falls back to the deliberate flow, by D-ELIG-1's own reason.
    const before = await fingerprint();
    const result = await fast("fp-issued");
    assert.equal(result.fastPath, "deliberate");
    if (result.fastPath === "deliberate") assert.ok(result.because.includes("issued-report"), JSON.stringify(result.because));
    assert.deepEqual(await fingerprint(), before);
    assert.equal((await refreshedEvents("fp-issued")).length, 0);
  });

  it("D-ELIG-2 alone — a person's edit of one of the job's rows: falls back and auto-commits nothing", async () => {
    const before = await fingerprint();
    const result = await fast("fp-edited");
    assert.equal(result.fastPath, "deliberate");
    if (result.fastPath !== "deliberate") return;
    assert.deepEqual([result.because, result.preview.outcome], [["manual-edits"], "would-commit"]);
    assert.deepEqual(await fingerprint(), before);
  });

  it("D-ELIG-3 — D7 refuses an otherwise-eligible job (water planned on a per-litre factor): refused, nothing written, the reason 'flagged'", async () => {
    const before = await fingerprint();
    const wrong = withoutRun(PLAN_BEFORE("x"));
    const plan = { ...wrong, rows: wrong.rows.map((row) => row.v7RowId === "v7-row-1002" ? { ...row, factorId: "lpg" } : row) };
    const result = await fast("fp-d7", context("fp-d7"), { basePlan: plan });
    assert.equal(result.fastPath, "deliberate");
    if (result.fastPath !== "deliberate") return;
    assert.deepEqual([result.because, result.flagged, result.preview.outcome, result.preview.refusal?.stage, result.preview.exceptions], [["flagged"], 0, "refused", "reingest", []]);
    assert.deepEqual(await fingerprint(), before);
    assert.equal((await refreshedEvents("fp-d7")).length, 0);
  });

  it("the Admin-commit gate wins: set, a CRM's eligible job does not auto-commit; an Admin's does", async () => {
    await setOrganisationImportPolicy(database.pool, { refreshCommitRequiresAdmin: true, expectedVersion: 0 }, context("fp-gated", "admin", "staff-admin", "Admins commit (test)"));
    const before = await fingerprint();
    const crm = await fast("fp-gated");
    assert.equal(crm.fastPath, "deliberate");
    if (crm.fastPath !== "deliberate") return;
    assert.deepEqual([crm.because, crm.preview.outcome], [["admin-commits"], "would-commit"]);
    assert.deepEqual(await fingerprint(), before, "the CRM's action wrote nothing");
    const admin = await fast("fp-gated", context("fp-gated", "admin"));
    assert.equal(admin.fastPath, "refreshed");
    assert.deepEqual((await refreshedEvents("fp-gated")).map((row) => [row.actor_id, row.reason]), [["staff-admin", V7_IMPORT_FAST_PATH_REASON]]);
  });

  it("re-checked in the commit's own transaction: an edit landing after the preview refuses FAST_PATH_INELIGIBLE, and nothing is written — the edit's own row included", async () => {
    const before = await fingerprint();
    await assert.rejects(fast("fp-race", context("fp-race"), { ...options, within: async (client, at) => { if (at === "commit") await personEdits(client as never, "fp-race"); } }),
      (error) => codes(error).includes("FAST_PATH_INELIGIBLE"));
    assert.deepEqual(await fingerprint(), before);
  });
});

/**
 * Phase E (BRIEF-v7-import-server-side-phase-e, R-5; RULING-v7-import-phase-e-infra): the batch. Every job here stands as Phase D's
 * J000901 does — migrated, re-ingested by the system — each with its own rows, under one client per scenario. The batch runs the
 * fast path per job, unchanged: these tests are about the orchestration (which jobs, in what order, recorded how, resumed how).
 */
describe("the import refresh batch: one client's jobs through the fast path, the eligible auto-committed and the rest queued", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const ORG = "batch", GATED = "batch-gated";
  const context = (org: string, role: "admin" | "consultant" | "reviewer" = "admin", actorId = `staff-${role}`, reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId, principal: "staff", idempotencyKey: `bt-${keys}`, correlationId: `bt-corr-${keys}`, ...(reason ? { reason } : {}),
      grant: commandGrantForRole(role, org, actorId) };
  };
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const withoutRun = ({ runId: _runId, ...rest }: V7ReingestJobInput) => rest;
  /** Job k: its own three rows (ids k001..k003), gas amended in the previous system now. */
  const job = (k: number) => {
    const at = (base: V7Fixture, n: string): V7Fixture => ({ ...base, id: `${k}${n}` });
    const gas = at(GAS, "001"), water = at(WATER, "002"), refrigerant = at(REFRIGERANT, "003");
    const jobId = `batch-job-${k}`;
    const plan = (runId: string): V7ReingestJobInput => ({ ...planFor(runId, [[`v7-row-${gas.id}`, gas], [`v7-row-${water.id}`, water], [`v7-row-${refrigerant.id}`, refrigerant]]), jobId });
    return { jobId, k, plan, before: [gas, water, refrigerant].map(plannedRow), now: [{ ...gas, qty: 1200, reported: 0.24 }, water, refrigerant].map(plannedRow) };
  };
  type Job = ReturnType<typeof job>;
  const ELIGIBLE = job(1), EDITED = job(2), D7 = job(3), CLEAN = job(4), TIMEOUT = job(5), ISSUED = job(6);
  const CRASHED = job(7), AFTER_CRASH = job(8), CRASHED_EARLY = job(9), GATE_1 = job(10), GATE_2 = job(11), DEMOTED = job(12);
  // What the previous system holds for each job now; a test may change it. A job named in `timingOut` times out on every read.
  const holds = new Map<string, PlannedRow[]>();
  const timingOut = new Set<string>();
  // The hardening's sources (BRIEF-v7-import-batch-hardening): a job read through a real pool to a source that never answers;
  // a job whose source refuses connections; a job whose reads take (on the test's clock) 31s each.
  const throughPool = new Map<string, V7ImportRefreshSource>();
  const unreachable = new Set<string>();
  const slow = new Set<string>();
  let clock = 0;
  const reads: string[] = [];
  const source: V7ImportRefreshSource = async (db, job) => {
    const { jobId } = job;
    reads.push(jobId);
    if (timingOut.has(jobId)) throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    if (throughPool.has(jobId)) return throughPool.get(jobId)!(db, job);
    if (unreachable.has(jobId)) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    if (slow.has(jobId)) clock += 31_000;
    return { sourceSha256: "e".repeat(64), rows: holds.get(jobId)! };
  };
  const HUNG = job(13), SEVERED = job(14), BREAKER = [job(15), job(16), job(17), job(18)], SLOW = [job(19), job(20), job(21), job(22)];
  const ALL = [ELIGIBLE, EDITED, D7, CLEAN, TIMEOUT, ISSUED, CRASHED, AFTER_CRASH, CRASHED_EARLY, GATE_1, GATE_2, DEMOTED, HUNG, SEVERED, ...BREAKER, ...SLOW];
  const servers: net.Server[] = [];
  const pools: pg.Pool[] = [];
  const byId = new Map(ALL.map((entry) => [entry.jobId, entry]));
  const optionsFor = (jobId: string) => {
    const plan = withoutRun(byId.get(jobId)!.plan("x"));
    // D7's job: water planned on a per-litre factor, so the re-ingest cannot reconcile (Phase D's D-ELIG-3 case).
    return { basePlan: jobId === D7.jobId ? { ...plan, rows: plan.rows.map((row) => row.v7RowId === `v7-row-${D7.k}002` ? { ...row, factorId: "lpg" } : row) } : plan };
  };
  // No real waiting between jobs in these tests (the pacing tests below capture what the runner would wait instead).
  const runner = { source, optionsFor, sleep: async () => undefined };
  const results = async (org: string, runId: string) => Object.fromEntries((await db.query<{ job_id: string; status: string; because: string[]; flagged: number; refusal_codes: string[];
    failure_class: string | null; attempts: number; ingest_id: string | null; audit_event_id: string | null }>(
    `SELECT job_id, status, because, flagged, refusal_codes, failure_class, attempts, ingest_id, audit_event_id FROM nzi_console.v7_import_batch_results
      WHERE organisation_id = $1 AND run_id = $2 ORDER BY position`, [org, runId])).rows.map((row) => [row.job_id, row]));
  const refreshedEvents = async (org: string, jobId: string) => (await db.query<{ actor_id: string; reason: string; correlation_id: string }>(
    `SELECT actor_id, reason, correlation_id FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'import.refreshed' AND entity_id = $2`, [org, jobId])).rows;
  const ingests = async (org: string, jobId: string) => (await db.query<{ ingest_id: string }>(
    `SELECT ingest_id FROM nzi_console.v7_import_ingests WHERE organisation_id = $1 AND job_id = $2 AND kind = 'ingest'`, [org, jobId])).rows.map((row) => row.ingest_id);
  const runCorrelation = async (org: string, runId: string) => (await db.query<{ correlation_id: string }>(
    `SELECT correlation_id FROM nzi_console.v7_import_batch_runs WHERE organisation_id = $1 AND run_id = $2`, [org, runId])).rows[0]!.correlation_id;

  const seedJob = async (org: string, client: string, entry: Job) => {
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [org]);
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
      VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7',$5,$6)`, [org, entry.jobId, client, 9300 + entry.k, `9${entry.k}`, `J${String(900 + entry.k).padStart(6, "0")}`]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [org, entry.jobId]);
    for (const row of entry.before) await insert(db, "job_scope_rows", [
      { column: "organisation_id", value: org, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
      { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(entry.jobId, row)]);
    const standing = `v7-reingest-${randomUUID()}`;
    await withTenantWrite(database.pool, org, (client) => reingestV7JobInTransaction(client, { ...entry.plan(standing) },
      { organisationId: org, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: standing, correlationId: standing,
        reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", org, V7_REINGEST_ACTOR) }));
    holds.set(entry.jobId, entry.now);
  };

  before(async () => {
    database = (await createDisposableDatabase("v7batch"))!;
    db = await database.admin();
    for (const org of [ORG, GATED]) {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [org]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
      await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [org]);
      for (const client of ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c-empty"]) await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Batch Test','active')`, [org, client]);
      // A second Admin, so the demotion test may demote the first (an organisation keeps one active Admin).
      for (const [user, role] of [["staff-admin", "admin"], ["staff-admin-2", "admin"], ["staff-consultant", "consultant"]]) {
        await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $2)`, [org, user, role]);
      }
      await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                      VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [org]);
      for (const [id, label, unit, kg, scope, levels] of [["gas", "Natural gas", "kWh", 0.2, "1", ["Fuels", "Gaseous fuels", "Natural gas"]], ["water", "Water supply", "m3", 0.15, "3", []],
        ["lpg", "LPG", "litres", 0.2, "1", ["Fuels", "Gaseous fuels", "LPG"]]] as const) {
        await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6::text],$7::text[])`,
          [org, id, label, unit, kg, scope, levels]);
      }
    }
    // c1, the mixed client, in job-number order: eligible · edited by a person · D7 refuses · clean · times out · a console-issued report.
    for (const entry of [ELIGIBLE, EDITED, D7, CLEAN, TIMEOUT, ISSUED]) await seedJob(ORG, "c1", entry);
    holds.set(CLEAN.jobId, CLEAN.before); // the previous system still holds what the job holds: nothing to refresh
    timingOut.add(TIMEOUT.jobId);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
      SELECT $1, $2, 'staff-consultant', 'staff', 'scopeRow.update', 'scope_row', scope_row_id, $2, 'a correction (test)', '{}'::jsonb
        FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $3 AND origin = 'live' AND enabled LIMIT 1`, [ORG, randomUUID(), EDITED.jobId]);
    await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
      VALUES ($1, 'snap-1', $2, 1, 1, $3, '{}'::jsonb, 'staff-consultant')`, [ORG, ISSUED.jobId, `sha256:${"a".repeat(64)}`]);
    await db.query(`INSERT INTO nzi_console.report_versions (organisation_id, report_version_id, job_id, status, manifest_version, reviewed_snapshot_id, data_hash, published_at)
      VALUES ($1, 'rv-1', $2, 'published', 1, 'snap-1', $3, now())`, [ORG, ISSUED.jobId, `sha256:${"a".repeat(64)}`]);
    // c2 and c3: the crash cases. GATED: the Admin-commit gate set, c1 two eligible jobs, c2 one for the demoted starter.
    for (const entry of [CRASHED, AFTER_CRASH]) await seedJob(ORG, "c2", entry);
    await seedJob(ORG, "c3", CRASHED_EARLY);
    for (const entry of [GATE_1, GATE_2]) await seedJob(GATED, "c1", entry);
    await seedJob(GATED, "c2", DEMOTED);
    // c5: the bounded reads — one job through a source that accepts and never answers, one through a source that cuts the line.
    // c6: the breaker — four jobs, the source refusing. c7: slow reads — four eligible jobs, each read 31s on the test's clock.
    for (const entry of [HUNG, SEVERED]) await seedJob(ORG, "c5", entry);
    for (const entry of BREAKER) await seedJob(ORG, "c6", entry);
    for (const entry of SLOW) await seedJob(ORG, "c7", entry);
    const listen = (onSocket: (socket: net.Socket) => void) => new Promise<number>((resolve) => {
      const server = net.createServer(onSocket);
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });
    const silent = await listen(() => undefined);                      // accepts, then says nothing: a source gone quiet
    const severing = await listen((socket) => socket.destroy());        // accepts, then drops the connection
    // The real pool, with the bound the view pool carries — shortened here so the test does not take ten seconds a read.
    for (const [entry, port] of [[HUNG, silent], [SEVERED, severing]] as const) {
      const pool = new pg.Pool({ host: "127.0.0.1", port, user: "cc_import_view", database: "postgres", connectionTimeoutMillis: 300, query_timeout: 300 });
      pool.on("error", () => undefined);
      pools.push(pool);
      throughPool.set(entry.jobId, v7ImportViewSource(pool));
    }
    await setOrganisationImportPolicy(database.pool, { refreshCommitRequiresAdmin: true, expectedVersion: 0 }, context(GATED, "admin", "staff-admin", "Admins commit (test)"));
  });
  after(async () => {
    for (const pool of pools) await pool.end().catch(() => undefined);
    for (const server of servers) server.close();
    await db?.end(); await database?.end();
  });

  let mixedRun = "";
  let crashRun = "";
  it("a batch over a mixed client auto-commits exactly the eligible job and queues the rest with the fast path's own reasons; a failing job does not stop it", async () => {
    const started = await startV7ImportBatch(database.pool, { clientId: "c1" }, context(ORG));
    mixedRun = started.data.runId;
    assert.deepEqual([started.data.jobs, started.data.clientId], [6, "c1"]);
    reads.length = 0;
    const run = await runV7ImportBatch(database.pool, ORG, mixedRun, runner);
    assert.deepEqual(run, { claimed: true, processed: 7, status: "completed" }, "six jobs, the timed-out one read twice");
    // One at a time, in job order; a refreshed job reads twice (its preview, then its commit's own read); one retry for the timeout.
    assert.deepEqual(reads, [ELIGIBLE, ELIGIBLE, EDITED, D7, CLEAN, TIMEOUT, TIMEOUT, ISSUED].map((entry) => entry.jobId));
    const rows = await results(ORG, mixedRun);
    assert.deepEqual(Object.values(rows).map((row) => [row.status, row.because, row.flagged, row.refusal_codes, row.failure_class, row.attempts]), [
      ["refreshed", [], 0, [], null, 0],
      ["queued", ["manual-edits"], 0, [], null, 0],
      ["queued", ["flagged"], 0, [], null, 0],
      ["current", [], 0, [], null, 0],
      ["failed", [], 0, [], "view-timeout", 1],
      ["queued", ["issued-report", "flagged"], 0, [], null, 0],
    ]);
    assert.deepEqual(rows[ELIGIBLE.jobId]!.ingest_id, (await ingests(ORG, ELIGIBLE.jobId))[0]);
    // The commit is the fast path's, as a person's one action makes it: the starter as actor, the fixed reason, the run's correlation.
    assert.deepEqual((await refreshedEvents(ORG, ELIGIBLE.jobId)).map((row) => [row.actor_id, row.reason, row.correlation_id]),
      [["staff-admin", V7_IMPORT_FAST_PATH_REASON, await runCorrelation(ORG, mixedRun)]]);
    for (const other of [EDITED, D7, CLEAN, TIMEOUT, ISSUED]) assert.deepEqual([await refreshedEvents(ORG, other.jobId), await ingests(ORG, other.jobId)], [[], []], other.jobId);
    const view = await withTenantRead(database.pool, ORG, (client) => readV7ImportBatch(client, ORG, "c1"));
    assert.deepEqual(view.run?.tally, { total: 6, refreshed: 1, exceptions: 3, failed: 1, current: 1, skipped: 0, pending: 0 });
    assert.deepEqual(view.run?.queue.map((item) => [item.jobNumber, item.status, item.because, item.refusalCodes, item.failureClass]), [
      ["J009302", "queued", ["manual-edits"], [], null], ["J009303", "queued", ["flagged"], [], null],
      ["J009305", "failed", [], [], "view-timeout"], ["J009306", "queued", ["issued-report", "flagged"], [], null]]);
    assert.deepEqual([view.importedJobs, view.run?.status, view.run?.stopped], [6, "completed", false]);
    const events = (await db.query<{ action: string; after_json: Record<string, unknown> }>(`SELECT action, after_json FROM nzi_console.audit_events
      WHERE organisation_id = $1 AND action LIKE 'import.refreshBatch.%' AND entity_id = 'c1' ORDER BY occurred_at, action`, [ORG])).rows;
    assert.deepEqual(events.map((row) => row.action), ["import.refreshBatch.started", "import.refreshBatch.finished"]);
    assert.deepEqual(events[1]!.after_json, { runId: mixedRun, total: 6, refreshed: 1, exceptions: 3, failed: 1, current: 1, skipped: 0, pending: 0 }, "counts only");
  });

  it("a re-run skips the committed job without reading it, re-attempts the exceptions and the failure, and shows a job a person resolved since as current locally", async () => {
    // A person works the edited job through the deliberate flow; the source recovers for the one that timed out.
    const preview = await previewV7ImportRefresh(database.pool, source, { jobId: EDITED.jobId, mode: "preview" }, context(ORG, "consultant"), optionsFor(EDITED.jobId));
    assert.equal(preview.outcome, "would-commit");
    await commitV7ImportRefresh(database.pool, source, { jobId: EDITED.jobId, mode: "commit", summarySha256: preview.summarySha256, decisionsSha256: preview.decisionsSha256 },
      context(ORG, "consultant", "staff-consultant", "worked by hand (test)"), optionsFor(EDITED.jobId));
    timingOut.delete(TIMEOUT.jobId);
    const started = await startV7ImportBatch(database.pool, { clientId: "c1" }, context(ORG));
    reads.length = 0;
    assert.equal((await runV7ImportBatch(database.pool, ORG, started.data.runId, runner)).status, "completed");
    assert.deepEqual(reads, [D7, CLEAN, TIMEOUT, TIMEOUT, ISSUED].map((entry) => entry.jobId), "the two committed jobs are not read again (the recovered one reads twice: preview, commit)");
    assert.deepEqual(Object.values(await results(ORG, started.data.runId)).map((row) => row.status), ["skipped", "skipped", "queued", "current", "refreshed", "queued"]);
    assert.equal((await refreshedEvents(ORG, ELIGIBLE.jobId)).length, 1, "never committed twice");
    assert.equal((await refreshedEvents(ORG, TIMEOUT.jobId)).length, 1, "the job that failed last time refreshed now");
    const view = await withTenantRead(database.pool, ORG, (client) => readV7ImportBatch(client, ORG, "c1"));
    assert.deepEqual(view.run?.tally, { total: 6, refreshed: 1, exceptions: 2, failed: 0, current: 1, skipped: 2, pending: 0 });
  });

  it("one open run per client, and a client with nothing imported has nothing to run", async () => {
    const open = await startV7ImportBatch(database.pool, { clientId: "c2" }, context(ORG));
    await assert.rejects(startV7ImportBatch(database.pool, { clientId: "c2" }, context(ORG)), (error) => codes(error).includes("BATCH_OPEN"));
    await assert.rejects(startV7ImportBatch(database.pool, { clientId: "c-empty" }, context(ORG)), (error) => codes(error).includes("NO_IMPORTED_JOBS"));
    // c2's open run is the keystone test's.
    crashRun = open.data.runId;
  });

  it("KEYSTONE — killed after a job's commit, before its result: Resume re-claims the job under the SAME key, the landed commit is recorded, nothing commits twice", async () => {
    const correlation = await runCorrelation(ORG, crashRun);
    const key = v7ImportBatchIdempotencyKey(crashRun, CRASHED.jobId, 0);
    // The runner took the run and the first job, committed it under the job's key — and died before writing the result.
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`UPDATE nzi_console.v7_import_batch_runs SET status = 'running', started_at = now(), lease_holder = 'runner-dead', lease_until = now() + interval '10 minutes' WHERE run_id = $1`, [crashRun]);
    await db.query(`UPDATE nzi_console.v7_import_batch_results SET status = 'running', lease_until = now() + interval '10 minutes' WHERE run_id = $1 AND job_id = $2`, [crashRun, CRASHED.jobId]);
    const landed = await refreshV7ImportFastPath(database.pool, source, CRASHED.jobId,
      { organisationId: ORG, actorId: "staff-admin", principal: "staff", grant: commandGrantForRole("admin", ORG, "staff-admin"), idempotencyKey: key, correlationId: correlation },
      optionsFor(CRASHED.jobId));
    assert.equal(landed.fastPath, "refreshed");
    if (landed.fastPath !== "refreshed") return;
    // While the dead runner's lease stands: no Resume, and no second runner.
    await assert.rejects(resumeV7ImportBatch(database.pool, { clientId: "c2", runId: crashRun }, context(ORG)), (error) => codes(error).includes("BATCH_RUNNING"));
    assert.deepEqual(await runV7ImportBatch(database.pool, ORG, crashRun, runner), { claimed: false, processed: 0, status: null });
    // The lease runs out; an Admin resumes; a new runner carries on.
    await db.query(`UPDATE nzi_console.v7_import_batch_runs SET lease_until = now() - interval '1 second' WHERE run_id = $1`, [crashRun]);
    await db.query(`UPDATE nzi_console.v7_import_batch_results SET lease_until = now() - interval '1 second' WHERE run_id = $1 AND status = 'running'`, [crashRun]);
    const resumed = await resumeV7ImportBatch(database.pool, { clientId: "c2", runId: crashRun }, context(ORG));
    assert.equal(resumed.data.remaining, 2, "the job left running and the one not reached");
    reads.length = 0;
    assert.deepEqual(await runV7ImportBatch(database.pool, ORG, crashRun, runner), { claimed: true, processed: 2, status: "completed" });
    assert.deepEqual(reads, [AFTER_CRASH.jobId, AFTER_CRASH.jobId], "the crashed job's commit is found by its key: it is not read, nor run, again");
    const rows = await results(ORG, crashRun);
    assert.deepEqual([rows[CRASHED.jobId]!.status, rows[CRASHED.jobId]!.ingest_id, rows[CRASHED.jobId]!.audit_event_id, rows[CRASHED.jobId]!.attempts],
      ["refreshed", landed.committed.ingestId, landed.auditEventId, 0], "recorded as the commit that landed — no attempt bump on a crash-resume");
    assert.deepEqual([(await refreshedEvents(ORG, CRASHED.jobId)).length, (await ingests(ORG, CRASHED.jobId)).length], [1, 1], "one commit, one 0229 record: never twice");
    assert.equal(rows[AFTER_CRASH.jobId]!.status, "refreshed");
    // And the stored outcome under that same key replays rather than commits — the key really is the one the commit used.
    const replay = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM nzi_console.command_idempotency WHERE organisation_id = $1 AND idempotency_key = $2`, [ORG, key])).rows[0]!.n;
    assert.equal(replay, "1");
  });

  it("killed after claiming a job but before its commit: Resume runs it under the same key (attempt 0), once", async () => {
    const started = await startV7ImportBatch(database.pool, { clientId: "c3" }, context(ORG));
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`UPDATE nzi_console.v7_import_batch_runs SET status = 'running', started_at = now(), lease_holder = 'runner-dead', lease_until = now() - interval '1 second' WHERE run_id = $1`, [started.data.runId]);
    await db.query(`UPDATE nzi_console.v7_import_batch_results SET status = 'running', lease_until = now() - interval '1 second' WHERE run_id = $1`, [started.data.runId]);
    await resumeV7ImportBatch(database.pool, { clientId: "c3", runId: started.data.runId }, context(ORG));
    assert.equal((await runV7ImportBatch(database.pool, ORG, started.data.runId, runner)).status, "completed");
    const row = (await results(ORG, started.data.runId))[CRASHED_EARLY.jobId]!;
    assert.deepEqual([row.status, row.attempts], ["refreshed", 0]);
    const stored = (await db.query<{ idempotency_key: string }>(`SELECT idempotency_key FROM nzi_console.command_idempotency WHERE organisation_id = $1 AND idempotency_key LIKE $2`,
      [ORG, `v7-batch:${started.data.runId}:%`])).rows.map((entry) => entry.idempotency_key);
    assert.deepEqual(stored, [v7ImportBatchIdempotencyKey(started.data.runId, CRASHED_EARLY.jobId, 0)]);
    assert.equal((await refreshedEvents(ORG, CRASHED_EARLY.jobId)).length, 1);
  });

  it("a role without import.refresh_batch cannot start a batch (the CRM holds it since v17) — and the orchestration under a CRM still honours the per-job Admin gate: every job queues admin-commits", async () => {
    await assert.rejects(startV7ImportBatch(database.pool, { clientId: "c1" }, context(GATED, "reviewer")),
      (error) => error instanceof AuthorizationError && error.permission === "import.refresh_batch");
    const started = await startV7ImportBatch(database.pool, { clientId: "c1" }, context(GATED));
    const crm = commandGrantForRole("consultant", GATED, "staff-consultant");
    for (const entry of [GATE_1, GATE_2]) {
      const outcome = await v7ImportBatchJobOutcome(database.pool, GATED, started.data.runId, { correlation_id: "bt-crm" },
        { jobId: entry.jobId, legacyJobNumber: `J${String(900 + entry.k).padStart(6, "0")}`, attempts: 0 }, crm, runner);
      assert.deepEqual(outcome, { status: "queued", because: ["admin-commits"], flagged: 0 }, entry.jobId);
      assert.equal((await refreshedEvents(GATED, entry.jobId)).length, 0, "nothing auto-commits for a CRM");
    }
    // The Admin who started it passes the gate: the run itself refreshes both.
    assert.equal((await runV7ImportBatch(database.pool, GATED, started.data.runId, runner)).status, "completed");
    assert.deepEqual(Object.values(await results(GATED, started.data.runId)).map((row) => row.status), ["refreshed", "refreshed"]);
  });

  it("the starter's grant is re-derived per job: no longer holding import.refresh_batch, the run stops cancelled, its jobs left pending and nothing run", async () => {
    const started = await startV7ImportBatch(database.pool, { clientId: "c2" }, context(GATED));
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [GATED]);
    // v17: a consultant holds import.refresh_batch, so the starter is demoted to a reviewer, who does not.
    await db.query(`UPDATE nzi_console.memberships SET role_id = 'reviewer' WHERE organisation_id = $1 AND user_id = 'staff-admin'`, [GATED]);
    try {
      reads.length = 0;
      assert.deepEqual(await runV7ImportBatch(database.pool, GATED, started.data.runId, runner), { claimed: true, processed: 0, status: "cancelled" });
      assert.deepEqual([reads, Object.values(await results(GATED, started.data.runId)).map((row) => row.status)], [[], ["pending"]]);
      assert.equal((await db.query(`SELECT 1 FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'import.refreshBatch.cancelled'`, [GATED])).rows.length, 1);
    } finally {
      await db.query(`UPDATE nzi_console.memberships SET role_id = 'admin' WHERE organisation_id = $1 AND user_id = 'staff-admin'`, [GATED]);
    }
  });

  // ── BRIEF-v7-import-batch-hardening (post-incident, 22 Nov): bounded reads, the pause, the breaker ──

  it("HARDENING §2 — a source that never answers, or cuts the line: each job fails view-unavailable within the bound and the batch carries on", async () => {
    const started = await startV7ImportBatch(database.pool, { clientId: "c5" }, context(ORG));
    const pauses: number[] = [];
    const at = Date.now();
    const run = await runV7ImportBatch(database.pool, ORG, started.data.runId, { ...runner, sleep: async (ms) => { pauses.push(ms); } });
    const took = Date.now() - at;
    assert.deepEqual(run, { claimed: true, processed: 2, status: "completed" }, "two jobs: fewer than the breaker's three, so the run finishes");
    assert.deepEqual(Object.values(await results(ORG, started.data.runId)).map((row) => [row.status, row.failure_class]),
      [["failed", "view-unavailable"], ["failed", "view-unavailable"]]);
    assert.ok(took < 5_000, `bounded: ${took}ms for two jobs at a 300ms connect cap — never the 600s lease`);
    assert.deepEqual(pauses, [V7_IMPORT_BATCH_PACING.pauseMs, V7_IMPORT_BATCH_PACING.pauseMs], "the 2s floor between jobs, by default");
  });

  it("HARDENING §3 — the pause: 2s at least, twice a slow job's read time, 60s at most", () => {
    assert.equal(V7_IMPORT_BATCH_PACING.pauseMs, 2_000);
    assert.deepEqual([0, 400, 1_000, 5_000, 29_000, 45_000].map((ms) => v7ImportBatchPauseAfter(ms)), [2_000, 2_000, 2_000, 10_000, 58_000, 60_000]);
    assert.equal(v7ImportBatchPauseAfter(100, 5_000), 5_000, "a higher floor, configured, holds");
  });

  it("HARDENING §4 — the breaker: three jobs in a row with the source not answering stop the run, nothing more is read; Resume, once it answers, finishes it", async () => {
    for (const entry of BREAKER) unreachable.add(entry.jobId);
    const started = await startV7ImportBatch(database.pool, { clientId: "c6" }, context(ORG));
    reads.length = 0;
    const paused = await runV7ImportBatch(database.pool, ORG, started.data.runId, runner);
    assert.deepEqual(paused, { claimed: true, processed: 3, status: "paused" });
    assert.deepEqual(reads, BREAKER.slice(0, 3).map((entry) => entry.jobId), "the fourth job is never read");
    // The jobs the source failed are put back: the failure was the source's. Nothing was committed for any of them.
    assert.deepEqual(Object.values(await results(ORG, started.data.runId)).map((row) => [row.status, row.failure_class]), BREAKER.map(() => ["pending", null]));
    const view = await withTenantRead(database.pool, ORG, (client) => readV7ImportBatch(client, ORG, "c6"));
    assert.deepEqual([view.run?.status, view.run?.stopped, view.run?.paused], ["running", true, "source-unresponsive"], "stopped, Resumable, and why");
    const event = (await db.query<{ after_json: Record<string, unknown> }>(`SELECT after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'import.refreshBatch.paused'`, [ORG])).rows;
    assert.deepEqual(event.map((row) => row.after_json), [{ runId: started.data.runId, reason: "source-unresponsive", consecutive: 3, putBack: 3 }], "counts only");
    // A second runner does not pick it up by itself: it waits for an Admin.
    // (The run's lease is released, so it is the Admin's Resume — the governed command — that hands it to a runner.)
    for (const entry of BREAKER) unreachable.delete(entry.jobId);
    await resumeV7ImportBatch(database.pool, { clientId: "c6", runId: started.data.runId }, context(ORG));
    reads.length = 0;
    assert.deepEqual(await runV7ImportBatch(database.pool, ORG, started.data.runId, runner), { claimed: true, processed: 4, status: "completed" });
    assert.deepEqual(Object.values(await results(ORG, started.data.runId)).map((row) => row.status), ["refreshed", "refreshed", "refreshed", "refreshed"]);
    const after = await withTenantRead(database.pool, ORG, (client) => readV7ImportBatch(client, ORG, "c6"));
    assert.deepEqual([after.run?.status, after.run?.stopped, after.run?.paused], ["completed", false, null]);
  });

  it("HARDENING §3/§4 — a source slowing: the pause lengthens with the read time, and three slow jobs in a row stop the run (their refreshes kept)", async () => {
    for (const entry of SLOW) slow.add(entry.jobId);
    const started = await startV7ImportBatch(database.pool, { clientId: "c7" }, context(ORG));
    const pauses: number[] = [];
    reads.length = 0;
    const run = await runV7ImportBatch(database.pool, ORG, started.data.runId, { ...runner, now: () => clock, sleep: async (ms) => { pauses.push(ms); } });
    assert.deepEqual(run, { claimed: true, processed: 3, status: "paused" });
    // Each refresh read twice (preview, commit) at 31s a read: 62s, so the pause is at its 60s cap — and the third trips the breaker.
    assert.deepEqual(pauses, [60_000, 60_000]);
    assert.deepEqual(Object.values(await results(ORG, started.data.runId)).map((row) => row.status), ["refreshed", "refreshed", "refreshed", "pending"],
      "a slow read that succeeded keeps its refresh; the fourth job is not read");
    assert.ok(!reads.includes(SLOW[3]!.jobId));
    for (const entry of SLOW) slow.delete(entry.jobId);
  });
});

describe("the job's mapping view: every row of the previous system against its intended console mapping, read and rolled back", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const MV_ORG = "v7-mapping";
  const JOB_T = "v7-job-t";
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (role: "admin" | "consultant" | "reviewer" = "consultant", actorId = `staff-${role}`): CommandContext => {
    keys += 1;
    return { organisationId: MV_ORG, actorId, principal: "staff", idempotencyKey: `mv-${keys}`, correlationId: `mv-corr-${keys}`, grant: commandGrantForRole(role, MV_ORG, actorId) };
  };
  const holder = (role: "admin" | "consultant" | "reviewer" = "consultant") => commandGrantForRole(role, MV_ORG, `staff-${role}`);
  const withoutRun = ({ runId: _runId, ...rest }: V7ReingestJobInput) => rest;
  // J000434's shape: the console imported only the previous system's three scope totals (its WFM import); it now holds activity rows.
  const total = (n: "1" | "2" | "3", id: string): PlannedRow => {
    const row = plannedRow({ id, scope: n === "2" ? "1" : n as "1" | "3", label: "Imported Totals", qty: 1000, unit: "kgCO2e", reported: 1 });
    return { ...row, scope: n, v7Scope: n, migratedRecord: { ...row.migratedRecord, original_id: `wfm-import-scope-${n}`, data_source: "WFM Import" } as PlannedRow["migratedRecord"] };
  };
  const TOTALS = [total("1", "3001"), total("2", "3002"), total("3", "3003")];
  const ACTIVITY = [{ ...GAS, id: "2001" }, { ...WATER, id: "2002" }].map(plannedRow);
  const holds = new Map<string, readonly PlannedRow[]>([[JOB_A, NOW], [JOB_T, ACTIVITY]]);
  const reads: string[] = [];
  const source: V7ImportRefreshSource = async (_db, job) => { reads.push(job.jobId); return { sourceSha256: "e".repeat(64), rows: holds.get(job.jobId)! }; };
  const EMPTY_PLAN = (jobId: string) => ({ jobId, crosswalkVersion: "none", crosswalkSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", vintageDatasetIds: [], rows: [] });
  const planOf = (jobId: string) => jobId === JOB_A ? withoutRun(PLAN_BEFORE("x")) : EMPTY_PLAN(jobId);
  const mapping = (jobId: string, role: "admin" | "consultant" | "reviewer" = "consultant") => readV7ImportMapping(database.pool, source, holder(role), jobId, { basePlan: planOf(jobId) });
  const fingerprint = async () => {
    const tables = (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'nzi_console' ORDER BY tablename`)).rows.map((row) => row.t);
    const prints: Record<string, string> = {};
    for (const table of tables) prints[table] = (await db.query<{ p: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS p FROM nzi_console.${table} t`)).rows[0]!.p;
    return prints;
  };
  const upload = async (jobId: string, legacyJobNumber: string) => {
    const summary = await withTenantWrite(database.pool, MV_ORG, (client) => summariseV7JobAsTheChainSees(client,
      { organisationId: MV_ORG, jobId, legacyJobNumber, extractSha256: "e".repeat(64), rows: holds.get(jobId)!, generatedAt: "2026-11-23T09:00:00.000Z" }));
    await uploadV7ImportSummary(database.pool, { jobId, summary }, context("admin", V7_IMPORT_ACTOR));
  };

  before(async () => {
    database = (await createDisposableDatabase("v7mapping"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [MV_ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [MV_ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [MV_ORG]);
    for (const client of ["c1", "ct"]) await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Mapping Test','active')`, [MV_ORG, client]);
    for (const [user, role] of [["staff-admin", "admin"], ["staff-consultant", "consultant"], ["staff-reviewer", "reviewer"]]) {
      await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $2)`, [MV_ORG, user, role]);
    }
    await db.query(`INSERT INTO nzi_console.client_sites (organisation_id,site_id,client_id,name,created_by) VALUES ($1,'v7-site-1','c1','Head office','test')`, [MV_ORG]);
    for (const [jobId, client, sequence, number] of [[JOB_A, "c1", 901, "J000901"], [JOB_T, "ct", 902, "J000902"]] as const) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
        VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7',$5,$6)`, [MV_ORG, jobId, client, sequence, String(sequence), number]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [MV_ORG, jobId]);
    }
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [MV_ORG]);
    for (const [id, label, unit, kg, scope, levels] of [["gas", "Natural gas", "kWh", 0.2, "1", ["Fuels", "Gaseous fuels", "Natural gas"]], ["water", "Water supply", "m3", 0.15, "3", []]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6::text],$7::text[])`,
        [MV_ORG, id, label, unit, kg, scope, levels]);
    }
    for (const [jobId, rows] of [[JOB_A, BEFORE], [JOB_T, TOTALS]] as const) for (const row of rows) await insert(db, "job_scope_rows", [
      { column: "organisation_id", value: MV_ORG, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
      { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(jobId, row)]);
    const standing = `v7-reingest-${randomUUID()}`;
    await withTenantWrite(database.pool, MV_ORG, (client) => reingestV7JobInTransaction(client, { ...PLAN_BEFORE(standing) },
      { organisationId: MV_ORG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: standing, correlationId: standing,
        reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", MV_ORG, V7_REINGEST_ACTOR) }));
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("access: the refresh's own rule — a Reviewer is refused before the source is read, and nothing is written", async () => {
    const before = await fingerprint();
    reads.length = 0;
    await assert.rejects(mapping(JOB_A, "reviewer"), (error) => error instanceof AuthorizationError && error.permission === "import.refresh");
    assert.deepEqual(reads, []);
    assert.deepEqual(await fingerprint(), before);
  });

  it("every row, two sides: the previous system now, and the console's intended mapping — from the committed plan, or none — with why a row is flagged", async () => {
    const before = await fingerprint();
    const seen = await mapping(JOB_A);
    assert.deepEqual(await fingerprint(), before, "a read: nothing written, the lock and the summary's revert rolled back");
    assert.deepEqual(seen.rows.map((row) => [row.legacyDbId, row.status, row.source, row.intended.categoryCode, row.intended.factorId, row.flag]), [
      ["1001", "changed", "plan", "1.natural-gas", "gas", null],
      ["1002", "matched", "plan", "3.5", "water", null],
      ["1004", "new", "none", null, null, "NEW"],
      ["1003", "withdrawn", "none", null, null, "WITHDRAWN"],
    ]);
    const gas = seen.rows[0]!.previous;
    assert.deepEqual([gas.label, gas.quantity, gas.unit, gas.factorCode, gas.tco2e], ["Natural gas", 1200, "kWh", "7_1001", 0.24], "the previous system as it stands now");
    assert.equal(seen.rows[3]!.previous.label, "Refrigerant", "a withdrawn row: as the console last held it");
    assert.deepEqual([seen.verdict, seen.summaryCurrent, seen.firstTimeMapping], ["needs-mapping", false, false]);
    assert.deepEqual([seen.scopeTotals["1"].v7Tco2e, seen.scopeTotals["3"].v7Tco2e], [0.34, 0.0015], "Σ per scope, as the preview reconciles it");
  });

  it("a decision is the row's mapping once made: resolved inline against the current summary, its source the decision; the rest unchanged", async () => {
    await upload(JOB_A, "J000901");
    assert.equal((await mapping(JOB_A)).summaryCurrent, true, "the stored summary is the one shown, so a decision is checked against it");
    await setV7ImportDecision(database.pool, { jobId: JOB_A, sourceSystem: "nzi-pro-v7", legacyDbId: "1004", kind: "map", categoryCode: "1.natural-gas",
      datasetId: "v7-vintage-2025", factorId: "gas", expectedDecisionId: null } as never, context("admin", "staff-admin"));
    await setV7ImportDecision(database.pool, { jobId: JOB_A, sourceSystem: "nzi-pro-v7", legacyDbId: "1003", kind: "withdraw", expectedDecisionId: null } as never, context("admin", "staff-admin"));
    const seen = await mapping(JOB_A);
    assert.deepEqual(seen.rows.map((row) => [row.legacyDbId, row.source, row.intended.factorId, row.intended.withdraw, row.flag]), [
      ["1001", "plan", "gas", false, null], ["1002", "plan", "water", false, null], ["1004", "decision", "gas", false, null], ["1003", "decision", null, true, null]]);
    assert.equal(seen.verdict, "ready-to-ingest");
  });

  it("J000434's case: a totals-only job with activity rows now — each row new, its three totals withdrawn, and it reads as a first-time mapping", async () => {
    const seen = await mapping(JOB_T);
    assert.deepEqual(seen.rows.map((row) => [row.legacyDbId, row.status, row.source, row.flag]), [
      ["2001", "new", "none", "NEW"], ["2002", "new", "none", "NEW"],
      ["3001", "withdrawn", "none", "WITHDRAWN"], ["3002", "withdrawn", "none", "WITHDRAWN"], ["3003", "withdrawn", "none", "WITHDRAWN"]]);
    assert.equal(seen.firstTimeMapping, true);
    assert.deepEqual(await withTenantRead(database.pool, MV_ORG, async (client) => [await v7JobIsTotalsOnly(client, MV_ORG, JOB_T), await v7JobIsTotalsOnly(client, MV_ORG, JOB_A)]),
      [true, false], "the totals test: every imported row a WFM scope total — and a job with activity rows is not");
  });

  it("the batch's queue says the same: the totals-only job is a first-time mapping, not a regression", async () => {
    const started = await startV7ImportBatch(database.pool, { clientId: "ct" }, context("admin", "staff-admin"));
    await runV7ImportBatch(database.pool, MV_ORG, started.data.runId, { source, optionsFor: (jobId: string) => ({ basePlan: planOf(jobId) }), sleep: async () => undefined });
    const view = await withTenantRead(database.pool, MV_ORG, (client) => readV7ImportBatch(client, MV_ORG, "ct"));
    assert.deepEqual(view.run?.queue.map((item) => [item.jobNumber, item.status, item.because, item.flagged, item.firstTimeMapping]),
      [["J000902", "queued", ["flagged"], 5, true]]);
  });
});

/**
 * The import rows modal (BRIEF-v7-import-rows-modal): J000434's shape — the console holds only the previous system's three scope
 * totals; the previous system now has activity rows. The read lays each row beside its candidates, found by its own ID
 * (suffix-insensitive) and recomputed; the accept writes many rows' decisions in one request through the decision command; the
 * totals retire as the rows come in; and from the job, a commit is refused unless every scope agrees to one decimal place.
 */
describe("the import rows modal: candidates by ID, recomputed and judged; the bulk accept; the totals retire; the reconcile gate", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const RM_ORG = "v7-rows";
  const JOB_R = "v7-job-r", JOB_W = "v7-job-w";
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (role: "admin" | "consultant" | "reviewer" = "admin", actorId = `staff-${role}`, reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: RM_ORG, actorId, principal: actorId.startsWith("policy:") ? "system" : "staff", idempotencyKey: `rm-${keys}`, correlationId: `rm-corr-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole(role, RM_ORG, actorId) };
  };
  const holder = (role: "admin" | "consultant" | "reviewer" = "consultant") => commandGrantForRole(role, RM_ORG, `staff-${role}`);
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const activity = (id: string, scope: "1" | "3", label: string, qty: number, unit: string, reported: number, originalId: string): PlannedRow => {
    const row = plannedRow({ id, scope, label, qty, unit, reported });
    return { ...row, migratedRecord: { ...(row.migratedRecord as unknown as Record<string, unknown>), original_id: originalId } as unknown as PlannedRow["migratedRecord"] };
  };
  const total = (n: "1" | "2" | "3", id: string): PlannedRow => {
    const row = plannedRow({ id, scope: n === "2" ? "1" : n as "1" | "3", label: "Imported Totals", qty: 1000, unit: "kgCO2e", reported: 1 });
    return { ...row, scope: n, v7Scope: n, migratedRecord: { ...row.migratedRecord, original_id: `wfm-import-scope-${n}`, data_source: "WFM Import" } as PlannedRow["migratedRecord"] };
  };
  // J000434 now, in miniature: a gas row its ID finds (one factor reproduces), a gas row its ID does not, an LPG row two editions
  // reproduce alike, and the three totals gone from the previous system.
  const GAS_ROW = activity("4001", "1", "Fuels — natural gas", 154_008, "kWh", 28.168063, "1_100_1004_6_1");
  const GAS_OTHER = activity("4002", "1", "Natural gas (second meter)", 1_000, "kWh", 0.1829, "1_100_1009_6_1");
  const LPG_ROW = activity("4003", "1", "LPG", 500, "litres", 0.75, "1_100_1020_6_1");
  // The wrong-basis guard, alone on its job: a Scope 3 row whose ID finds a Scope 1 factor that gives the right figure.
  const TRAVEL_ROW = activity("4101", "3", "Business travel — small car", 100, "miles", 0.023818, "4_301_3069_9_1");
  const holds = new Map<string, readonly PlannedRow[]>([[JOB_R, [GAS_ROW, GAS_OTHER, LPG_ROW]], [JOB_W, [TRAVEL_ROW]]]);
  const reads: string[] = [];
  const source: V7ImportRefreshSource = async (_db, job) => { reads.push(job.jobId); return { sourceSha256: "e".repeat(64), rows: holds.get(job.jobId)! }; };
  const EMPTY_PLAN = (jobId: string) => ({ jobId, crosswalkVersion: "none", crosswalkSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", vintageDatasetIds: [], rows: [] });
  const rowsOf = (jobId: string, role: "admin" | "consultant" | "reviewer" = "consultant") => readV7ImportRows(database.pool, source, holder(role), jobId, { basePlan: EMPTY_PLAN(jobId) });
  const fingerprint = async () => {
    const tables = (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'nzi_console' ORDER BY tablename`)).rows.map((row) => row.t);
    const prints: Record<string, string> = {};
    for (const table of tables) prints[table] = (await db.query<{ p: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS p FROM nzi_console.${table} t`)).rows[0]!.p;
    return prints;
  };
  const upload = async (jobId: string, legacyJobNumber: string) => {
    const summary = await withTenantWrite(database.pool, RM_ORG, (client) => summariseV7JobAsTheChainSees(client,
      { organisationId: RM_ORG, jobId, legacyJobNumber, extractSha256: "e".repeat(64), rows: holds.get(jobId)!, generatedAt: "2026-11-24T02:00:00.000Z" }));
    await uploadV7ImportSummary(database.pool, { jobId, summary }, context("admin", V7_IMPORT_ACTOR));
  };
  const options = { basePlan: EMPTY_PLAN(JOB_R) };
  const preview = () => previewV7ImportRefresh(database.pool, source, { jobId: JOB_R, mode: "preview" }, context("consultant"), options);
  const commit = (shown: { summarySha256: string; decisionsSha256: string }, gate: boolean) => commitV7ImportRefresh(database.pool, source,
    { jobId: JOB_R, mode: "commit", summarySha256: shown.summarySha256, decisionsSha256: shown.decisionsSha256 },
    context("consultant", "staff-consultant", "bring J000903 in from the previous system (test)"), { ...options, ...(gate ? { requireScopesAgree: true } : {}) });

  before(async () => {
    database = (await createDisposableDatabase("v7rows"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [RM_ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [RM_ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [RM_ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'cr','Rows Modal Client','active')`, [RM_ORG]);
    for (const [user, role] of [["staff-admin", "admin"], ["staff-consultant", "consultant"], ["staff-reviewer", "reviewer"]]) {
      await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $2)`, [RM_ORG, user, role]);
    }
    for (const [ds, name, from] of [["uk-ghg-gb-2024", "DESNZ GB 2024", "2024-01-01"], ["uk-ghg-gb-2023", "DESNZ GB 2023", "2023-01-01"]]) {
      await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                      VALUES ($1,$2,$3,'1',$4,'2026-12-31','GB','active','Test','Source: test.')`, [RM_ORG, ds, name, from]);
    }
    const GAS = ["Fuels", "Gaseous fuels", "Natural gas"], LPG = ["Fuels", "Gaseous fuels", "LPG"], CARS = ["Passenger vehicles", "Cars (by size)", "Small car"];
    for (const [ds, id, label, unit, kg, scope, levels] of [
      ["uk-ghg-gb-2024", "uk-ghg-1_100_1004_6_1", "Natural gas — gross CV", "kWh", 0.1829, "1", GAS],
      ["uk-ghg-gb-2024", "uk-ghg-1_100_1004_6_2", "Natural gas — net CV", "kWh", 0.2, "1", GAS],
      ["uk-ghg-gb-2023", "uk-ghg-1_100_1004_6_1", "Natural gas — gross CV", "kWh", 0.19, "1", GAS],
      ["uk-ghg-gb-2024", "uk-ghg-1_100_1020_6_1", "LPG", "litres", 1.5, "1", LPG],
      ["uk-ghg-gb-2023", "uk-ghg-1_100_1020_6_1", "LPG", "litres", 1.5, "1", LPG],
      ["uk-ghg-gb-2024", "uk-ghg-1_100_1020_6_9", "LPG — another edition", "litres", 1.7, "1", LPG],
      ["uk-ghg-gb-2024", "uk-ghg-4_301_3069_9_2", "Passenger vehicles · small car · petrol · per mile", "miles", 0.23818, "1", CARS],
    ] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,$2,$3,$4,$5,$6,ARRAY[$7::text],$8::text[])`,
        [RM_ORG, ds, id, label, unit, kg, scope, levels]);
    }
    for (const [jobId, sequence, number] of [[JOB_R, 903, "J000903"], [JOB_W, 904, "J000904"]] as const) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
        VALUES ($1,$2,'cr',$3,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7',$4,$5)`, [RM_ORG, jobId, sequence, String(sequence), number]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [RM_ORG, jobId]);
      for (const ds of ["uk-ghg-gb-2024", "uk-ghg-gb-2023"]) await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
        VALUES ($1,$2,$3,'manual','the job''s datasets (test)','staff-admin')`, [RM_ORG, jobId, ds]);
    }
    for (const row of [total("1", "3001"), total("2", "3002"), total("3", "3003")]) await insert(db, "job_scope_rows", [
      { column: "organisation_id", value: RM_ORG, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
      { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(JOB_R, row)]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("access: the refresh's own rule — a Reviewer is refused before the source is read; the read and the search write nothing", async () => {
    const before = await fingerprint();
    reads.length = 0;
    await assert.rejects(rowsOf(JOB_R, "reviewer"), (error) => error instanceof AuthorizationError && error.permission === "import.refresh");
    await assert.rejects(searchV7ImportFactors(database.pool, holder("reviewer"), { jobId: JOB_R, query: "gas", unit: "kWh" }),
      (error) => error instanceof AuthorizationError && error.permission === "import.refresh");
    assert.deepEqual(reads, []);
    await rowsOf(JOB_R);
    await searchV7ImportFactors(database.pool, holder(), { jobId: JOB_R, query: "gas", unit: "kWh" });
    assert.deepEqual(await fingerprint(), before, "read and rolled back: the lock, the summary's revert, nothing kept");
  });

  it("each row's lane: one clean reproduction by its ID comes in pre-accepted; two that reproduce alike are a suggestion; none is a match to find; the dropped totals retire", async () => {
    const seen = await rowsOf(JOB_R);
    assert.deepEqual(seen.rows.map((row) => [row.legacyDbId, row.lane]), [
      ["4001", "pre-accepted"], ["4002", "unmatched"], ["4003", "suggested"], ["3001", "retiring"], ["3002", "retiring"], ["3003", "retiring"]]);
    const gas = seen.rows[0]!;
    assert.deepEqual(gas.candidates.map((candidate) => [candidate.datasetId, candidate.factorId, candidate.match.verdict, candidate.match.tco2e]), [
      ["uk-ghg-gb-2024", "uk-ghg-1_100_1004_6_1", "reproduces", 28.168063],
      ["uk-ghg-gb-2023", "uk-ghg-1_100_1004_6_1", "close", 29.26152]],
      "the ID finds the other edition too, and the recompute tells them apart; the net-CV _6_2 is not offered — the code itself found factors, so its unit index is never stripped (autopick fix §3)");
    assert.deepEqual([gas.pick?.factorId, gas.pick?.match.categoryCode, gas.pick?.invalid, gas.pick?.exactCode], ["uk-ghg-1_100_1004_6_1", "1.natural-gas", null, true]);
    assert.deepEqual(seen.rows[2]!.candidates.filter((candidate) => candidate.match.verdict === "reproduces").map((candidate) => candidate.datasetId), ["uk-ghg-gb-2023", "uk-ghg-gb-2024"],
      "two editions at one value: ambiguity, a person chooses");
    assert.deepEqual([seen.rows[1]!.candidates, seen.rows[1]!.pick], [[], null]);
    assert.ok(seen.rows.every((row) => !row.totalStillCounted));
    assert.deepEqual([seen.firstTimeMapping, seen.summaryCurrent, seen.scopeTotals["1"].v7Tco2e], [true, false, 29.100963]);
    assert.ok(!JSON.stringify(seen).includes("Rows Modal Client"), "no client name in the read");
  });

  it("the wrong-basis guard: a Scope 1 factor giving a Scope 3 row's figure is offered as figure-only, and never auto-picked", async () => {
    const travel = (await rowsOf(JOB_W)).rows[0]!;
    assert.deepEqual([travel.lane, travel.pick, travel.candidates.map((candidate) => [candidate.factorId, candidate.match.verdict, candidate.match.rightBasis])],
      ["unmatched", null, [["uk-ghg-4_301_3069_9_2", "figure-only", false]]]);
  });

  it("the smart search: any words of the ID, label, unit and dataset, any order; each hit priced against the row's unit and filed by its family", async () => {
    const found = await searchV7ImportFactors(database.pool, holder(), { jobId: JOB_R, query: "kwh gas natural 2024", unit: "kWh" });
    // Every word must appear (2024 rules out the 2023 edition); the shorter label first. The modal re-ranks by verdict for the row.
    assert.deepEqual(found.hits.map((hit) => [hit.factorId, hit.dataset, hit.sameUnit, hit.categories]), [
      ["uk-ghg-1_100_1004_6_2", "DESNZ GB 2024", true, ["1.natural-gas"]], ["uk-ghg-1_100_1004_6_1", "DESNZ GB 2024", true, ["1.natural-gas"]]]);
    const byId = await searchV7ImportFactors(database.pool, holder(), { jobId: JOB_R, query: "1_100_1020", unit: "kWh" });
    assert.deepEqual([...new Set(byId.hits.map((hit) => hit.factorId))].sort(), ["uk-ghg-1_100_1020_6_1", "uk-ghg-1_100_1020_6_9"]);
    assert.ok(byId.hits.every((hit) => hit.sameUnit === false), "per litre, against a row in kWh");
    await assert.rejects(searchV7ImportFactors(database.pool, holder(), { jobId: JOB_R, query: "   ", unit: null }), (error) => codes(error).includes("INVALID"));
  });

  it("the bulk accept: one request, each row's decision by its id through the decision command — the totals retired with them — a refused row reported, the rest kept; a retry replays", async () => {
    await upload(JOB_R, "J000903");
    const rowsBefore = (await db.query<{ p: string }>(`SELECT md5(coalesce(string_agg(r::text, '|' ORDER BY scope_row_id), '')) AS p FROM nzi_console.job_scope_rows r`)).rows[0]!.p;
    const items = [
      { kind: "map" as const, legacyDbId: "4001", categoryCode: "1.natural-gas", datasetId: "uk-ghg-gb-2024", factorId: "uk-ghg-1_100_1004_6_1", expectedDecisionId: null },
      { kind: "map" as const, legacyDbId: "4002", categoryCode: "1.natural-gas", datasetId: "uk-ghg-gb-2024", factorId: "uk-ghg-1_100_1020_6_1", expectedDecisionId: null },
      ...["3001", "3002", "3003"].map((legacyDbId) => ({ kind: "withdraw" as const, legacyDbId, expectedDecisionId: null })),
    ];
    // v17: the CRM holds import.manage, so the refusal is shown on a reviewer.
    await assert.rejects(acceptV7ImportRows(database.pool, { jobId: JOB_R, items }, context("reviewer")),
      (error) => error instanceof AuthorizationError && error.permission === "import.manage", "a reviewer cannot accept — refused before anything is written");
    const ctx = context("admin");
    const outcome = await acceptV7ImportRows(database.pool, { jobId: JOB_R, items }, ctx);
    assert.deepEqual(outcome.written.map((entry) => [entry.legacyDbId, entry.kind]), [["4001", "map"], ["3001", "withdraw"], ["3002", "withdraw"], ["3003", "withdraw"]]);
    assert.deepEqual(outcome.refused.map((entry) => [entry.legacyDbId, entry.codes]), [["4002", ["FACTOR_NOT_IN_CATEGORY"]]], "an LPG factor is not one of Natural Gas's");
    const decisions = (await db.query(`SELECT legacy_db_id, kind, factor_id FROM nzi_console.v7_import_decisions WHERE job_id = $1 AND superseded_at IS NULL ORDER BY legacy_db_id`, [JOB_R])).rows;
    assert.deepEqual(decisions, [{ legacy_db_id: "3001", kind: "withdraw", factor_id: null }, { legacy_db_id: "3002", kind: "withdraw", factor_id: null },
      { legacy_db_id: "3003", kind: "withdraw", factor_id: null }, { legacy_db_id: "4001", kind: "map", factor_id: "uk-ghg-1_100_1004_6_1" }]);
    const audit = (await db.query<{ after_json: unknown }>(`SELECT after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'import.decision.set' AND entity_id = $2`, [RM_ORG, JOB_R])).rows;
    assert.equal(audit.length, 4, "one audit event per decision, as the one-row control writes it");
    assert.ok(audit.every((event) => !/:\s*-?\d/.test(JSON.stringify(event.after_json).replace(/v7-decision-[0-9a-f-]{36}/g, ""))), "no figure in the audit");
    const again = await acceptV7ImportRows(database.pool, { jobId: JOB_R, items }, ctx);
    assert.deepEqual(again.written.map((entry) => entry.decisionId), outcome.written.map((entry) => entry.decisionId), "the same request again replays what it wrote");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.v7_import_decisions WHERE job_id = $1`, [JOB_R])).rows[0]!.n, 4, "nothing written twice");
    assert.equal((await db.query<{ p: string }>(`SELECT md5(coalesce(string_agg(r::text, '|' ORDER BY scope_row_id), '')) AS p FROM nzi_console.job_scope_rows r`)).rows[0]!.p, rowsBefore,
      "decisions only: no job row touched");
    const seen = await rowsOf(JOB_R);
    assert.deepEqual(seen.rows.map((row) => [row.legacyDbId, row.lane, row.resolution]), [
      ["4001", "accepted", "resolved"], ["4002", "unmatched", "unresolved"], ["4003", "suggested", "unresolved"],
      ["3001", "retiring", "resolved"], ["3002", "retiring", "resolved"], ["3003", "retiring", "resolved"]]);
    assert.equal(seen.summaryCurrent, true);
  });

  it("the reconcile gate: from the job, a scope that does not agree to one decimal place is refused and nothing is written; once it agrees, it is brought in and the totals retire", async () => {
    const admin = context("admin");
    await acceptV7ImportRows(database.pool, { jobId: JOB_R, items: [
      { kind: "map", legacyDbId: "4002", categoryCode: "1.natural-gas", datasetId: "uk-ghg-gb-2024", factorId: "uk-ghg-1_100_1004_6_1", expectedDecisionId: null },
      { kind: "map", legacyDbId: "4003", categoryCode: "1.other-stationary-fuels", datasetId: "uk-ghg-gb-2024", factorId: "uk-ghg-1_100_1020_6_9", expectedDecisionId: null }] }, admin);
    // LPG at 1.7 kg a litre: 0.85 t against the previous system's 0.75 — D7 carries the input exactly, and the scope is out by 0.1.
    const off = await preview();
    assert.deepEqual([off.outcome, off.scopeTotals?.["1"]], ["would-commit", { v7Tco2e: 29.100963, liveTco2e: 29.200963 }]);
    const before = await fingerprint();
    await assert.rejects(commit(off, true), (error) => codes(error).length === 1 && codes(error)[0] === "SCOPE_DOES_NOT_AGREE"
      && !JSON.stringify((error as CommandValidationError).issues).includes("29."), "named by scope, never by figure");
    assert.deepEqual(await fingerprint(), before, "refused: nothing brought in, no record, no audit");
    // The right edition: now every scope agrees, and it comes in.
    const lpg = (await db.query<{ decision_id: string }>(`SELECT decision_id FROM nzi_console.v7_import_decisions WHERE job_id = $1 AND legacy_db_id = '4003' AND superseded_at IS NULL`, [JOB_R])).rows[0]!.decision_id;
    await acceptV7ImportRows(database.pool, { jobId: JOB_R, items: [
      { kind: "map", legacyDbId: "4003", categoryCode: "1.other-stationary-fuels", datasetId: "uk-ghg-gb-2024", factorId: "uk-ghg-1_100_1020_6_1", expectedDecisionId: lpg }] }, context("admin"));
    const on = await preview();
    assert.deepEqual(on.scopeTotals?.["1"], { v7Tco2e: 29.100963, liveTco2e: 29.100963 });
    const outcome = await commit(on, true);
    assert.deepEqual([outcome.data.mode, outcome.data.plan], ["commit", { committed: 0, decided: 3 }]);
    const totals = (await db.query(`SELECT legacy_db_id, enabled FROM nzi_console.job_scope_rows WHERE job_id = $1 AND origin = 'migrated' AND migrated_record->>'original_id' LIKE 'wfm-import-scope-%' ORDER BY legacy_db_id`, [JOB_R])).rows;
    assert.ok(totals.length >= 3 && totals.every((row) => row.enabled === false), "the import totals are retired");
    const live = (await db.query<{ t: string }>(`SELECT sum(calculated_tco2e)::text AS t FROM nzi_console.job_scope_rows WHERE job_id = $1 AND origin = 'live' AND enabled`, [JOB_R])).rows[0]!.t;
    assert.equal(Math.round(Number(live) * 1e6) / 1e6, 29.100963, "the activity rows are the job's native entries, at the previous system's figure");
  });
});

/**
 * BRIEF-v7-import-rows-autopick-fix (24 Nov), after the J000434 live check: the lanes were wrong though the data reconciled. A job
 * shaped as J000434 is — 41 live rows, 12 switched off in the previous system, 3 import totals; 56 in the read — on the factor codes
 * and rates the live check cites. Synthetic: no client, site, label or quantity of the real job (the repository holds no client
 * data); the three linked pairs are not in it (carried as one, proven above). After the fix every live row comes in pre-accepted on
 * the previous system's own factor in the job's year; the switched-off rows come in switched off and are never counted (ruled 24 Nov).
 */
describe("the import rows modal's auto-pick, on a job shaped as J000434: the job-year anchor, switched-off rows, the ordered ID, the previous system's category", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const AP_ORG = "v7-autopick";
  const JOB_J = "v7-job-j", JOB_S = "v7-job-s", JOB_N = "v7-job-n";
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (role: "admin" | "consultant" = "admin", reason?: string): CommandContext => {
    keys += 1;
    const actorId = `staff-${role}`;
    return { organisationId: AP_ORG, actorId, principal: "staff", idempotencyKey: `ap-${keys}`, correlationId: `ap-corr-${keys}`, ...(reason ? { reason } : {}),
      grant: commandGrantForRole(role, AP_ORG, actorId) };
  };
  const importer = (): CommandContext => {
    keys += 1;
    return { organisationId: AP_ORG, actorId: V7_IMPORT_ACTOR, principal: "staff", idempotencyKey: `ap-${keys}`, correlationId: `ap-corr-${keys}`,
      grant: commandGrantForRole("admin", AP_ORG, V7_IMPORT_ACTOR) };
  };
  const holder = () => commandGrantForRole("consultant", AP_ORG, "staff-consultant");
  const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

  // The factor families the live check names: V7's own factor in the job's year (2024), and another year beside it.
  // `unit`: the console factor's; `v7Uom`: the previous system's spelling on its rows, where it differs (energy's calorific value).
  type Family = { code: string; scope: "1" | "3"; unit: string; v7Uom?: string; levels: string[]; label: string; v7Category: string; rates: Array<[string, number]>; lookup: string | null };
  const HGV: Family = { code: "5_304_3140_9_1", scope: "1", unit: "miles", levels: ["Delivery vehicles", "HGV (all diesel)", "Average laden"], label: "HGV · diesel · average laden",
    v7Category: "Company Vehicles", rates: [["uk-ghg-gb-2024", 1.40489], ["uk-ghg-gb-2023", 1.40341]], lookup: "f-hgv" };
  const VAN: Family = { code: "5_301_3140_9_2", scope: "1", unit: "miles", levels: ["Delivery vehicles", "Vans", "Diesel"], label: "Van · diesel · average",
    v7Category: "Company Vehicles", rates: [["uk-ghg-gb-2024", 0.27332], ["uk-ghg-gb-2023", 0.27298]], lookup: "f-van" };
  // Natural gas as J000434 holds it (10357/10358): v7 records it in kWh (Gross CV); the console's factor is in kWh — the same unit.
  const GAS: Family = { code: "1_100_1004_6_1", scope: "1", unit: "kWh", v7Uom: "kWh (Gross CV)", levels: ["Fuels", "Gaseous fuels", "Natural gas"], label: "Natural gas — kWh (Gross CV)",
    v7Category: "Fuels", rates: [["uk-ghg-gb-2024", 0.1829], ["uk-ghg-gb-2023", 0.18293]], lookup: "f-gas" };
  // Natural gas in net CV, against a factor the console stores in kWh (its label carries the CV): never the same unit.
  const GAS_NET: Family = { code: "1_100_1004_6_2", scope: "1", unit: "kWh", v7Uom: "kWh (Net CV)", levels: ["Fuels", "Gaseous fuels", "Natural gas"], label: "Natural gas — kWh (Net CV)",
    v7Category: "Fuels", rates: [["uk-ghg-gb-2024", 0.20297]], lookup: "f-gasnet" };
  const GAS_OIL: Family = { code: "1_100_1012_7_1", scope: "1", unit: "litres", levels: ["Fuels", "Liquid fuels", "Gas oil"], label: "Gas oil",
    v7Category: "Fuels", rates: [["uk-ghg-gb-2024", 2.75857], ["uk-ghg-gb-2023", 2.75776]], lookup: "f-gasoil" };
  const CAR: Family = { code: "25_301_3069_9_2", scope: "3", unit: "miles", levels: ["Business travel- land", "Cars (by size)", "Small car"], label: "Business travel · small car · petrol",
    v7Category: "Business Travel", rates: [["uk-ghg-gb-2024", 0.23818], ["uk-ghg-gb-2023", 0.23791]], lookup: "f-car" };
  // Walking, as a commuting row (`-c`): its own code in every NZI year, at a zero rate; Cycling beside it, also zero.
  const WALK: Family = { code: "99_316_3160_11_2", scope: "3", unit: "km", levels: ["Business travel- land", "Walking"], label: "Walking",
    v7Category: "Employee Commuting", rates: [["nzi-gb-2024", 0], ["nzi-gb-2019", 0]], lookup: null };
  const CYCLE = { code: "99_316_3160_11_3", label: "Cycling", rates: [["nzi-gb-2024", 0], ["nzi-gb-2019", 0]] as Array<[string, number]> };

  const v7Categories: Record<string, string> = {};
  const row = (id: string, family: Family, qty: number, enabled: boolean): PlannedRow => {
    const rate = family.rates[0]![1];
    const reported = round6(qty * rate / 1000);
    const base = plannedRow({ id, scope: family.scope, label: family.label, qty, unit: family.v7Uom ?? family.unit, reported });
    v7Categories[id] = family.v7Category;
    return { ...base, level1: family.levels[0]!, level2: family.levels[1] ?? family.levels[0]!, level3: family.levels[2] ?? null, enabled, counted: enabled,
      migratedRecord: { ...(base.migratedRecord as unknown as Record<string, unknown>), original_id: family === WALK ? `${family.code}-c` : family.code, factor: rate,
        factor_db_id: family.lookup, uom: family.v7Uom ?? family.unit, enabled } as unknown as PlannedRow["migratedRecord"] };
  };
  // 41 live: 10 HGV, 11 van (one the duplicate's twin, below), 4 gas oil, 2 natural gas (kWh (Gross CV)), 11 business car, 3 walking. Small quantities make the
  // other year reproduce to 1 dp too (F1).
  const live: PlannedRow[] = [];
  const families: Array<[Family, number]> = [[HGV, 10], [VAN, 10], [GAS_OIL, 4], [GAS, 2], [CAR, 11], [WALK, 3]];
  let n = 10300;
  for (const [family, count] of families) for (let at = 0; at < count; at += 1) live.push(row(String(n += 1), family, 400 + at * 2_311.7, true));
  // 12 switched off: among them the duplicate of a live van row — 87,803 miles, 24.0 t — that would count twice if it came in on.
  const DUPLICATE_OF = row(String(n += 1), VAN, 87_803, true);
  const DUPLICATE = row("10372", VAN, 87_803, false);
  const off: PlannedRow[] = [DUPLICATE, ...[HGV, HGV, HGV, VAN, VAN, VAN, VAN, VAN, CAR, CAR, CAR].map((family, at) => row(String(10_500 + at), family, 150 + at * 911.3, false))];
  const JOB_ROWS = [...live, DUPLICATE_OF, ...off];
  const totalRow = (scope: "1" | "2" | "3", id: string): PlannedRow => {
    const base = plannedRow({ id, scope: scope === "2" ? "1" : scope, label: "Imported Totals", qty: 1000, unit: "kgCO2e", reported: 1 });
    return { ...base, scope, v7Scope: scope, migratedRecord: { ...base.migratedRecord, original_id: `wfm-import-scope-${scope}`, data_source: "WFM Import" } as PlannedRow["migratedRecord"] };
  };
  // A second job, of 2025 — no 2025 edition exists, so nothing is the anchor: two editions reproduce alike, a suggestion each.
  const SUGGESTED = [row("20001", HGV, 300, true), row("20002", CAR, 250, true)];
  // A third job of 2024: one natural gas row in net CV.
  const NET = [row("30001", GAS_NET, 50_000, true)];
  const holds = new Map<string, readonly PlannedRow[]>([[JOB_J, JOB_ROWS], [JOB_S, SUGGESTED], [JOB_N, NET]]);
  const source: V7ImportRefreshSource = async (_db, job) => ({ sourceSha256: "a".repeat(64), rows: holds.get(job.jobId)!, v7Categories });
  const EMPTY_PLAN = (jobId: string) => ({ jobId, crosswalkVersion: "none", crosswalkSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", vintageDatasetIds: [], rows: [] });
  const rowsOf = (jobId: string) => readV7ImportRows(database.pool, source, holder(), jobId, { basePlan: EMPTY_PLAN(jobId) });
  const upload = async (jobId: string, legacyJobNumber: string) => {
    const summary = await withTenantWrite(database.pool, AP_ORG, (client) => summariseV7JobAsTheChainSees(client,
      { organisationId: AP_ORG, jobId, legacyJobNumber, extractSha256: "a".repeat(64), rows: holds.get(jobId)!, generatedAt: "2026-11-24T12:00:00.000Z" }));
    await uploadV7ImportSummary(database.pool, { jobId, summary }, importer());
  };
  /** What "Accept all matched" sends (the modal's pendingAccepts): every pre-accepted and switched-off pick, and the totals retiring. */
  const acceptAll = (rows: Awaited<ReturnType<typeof rowsOf>>["rows"]) => [
    ...rows.filter((entry) => (entry.lane === "pre-accepted" || entry.lane === "switched-off") && entry.pick?.match.categoryCode).map((entry) => ({ kind: "map" as const,
      legacyDbId: entry.legacyDbId, categoryCode: entry.pick!.match.categoryCode!, datasetId: entry.pick!.datasetId, factorId: entry.pick!.factorId, expectedDecisionId: null })),
    ...rows.filter((entry) => entry.lane === "retiring" && entry.ownStatus === "withdrawn").map((entry) => ({ kind: "withdraw" as const, legacyDbId: entry.legacyDbId, expectedDecisionId: null })),
  ];

  before(async () => {
    database = (await createDisposableDatabase("v7autopick"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [AP_ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [AP_ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [AP_ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'ca','Autopick Client','active')`, [AP_ORG]);
    for (const [user, role] of [["staff-admin", "admin"], ["staff-consultant", "consultant"]]) {
      await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $2)`, [AP_ORG, user, role]);
    }
    const DATASETS = [["uk-ghg-gb-2024", "DESNZ GB 2024", "2024-01-01"], ["uk-ghg-gb-2023", "DESNZ GB 2023", "2023-01-01"], ["nzi-gb-2024", "NZI GB 2024", "2024-01-01"], ["nzi-gb-2019", "NZI GB 2019", "2019-01-01"]] as const;
    // As the reference import loads them: the previous system's datasets, by family — a factor's identity takes its family from here.
    for (const [ds, name, from] of DATASETS) {
      await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence,
                        source_system,source_family,legacy_dataset_id,content_sha256)
                      VALUES ($1,$2,$3,'1',$4,'2026-12-31','GB','active','Test','Source: test.','nzi-pro-v7',$5,$2,repeat('a',64))`, [AP_ORG, ds, name, from, ds.split("-gb-")[0]]);
    }
    const factor = async (ds: string, code: string, label: string, unit: string, rate: number, scope: string, levels: string[], lookup: string | null) =>
      db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels,source_system,legacy_db_id,legacy_original_id)
                VALUES ($1,$2,$3,$4,$5,$6,ARRAY[$7::text],$8::text[],$9,$10,$11)`,
        [AP_ORG, ds, `${ds.split("-")[0] === "nzi" ? "nzi" : "uk-ghg"}-${code}`, label, unit, rate, scope, levels, lookup ? "nzi-pro-v7" : null, lookup, code]);
    for (const family of [HGV, VAN, GAS, GAS_NET, GAS_OIL, CAR, WALK]) {
      for (const [at, [ds, rate]] of family.rates.entries()) await factor(ds, family.code, family.label, family.unit, rate, family.scope, family.levels, at === 0 ? family.lookup : null);
    }
    for (const [ds, rate] of CYCLE.rates) await factor(ds, CYCLE.code, CYCLE.label, "km", rate, "3", ["Business travel- land", "Cycling"], null);
    for (const [jobId, sequence, number, year] of [[JOB_J, 906, "J000906", 2024], [JOB_S, 907, "J000907", 2025], [JOB_N, 908, "J000908", 2024]] as const) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
        VALUES ($1,$2,'ca',$3,'crp','CRP','open','Data entry',$4,$5,$6,'nzi-pro-v7',$7,$8)`, [AP_ORG, jobId, sequence, year, `${year}-01-01`, `${year}-12-31`, String(sequence), number]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`, [AP_ORG, jobId, `${year}-01-01`, `${year}-12-31`]);
      for (const [ds] of DATASETS) await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
        VALUES ($1,$2,$3,'manual','the job''s datasets (test)','staff-admin')`, [AP_ORG, jobId, ds]);
    }
    for (const total of [totalRow("1", "3001"), totalRow("2", "3002"), totalRow("3", "3003")]) await insert(db, "job_scope_rows", [
      { column: "organisation_id", value: AP_ORG, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
      { column: "legacy_db_id", value: total.legacyDbId, type: "text" }, ...migratedRowCols(JOB_J, total)]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("the counts: 56 rows read — 41 live all pre-accepted, 12 switched off, 3 totals retiring; nothing suggested, nothing to find", async () => {
    const seen = await rowsOf(JOB_J);
    const lanes = new Map<string, number>();
    for (const entry of seen.rows) lanes.set(entry.lane, (lanes.get(entry.lane) ?? 0) + 1);
    assert.equal(seen.rows.length, 56);
    assert.deepEqual(Object.fromEntries(lanes), { "pre-accepted": 41, "switched-off": 12, retiring: 3 });
    assert.ok(seen.rows.filter((entry) => entry.lane === "switched-off").every((entry) => entry.pick !== null && entry.pick.identity && entry.pick.anchor),
      "each switched-off row comes in on the previous system's own factor");
  });

  it("the job-year anchor (F1): another year reproducing to 1 dp is an alternative, never ambiguity", async () => {
    const small = (await rowsOf(JOB_J)).rows.find((entry) => entry.legacyDbId === "10301")!;
    const reproducing = small.candidates.filter((candidate) => candidate.match.verdict === "reproduces");
    assert.deepEqual(reproducing.map((candidate) => [candidate.datasetId, candidate.anchor]), [["uk-ghg-gb-2024", true], ["uk-ghg-gb-2023", false]], "two years reproduce 400 miles of HGV");
    assert.deepEqual([small.lane, small.pick?.datasetId, small.pick?.identity, small.pick?.year], ["pre-accepted", "uk-ghg-gb-2024", true, 2024]);
  });

  it("the ordered ID and the zero rate (F3): walking (_11_2-c) comes in on Walking in the job's NZI year, never Cycling", async () => {
    const walks = (await rowsOf(JOB_J)).rows.filter((entry) => entry.previous.factorCode === "99_316_3160_11_2-c");
    assert.equal(walks.length, 3);
    for (const walk of walks) {
      assert.deepEqual([walk.lane, walk.pick?.factorId, walk.pick?.datasetId, walk.pick?.match.categoryCode], ["pre-accepted", "nzi-99_316_3160_11_2", "nzi-gb-2024", "3.7"]);
      assert.ok(!walk.candidates.some((candidate) => candidate.code === CYCLE.code), "Cycling is not a candidate: the core is _11_2, the unit index never stripped too");
      assert.deepEqual(walk.candidates.filter((candidate) => !candidate.anchor).map((candidate) => [candidate.datasetId, candidate.match.verdict]), [["nzi-gb-2019", "figure-only"]],
        "the other year's zero: the figure only");
    }
  });

  it("the previous system's category (F4): gas oil filed under Other Stationary Fuels, business travel under 3.6", async () => {
    const seen = (await rowsOf(JOB_J)).rows;
    const of = (code: string) => [...new Set(seen.filter((entry) => entry.previous.factorCode === code && entry.lane === "pre-accepted").map((entry) => entry.pick?.match.categoryCode))];
    assert.deepEqual(of(GAS_OIL.code), ["1.other-stationary-fuels"], "Liquid fuels files under both; V7's Fuels settles it");
    assert.deepEqual(of(CAR.code), ["3.6"]);
    assert.ok(seen.filter((entry) => entry.previous.factorCode === GAS_OIL.code).every((entry) => entry.categories.length === 2), "the levels alone name two");
  });

  it("Accept all, then bring in: every scope agrees; the switched-off rows come in switched off — the duplicate 10372 is not counted, in the totals or the report's rows", async () => {
    await upload(JOB_J, "J000906");
    const outcome = await acceptV7ImportRows(database.pool, { jobId: JOB_J, items: acceptAll((await rowsOf(JOB_J)).rows) }, context());
    assert.deepEqual([outcome.written.length, outcome.refused], [41 + 12 + 3, []]);
    const preview = await previewV7ImportRefresh(database.pool, source, { jobId: JOB_J, mode: "preview" }, context("consultant"), { basePlan: EMPTY_PLAN(JOB_J) });
    assert.equal(preview.outcome, "would-commit");
    const v7 = (scope: "1" | "3") => round6(JOB_ROWS.filter((entry) => entry.enabled && entry.scope === scope).reduce((sum, entry) => sum + entry.calculatedTco2e, 0));
    assert.deepEqual([preview.scopeTotals?.["1"].v7Tco2e, preview.scopeTotals?.["3"].v7Tco2e], [v7("1"), v7("3")], "the previous system's totals leave its switched-off rows out");
    const committed = await commitV7ImportRefresh(database.pool, source, { jobId: JOB_J, mode: "commit", summarySha256: preview.summarySha256, decisionsSha256: preview.decisionsSha256 },
      context("consultant", "bring J000906 in from the previous system (test)"), { basePlan: EMPTY_PLAN(JOB_J), requireScopesAgree: true });
    assert.equal(committed.data.mode, "commit", "the reconcile gate passed: every scope agrees to one decimal place");
    const duplicate = (await db.query<{ enabled: boolean; origin: string }>(`SELECT enabled, origin FROM nzi_console.job_scope_rows WHERE job_id = $1 AND legacy_db_id = '10372' AND superseded_by_row_id IS NULL
      UNION ALL SELECT enabled, origin FROM nzi_console.job_scope_rows WHERE job_id = $1 AND reingested_from_row_id = 'v7-row-10372'`, [JOB_J])).rows;
    assert.ok(duplicate.length > 0 && duplicate.every((entry) => entry.enabled === false), "10372 is held, switched off — as the previous system holds it");
    const counted = async (scope: string) => round6(Number((await db.query<{ t: string | null }>(`SELECT sum(coalesce(override_tco2e, calculated_tco2e))::text AS t FROM nzi_console.job_scope_rows
      WHERE job_id = $1 AND origin = 'live' AND enabled AND split_part(scope, '.', 1) = $2`, [JOB_J, scope])).rows[0]!.t ?? 0));
    for (const scope of ["1", "3"] as const) {
      assert.ok(Math.abs((await counted(scope)) - v7(scope)) < 1e-5, `Scope ${scope}: the job's counted rows are the previous system's total, 24.0 t not twice`);
    }
    const offCounted = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE job_id = $1 AND enabled AND
      (legacy_db_id = ANY($2::text[]) OR reingested_from_row_id = ANY($3::text[]))`, [JOB_J, off.map((entry) => entry.legacyDbId), off.map((entry) => entry.scopeRowId)])).rows[0]!.n;
    assert.equal(offCounted, 0, "no switched-off row is counted anywhere a report reads the job's enabled rows");
  });

  it("Accept all suggested: each suggestion's pick by row id through import.decision.set; a refused item reported, the rest kept", async () => {
    const seen = await rowsOf(JOB_S);
    assert.deepEqual(seen.rows.map((entry) => [entry.legacyDbId, entry.lane]), [["20001", "suggested"], ["20002", "suggested"]], "a 2025 job: two editions reproduce, no anchor");
    await upload(JOB_S, "J000907");
    const items = seen.rows.map((entry) => ({ kind: "map" as const, legacyDbId: entry.legacyDbId, categoryCode: entry.pick!.match.categoryCode!, datasetId: entry.pick!.datasetId,
      factorId: entry.pick!.factorId, expectedDecisionId: null }));
    // One the decision command refuses: the car's pick filed under a category its family does not offer.
    const refusedItem = { ...items[1]!, categoryCode: "1.natural-gas" };
    const outcome = await acceptV7ImportRows(database.pool, { jobId: JOB_S, items: [items[0]!, refusedItem] }, context());
    assert.deepEqual(outcome.written.map((entry) => [entry.legacyDbId, entry.kind]), [["20001", "map"]]);
    assert.deepEqual(outcome.refused.map((entry) => entry.legacyDbId), ["20002"]);
    const decisions = (await db.query(`SELECT legacy_db_id, kind, dataset_id, factor_id FROM nzi_console.v7_import_decisions WHERE job_id = $1 AND superseded_at IS NULL ORDER BY legacy_db_id`, [JOB_S])).rows;
    assert.deepEqual(decisions, [{ legacy_db_id: "20001", kind: "map", dataset_id: items[0]!.datasetId, factor_id: items[0]!.factorId }]);
    const audit = (await db.query(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'import.decision.set' AND entity_id = $2`, [AP_ORG, JOB_S])).rows[0]!.n;
    assert.equal(audit, 1, "one audit event per decision written");
  });

  // J000434's refused bring-in (24 Nov): "v7-row-10357/10358: the plan's unit kWh (Gross CV) is not v7's kWh". One unit rule now.
  it("natural gas held in kWh (Gross CV), on the factor in kWh: matched, and brought in — on the factor's unit, v7's quantity", async () => {
    const gas = live.filter((entry) => entry.migratedRecord.original_id === GAS.code);
    assert.equal(gas.length, 2);
    const live2 = (await db.query<{ legacy: string; unit: string; quantity: string; enabled: boolean }>(`SELECT m.legacy_db_id AS legacy, l.unit, l.quantity::text AS quantity, l.enabled
      FROM nzi_console.job_scope_rows l JOIN nzi_console.job_scope_rows m ON (m.organisation_id, m.scope_row_id) = (l.organisation_id, l.reingested_from_row_id)
      WHERE l.job_id = $1 AND l.origin = 'live' AND l.enabled AND m.legacy_db_id = ANY($2::text[]) ORDER BY 1`, [JOB_J, gas.map((entry) => entry.legacyDbId)])).rows;
    assert.deepEqual(live2.map((entry) => [entry.legacy, entry.unit, Number(entry.quantity)]), gas.map((entry) => [entry.legacyDbId, "kWh", entry.quantity]),
      "the bring-in above went through with both: no PLAN_QUANTITY_MISMATCH on the unit");
  });

  it("natural gas in kWh (Net CV) on a factor in kWh: Need a match with the reason before anything is pressed — and still refused when brought in, nothing written", async () => {
    const seen = (await rowsOf(JOB_N)).rows[0]!;
    assert.deepEqual([seen.lane, seen.pick], ["unmatched", null]);
    assert.match(seen.held ?? "", /kWh \(Net CV\).*priced per kWh.*refused/, "the reason, on the row");
    const own = seen.candidates.find((candidate) => candidate.identity)!;
    assert.deepEqual([own.match.verdict, own.unitRefusal !== null, own.invalid !== null], ["unit-mismatch", true, true], "its own factor, and why it cannot come in on it");
    // Forced: the decision written by hand — the modal still holds it, and bringing it in refuses it.
    await upload(JOB_N, "J000908");
    const forced = await acceptV7ImportRows(database.pool, { jobId: JOB_N, items: [{ kind: "map", legacyDbId: "30001", categoryCode: "1.natural-gas",
      datasetId: own.datasetId, factorId: own.factorId, expectedDecisionId: null }] }, context());
    assert.equal(forced.written.length, 1);
    const after = (await rowsOf(JOB_N)).rows[0]!;
    assert.deepEqual([after.resolution, after.lane], ["resolved", "unmatched"], "an accepted decision bringing it in would refuse goes back to Need a match");
    assert.match(after.held ?? "", /refused/);
    const before = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE job_id = $1 AND origin = 'live'`, [JOB_N])).rows[0]!.n;
    const preview = await previewV7ImportRefresh(database.pool, source, { jobId: JOB_N, mode: "preview" }, context("consultant"), { basePlan: EMPTY_PLAN(JOB_N) });
    assert.equal(preview.outcome, "refused", JSON.stringify(preview.refusal));
    assert.ok(preview.refusal?.issues.some((issue) => /unit|kWh/i.test(issue.message)), JSON.stringify(preview.refusal?.issues));
    await assert.rejects(commitV7ImportRefresh(database.pool, source, { jobId: JOB_N, mode: "commit", summarySha256: preview.summarySha256, decisionsSha256: preview.decisionsSha256 },
      context("consultant", "bring J000908 in (test)"), { basePlan: EMPTY_PLAN(JOB_N), requireScopesAgree: true }), (error) => error instanceof CommandValidationError);
    assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE job_id = $1 AND origin = 'live'`, [JOB_N])).rows[0]!.n, before, "nothing written");
  });
});

/**
 * BRIEF-v7-import-j000663 §A: a snapshot blocks a revert, never a read. J000663 was re-ingested and then snapshotted, and its rows
 * read refused with the revert's SNAPSHOT_EXISTS: every read compares the job's rows as the chain will see them, by running the
 * revert under a savepoint it rolls back, and that revert reached the snapshot gate. The comparison now skips that gate; the
 * revert itself does not.
 */
describe("a snapshotted job: the rows read, the mapping read and the refresh preview return and write nothing; the revert is still refused", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const SN_ORG = "v7-snapshotted";
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  let standing = "";
  const context = (role: "admin" | "consultant" = "consultant"): CommandContext => {
    keys += 1;
    return { organisationId: SN_ORG, actorId: `staff-${role}`, principal: "staff", idempotencyKey: `sn-${keys}`, correlationId: `sn-corr-${keys}`, grant: commandGrantForRole(role, SN_ORG, `staff-${role}`) };
  };
  const holder = () => commandGrantForRole("consultant", SN_ORG, "staff-consultant");
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const withoutRun = ({ runId: _runId, ...rest }: V7ReingestJobInput) => rest;
  const source: V7ImportRefreshSource = async () => ({ sourceSha256: "e".repeat(64), rows: NOW });
  const options = { basePlan: withoutRun(PLAN_BEFORE("x")) };
  const fingerprint = async () => {
    const tables = (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'nzi_console' ORDER BY tablename`)).rows.map((row) => row.t);
    const prints: Record<string, string> = {};
    for (const table of tables) prints[table] = (await db.query<{ p: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS p FROM nzi_console.${table} t`)).rows[0]!.p;
    return prints;
  };

  before(async () => {
    database = (await createDisposableDatabase("v7snapshotted"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [SN_ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [SN_ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [SN_ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Snapshotted Test','active')`, [SN_ORG]);
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
      VALUES ($1,$2,'c1',901,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7','901','J000901')`, [SN_ORG, JOB_A]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [SN_ORG, JOB_A]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [SN_ORG]);
    for (const [id, label, unit, kg, scope, levels] of [["gas", "Natural gas", "kWh", 0.2, "1", ["Fuels", "Gaseous fuels", "Natural gas"]], ["water", "Water supply", "m3", 0.15, "3", []]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6::text],$7::text[])`,
        [SN_ORG, id, label, unit, kg, scope, levels]);
    }
    for (const row of BEFORE) await insert(db, "job_scope_rows", [
      { column: "organisation_id", value: SN_ORG, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
      { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(JOB_A, row)]);
    standing = `v7-reingest-${randomUUID()}`;
    await withTenantWrite(database.pool, SN_ORG, (client) => reingestV7JobInTransaction(client, { ...PLAN_BEFORE(standing) },
      { organisationId: SN_ORG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: standing, correlationId: standing,
        reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", SN_ORG, V7_REINGEST_ACTOR) }));
    // Then reviewed and frozen, as J000663 was: a snapshot taken after the re-ingest.
    await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
                    VALUES ($1,'snap-after-reingest',$2,1,1,'sha256:' || repeat('a', 64),'{}'::jsonb,'staff-1')`, [SN_ORG, JOB_A]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("the rows read returns every row of the previous system, and writes nothing", async () => {
    const before = await fingerprint();
    const rows = await readV7ImportRows(database.pool, source, holder(), JOB_A, options);
    assert.deepEqual(rows.rows.map((row) => [row.legacyDbId, row.ownStatus]).sort(), [["1001", "changed"], ["1002", "matched"], ["1003", "withdrawn"], ["1004", "new"]]);
    assert.deepEqual(await fingerprint(), before);
  });

  it("the mapping read returns, and writes nothing", async () => {
    const before = await fingerprint();
    const mapping = await readV7ImportMapping(database.pool, source, holder(), JOB_A, options);
    assert.equal(mapping.rows.length, 4);
    assert.deepEqual(await fingerprint(), before);
  });

  it("the refresh preview returns, and writes nothing", async () => {
    const before = await fingerprint();
    const seen = await previewV7ImportRefresh(database.pool, source, { jobId: JOB_A, mode: "preview" }, context(), options);
    assert.deepEqual([seen.outcome, seen.verdict, seen.refusal?.stage], ["refused", "needs-mapping", "ready"]);
    assert.deepEqual(await fingerprint(), before);
  });

  it("the revert is still refused with SNAPSHOT_EXISTS, and nothing is written", async () => {
    const before = await fingerprint();
    await assert.rejects(withTenantWrite(database.pool, SN_ORG, (client) => revertV7ReingestInTransaction(client, { jobId: JOB_A, runId: standing },
      { organisationId: SN_ORG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: `sn-revert-${randomUUID()}`, correlationId: "sn-revert",
        reason: "revert (test)", grant: commandGrantForRole("admin", SN_ORG, V7_REINGEST_ACTOR) })), (error) => codes(error).includes("SNAPSHOT_EXISTS"));
    assert.deepEqual(await fingerprint(), before);
    assert.equal((await db.query(`SELECT status FROM nzi_console.v7_reingest_runs WHERE run_id = $1`, [standing])).rows[0]!.status, "completed");
  });
});

/**
 * BRIEF-v7-import-j000663 §B (ruled 24 Nov 2026): V7 is the source, so a person may bring the previous system's rows in on a
 * snapshotted job. The snapshot is never edited: it is kept, and recorded as superseded by the ingest (0234). QA reopens (the rows
 * come in pending), and no report is validated or issued from the superseded snapshot until a new one is taken. A published
 * version stands untouched; the job says it is behind the previous system.
 */
describe("bring-in on a snapshotted job: the snapshot kept and superseded, QA reopened, the report blocked until re-composed", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const BI_ORG = "v7-bring-in";
  const HASH = `sha256:${"a".repeat(64)}`;
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  let standing = "";
  const context = (role: "admin" | "consultant" = "consultant", reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: BI_ORG, actorId: `staff-${role}`, principal: "staff", idempotencyKey: `bi-${keys}`, correlationId: `bi-corr-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole(role, BI_ORG, `staff-${role}`) };
  };
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const withoutRun = ({ runId: _runId, ...rest }: V7ReingestJobInput) => rest;
  const source: V7ImportRefreshSource = async () => ({ sourceSha256: "e".repeat(64), rows: NOW });
  const plan = { basePlan: withoutRun(PLAN_BEFORE("x")) };
  const snapshotRow = async () => (await db.query<{ t: string }>(`SELECT to_jsonb(s)::text AS t FROM nzi_console.reviewed_crp_snapshots s WHERE snapshot_id = 'snap-bi'`)).rows[0]!.t;
  const decide = (input: Record<string, unknown>) => setV7ImportDecision(database.pool, { jobId: JOB_A, sourceSystem: "nzi-pro-v7", ...input } as never, context("admin"));
  const registerRow = async () => (await withTenantRead(database.pool, BI_ORG, (client) => listReportStatusRegister(client, { jobId: JOB_A })))[0]!;

  before(async () => {
    database = (await createDisposableDatabase("v7bringin"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [BI_ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [BI_ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [BI_ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Bring-in Test','active')`, [BI_ORG]);
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
      VALUES ($1,$2,'c1',901,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7','901','J000901')`, [BI_ORG, JOB_A]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [BI_ORG, JOB_A]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [BI_ORG]);
    for (const [id, label, unit, kg, scope, levels] of [["gas", "Natural gas", "kWh", 0.2, "1", ["Fuels", "Gaseous fuels", "Natural gas"]], ["water", "Water supply", "m3", 0.15, "3", []]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6::text],$7::text[])`,
        [BI_ORG, id, label, unit, kg, scope, levels]);
    }
    for (const row of BEFORE) await insert(db, "job_scope_rows", [
      { column: "organisation_id", value: BI_ORG, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
      { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(JOB_A, row)]);
    standing = `v7-reingest-${randomUUID()}`;
    await withTenantWrite(database.pool, BI_ORG, (client) => reingestV7JobInTransaction(client, { ...PLAN_BEFORE(standing) },
      { organisationId: BI_ORG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: standing, correlationId: standing,
        reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", BI_ORG, V7_REINGEST_ACTOR) }));
    // As J000663 stood: QA approved, then reviewed and frozen — a snapshot, and a version validated on it.
    await db.query(`UPDATE nzi_console.job_scope_rows SET review_status = 'approved', reviewed_row_version = version, reviewed_by = 'staff-reviewer', reviewed_at = now()
                     WHERE job_id = $1 AND origin = 'live' AND enabled`, [JOB_A]);
    await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
                    VALUES ($1,'snap-bi',$2,1,1,$3,'{"measurements":[]}'::jsonb,'staff-1')`, [BI_ORG, JOB_A, HASH]);
    await db.query(`INSERT INTO nzi_console.report_versions (organisation_id,report_version_id,job_id,status,manifest_version,reviewed_snapshot_id,data_hash) VALUES ($1,'rv-bi',$2,'validated',1,'snap-bi',$3)`, [BI_ORG, JOB_A, HASH]);
    // The person's decisions, made against a stored summary: the deleted row goes off, the new one is mapped.
    const summary = await withTenantWrite(database.pool, BI_ORG, (client) => summariseV7JobAsTheChainSees(client,
      { organisationId: BI_ORG, jobId: JOB_A, legacyJobNumber: "J000901", extractSha256: "e".repeat(64), rows: NOW, generatedAt: "2026-11-24T09:00:00.000Z" }));
    await uploadV7ImportSummary(database.pool, { jobId: JOB_A, summary }, { organisationId: BI_ORG, actorId: V7_IMPORT_ACTOR, principal: "staff", idempotencyKey: "bi-upload",
      correlationId: "bi-upload", grant: commandGrantForRole("admin", BI_ORG, V7_IMPORT_ACTOR) });
    await decide({ legacyDbId: "1003", kind: "withdraw" });
    await decide({ legacyDbId: "1004", kind: "map", categoryCode: "1.natural-gas", datasetId: "v7-vintage-2025", factorId: "gas" });
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("without the job route's bring-in, a snapshotted job is still refused (SNAPSHOT_EXISTS), and the fast path never brings in on one", async () => {
    const seen = await previewV7ImportRefresh(database.pool, source, { jobId: JOB_A, mode: "preview" }, context(), plan);
    assert.deepEqual([seen.outcome, seen.refusal?.stage, seen.refusal?.issues.map((issue) => issue.code)], ["refused", "revert", ["SNAPSHOT_EXISTS"]]);
    await assert.rejects(commitV7ImportRefresh(database.pool, source, { jobId: JOB_A, mode: "commit", summarySha256: seen.summarySha256, decisionsSha256: seen.decisionsSha256 },
      context("consultant", "bring-in (test)"), plan), (error) => codes(error).includes("SNAPSHOT_EXISTS"));
    const fast = await refreshV7ImportFastPath(database.pool, source, JOB_A, context(), { ...plan, allowSnapshotted: true });
    assert.equal(fast.fastPath, "deliberate");
    assert.deepEqual([fast.preview.refusal?.stage, fast.preview.refusal?.issues.map((issue) => issue.code)], ["revert", ["SNAPSHOT_EXISTS"]],
      "the fast path turns bring-in off itself: its own preview is refused on the snapshot");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.reviewed_crp_snapshot_supersessions`)).rows[0]!.n, 0);
  });

  let ingestId = "";
  it("the job route's bring-in commits: the snapshot's bytes unchanged and recorded as superseded by the ingest, audited by id", async () => {
    const bytes = await snapshotRow();
    const options = { ...plan, allowSnapshotted: true };
    const seen = await previewV7ImportRefresh(database.pool, source, { jobId: JOB_A, mode: "preview" }, context(), options);
    assert.equal(seen.outcome, "would-commit", JSON.stringify(seen.refusal));
    const outcome = await commitV7ImportRefresh(database.pool, source, { jobId: JOB_A, mode: "commit", summarySha256: seen.summarySha256, decisionsSha256: seen.decisionsSha256 },
      context("consultant", "bring V7's current rows in (test)"), options);
    ingestId = outcome.data.ingestId;
    assert.equal(await snapshotRow(), bytes, "the snapshot row is byte for byte as it was");
    const marks = (await db.query(`SELECT snapshot_id, job_id, superseded_by_ingest_id, created_by FROM nzi_console.reviewed_crp_snapshot_supersessions`)).rows;
    assert.deepEqual(marks, [{ snapshot_id: "snap-bi", job_id: JOB_A, superseded_by_ingest_id: ingestId, created_by: "staff-consultant" }]);
    const audit = (await db.query(`SELECT entity_id, after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'report.snapshot.superseded'`, [BI_ORG])).rows;
    assert.deepEqual(audit, [{ entity_id: "snap-bi", after_json: { superseded: true, jobId: JOB_A, ingestId } }]);
    assert.deepEqual((await db.query(`SELECT status FROM nzi_console.v7_reingest_runs WHERE job_id = $1 ORDER BY created_at`, [JOB_A])).rows.map((row) => row.status), ["reverted", "completed"]);
  });

  it("QA reopens: every row brought in is pending, and the job is not ready for reporting", async () => {
    const rows = (await db.query<{ review_status: string }>(`SELECT review_status FROM nzi_console.job_scope_rows WHERE job_id = $1 AND origin = 'live' AND enabled`, [JOB_A])).rows;
    assert.ok(rows.length > 0 && rows.every((row) => row.review_status !== "approved"), JSON.stringify(rows));
    const qa = await withTenantRead(database.pool, BI_ORG, (client) => getScopeQaReadiness(client, JOB_A));
    assert.deepEqual([qa.approved, qa.readyForReporting], [0, false]);
  });

  it("the report is blocked until re-composed: validate and issue refuse the superseded snapshot (SNAPSHOT_SUPERSEDED); the version stands unedited", async () => {
    await assert.rejects(validateCrpReport(database.pool, { reviewedSnapshotId: "snap-bi", manifestVersion: crpProfessionalManifest.version } as never, context("admin")),
      (error) => codes(error).includes("SNAPSHOT_SUPERSEDED"));
    await assert.rejects(withTenantWrite(database.pool, BI_ORG, (client) => issueReportVersion(client, context("admin"), { reportVersionId: "rv-bi", jobId: JOB_A, scopeKey: "whole" }, "validated")),
      (error) => codes(error).includes("SNAPSHOT_SUPERSEDED"));
    assert.equal((await db.query(`SELECT status FROM nzi_console.report_versions WHERE report_version_id = 'rv-bi'`)).rows[0]!.status, "validated");
  });

  it("the job reads awaiting re-compose; with a published version standing, it reads behind the previous system and that version stays the job's", async () => {
    const awaiting = await registerRow();
    assert.deepEqual([awaiting.snapshotSuperseded, awaiting.stage, reportLinkFor(awaiting).label], [true, "in-preparation", "Earlier record of account · awaiting re-compose"]);
    // As if the version had been published before the bring-in (set directly: the fixture, not the route).
    await db.query(`UPDATE nzi_console.report_versions SET status = 'published', published_at = now() WHERE report_version_id = 'rv-bi'`);
    const behind = await registerRow();
    assert.deepEqual([reportLinkFor(behind).label, behind.publishedVersionId], [SUPERSEDED_PUBLISHED_LABEL, "rv-bi"]);
  });

  it("0234 is append-only: a supersession cannot be updated or deleted, even by the owner", async () => {
    await assert.rejects(db.query(`UPDATE nzi_console.reviewed_crp_snapshot_supersessions SET created_by = 'x'`), /append-only/);
    await assert.rejects(db.query(`DELETE FROM nzi_console.reviewed_crp_snapshot_supersessions`), /append-only/);
  });
});

/**
 * The two-dataset-year guard (urgent, 25 Nov; J000265). The previous system prices a period over two calendar years month by month
 * across both editions; the import's "previous system" figure is a recompute from its one stored factor, so on such a job the
 * reconcile passes falsely (J000265: 17.3 against 17.3, where the previous system's own figure is 15.3). Without the previous system's
 * own figures (endpoint 2; increment 2 lifts the guard per job once they reconcile, below), bring-in is refused for every such job — at the preview, the commit, the fast path and the batch — with nothing written,
 * the previous system not even read. A calendar-year job (J000434's shape) brings in exactly as before.
 */
describe("the two-dataset-year guard: a job whose period spans two calendar years is refused at preview, commit, fast path and batch, nothing written", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const ORG_TY = "two-year";
  // With no read of the previous system's own figures (no client: as the batch runs it), a spanning job is refused before anything is read.
  const TWO_YEAR = V7_IMPORT_TWO_DATASET_YEARS_UNREAD;
  const context = (role: "admin" | "consultant" = "admin", reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG_TY, actorId: `staff-${role}`, principal: "staff", idempotencyKey: `ty-${keys}`, correlationId: `ty-corr-${keys}`, ...(reason ? { reason } : {}),
      grant: commandGrantForRole(role, ORG_TY, `staff-${role}`) };
  };
  const issues = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => [issue.code, issue.message]) : [[String(error), ""]];
  const withoutRun = ({ runId: _runId, ...rest }: V7ReingestJobInput) => rest;
  /** Job k: its own three rows, gas amended in the previous system now — a job with something to bring in. */
  const job = (k: number, jobId: string, period: [string, string] | null) => {
    const at = (base: V7Fixture, n: string): V7Fixture => ({ ...base, id: `${k}${n}` });
    const gas = at(GAS, "001"), water = at(WATER, "002"), refrigerant = at(REFRIGERANT, "003");
    const plan = (runId: string): V7ReingestJobInput => ({ ...planFor(runId, [[`v7-row-${gas.id}`, gas], [`v7-row-${water.id}`, water], [`v7-row-${refrigerant.id}`, refrigerant]]), jobId });
    return { jobId, k, period, plan, before: [gas, water, refrigerant].map(plannedRow), now: [{ ...gas, qty: 1200, reported: 0.24 }, water, refrigerant].map(plannedRow) };
  };
  // J000265's shape (April to March), J000434's (a calendar year), and a job with no period recorded.
  const SPANS = job(61, "ty-spans", ["2025-04-01", "2026-03-31"]);
  const CALENDAR = job(62, "ty-calendar", ["2025-01-01", "2025-12-31"]);
  const NO_PERIOD = job(63, "ty-no-period", null);
  const byId = new Map([SPANS, CALENDAR, NO_PERIOD].map((entry) => [entry.jobId, entry]));
  const reads: string[] = [];
  const source: V7ImportRefreshSource = async (_db, { jobId }) => { reads.push(jobId); return { sourceSha256: "e".repeat(64), rows: byId.get(jobId)!.now }; };
  const options = (jobId: string) => ({ basePlan: withoutRun(byId.get(jobId)!.plan("x")) });
  const fingerprint = async () => {
    const tables = (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'nzi_console' ORDER BY tablename`)).rows.map((row) => row.t);
    const prints: Record<string, string> = {};
    for (const table of tables) prints[table] = (await db.query<{ p: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS p FROM nzi_console.${table} t`)).rows[0]!.p;
    return prints;
  };
  /** Everything of one job's own: its rows, its import records, its audit, its decisions. */
  const jobPrint = async (jobId: string) => (await db.query<{ p: string }>(
    `SELECT md5(concat_ws('#',
       (SELECT string_agg(r::text, '|' ORDER BY r.scope_row_id) FROM nzi_console.job_scope_rows r WHERE r.organisation_id = $1 AND r.job_id = $2),
       (SELECT string_agg(g::text, '|' ORDER BY g.ingest_id) FROM nzi_console.v7_import_ingests g WHERE g.organisation_id = $1 AND g.job_id = $2),
       (SELECT string_agg(a::text, '|' ORDER BY a.occurred_at, a.audit_event_id) FROM nzi_console.audit_events a WHERE a.organisation_id = $1 AND a.entity_id = $2),
       (SELECT string_agg(i::text, '|' ORDER BY i.idempotency_key) FROM nzi_console.command_idempotency i WHERE i.organisation_id = $1 AND i.outcome_json::text LIKE '%' || $2 || '%'))) AS p`,
    [ORG_TY, jobId])).rows[0]!.p;

  before(async () => {
    database = (await createDisposableDatabase("v7twoyear"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG_TY]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG_TY]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG_TY]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Two Year Test','active')`, [ORG_TY]);
    for (const [user, role] of [["staff-admin", "admin"], ["staff-consultant", "consultant"]]) {
      await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $2)`, [ORG_TY, user, role]);
    }
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [ORG_TY]);
    for (const [id, label, unit, kg, scope, levels] of [["gas", "Natural gas", "kWh", 0.2, "1", ["Fuels", "Gaseous fuels", "Natural gas"]], ["water", "Water supply", "m3", 0.15, "3", []],
      ["lpg", "LPG", "litres", 0.2, "1", ["Fuels", "Gaseous fuels", "LPG"]]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6::text],$7::text[])`,
        [ORG_TY, id, label, unit, kg, scope, levels]);
    }
    for (const entry of [SPANS, CALENDAR, NO_PERIOD]) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
        VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',2025,$4,$5,'nzi-pro-v7',$6,$7)`,
        [ORG_TY, entry.jobId, 9500 + entry.k, entry.period?.[0] ?? null, entry.period?.[1] ?? null, `9${entry.k}`, `J${String(900 + entry.k).padStart(6, "0")}`]);
      if (entry.period) await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`,
        [ORG_TY, entry.jobId, entry.period[0], entry.period[1]]);
      for (const row of entry.before) await insert(db, "job_scope_rows", [
        { column: "organisation_id", value: ORG_TY, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
        { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(entry.jobId, row)]);
      const standing = `v7-reingest-${randomUUID()}`;
      await withTenantWrite(database.pool, ORG_TY, (client) => reingestV7JobInTransaction(client, { ...entry.plan(standing) },
        { organisationId: ORG_TY, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: standing, correlationId: standing,
          reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", ORG_TY, V7_REINGEST_ACTOR) }));
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("preview: refused, by name and in the words shown at the top — the previous system never read, nothing written", async () => {
    const before = await fingerprint();
    reads.length = 0;
    await assert.rejects(previewV7ImportRefresh(database.pool, source, { jobId: SPANS.jobId, mode: "preview" }, context(), options(SPANS.jobId)),
      (error) => { assert.deepEqual(issues(error), [["SPANS_TWO_DATASET_YEARS", TWO_YEAR]]); return true; });
    assert.deepEqual(reads, [], "refused before the source is read");
    assert.deepEqual(await fingerprint(), before);
  });

  it("commit: refused the same way, whatever fingerprints it names — nothing written, no audit, no import record", async () => {
    const before = await fingerprint();
    reads.length = 0;
    await assert.rejects(commitV7ImportRefresh(database.pool, source, { jobId: SPANS.jobId, mode: "commit", summarySha256: "a".repeat(64), decisionsSha256: "b".repeat(64) },
      context("admin", "bring it in (test)"), options(SPANS.jobId)), (error) => { assert.deepEqual(issues(error), [["SPANS_TWO_DATASET_YEARS", TWO_YEAR]]); return true; });
    assert.deepEqual(reads, []);
    assert.deepEqual(await fingerprint(), before);
  });

  it("fast path: refused — never automatic, nothing written", async () => {
    const before = await fingerprint();
    reads.length = 0;
    await assert.rejects(refreshV7ImportFastPath(database.pool, source, SPANS.jobId, context(), options(SPANS.jobId)),
      (error) => { assert.deepEqual(issues(error), [["SPANS_TWO_DATASET_YEARS", TWO_YEAR]]); return true; });
    assert.deepEqual(reads, []);
    assert.deepEqual(await fingerprint(), before);
  });

  it("a job with no reporting period is refused too: its dataset years cannot be told", async () => {
    const before = await fingerprint();
    await assert.rejects(previewV7ImportRefresh(database.pool, source, { jobId: NO_PERIOD.jobId, mode: "preview" }, context(), options(NO_PERIOD.jobId)),
      (error) => { assert.deepEqual(issues(error).map(([code]) => code), ["NO_REPORTING_PERIOD"]); return true; });
    assert.deepEqual(await fingerprint(), before);
  });

  it("the rows modal's read says why, for the modal to show at the top; a calendar-year job carries no refusal", async () => {
    const holder = commandGrantForRole("admin", ORG_TY, "staff-admin");
    assert.equal((await readV7ImportRows(database.pool, source, holder, SPANS.jobId, options(SPANS.jobId))).periodRefusal, TWO_YEAR);
    assert.equal((await readV7ImportRows(database.pool, source, holder, CALENDAR.jobId, options(CALENDAR.jobId))).periodRefusal, null);
  });

  it("a calendar-year job (J000434's shape) is unchanged: its preview would commit and reconciles per scope", async () => {
    const preview = await previewV7ImportRefresh(database.pool, source, { jobId: CALENDAR.jobId, mode: "preview" }, context(), options(CALENDAR.jobId));
    assert.deepEqual([preview.outcome, preview.exceptions, preview.refusal], ["would-commit", [], null]);
    assert.deepEqual(preview.scopeTotals, { "1": { v7Tco2e: 2.43, liveTco2e: 2.43 }, "2": { v7Tco2e: 0, liveTco2e: 0 }, "3": { v7Tco2e: 0.0015, liveTco2e: 0.0015 } });
  });

  it("batch: the two-year job and the job with no period are refused by code, nothing of theirs written; the calendar-year job is auto-committed as before", async () => {
    const spansBefore = await jobPrint(SPANS.jobId);
    const noPeriodBefore = await jobPrint(NO_PERIOD.jobId);
    const started = await startV7ImportBatch(database.pool, { clientId: "c1" }, context());
    reads.length = 0;
    const run = await runV7ImportBatch(database.pool, ORG_TY, started.data.runId, { source, optionsFor: (jobId) => options(jobId), sleep: async () => undefined });
    assert.equal(run.status, "completed");
    const results = Object.fromEntries((await db.query<{ job_id: string; status: string; refusal_codes: string[] }>(
      `SELECT job_id, status, refusal_codes FROM nzi_console.v7_import_batch_results WHERE organisation_id = $1 AND run_id = $2`, [ORG_TY, started.data.runId])).rows
      .map((row) => [row.job_id, [row.status, row.refusal_codes]]));
    assert.deepEqual(results, {
      [SPANS.jobId]: ["refused", ["SPANS_TWO_DATASET_YEARS"]],
      [CALENDAR.jobId]: ["refreshed", []],
      [NO_PERIOD.jobId]: ["refused", ["NO_REPORTING_PERIOD"]],
    });
    assert.deepEqual(reads, [CALENDAR.jobId, CALENDAR.jobId], "only the calendar-year job was read (its preview, then its commit)");
    assert.equal(await jobPrint(SPANS.jobId), spansBefore, "nothing of the two-year job's written");
    assert.equal(await jobPrint(NO_PERIOD.jobId), noPeriodBefore);
    const committed = (await db.query(`SELECT outcome FROM nzi_console.v7_import_ingests WHERE organisation_id = $1 AND job_id = $2 AND kind = 'ingest'`, [ORG_TY, CALENDAR.jobId])).rows;
    assert.deepEqual(committed, [{ outcome: "committed" }]);
  });
});

/**
 * Datasets Part 2, increment 2: the guard lifts per job. A job over two calendar years is brought in once what the chain would bring in —
 * its rows priced by month — reconciles with the previous system's own figures (CONTRACT-v7-import-figures endpoint 2) within 0.1 t in
 * every scope; until then SPANS_TWO_DATASET_YEARS refuses it, naming each row that differs and why. The rows modal judges each row
 * against its own figure, priced span by span from V7's own spans. J000265's shape: UK electricity, April 2025 to March 2026, V7 at
 * 0.177 for 2025 and 0.13096 for 2026 — row 9278 = 15.3, where the single factor gives 17.3.
 */
describe("a spanning job reconciled with the previous system's own figures: the modal by month, the guard lifted per job, a job that differs still refused", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const SO_ORG = "span-own";
  const J265 = "so-265", J265B = "so-265b", J265C = "so-265c", J265D = "so-265d", CAL = "so-cal";
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (role: "admin" | "consultant" = "admin", reason?: string): CommandContext => {
    keys += 1;
    const actorId = `staff-${role}`;
    return { organisationId: SO_ORG, actorId, principal: "staff", idempotencyKey: `so-${keys}`, correlationId: `so-corr-${keys}`, ...(reason ? { reason } : {}),
      grant: commandGrantForRole(role, SO_ORG, actorId) };
  };
  const importer = (): CommandContext => {
    keys += 1;
    return { organisationId: SO_ORG, actorId: V7_IMPORT_ACTOR, principal: "staff", idempotencyKey: `so-${keys}`, correlationId: `so-corr-${keys}`,
      grant: commandGrantForRole("admin", SO_ORG, V7_IMPORT_ACTOR) };
  };
  const holder = () => commandGrantForRole("consultant", SO_ORG, "staff-consultant");
  const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
  const issues = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => [issue.field, issue.code, issue.message]) : [["", String(error), ""]];

  const ELEC = { code: "7_400_4000_5_1", levels: ["UK electricity", "Electricity generated", "Electricity: UK"], label: "UK electricity — generated" };
  const GAS = { code: "1_100_1004_6_1", levels: ["Fuels", "Gaseous fuels", "Natural gas"], label: "Natural gas — kWh (Gross CV)" };
  // V7's month_N is calendar month N: Jan–Mar 14,324 kWh each, Apr–Dec 6,076 each (97,656 in all; DESIGN-datasets-by-period §3).
  const MONTHS = [14_324, 14_324, 14_324, 6_076, 6_076, 6_076, 6_076, 6_076, 6_076, 6_076, 6_076, 6_076];
  const row = (id: string, scope: "1" | "2", family: typeof ELEC, qty: number, rate: number, months: number[] | null): PlannedRow => {
    const base = plannedRow({ id, scope: "1", label: family.label, qty, unit: "kWh", reported: round6(qty * rate / 1000) });
    return { ...base, scope, v7Scope: scope, level1: family.levels[0]!, level2: family.levels[1]!, level3: family.levels[2]!,
      migratedRecord: { ...(base.migratedRecord as unknown as Record<string, unknown>), original_id: family.code, factor: rate, factor_db_id: `f-${family.code}`,
        dataset: { id: "1", year: 2025, version: null }, ...(months ? { months } : {}) } as unknown as PlannedRow["migratedRecord"] };
  };
  const ROW_9278 = row("9278", "2", ELEC, 97_656, 0.177, MONTHS);
  const ROW_9301 = row("9301", "1", GAS, 10_000, 0.18293, null);
  // The same two rows on J265B, under their own ids there (a V7 row is one job's).
  const ROW_B_9278 = row("19278", "2", ELEC, 97_656, 0.177, MONTHS), ROW_B_9301 = row("19301", "1", GAS, 10_000, 0.18293, null);
  const ROW_C_9278 = row("29278", "2", ELEC, 97_656, 0.177, MONTHS), ROW_C_9301 = row("29301", "1", GAS, 10_000, 0.18293, null);
  const CAL_ROW = row("9401", "2", ELEC, 50_000, 0.177, null);
  // J000265 source:1169: a business-travel register source — a hotel stay, 29 "Room per night", no monthly figures, V7 at 10.4.
  // The import holds a register source's own category at level 3 ("Business Travel"); level 2 is the register's name.
  const HOTEL = { code: "29_600_4000_13_1", levels: ["Hotel stay", "Hotel stay", "UK"], label: "Hotel stay — UK" };
  const hotelBase = plannedRow({ id: "x", scope: "3", label: "Business Travel", qty: 29, unit: "Room per night", reported: 0.3016 });
  const SOURCE_1169: PlannedRow = { ...hotelBase, scopeRowId: "v7-source-1169", legacyDbId: "source:1169", scope: "3", v7Scope: "Scope 3",
    level1: "Scope 3", level2: "Business Travel Register", level3: "Business Travel",
    migratedRecord: { ...(hotelBase.migratedRecord as unknown as Record<string, unknown>), original_id: HOTEL.code, factor: 10.4, factor_db_id: `f-${HOTEL.code}`,
      dataset: { id: "1", year: 2025, version: null } } as unknown as PlannedRow["migratedRecord"] };
  const holds = new Map<string, readonly PlannedRow[]>([[J265, [ROW_9278, ROW_9301]], [J265B, [ROW_B_9278, ROW_B_9301]], [J265C, [ROW_C_9278, ROW_C_9301]], [CAL, [CAL_ROW]],
    [J265D, [SOURCE_1169]]]);
  const source: V7ImportRefreshSource = async (_db, job) => ({ sourceSha256: "b".repeat(64), rows: holds.get(job.jobId)! });
  const EMPTY_PLAN = (jobId: string) => ({ jobId, crosswalkVersion: "none", crosswalkSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", vintageDatasetIds: [], rows: [] });

  // The previous system's own figures (endpoint 2), as V7 computes them: 9278 over two spans, the gas row annual at its own edition.
  const OWN_9278 = { row_id: 9278, scope: "Scope 2", enabled: true, tco2e: 15.30668112, blended: true, custom_factor: false, spans: [
    { from: "2025-04", to: "2025-12", dataset_id: 1, dataset_year: 2025, factor: 0.177, ghg_unit: "kgCO2e", tco2e: 9.679068 },
    { from: "2026-01", to: "2026-03", dataset_id: 69, dataset_year: 2026, factor: 0.13096, ghg_unit: "kgCO2e", tco2e: 5.62761312 }] };
  const OWN_9301 = { row_id: 9301, scope: "Scope 1", enabled: true, tco2e: 1.8293, blended: false, custom_factor: false, spans: [
    { from: "2025-04", to: "2026-03", dataset_id: 1, dataset_year: 2025, factor: 0.18293, ghg_unit: "kgCO2e", tco2e: 1.8293 }] };
  const calls: string[] = [];
  // J265C: V7 priced Jan–Mar from a 2024 edition the library holds no copy of — no edition to add, so the reconcile still names it.
  const OWN_C_9278 = { ...OWN_9278, row_id: 29278, spans: [OWN_9278.spans[0]!, { ...OWN_9278.spans[1]!, dataset_id: 68, dataset_year: 2024 }] };
  const figuresOf: Record<string, V7FiguresRowFigures["rows"]> = { "265": [OWN_9278, OWN_9301], "266": [{ ...OWN_9278, row_id: 19278 }, { ...OWN_9301, row_id: 19301 }], "267": [],
    "268": [OWN_C_9278, { ...OWN_9301, row_id: 29301 }],
    // V7's own figure for the hotel: 0.3016 t, over two spans (9 months at its 2025 edition, 3 at 2026's — both 10.4).
    "269": [{ row_id: "source:1169", scope: "Scope 3", enabled: true, tco2e: 0.3016, blended: true, custom_factor: false, spans: [
      { from: "2025-04", to: "2025-12", dataset_id: 1, dataset_year: 2025, factor: 10.4, ghg_unit: "kgCO2e", tco2e: 0.2262 },
      { from: "2026-01", to: "2026-03", dataset_id: 69, dataset_year: 2026, factor: 10.4, ghg_unit: "kgCO2e", tco2e: 0.0754 }] }] };
  const selected = async (jobId: string) => (await db.query<{ dataset_id: string }>(
    `SELECT dataset_id FROM nzi_console.job_dataset_selections WHERE organisation_id = $1 AND job_id = $2 ORDER BY dataset_id`, [SO_ORG, jobId])).rows.map((entry) => entry.dataset_id);
  const rowFigures: V7RowFiguresClient = async ({ v7JobId }) => {
    calls.push(v7JobId);
    return { ok: true, body: { contract: "v7-import-figures/1", job_id: Number(v7JobId), computed_at: "2026-11-26T10:00:00Z", rows: figuresOf[v7JobId]! } };
  };
  const rowsOf = (jobId: string, client: V7RowFiguresClient | undefined = rowFigures) => readV7ImportRows(database.pool, source, holder(), jobId, { basePlan: EMPTY_PLAN(jobId), rowFigures: client });
  const upload = async (jobId: string, legacyJobNumber: string) => {
    const summary = await withTenantWrite(database.pool, SO_ORG, (client) => summariseV7JobAsTheChainSees(client,
      { organisationId: SO_ORG, jobId, legacyJobNumber, extractSha256: "b".repeat(64), rows: holds.get(jobId)!, generatedAt: "2026-11-26T09:00:00.000Z" }));
    await uploadV7ImportSummary(database.pool, { jobId, summary }, importer());
  };
  const acceptAll = async (jobId: string) => {
    const seen = await rowsOf(jobId);
    const items = seen.rows.filter((entry) => entry.lane === "pre-accepted" && entry.pick?.match.categoryCode).map((entry) => ({ kind: "map" as const,
      legacyDbId: entry.legacyDbId, categoryCode: entry.pick!.match.categoryCode!, datasetId: entry.pick!.datasetId, factorId: entry.pick!.factorId, expectedDecisionId: null }));
    return acceptV7ImportRows(database.pool, { jobId, items }, context());
  };
  const jobPrint = async (jobId: string) => (await db.query<{ p: string }>(
    `SELECT md5(concat_ws('#',
       (SELECT string_agg(r::text, '|' ORDER BY r.scope_row_id) FROM nzi_console.job_scope_rows r WHERE r.organisation_id = $1 AND r.job_id = $2),
       (SELECT string_agg(g::text, '|' ORDER BY g.ingest_id) FROM nzi_console.v7_import_ingests g WHERE g.organisation_id = $1 AND g.job_id = $2))) AS p`, [SO_ORG, jobId])).rows[0]!.p;

  before(async () => {
    database = (await createDisposableDatabase("v7spanown"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [SO_ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [SO_ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [SO_ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'cs','Spanning Client','active')`, [SO_ORG]);
    for (const [user, role] of [["staff-admin", "admin"], ["staff-consultant", "consultant"]]) {
      await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $2)`, [SO_ORG, user, role]);
    }
    for (const [ds, name, from, to] of [["uk-ghg-gb-2025", "DESNZ GB 2025", "2025-01-01", "2025-12-31"], ["uk-ghg-gb-2026", "DESNZ GB 2026", "2026-01-01", "2026-12-31"]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence,
                        source_system,source_family,legacy_dataset_id,content_sha256)
                      VALUES ($1,$2,$3,'1',$4,$5,'GB','active','Test','Source: test.','nzi-pro-v7','uk-ghg',$2,repeat('a',64))`, [SO_ORG, ds, name, from, to]);
    }
    for (const [ds, family, scope, rate, lookup] of [["uk-ghg-gb-2025", ELEC, "2", 0.177, true], ["uk-ghg-gb-2026", ELEC, "2", 0.13096, false],
      ["uk-ghg-gb-2025", GAS, "1", 0.18293, true], ["uk-ghg-gb-2026", GAS, "1", 0.18, false]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels,source_system,legacy_db_id,legacy_original_id)
                      VALUES ($1,$2,$3,$4,'kWh',$5,ARRAY[$6::text],$7::text[],$8,$9,$10)`,
        [SO_ORG, ds, `uk-ghg-${family.code}`, family.label, rate, scope, family.levels, lookup ? "nzi-pro-v7" : null, lookup ? `f-${family.code}` : null, family.code]);
    }
    // The hotel night, in both editions at 10.4 per night (staging's own: uk-ghg-29_600_4000_13_1, "nights").
    for (const [ds, lookup] of [["uk-ghg-gb-2025", true], ["uk-ghg-gb-2026", false]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels,source_system,legacy_db_id,legacy_original_id)
                      VALUES ($1,$2,$3,$4,'nights',10.4,ARRAY['3'],$5::text[],$6,$7,$8)`,
        [SO_ORG, ds, `uk-ghg-${HOTEL.code}`, HOTEL.label, HOTEL.levels, lookup ? "nzi-pro-v7" : null, lookup ? `f-${HOTEL.code}` : null, HOTEL.code]);
    }
    // J000265's shape over April–March, with both editions (J265) and with 2026's missing (J265B); and a calendar-year job (J000434's shape).
    for (const [jobId, sequence, number, v7Id, from, to, editions] of [[J265, 965, "J000965", "265", "2025-04-01", "2026-03-31", ["uk-ghg-gb-2025", "uk-ghg-gb-2026"]],
      [J265B, 966, "J000966", "266", "2025-04-01", "2026-03-31", ["uk-ghg-gb-2025"]], [CAL, 967, "J000967", "267", "2025-01-01", "2025-12-31", ["uk-ghg-gb-2025"]],
      [J265C, 968, "J000968", "268", "2025-04-01", "2026-03-31", ["uk-ghg-gb-2025"]], [J265D, 969, "J000969", "269", "2025-04-01", "2026-03-31", ["uk-ghg-gb-2025", "uk-ghg-gb-2026"]]] as const) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
        VALUES ($1,$2,'cs',$3,'crp','CRP','open','Data entry',2025,$4,$5,'nzi-pro-v7',$6,$7)`, [SO_ORG, jobId, sequence, from, to, v7Id, number]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`, [SO_ORG, jobId, from, to]);
      for (const ds of editions) await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
        VALUES ($1,$2,$3,'manual','the job''s datasets (test)','staff-admin')`, [SO_ORG, jobId, ds]);
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("the modal: row 9278 judged against the previous system's own 15.3, priced by month at each year's edition — pre-accepted, both parts ticked", async () => {
    calls.length = 0;
    const seen = await rowsOf(J265);
    assert.deepEqual([seen.periodRefusal, seen.ownFigures, calls], [null, true, ["265"]], "one read of the previous system's own figures; nothing holds the job back");
    const elec = seen.rows.find((entry) => entry.legacyDbId === "9278")!;
    assert.equal(elec.previousSystem?.tco2e, 15.30668112);
    assert.deepEqual([elec.lane, elec.pick?.datasetId, elec.pick?.match.verdict, elec.pick?.match.tco2e], ["pre-accepted", "uk-ghg-gb-2025", "reproduces", 15.306681]);
    assert.deepEqual(elec.pick?.parts?.map((part) => [part.from, part.to, part.datasetId, part.tco2e, part.agrees, part.issue]), [
      ["2025-04", "2025-12", "uk-ghg-gb-2025", 9.679068, true, null], ["2026-01", "2026-03", "uk-ghg-gb-2026", 5.627613, true, null]]);
    assert.equal(Number(elec.pick!.match.tco2e!.toFixed(1)), 15.3, "row 9278 = 15.3, not the single factor's 17.3");
    const gas = seen.rows.find((entry) => entry.legacyDbId === "9301")!;
    assert.deepEqual([gas.lane, gas.pick?.match.tco2e, gas.pick?.parts?.length], ["pre-accepted", 1.8293, 1], "an annual row: one span, at its own edition");
  });

  it("J000265 source:1169, a hotel stay (29 \"Room per night\"): nights, priced 0.30 t at its own edition with both parts ✓, filed under Business Travel", async () => {
    const seen = await rowsOf(J265D);
    const hotel = seen.rows.find((entry) => entry.legacyDbId === "source:1169")!;
    assert.deepEqual([hotel.v7Category, hotel.previousSystem?.tco2e], ["3.6", 0.3016], "the previous system's own category, from the register source's level 3");
    // One factor, in both editions: a candidate each (the modal shows it once), each priced once at its own edition (D-B).
    assert.deepEqual(hotel.candidates.map((candidate) => [candidate.datasetId, candidate.unit, candidate.match.tco2e, candidate.match.verdict, candidate.match.categoryCode]).sort(), [
      ["uk-ghg-gb-2025", "nights", 0.3016, "reproduces", "3.6"], ["uk-ghg-gb-2026", "nights", 0.3016, "reproduces", "3.6"]]);
    assert.deepEqual([hotel.lane, hotel.pick?.datasetId, hotel.pick?.match.tco2e, hotel.pick?.unitRefusal], ["pre-accepted", "uk-ghg-gb-2025", 0.3016, null],
      "the job-year anchor reproduces: it comes in pre-accepted, its unit the same");
    assert.deepEqual(hotel.pick?.parts?.map((part) => [part.from, part.to, part.datasetId, part.tco2e, part.agrees, part.issue]), [
      ["2025-04", "2025-12", "uk-ghg-gb-2025", 0.2262, true, null], ["2026-01", "2026-03", "uk-ghg-gb-2025", 0.0754, true, null]],
      "both parts ✓ — never \"factor not in that edition\" or \"no figure to compare\"");
  });

  it("bringing J000969 in: the edited reason reaches the audit byte for byte, and the job's figures — the totals band's own read — move", async () => {
    await upload(J265D, "J000969");
    assert.deepEqual((await acceptAll(J265D)).refused, []);
    const before = await readJobEmissions(database.pool, { organisationId: SO_ORG, jobId: J265D });
    const preview = await previewV7ImportRefresh(database.pool, source, { jobId: J265D, mode: "preview" }, context(), { basePlan: EMPTY_PLAN(J265D), rowFigures });
    assert.equal(preview.outcome, "would-commit");
    // The modal's prefill, then edited by the person — sent as the browser sends it (percent-encoded), read as the route reads it.
    const reason = "Imported and reconciled from previous system · manual: factor on 1 row (source:1169) — checked against V7’s 0.30 t ×1";
    const carried = commandReason(new Headers(commandReasonHeaders(reason)));
    const committed = await commitV7ImportRefresh(database.pool, source, { jobId: J265D, mode: "commit", summarySha256: preview.summarySha256, decisionsSha256: preview.decisionsSha256 },
      context("admin", carried), { basePlan: EMPTY_PLAN(J265D), rowFigures, requireScopesAgree: true });
    const audit = (await db.query<{ reason: string }>(`SELECT reason FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'import.refreshed' AND entity_id = $2`, [SO_ORG, J265D])).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual(Buffer.from(audit[0]!.reason, "utf8"), Buffer.from(reason, "utf8"), "byte for byte");
    assert.deepEqual(committed.data.plan, { committed: 0, decided: 1 }, "what the confirmation says: 1 row brought in");
    const after = await readJobEmissions(database.pool, { organisationId: SO_ORG, jobId: J265D });
    assert.notDeepEqual(after, before, "the job's figures moved: what the totals band re-reads after a bring-in");
    assert.ok(JSON.stringify(after).includes("0.3016"), "the hotel's 0.3016 t is in the job's totals");
  });

  it("with no read of the previous system's own figures, the modal holds the job and says why — never a tick", async () => {
    const unread: V7RowFiguresClient = async () => ({ ok: false, reason: "not-configured" });
    const seen = await rowsOf(J265, unread);
    assert.deepEqual([seen.periodRefusal, seen.ownFigures], [V7_IMPORT_TWO_DATASET_YEARS_UNREAD, false]);
    assert.ok(seen.rows.every((entry) => entry.previousSystem === null && (entry.pick?.parts ?? null) === null));
  });

  it("the guard lifts: the preview reconciles in every scope with V7's own totals, the commit brings it in, and 9278 is priced 15.3 by month", async () => {
    await upload(J265, "J000965");
    assert.deepEqual((await acceptAll(J265)).refused, []);
    calls.length = 0;
    const preview = await previewV7ImportRefresh(database.pool, source, { jobId: J265, mode: "preview" }, context(), { basePlan: EMPTY_PLAN(J265), rowFigures });
    assert.deepEqual([preview.outcome, preview.refusal, calls], ["would-commit", null, ["265"]]);
    assert.deepEqual(preview.scopeTotals, { "1": { v7Tco2e: 1.8293, liveTco2e: 1.8293 }, "2": { v7Tco2e: 15.306681, liveTco2e: 15.306681 }, "3": { v7Tco2e: 0, liveTco2e: 0 } },
      "the previous system's own totals beside the console's — not the single-factor 17.3");
    const committed = await commitV7ImportRefresh(database.pool, source, { jobId: J265, mode: "commit", summarySha256: preview.summarySha256, decisionsSha256: preview.decisionsSha256 },
      context("admin", "bring J000965 in (test)"), { basePlan: EMPTY_PLAN(J265), rowFigures, requireScopesAgree: true });
    assert.equal(committed.data.mode, "commit");
    const live = (await db.query<{ tco2e: string; lineage: string }>(`SELECT r.calculated_tco2e::text AS tco2e, r.lineage_json::text AS lineage FROM nzi_console.job_scope_rows r
      JOIN nzi_console.job_scope_rows m ON m.scope_row_id = r.reingested_from_row_id WHERE r.job_id = $1 AND r.origin = 'live' AND r.enabled AND m.legacy_db_id = '9278'`, [J265])).rows;
    assert.equal(live.length, 1);
    assert.equal(round6(Number(live[0]!.tco2e)), 15.306681);
    assert.ok(live[0]!.lineage.includes("Priced by month"), "the lineage names the months and editions");
    const totals = await withTenantRead(database.pool, SO_ORG, (client) => readConsoleScopeTotals(client, SO_ORG, J265));
    assert.deepEqual([round6(totals["1"]), round6(totals["2"]), round6(totals["3"])], [1.8293, 15.306681, 0], "the job's scope totals are V7's own");
    const record = (await db.query<{ v2: string; l2: string }>(`SELECT v7_scope2_tco2e::text AS v2, live_scope2_tco2e::text AS l2 FROM nzi_console.v7_import_ingests WHERE job_id = $1 AND kind = 'ingest'`, [J265])).rows;
    assert.deepEqual(record.map((entry) => [Number(entry.v2), Number(entry.l2)]), [[15.306681, 15.306681]], "the record holds the previous system's own figure");
  });

  it("a job without the 2026 edition (made before R1): bring-in adds every edition its rows' spans were priced from — the preview rolls it back, the commit keeps it", async () => {
    await upload(J265B, "J000966");
    assert.deepEqual((await acceptAll(J265B)).refused, []);
    const seen = (await rowsOf(J265B)).rows.find((entry) => entry.legacyDbId === "19278")!;
    assert.deepEqual(seen.pick?.parts?.map((part) => [part.datasetId, part.issue]), [["uk-ghg-gb-2025", null], ["uk-ghg-gb-2026", "dataset-not-on-job"]],
      "the modal: 2026 is in the library, not on the job — added when you accept");
    const before = await jobPrint(J265B);
    const preview = await previewV7ImportRefresh(database.pool, source, { jobId: J265B, mode: "preview" }, context(), { basePlan: EMPTY_PLAN(J265B), rowFigures });
    assert.deepEqual([preview.outcome, preview.refusal, preview.scopeTotals?.["2"]], ["would-commit", null, { v7Tco2e: 15.306681, liveTco2e: 15.306681 }], "reconciles with 2026 added");
    assert.deepEqual([await jobPrint(J265B), await selected(J265B)], [before, ["uk-ghg-gb-2025"]], "the preview wrote nothing — the edition included");
    await commitV7ImportRefresh(database.pool, source, { jobId: J265B, mode: "commit", summarySha256: preview.summarySha256, decisionsSha256: preview.decisionsSha256 },
      context("admin", "bring J000966 in (test)"), { basePlan: EMPTY_PLAN(J265B), rowFigures, requireScopesAgree: true });
    assert.deepEqual(await selected(J265B), ["uk-ghg-gb-2025", "uk-ghg-gb-2026"], "2026 joins the job's datasets, added, never removed");
    const reason = (await db.query<{ reason: string; source: string }>(`SELECT reason, selection_source AS source FROM nzi_console.job_dataset_selections
      WHERE organisation_id = $1 AND job_id = $2 AND dataset_id = 'uk-ghg-gb-2026'`, [SO_ORG, J265B])).rows[0]!;
    assert.match(reason.reason, /bind to v7's dataset vintage/);
    const live = (await db.query<{ tco2e: string }>(`SELECT r.calculated_tco2e::text AS tco2e FROM nzi_console.job_scope_rows r
      JOIN nzi_console.job_scope_rows m ON m.scope_row_id = r.reingested_from_row_id WHERE r.job_id = $1 AND r.origin = 'live' AND r.enabled AND m.legacy_db_id = '19278'`, [J265B])).rows;
    assert.deepEqual(live.map((entry) => round6(Number(entry.tco2e))), [15.306681], "Jan–Mar priced at 2026, as the previous system priced them");
  });

  it("an edition the library holds no copy of is not added: still refused, the row named with \"add it to the job's datasets first\" — nothing written", async () => {
    await upload(J265C, "J000968");
    assert.deepEqual((await acceptAll(J265C)).refused, []);
    const seen = (await rowsOf(J265C)).rows.find((entry) => entry.legacyDbId === "29278")!;
    // A part with no edition cannot be priced, so the row has no figure and no auto-pick: a person accepts the factor by hand.
    const elec = seen.candidates.find((candidate) => candidate.datasetId === "uk-ghg-gb-2025")!;
    assert.deepEqual([seen.pick, elec.parts?.map((part) => [part.year, part.datasetId, part.issue])], [null, [[2025, "uk-ghg-gb-2025", null], [2024, null, "dataset-not-on-job"]]]);
    assert.deepEqual((await acceptV7ImportRows(database.pool, { jobId: J265C, items: [{ kind: "map", legacyDbId: "29278", categoryCode: elec.categories[0]!,
      datasetId: elec.datasetId, factorId: elec.factorId, expectedDecisionId: seen.decision?.decisionId ?? null }] }, context())).refused, []);
    const before = await jobPrint(J265C);
    await assert.rejects(previewV7ImportRefresh(database.pool, source, { jobId: J265C, mode: "preview" }, context(), { basePlan: EMPTY_PLAN(J265C), rowFigures }), (error) => {
      const found = issues(error);
      assert.deepEqual(found.map(([field, code]) => [field, code]), [["jobId", "SPANS_TWO_DATASET_YEARS"], ["rows.29278", "SPANS_TWO_DATASET_YEARS"]]);
      assert.match(found[0]![2]!, /Scope 2 17\.3 here, 15\.3 there/);
      assert.equal(found[1]![2], "Row 29278 (Scope 2): 17.3 here, 15.3 there — DESNZ GB 2024 — add it to the job's datasets first.");
      return true;
    });
    assert.equal(await jobPrint(J265C), before);
    // The commit, naming the fingerprints a preview reads (the refresh's own read): the chain runs, and the reconcile refuses — nothing kept.
    const fingerprints = await withTenantWrite(database.pool, SO_ORG, async (client) => {
      const read = await readRefresh(client, source, SO_ORG, J265C);
      return { summarySha256: read.summarySha256, decisionsSha256: read.decisionsSha256 };
    });
    await assert.rejects(commitV7ImportRefresh(database.pool, source, { jobId: J265C, mode: "commit", ...fingerprints }, context("admin", "bring it in (test)"),
      { basePlan: EMPTY_PLAN(J265C), rowFigures, requireScopesAgree: true }), (error) => {
      assert.deepEqual(issues(error).map(([field, code]) => [field, code]), [["jobId", "SPANS_TWO_DATASET_YEARS"], ["rows.29278", "SPANS_TWO_DATASET_YEARS"]]);
      return true;
    });
    assert.deepEqual([await jobPrint(J265C), await selected(J265C)], [before, ["uk-ghg-gb-2025"]], "nothing kept, no edition added");
  });

  it("a row the previous system no longer holds as it was read is named as changed there", async () => {
    figuresOf["268"] = [OWN_C_9278, { ...OWN_9301, row_id: 29302 }];
    try {
      await assert.rejects(previewV7ImportRefresh(database.pool, source, { jobId: J265C, mode: "preview" }, context(), { basePlan: EMPTY_PLAN(J265C), rowFigures }), (error) => {
        const found = issues(error);
        assert.ok(found.some(([field, , message]) => field === "rows.29301" && /changed since it was read/.test(message!)), "29301: brought in here, not in the previous system's figures");
        assert.ok(found.some(([field, , message]) => field === "rows.29302" && /not brought in/.test(message!)));
        return true;
      });
    } finally { figuresOf["268"] = [OWN_C_9278, { ...OWN_9301, row_id: 29301 }]; }
  });

  it("a calendar-year job (J000434's shape) never reads the previous system's own figures and brings in exactly as before", async () => {
    calls.length = 0;
    const seen = await rowsOf(CAL);
    assert.deepEqual([seen.periodRefusal, seen.ownFigures, seen.rows.map((entry) => entry.pick?.parts ?? null)], [null, false, [null]]);
    await upload(CAL, "J000967");
    assert.deepEqual((await acceptAll(CAL)).refused, []);
    const preview = await previewV7ImportRefresh(database.pool, source, { jobId: CAL, mode: "preview" }, context(), { basePlan: EMPTY_PLAN(CAL), rowFigures });
    assert.deepEqual([preview.outcome, preview.scopeTotals?.["2"]], ["would-commit", { v7Tco2e: 8.85, liveTco2e: 8.85 }]);
    const committed = await commitV7ImportRefresh(database.pool, source, { jobId: CAL, mode: "commit", summarySha256: preview.summarySha256, decisionsSha256: preview.decisionsSha256 },
      context("admin", "bring J000967 in (test)"), { basePlan: EMPTY_PLAN(CAL), rowFigures, requireScopesAgree: true });
    assert.equal(committed.data.mode, "commit");
    assert.deepEqual(calls, [], "a one-year job never calls endpoint 2");
  });
});

/**
 * The drift guard (BRIEF-v7-import-j000663 Part C; CONTRACT-v7-import-figures v1; ruled 25 Nov): each check of an imported job against the
 * previous system's own scope totals is stored (0236); the banner, the Admin list and the publish gate read the latest. Behind → not
 * published; a two-dataset-year job → not published until a check says level; unknown on a one-year job → published, with the banner.
 */
describe("the drift guard: checks stored, the latest read by the banner, the list and the publish gate", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const ORG_DG = "drift";
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const job = (k: number, jobId: string, period: [string, string], imported = true) => {
    const at = (base: V7Fixture, n: string): V7Fixture => ({ ...base, id: `${k}${n}` });
    const gas = at(GAS, "001"), water = at(WATER, "002"), refrigerant = at(REFRIGERANT, "003");
    const plan = (runId: string): V7ReingestJobInput => ({ ...planFor(runId, [[`v7-row-${gas.id}`, gas], [`v7-row-${water.id}`, water], [`v7-row-${refrigerant.id}`, refrigerant]]), jobId });
    // An imported job keeps its J number from the previous system: the same as its console number (sequence 9600 + k).
    return { jobId, k, period, imported, plan, before: [gas, water, refrigerant].map(plannedRow), number: `J${String(9600 + k).padStart(6, "0")}` };
  };
  const CAL = job(71, "dg-calendar", ["2025-01-01", "2025-12-31"]);
  const TWO = job(72, "dg-two-year", ["2025-04-01", "2026-03-31"]);
  const THIRD = job(73, "dg-third", ["2025-01-01", "2025-12-31"]);
  const NATIVE = job(74, "dg-native", ["2025-01-01", "2025-12-31"], false);
  // The console's totals after the re-ingest: gas 0.2 + refrigerant 2.19 in Scope 1, water 0.0015 in Scope 3.
  const CONSOLE = { "1": 2.39, "2": 0, "3": 0.0015 };
  const reply = (number: string, totals: { "1": number; "2": number; "3": number }): V7FiguresRead => ({ ok: true, body: {
    contract: "v7-import-figures/1", job_id: 1, job_number: number, computed_at: "2026-11-25T14:00:00Z", period: { from: null, to: null },
    scope_totals: { scope_1: totals["1"], scope_2: totals["2"], scope_3: totals["3"], total: totals["1"] + totals["2"] + totals["3"] }, counted_rows: 3, rows_updated_at: null } });
  const answering = (byJob: Record<string, V7FiguresRead>): V7FiguresClient => async ({ legacyJobNumber }) => byJob[legacyJobNumber] ?? { ok: false, reason: "not-found" };
  const options = (trigger: "admin" | "publish" | "nightly" = "admin") => ({ trigger, requestedBy: "staff-admin", correlationId: `dg-${randomUUID()}`, principal: "staff" as const });
  const check = (entry: ReturnType<typeof job>, client: V7FiguresClient) => checkV7Drift(database.pool, client, ORG_DG, entry.jobId, options());
  const gate = (entry: ReturnType<typeof job>) => withTenantWrite(database.pool, ORG_DG, (client) => refuseDriftedPublish(client, ORG_DG, entry.jobId));
  const checks = async (jobId?: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.v7_drift_checks WHERE organisation_id = $1 ${jobId ? "AND job_id = $2" : ""}`,
    jobId ? [ORG_DG, jobId] : [ORG_DG])).rows[0]!.n;

  before(async () => {
    database = (await createDisposableDatabase("v7drift"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG_DG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG_DG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG_DG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Drift Test','active')`, [ORG_DG]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [ORG_DG]);
    for (const [id, label, unit, kg, scope, levels] of [["gas", "Natural gas", "kWh", 0.2, "1", ["Fuels", "Gaseous fuels", "Natural gas"]], ["water", "Water supply", "m3", 0.15, "3", []]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6::text],$7::text[])`,
        [ORG_DG, id, label, unit, kg, scope, levels]);
    }
    for (const entry of [CAL, TWO, THIRD, NATIVE]) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
        VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',2025,$4,$5,$6,$7,$8)`, [ORG_DG, entry.jobId, 9600 + entry.k, entry.period[0], entry.period[1],
        entry.imported ? "nzi-pro-v7" : null, entry.imported ? String(entry.k) : null, entry.imported ? entry.number : null]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`, [ORG_DG, entry.jobId, entry.period[0], entry.period[1]]);
      if (!entry.imported) continue;
      for (const row of entry.before) await insert(db, "job_scope_rows", [
        { column: "organisation_id", value: ORG_DG, type: "text" }, { column: "source_system", value: "nzi-pro-v7", type: "text" },
        { column: "legacy_db_id", value: row.legacyDbId, type: "text" }, ...migratedRowCols(entry.jobId, row)]);
      const standing = `v7-reingest-${randomUUID()}`;
      await withTenantWrite(database.pool, ORG_DG, (client) => reingestV7JobInTransaction(client, { ...entry.plan(standing) },
        { organisationId: ORG_DG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: standing, correlationId: standing,
          reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", ORG_DG, V7_REINGEST_ACTOR) }));
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("the console's totals are the job's enabled rows, as the report sums them", async () => {
    const totals = await withTenantRead(database.pool, ORG_DG, (client) => readConsoleScopeTotals(client, ORG_DG, CAL.jobId));
    assert.deepEqual(Object.fromEntries(Object.entries(totals).map(([scope, value]) => [scope, Math.round(value * 1e6) / 1e6])), CONSOLE);
  });

  it("before any check: a one-year job publishes (no banner line); a two-dataset-year job does not; a native job is never gated", async () => {
    await gate(CAL);
    await assert.rejects(gate(TWO), (error) => codes(error).includes("NOT_CHECKED_AGAINST_PREVIOUS_SYSTEM"));
    await gate(NATIVE);
    const banner = await withTenantRead(database.pool, ORG_DG, (client) => readV7DriftBanner(client, ORG_DG, TWO.jobId));
    assert.equal(banner?.tone, "unchecked");
    assert.equal(await withTenantRead(database.pool, ORG_DG, (client) => readV7DriftBanner(client, ORG_DG, NATIVE.jobId)), null);
  });

  it("level: stored with both sides' figures, audited with ids and the outcome only; the two-year job may now publish", async () => {
    const result = await check(TWO, answering({ [TWO.number]: reply(TWO.number, CONSOLE) }));
    assert.equal(result.outcome, "level");
    const row = (await db.query(`SELECT outcome, trigger, unknown_reason, v7_scope1_tco2e::float8 AS v1, console_scope1_tco2e::float8 AS c1 FROM nzi_console.v7_drift_checks WHERE check_id = $1`, [result.checkId])).rows[0];
    assert.deepEqual(row, { outcome: "level", trigger: "admin", unknown_reason: null, v1: 2.39, c1: 2.39 });
    const audit = (await db.query<{ after_json: Record<string, unknown>; entity_id: string }>(`SELECT after_json, entity_id FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'import.drift.checked'`, [ORG_DG])).rows;
    assert.deepEqual(audit.map((entry) => [entry.entity_id, Object.keys(entry.after_json).sort()]), [[TWO.jobId, ["behind", "checkId", "outcome", "trigger"]]], "no figure in the audit");
    await gate(TWO);
  });

  it("behind: the banner says the brief's line; the gate refuses it by scope; the list puts it first", async () => {
    const result = await check(CAL, answering({ [CAL.number]: reply(CAL.number, { ...CONSOLE, "2": 2121.17 }) }));
    assert.equal(result.outcome, "behind");
    const banner = await withTenantRead(database.pool, ORG_DG, (client) => readV7DriftBanner(client, ORG_DG, CAL.jobId));
    assert.deepEqual([banner?.tone, banner?.line], ["behind", "Behind the previous system: Scope 2 0.0 here, 2,121.2 in the previous system"]);
    await assert.rejects(gate(CAL), (error) => codes(error).includes("BEHIND_PREVIOUS_SYSTEM"));
    const list = await withTenantRead(database.pool, ORG_DG, (client) => listV7Drift(client, ORG_DG));
    assert.deepEqual(list.map((item) => [item.jobNumber, item.outcome]), [[CAL.number, "behind"], [TWO.number, "level"], [THIRD.number, "unchecked"]], "imported jobs only, the furthest first");
    assert.deepEqual(list[0]!.scopes[1], { scope: "2", console: 0, previous: 2121.17, difference: -2121.17 });
    assert.deepEqual(list[2]!.scopes.map((entry) => entry.console), [null, null, null], "never checked: no figure, not a zero");
  });

  it("through issueReportVersion: a validated report on the job behind is not issued, and nothing changes", async () => {
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG_DG]);
    await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
      VALUES ($1, 'dg-snap', $2, 1, 1, $3, '{}'::jsonb, 'staff-consultant')`, [ORG_DG, CAL.jobId, `sha256:${"a".repeat(64)}`]);
    await db.query(`INSERT INTO nzi_console.report_versions (organisation_id, report_version_id, job_id, status, manifest_version, reviewed_snapshot_id, data_hash)
      VALUES ($1, 'dg-rv', $2, 'validated', 1, 'dg-snap', $3)`, [ORG_DG, CAL.jobId, `sha256:${"a".repeat(64)}`]);
    const scopeKey = (await db.query<{ scope_key: string }>(`SELECT scope_key FROM nzi_console.report_versions WHERE report_version_id = 'dg-rv'`)).rows[0]!.scope_key;
    const context: CommandContext = { organisationId: ORG_DG, actorId: "staff-admin", principal: "staff", idempotencyKey: "dg-issue", correlationId: "dg-issue", grant: commandGrantForRole("admin", ORG_DG, "staff-admin") };
    await assert.rejects(withTenantWrite(database.pool, ORG_DG, (client) => issueReportVersion(client, context, { reportVersionId: "dg-rv", jobId: CAL.jobId, scopeKey }, "validated")),
      (error) => codes(error).includes("BEHIND_PREVIOUS_SYSTEM"));
    assert.deepEqual((await db.query(`SELECT status, published_at FROM nzi_console.report_versions WHERE report_version_id = 'dg-rv'`)).rows[0], { status: "validated", published_at: null });
  });

  it("unknown: stored with its reason and no figure of the previous system's; a one-year job publishes, a two-year job does not", async () => {
    const calendar = await check(CAL, answering({}));
    assert.deepEqual([calendar.outcome, calendar.unknownReason, calendar.scopes], ["unknown", "not-found", null]);
    await gate(CAL);
    const banner = await withTenantRead(database.pool, ORG_DG, (client) => readV7DriftBanner(client, ORG_DG, CAL.jobId));
    assert.deepEqual([banner?.tone, banner?.line], ["unknown", "Can't check against the previous system just now."]);
    await check(TWO, async () => ({ ok: false, reason: "timeout" }));
    await assert.rejects(gate(TWO), (error) => codes(error).includes("NOT_CHECKED_AGAINST_PREVIOUS_SYSTEM"));
  });

  it("the list also carries each job's enabled rows now, its re-ingest and its last checks, newest first, with no figure for an unknown", async () => {
    const list = await withTenantRead(database.pool, ORG_DG, (client) => listV7Drift(client, ORG_DG));
    const of = (entry: ReturnType<typeof job>) => list.find((item) => item.jobId === entry.jobId)!;
    const enabled = async (jobId: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND enabled`, [ORG_DG, jobId])).rows[0]!.n;
    for (const entry of [CAL, TWO, THIRD]) assert.equal(of(entry).consoleRows, await enabled(entry.jobId));
    assert.ok(of(CAL).consoleRows > 0);
    const reingested = (await db.query<{ at: Date }>(`SELECT max(created_at) AS at FROM nzi_console.v7_reingest_runs WHERE organisation_id = $1 AND job_id = $2 AND status = 'completed'`, [ORG_DG, CAL.jobId])).rows[0]!.at;
    assert.equal(of(CAL).reingestedAt, reingested.toISOString());
    assert.deepEqual(of(CAL).history.map((entry) => [entry.outcome, entry.trigger, entry.unknownReason, entry.differences]),
      [["unknown", "admin", "not-found", [null, null, null]], ["behind", "admin", null, [0, -2121.17, 0]]]);
    assert.deepEqual(of(TWO).history.map((entry) => [entry.outcome, entry.unknownReason]), [["unknown", "timeout"], ["level", null]]);
    assert.equal(of(CAL).history[0]!.checkedAt, of(CAL).checkedAt, "the history's newest is the row's own check");
    assert.deepEqual(of(THIRD).history, [], "never checked: no history");
    await withTenantRead(database.pool, ORG_DG, async (client) => {
      const deep = await listV7Drift(client, ORG_DG);
      assert.ok(deep.every((item) => item.history.length <= V7_DRIFT_HISTORY_DEPTH));
    });
  });

  it("a job not imported from the previous system is refused, and nothing is stored", async () => {
    const before = await checks();
    await assert.rejects(check(NATIVE, answering({})), (error) => codes(error).includes("NOT_IMPORTED"));
    assert.equal(await checks(), before);
  });

  it("0236 holds: append-only for everyone, and an unknown check can't carry a figure of the previous system's", async () => {
    await assert.rejects(db.query(`UPDATE nzi_console.v7_drift_checks SET outcome = 'level'`), /append-only/);
    await assert.rejects(db.query(`DELETE FROM nzi_console.v7_drift_checks`), /append-only/);
    await assert.rejects(db.query(`INSERT INTO nzi_console.v7_drift_checks (organisation_id, check_id, job_id, outcome, trigger, unknown_reason, console_scope1_tco2e, console_scope2_tco2e, console_scope3_tco2e,
      v7_scope1_tco2e, v7_scope2_tco2e, v7_scope3_tco2e, requested_by, correlation_id) VALUES ($1, 'x', $2, 'unknown', 'admin', 'timeout', 0, 0, 0, 1, 1, 1, 'a', 'b')`, [ORG_DG, CAL.jobId]),
      /v7_drift_checks_known_has_figures/);
  });

  it("the run: every imported job in order, paced at the batch's floor; it stops when the source stops answering, or at once when not connected", async () => {
    const sleeps: number[] = [];
    const seen: string[] = [];
    const level: V7FiguresClient = async (job) => { seen.push(job.legacyJobNumber); return reply(job.legacyJobNumber, CONSOLE); };
    const all = await runV7DriftChecks(database.pool, level, ORG_DG, { ...options("nightly"), principal: "system", requestedBy: "policy:v7-drift-check", sleep: async (ms) => { sleeps.push(ms); } });
    assert.deepEqual([all, seen], [{ checked: 3, level: 3, behind: 0, unknown: 0, stopped: "completed" }, [CAL.number, TWO.number, THIRD.number]]);
    assert.ok(sleeps.length === 2 && sleeps.every((ms) => ms >= 2000), `paced between jobs: ${sleeps.join(",")}`);
    const down = await runV7DriftChecks(database.pool, async () => ({ ok: false, reason: "unreachable" }), ORG_DG, { ...options(), breakerThreshold: 2, sleep: async () => undefined });
    assert.deepEqual(down, { checked: 2, level: 0, behind: 0, unknown: 2, stopped: "source-unresponsive" });
    const before = await checks();
    const off = await runV7DriftChecks(database.pool, async () => ({ ok: false, reason: "not-configured" }), ORG_DG, { ...options(), sleep: async () => undefined });
    assert.deepEqual(off, { checked: 1, level: 0, behind: 0, unknown: 1, stopped: "not-configured" });
    assert.equal(await checks(), before + 1, "one honest 'can't check', then nothing called");
  });
});
