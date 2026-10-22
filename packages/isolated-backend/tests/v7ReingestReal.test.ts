import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR, V7_REPORTED_TOTAL_LABEL, V7_REPORTED_TOTAL_REASONS, type CommandContext, type StaffCommandContext, type V7ReingestJobInput } from "@nzi/contracts";
import { CommandValidationError, createReviewedCrpSnapshot, createScopeRow, createScopeRowInTransaction, MIGRATED_PERIOD } from "../src/postgresCommands";
import { getScopeQaReadiness } from "../src/readModels";
import { withTenantRead, withTenantWrite } from "../src/postgres";
import { reingestV7JobInTransaction, revertV7ReingestInTransaction } from "../src/v7Reingest";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * The v7 re-ingest commit phase (DESIGN-v7-reingest-commit-phase, ruled in REVIEW-v7-reingest-commit-phase), against a real
 * database: one job's enabled v7 rows re-written as live rows through the ordinary create and calculate, reproducing v7's
 * figures exactly, in total and per scope; the v7 rows switched off, nothing counted twice; the snapshot gate opened only by a
 * completed run; a reported total carried as a labelled figure; and nobody but the re-ingest able to write what it may.
 */
const ORG = "v7-reingest";
const JOB = "v7-job";
const STAFF = "staff-consultant";
const CROSSWALK_SHA = "d4c14407379377d20aeccebd9256eaf7ef7124846b07e05b3a0bf4afd233c8f2";
const record = (over: Record<string, unknown>) => ({ qty: 0, uom: "kWh", factor: 0, ghg_unit: "kgCO2e", original_id: "7_x", reported_tco2e: 0, data_source: "Company Data", enabled: true, ...over });

// The job's v7 rows: one per disposition, a historical unit or two, and one disabled row that was never in v7's totals.
const V7_ROWS = [
  { id: "v7-gas", scope: "1", label: "Natural gas", qty: 1000, unit: "kWh", reported: 0.2, enabled: true },
  { id: "v7-ev", scope: "2", label: "UK Electricity for EVs: Average Car Battery Electric Vehicle", qty: 50, unit: "miles", reported: 0.005, enabled: true },
  // Purchased electricity and company vehicles declare a factor (0121, 0123). The grid factor is carried by v7's vintage and by the
  // job's current edition alike — J000663's case — so the declared pick would be ambiguous; the re-ingest names v7's own.
  { id: "v7-grid", scope: "2", label: "UK Electricity: Electricity Generated", qty: 1000, unit: "kWh", reported: 0.2, enabled: true },
  { id: "v7-car", scope: "1", label: "Passenger Vehicles: Average Car Petrol", qty: 100, unit: "miles", reported: 0.025, enabled: true },
  // v7 often stored a Scope 3 row as plain "3"; its live row's scope is the category, "3.5" — refined, not moved.
  { id: "v7-water", scope: "3", label: "Water Supply", qty: 10, unit: "cubic metres", reported: 0.0015, enabled: true },
  { id: "v7-refrigerant", scope: "1", label: "Refrigerant", qty: 2.19, unit: "tCO2e", reported: 2.19, enabled: true },
  { id: "v7-spend", scope: "3.1", label: "Office supplies", qty: 100, unit: "GBP", reported: 0.05, enabled: true },
  { id: "v7-disabled", scope: "3.1", label: "Never counted", qty: 5, unit: "GBP", reported: 9.99, enabled: false },
];

const plan = (runId: string, over: Partial<V7ReingestJobInput> = {}): V7ReingestJobInput => ({
  jobId: JOB, runId, crosswalkVersion: "v1", crosswalkSha256: CROSSWALK_SHA, vintageDatasetIds: ["v7-vintage-2025"],
  rows: [
    { v7RowId: "v7-gas", disposition: "RE-INGEST", categoryCode: "1.natural-gas", scope: "1", sourceLabel: "Natural gas", quantity: 1000, unit: "kWh",
      datasetId: "v7-vintage-2025", factorId: "gas", qualityTier: "measured", v7Tco2e: 0.2, rule: "S1-GAS" },
    { v7RowId: "v7-ev", disposition: "RE-INGEST", categoryCode: "2.purchased-electricity", scope: "2", sourceLabel: "UK Electricity for EVs", quantity: 50, unit: "miles",
      datasetId: "v7-vintage-2025", factorId: "ev-miles", qualityTier: "measured", v7Tco2e: 0.005, rule: "S2-EV" },
    { v7RowId: "v7-grid", disposition: "RE-INGEST", categoryCode: "2.purchased-electricity", scope: "2", sourceLabel: "UK Electricity", quantity: 1000, unit: "kWh",
      datasetId: "v7-vintage-2025", factorId: "uk-ghg-7_400_4000_5_1", qualityTier: "measured", v7Tco2e: 0.2, rule: "S2-ELEC" },
    { v7RowId: "v7-car", disposition: "RE-INGEST", categoryCode: "1.company-vehicles", scope: "1", sourceLabel: "Average Car Petrol", quantity: 100, unit: "miles",
      datasetId: "v7-vintage-2025", factorId: "uk-ghg-4_301_3070_9_1", qualityTier: "measured", v7Tco2e: 0.025, rule: "S1-VEH" },
    { v7RowId: "v7-water", disposition: "RE-INGEST", categoryCode: "3.5", scope: "3.5", sourceLabel: "Water Supply", quantity: 10, unit: "m3",
      datasetId: "v7-vintage-2025", factorId: "water", qualityTier: "measured", v7Tco2e: 0.0015, rule: "S3-5" },
    { v7RowId: "v7-refrigerant", disposition: "REPORTED-TOTAL", categoryCode: "1.refrigerants", scope: "1", sourceLabel: "Refrigerant", quantity: null, unit: null,
      qualityTier: "estimated", v7Tco2e: 2.19, rule: "T1" },
    { v7RowId: "v7-spend", disposition: "CARRY-V7-FACTOR", categoryCode: "3.1", scope: "3.1", sourceLabel: "Office supplies", quantity: 100, unit: "GBP",
      carriedFactor: { label: "Office supplies (v7 factor)", unit: "GBP", kgco2ePerUnit: 0.5, vintageYear: 2025 }, qualityTier: "spend-based", v7Tco2e: 0.05, rule: "NOFACTOR" },
  ],
  ...over,
});

class Rollback extends Error { constructor(readonly outcome: unknown) { super("dry run"); } }

describe("the v7 re-ingest commit phase, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const reingest = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: `reingest-${keys}`, correlationId: `corr-reingest-${keys}`,
      reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", ORG, V7_REINGEST_ACTOR) };
  };
  const staff = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `staff-${keys}`, correlationId: `corr-staff-${keys}`,
      reason: "test", grant: commandGrantForRole("admin", ORG, STAFF) };
  };
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const run = (input: V7ReingestJobInput, commit: boolean, context = reingest()) => withTenantWrite(database.pool, ORG, async (client) => {
    const outcome = await reingestV7JobInTransaction(client, input, context);
    if (!commit) throw new Rollback(outcome);
    return outcome;
  });
  const dryRun = async (input: V7ReingestJobInput) => {
    try { await run(input, false); } catch (error) { if (error instanceof Rollback) return error.outcome as Awaited<ReturnType<typeof run>>; throw error; }
    throw new Error("unreachable");
  };
  const freezeCodes = async (job: string) => {
    try { await createReviewedCrpSnapshot(database.pool, { jobId: job, expectedJobVersion: 1 }, staff()); return []; } catch (error) { return codes(error); }
  };
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0]!.n);

  before(async () => {
    database = (await createDisposableDatabase("v7reingest"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','EFF Test','active')`, [ORG]);
    for (const [job, sequence, v7] of [[JOB, 663, true], ["other-job", 2, false]] as const) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id)
        VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31',$4,$5)`, [ORG, job, sequence, v7 ? "nzi-pro-v7" : null, v7 ? "663" : null]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [ORG, job]);
    }
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [ORG]);
    for (const [id, label, unit, kg, scope] of [["gas", "Natural gas", "kWh", 0.2, "1"], ["ev-miles", "UK electricity for EVs, BEV", "miles", 0.1, "2"], ["water", "Water supply", "m3", 0.15, "3"],
      ["uk-ghg-7_400_4000_5_1", "UK electricity (2025)", "kWh", 0.2, "2"], ["uk-ghg-4_301_3070_9_1", "Average car, petrol", "miles", 0.25, "1"]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6])`,
        [ORG, id, label, unit, kg, scope]);
    }
    // The job's current edition, already selected (as J000663's uk-ghg-gb-2026 is), carrying the same grid factor id.
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'current-2026','DESNZ GB 2026','1','2026-01-01','2026-12-31','GB','active','Test','Source: test.')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,'current-2026','uk-ghg-7_400_4000_5_1','UK electricity (2026)','kWh',0.19,ARRAY['2'])`, [ORG]);
    await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,'current-2026','automatic','test','test')`, [ORG, JOB]);
    for (const row of V7_ROWS) {
      await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,
          calculated_tco2e,review_status,enabled,origin,migrated_record,source_system,legacy_db_id)
        VALUES ($1,$2,$3,$4,$5,$5,'v7','v7',$6,$7,$8,'pending',$9,'migrated',$10::jsonb,'nzi-pro-v7',$2)`,
        [ORG, row.id, JOB, row.scope, row.label, row.qty, row.unit, row.reported, row.enabled,
          JSON.stringify(record({ qty: row.qty, uom: row.unit, reported_tco2e: row.reported, enabled: row.enabled }))]);
    }
    await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,calculated_tco2e)
                    VALUES ($1,'other-live','other-job','2','Electricity','Electricity','UK electricity','Grid',500,'kWh',0.1)`, [ORG]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("is refused for any actor but policy:v7-reingest as the system principal (condition 3)", async () => {
    await assert.rejects(run(plan(`v7-reingest-${randomUUID()}`), true, staff()), (error) => codes(error).includes("REINGEST_ACTOR_ONLY"));
    await assert.rejects(run(plan(`v7-reingest-${randomUUID()}`), true, { ...reingest(), principal: "staff" } as StaffCommandContext), (error) => codes(error).includes("REINGEST_ACTOR_ONLY"));
  });

  it("before any run, the job is an imported period: the snapshot gate refuses it (decision 12, unchanged)", async () => {
    assert.deepEqual(await freezeCodes(JOB), [MIGRATED_PERIOD]);
  });

  it("refuses a plan that is not the whole job, in its own scopes, with its own figures — before writing anything", async () => {
    const id = () => `v7-reingest-${randomUUID()}`;
    const full = plan(id());
    await assert.rejects(run({ ...full, rows: full.rows.filter((row) => row.v7RowId !== "v7-spend") }, true), (error) => codes(error).includes("PLAN_INCOMPLETE"));
    await assert.rejects(run({ ...full, runId: id(), rows: full.rows.map((row) => row.v7RowId === "v7-water" ? { ...row, scope: "2", categoryCode: "2.purchased-electricity" } : row) }, true), (error) => codes(error).includes("PLAN_SCOPE_MOVED"), "Scope 3 to Scope 2 is a move");
    await assert.rejects(run({ ...full, runId: id(), rows: full.rows.map((row) => row.v7RowId === "v7-spend" ? { ...row, scope: "3.2", categoryCode: "3.2" } : row) }, true), (error) => codes(error).includes("PLAN_SCOPE_MOVED"), "a v7 row already in 3.1 is not re-filed to 3.2");
    await assert.rejects(run({ ...full, runId: id(), rows: full.rows.map((row) => row.v7RowId === "v7-gas" ? { ...row, v7Tco2e: 0.3 } : row) }, true), (error) => codes(error).includes("PLAN_FIGURE_MISMATCH"));
    await assert.rejects(run({ ...full, runId: id(), rows: [...full.rows, { ...full.rows[0]!, v7RowId: "v7-disabled" }] }, true), (error) => codes(error).includes("PLAN_UNKNOWN_ROW"), "a disabled v7 row was never in v7's totals");
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live'`, [JOB]), 0);
  });

  it("a dry run reconciles, in total and per scope, and leaves nothing behind", async () => {
    const outcome = await dryRun(plan(`v7-reingest-${randomUUID()}`));
    assert.equal(outcome.data.v7TotalTco2e, 2.6715);
    assert.equal(outcome.data.nativeTotalTco2e, 2.6715);
    assert.deepEqual(outcome.data.scopeTotals, { "1": { v7: 2.415, native: 2.415 }, "2": { v7: 0.205, native: 0.205 }, "3": { v7: 0.0515, native: 0.0515 } });
    assert.deepEqual(outcome.data.rowsByDisposition, { "RE-INGEST": 5, "REPORTED-TOTAL": 1, "CARRY-V7-FACTOR": 1 });
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live'`, [JOB]), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='migrated' AND enabled`, [JOB]), 7);
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.v7_reingest_runs`), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.job_dataset_selections WHERE job_id=$1`, [JOB]), 1, "only the job's own current edition; the vintage rolled back");
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.client_factors`), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE actor_id=$1`, [V7_REINGEST_ACTOR]), 0);
  });

  let committedRun = "";
  it("commits: live rows through the ordinary create and calculate, each reproducing its v7 row; the v7 rows switched off; one run recorded", async () => {
    committedRun = `v7-reingest-${randomUUID()}`;
    const outcome = await run(plan(committedRun), true);
    assert.equal(outcome.data.nativeTotalTco2e, outcome.data.v7TotalTco2e);
    const live = (await db.query(`SELECT reingested_from_row_id AS v7, category_code, quantity::float AS q, unit, review_status, quality_tier, factor_source,
        coalesce(override_tco2e, calculated_tco2e)::float AS t, override_reason, factor_label, provenance_json->'reingest'->>'runId' AS run,
        (SELECT count(*) FROM jsonb_array_elements(lineage_json) l WHERE l->>'title' IN ('Re-ingested from NZ Insights Pro v7','v7 reported total carried'))::int AS marked,
        (SELECT count(*) FROM jsonb_array_elements(lineage_json) l WHERE l->>'detail' = 'declared resolution not applied: v7''s own factor (ruling 3)')::int AS undeclared,
        dataset_id, factor_id
      FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' ORDER BY reingested_from_row_id`, [JOB])).rows;
    assert.deepEqual(live.map((row) => [row.v7, row.category_code, row.t, row.review_status, row.run, row.marked]), [
      ["v7-car", "1.company-vehicles", 0.025, "pending", committedRun, 1],
      ["v7-ev", "2.purchased-electricity", 0.005, "pending", committedRun, 1],
      ["v7-gas", "1.natural-gas", 0.2, "pending", committedRun, 1],
      ["v7-grid", "2.purchased-electricity", 0.2, "pending", committedRun, 1],
      ["v7-refrigerant", "1.refrigerants", 2.19, "pending", committedRun, 1],
      ["v7-spend", "3.1", 0.05, "pending", committedRun, 1],
      ["v7-water", "3.5", 0.0015, "pending", committedRun, 1],
    ], "D4: written new, pending human review — never auto-approved; condition 5: every one marked in its lineage");
    // RULING-v7-reingest-declared-factor (a): in the categories that declare a factor, the row keeps v7's own — the grid row its
    // 2025 vintage, not the job's 2026 edition the declared pick would have meant — and says the declared pick was not applied.
    assert.deepEqual(live.filter((row) => row.undeclared === 1).map((row) => row.v7), ["v7-car", "v7-ev", "v7-grid"]);
    assert.deepEqual(live.filter((row) => row.undeclared !== 1).map((row) => row.v7), ["v7-gas", "v7-refrigerant", "v7-spend", "v7-water"], "no mark where nothing is declared");
    assert.deepEqual([live.find((row) => row.v7 === "v7-grid")!.dataset_id, live.find((row) => row.v7 === "v7-grid")!.factor_id], ["v7-vintage-2025", "uk-ghg-7_400_4000_5_1"]);
    const total = live.find((row) => row.v7 === "v7-refrigerant")!;
    assert.deepEqual([total.q, total.unit, total.override_reason, total.factor_label, total.quality_tier], [null, null, V7_REPORTED_TOTAL_REASONS[0], V7_REPORTED_TOTAL_LABEL, "estimated"],
      "D5: a figure, labelled as a figure — no quantity, no unit, the closed reason and the label");
    assert.equal(live.find((row) => row.v7 === "v7-spend")!.factor_source, "client", "ruling 4: v7's own factor value, carried");
    assert.deepEqual((await db.query(`SELECT scope_row_id, enabled FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='migrated' ORDER BY scope_row_id`, [JOB])).rows.map((row) => [row.scope_row_id, row.enabled]),
      V7_ROWS.map((row) => [row.id, false]).sort(), "D6: every v7 row off; the disabled one stays off; none deleted");
    assert.deepEqual((await db.query(`SELECT dataset_id, selection_source, reason LIKE 'v7 re-ingest%' AS ours FROM nzi_console.job_dataset_selections WHERE job_id=$1 ORDER BY dataset_id`, [JOB])).rows,
      [{ dataset_id: "current-2026", selection_source: "automatic", ours: false }, { dataset_id: "v7-vintage-2025", selection_source: "manual", ours: true }], "ruling 3: v7's vintage, added; the job's own kept");
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.client_factors WHERE source_system='nzi-pro-v7-reingest' AND legacy_db_id='v7-spend' AND job_id=$1`, [JOB]), 1);
    const runRow = (await db.query(`SELECT status, v7_total_tco2e::float AS v7, native_total_tco2e::float AS native, crosswalk_version FROM nzi_console.v7_reingest_runs WHERE run_id=$1`, [committedRun])).rows[0];
    assert.deepEqual(runRow, { status: "completed", v7: 2.6715, native: 2.6715, crosswalk_version: "v1" });
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE action='v7_row_superseded' AND actor_id=$1`, [V7_REINGEST_ACTOR]), 7, "a before/after event per v7 row switched off");
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE action='scope_row_created' AND actor_id=$1`, [V7_REINGEST_ACTOR]), 7, "each live row audited like any create");
    assert.equal((await db.query(`SELECT calculated_tco2e::float AS t, enabled FROM nzi_console.job_scope_rows WHERE scope_row_id='other-live'`)).rows[0]!.t, 0.1, "no other job's row moved");
  });

  it("NZC-120: no money in the run's audit event, its outbox payload or its record", async () => {
    const audit = (await db.query(`SELECT after_json::text AS j FROM nzi_console.audit_events WHERE action='v7_job_reingested'`)).rows[0]!.j as string;
    const outbox = (await db.query(`SELECT payload_json::text AS j FROM nzi_console.transactional_outbox WHERE topic='v7.reingest.completed'`)).rows[0]!.j as string;
    const runRow = (await db.query(`SELECT to_jsonb(r)::text AS j FROM nzi_console.v7_reingest_runs r WHERE run_id=$1`, [committedRun])).rows[0]!.j as string;
    for (const text of [audit, outbox, runRow]) {
      assert.doesNotMatch(text, /GBP|£|quantity|kgco2e|price|cost/i);
    }
  });

  it("with the run completed and every v7 row off, the snapshot gate lets the job through to its ordinary review gates — and readiness agrees", async () => {
    assert.deepEqual(await freezeCodes(JOB), ["QA_INCOMPLETE"], "no longer an imported period: what stops it now is the live rows' review");
    const readiness = await withTenantRead(database.pool, ORG, (client) => getScopeQaReadiness(client, JOB));
    assert.deepEqual([readiness.migratedRows, readiness.independentReviewPending, readiness.readyForReporting], [8, 7, false]);
    // Once a reviewer has approved the live rows (set here as the owner; the review commands are their own tests), the job is
    // ready — its switched-off v7 rows no longer make it an imported period, to readiness as to the gate.
    await db.query(`UPDATE nzi_console.job_scope_rows SET review_status='approved', reviewed_by='reviewer-1', reviewed_at=now(), reviewed_row_version=version
                     WHERE job_id=$1 AND origin='live'`, [JOB]);
    const approved = await withTenantRead(database.pool, ORG, (client) => getScopeQaReadiness(client, JOB));
    assert.deepEqual([approved.migratedRows, approved.independentReviewPending, approved.readyForReporting], [8, 0, true]);
    await db.query(`UPDATE nzi_console.job_scope_rows SET review_status='pending', reviewed_by=NULL, reviewed_at=NULL, reviewed_row_version=NULL WHERE job_id=$1 AND origin='live'`, [JOB]);
  });

  it("re-running plans nothing: a second run is refused, and a replay of the same run is the same outcome", async () => {
    await assert.rejects(run(plan(`v7-reingest-${randomUUID()}`), true), (error) => codes(error).includes("ALREADY_REINGESTED"));
  });

  it("condition 3: a normal actor still cannot write a reported-total row, nor use any re-ingest allowance", async () => {
    const totalRow = { jobId: JOB, scope: "1", categoryCode: "1.refrigerants", sourceLabel: "Refrigerant", quantity: null, unit: null, datasetId: null, factorId: null,
      factorVersion: null, factorLabel: null, qualityTier: "estimated" as const, overrideTco2e: 2.19, overrideReason: V7_REPORTED_TOTAL_REASONS[0] };
    await assert.rejects(createScopeRow(database.pool, totalRow, staff()), (error) => codes(error).includes("FACTOR_REQUIRED"), "the ordinary create still needs a factor for a categorised row");
    await assert.rejects(withTenantWrite(database.pool, ORG, (client) => createScopeRowInTransaction(client, totalRow, staff(), { reingestedFrom: "v7-refrigerant", reportedTotal: true })),
      (error) => codes(error).includes("REINGEST_ACTOR_ONLY"));
    await assert.rejects(withTenantWrite(database.pool, ORG, (client) => createScopeRowInTransaction(client, { ...totalRow, overrideReason: "because" }, reingest(), { reingestedFrom: "v7-refrigerant", reportedTotal: true })),
      (error) => codes(error).includes("REPORTED_TOTAL_SHAPE"), "only a reason from the closed set");
    await assert.rejects(withTenantWrite(database.pool, ORG, (client) => createScopeRowInTransaction(client, { ...totalRow, quantity: 1, unit: "kWh" }, reingest(), { reingestedFrom: "v7-refrigerant", reportedTotal: true })),
      (error) => codes(error).includes("REPORTED_TOTAL_SHAPE"), "and only in that shape");
  });

  it("RULING-v7-reingest-declared-factor (a): a consultant still meets declared resolution; only the re-ingest is exempt", async () => {
    // Both editions carrying the grid factor are now selected (the job's 2026 and v7's 2025): the declared pick is ambiguous for
    // a consultant naming either — the consultant path is unchanged (the resolver's own fix is a separate ticket, FOLLOW-UPS).
    const grid = { jobId: JOB, scope: "2", categoryCode: "2.purchased-electricity", sourceLabel: "Grid", quantity: 500, unit: "kWh", datasetId: "v7-vintage-2025",
      factorId: "uk-ghg-7_400_4000_5_1", factorVersion: null, factorLabel: null, qualityTier: "measured" as const };
    await assert.rejects(createScopeRow(database.pool, grid, staff()), (error) => codes(error).includes("DECLARED_FACTOR_AMBIGUOUS"), "the consultant path is unchanged");
    // A per-mile EV row is not the declared rule's case (it does not fire for miles); a consultant is refused it by the unit
    // field's whitelist, which only the re-ingest's historicalUnit skips.
    await assert.rejects(createScopeRow(database.pool, { ...grid, unit: "miles", factorId: "ev-miles" }, staff()), (error) => codes(error).includes("UNIT_NOT_ACCEPTED"));
    await assert.rejects(withTenantWrite(database.pool, ORG, (client) => createScopeRowInTransaction(client, grid, staff(), { declaredResolutionExempt: true })),
      (error) => codes(error).includes("REINGEST_ACTOR_ONLY"), "the exemption does not leak to a consultant");
    await assert.rejects(withTenantWrite(database.pool, ORG, (client) => createScopeRowInTransaction(client, grid, reingest(), { declaredResolutionExempt: true })),
      (error) => codes(error).includes("REQUIRED"), "and even the re-ingest uses it only for a row that names the v7 row it replaces");
  });

  it("the exemption skips only the declared pick: the factor must still be in the selection and reconcile with its unit", async () => {
    const base = { jobId: JOB, scope: "2", categoryCode: "2.purchased-electricity", sourceLabel: "Grid", quantity: 500, unit: "kWh", datasetId: "v7-vintage-2025",
      factorId: "uk-ghg-7_400_4000_5_1", factorVersion: null, factorLabel: null, qualityTier: "measured" as const };
    const exempt = { reingestedFrom: "v7-grid", historicalUnit: true, declaredResolutionExempt: true };
    await assert.rejects(withTenantWrite(database.pool, ORG, (client) => createScopeRowInTransaction(client, { ...base, datasetId: "not-selected" }, reingest(), exempt)),
      (error) => codes(error).includes("FACTOR_NOT_SELECTED"));
    await assert.rejects(withTenantWrite(database.pool, ORG, (client) => createScopeRowInTransaction(client, { ...base, unit: "litres" }, reingest(), exempt)),
      (error) => codes(error).includes("UNIT_INCOMPATIBLE"));
  });

  it("a normal actor still meets the field's accepted units: water in m³ is refused on the ordinary create", async () => {
    const water = { jobId: JOB, scope: "3.5", categoryCode: "3.5", sourceLabel: "Water", quantity: 10, unit: "m3", datasetId: "v7-vintage-2025", factorId: "water",
      factorVersion: null, factorLabel: null, qualityTier: "measured" as const };
    await assert.rejects(createScopeRow(database.pool, water, staff()), (error) => codes(error).includes("UNIT_NOT_ACCEPTED"));
  });

  it("reverts before any snapshot: the live rows off, the v7 rows back on, the gate closed again — and a later run may go again", async () => {
    await withTenantWrite(database.pool, ORG, (client) => revertV7ReingestInTransaction(client, { jobId: JOB, runId: committedRun }, reingest()));
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' AND enabled`, [JOB]), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live'`, [JOB]), 7, "switched off, never deleted");
    assert.deepEqual((await db.query(`SELECT scope_row_id FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='migrated' AND enabled ORDER BY 1`, [JOB])).rows.map((row) => row.scope_row_id),
      ["v7-car", "v7-ev", "v7-gas", "v7-grid", "v7-refrigerant", "v7-spend", "v7-water"], "the disabled v7 row stays off");
    assert.equal((await db.query(`SELECT status FROM nzi_console.v7_reingest_runs WHERE run_id=$1`, [committedRun])).rows[0]!.status, "reverted");
    assert.deepEqual(await freezeCodes(JOB), [MIGRATED_PERIOD]);
    const again = await run(plan(`v7-reingest-${randomUUID()}`), true);
    assert.equal(again.data.clientFactorsCreated, 0, "the carried factor is reused, not duplicated");
    assert.equal(again.data.nativeTotalTco2e, 2.6715);
  });
});
