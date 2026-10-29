import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR, type CommandContext, type V7ReingestPlanRow } from "@nzi/contracts";
import { createReviewedCrpSnapshot } from "../src/postgresCommands";
import { getClientWorkspace } from "../src/readModels";
import { withTenantRead, withTenantWrite } from "../src/postgres";
import { attestReingestRows, previewReingestAttestation } from "../src/reingestAttest";
import { openV7Residuals, runV7BookJobInTransaction, splitCsvLine, v7BookSkip, type V7BookJobOutcome, type V7BookPlan } from "../src/v7ReingestBook";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * RULING-v7-book-runner (29 Oct 2026) against a real database: the book runner over the ruled `v7.reingest.job`, and D7 as
 * refined — v7's input (quantity, unit, apportionment) the hard gate, the emission the console's calculation, v7's reported
 * figure a comparison. A drift row passes on its quantity at the calc's figure and is flagged; a mis-mapped factor shows as a
 * > 5% delta; a plan that moves a quantity is refused and writes nothing; totals-only carries v7's figure; an open residual is
 * skipped; J000663 is held; the year edition is added, or the job flagged; a dry run writes nothing; and one job end to end —
 * run, a person's attest with the deltas acknowledged, the snapshot, the client's analytics year.
 */
const ORG = "v7-book";
const CLIENT = "kinetics-test";
const REVIEWER = "staff-reviewer";
const SHA = "d4c14407379377d20aeccebd9256eaf7ef7124846b07e05b3a0bf4afd233c8f2";
type V7 = { id: string; scope: string; label: string; qty: number; unit: string; reported: number; applyPct?: number };
const record = (v7: V7) => ({ qty: v7.qty, uom: v7.unit, factor: 0, ghg_unit: "kgCO2e", original_id: "7_x", reported_tco2e: v7.reported, data_source: "Company Data", enabled: true,
  ...(v7.applyPct !== undefined ? { apply_pct: v7.applyPct } : {}) });
const gas = (id: string, qty: number, reported: number, factorId = "gas"): [V7, V7ReingestPlanRow] => [
  { id, scope: "1", label: `Gas ${id}`, qty, unit: "kWh", reported },
  { v7RowId: id, disposition: "RE-INGEST", categoryCode: "1.natural-gas", scope: "1", sourceLabel: `Gas ${id}`, quantity: qty, unit: "kWh",
    datasetId: "v7-vintage-2025", factorId, qualityTier: "measured", v7Tco2e: reported, rule: "S1-GAS" },
];
const water = (id: string): [V7, V7ReingestPlanRow] => [
  { id, scope: "3", label: "Water Supply", qty: 10, unit: "cubic metres", reported: 0.0015 },
  { v7RowId: id, disposition: "RE-INGEST", categoryCode: "3.5", scope: "3.5", sourceLabel: "Water Supply", quantity: 10, unit: "m3",
    datasetId: "v7-vintage-2025", factorId: "water", qualityTier: "measured", v7Tco2e: 0.0015, rule: "S3-5" },
];
const total = (id: string, reported: number): [V7, V7ReingestPlanRow] => [
  { id, scope: "1", label: `Refrigerant ${id}`, qty: reported, unit: "tCO2e", reported },
  { v7RowId: id, disposition: "REPORTED-TOTAL", categoryCode: "1.refrigerants", scope: "1", sourceLabel: `Refrigerant ${id}`, quantity: null, unit: null,
    qualityTier: "estimated", v7Tco2e: reported, rule: "T1" },
];

describe("the pure parts of the book runner", () => {
  it("reads the residuals' scope_row_id column, quotes honoured, less what Francis signed off", () => {
    const csv = `disposition,job,v7_label,scope_row_id\nFOR-FRANCIS,J1,"Petrol, small plant",v7-row-1\r\nCARRY,J2,"He said ""spend""",v7-row-2\n\n`;
    assert.deepEqual([...openV7Residuals(csv)], ["v7-row-1", "v7-row-2"]);
    assert.deepEqual([...openV7Residuals(csv, new Set(["v7-row-2"]))], ["v7-row-1"]);
    assert.deepEqual(splitCsvLine(`a,"b,c",d`), ["a", "b,c", "d"]);
    assert.throws(() => openV7Residuals("job,label\nJ1,x"), /scope_row_id/);
  });
  it("holds J000663 and skips a plan naming an open residual, saying how many rows", () => {
    const plan = (jobId: string, ids: string[]): V7BookPlan => ({ jobId, crosswalkVersion: "v1", crosswalkSha256: SHA, vintageDatasetIds: [],
      rows: ids.map((id) => gas(id, 1, 0.0002)[1]) });
    assert.equal(v7BookSkip(plan("v7-job-663", ["a"]), new Set())!.status, "HELD");
    assert.deepEqual(v7BookSkip(plan("j", ["a", "b", "c"]), new Set(["b", "c"])), { status: "OPEN_RESIDUAL", reason: "2 of its 3 rows await Francis's sign-off (residuals-for-francis.csv)" });
    assert.equal(v7BookSkip(plan("j", ["a"]), new Set(["z"])), null);
  });
});

describe("the v7 book runner, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  let sequence = 0;
  const context = (actorId: string, principal: "staff" | "system", reason = "book runner (test)"): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId, principal, idempotencyKey: `${actorId}-${keys}`, correlationId: `corr-${keys}`, reason, grant: commandGrantForRole("admin", ORG, actorId) };
  };
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0]!.n);
  const liveRows = (job: string) => count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live'`, [job]);
  const v7On = (job: string) => count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='migrated' AND enabled`, [job]);
  const runs = (job: string) => count(`SELECT count(*) AS n FROM nzi_console.v7_reingest_runs WHERE job_id=$1`, [job]);

  async function seedJob(job: string, rows: Array<[V7, V7ReingestPlanRow]>, options: { country?: string; selectYear?: boolean } = {}): Promise<V7BookPlan> {
    sequence += 1;
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id)
      VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7',$5)`, [ORG, job, CLIENT, sequence, String(sequence)]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31',$3)`, [ORG, job, options.country ?? "GB"]);
    // 412 of the book's 416 migrated jobs already have their year's edition selected.
    if (options.selectYear !== false)
      await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,warnings_json,selected_by) VALUES ($1,$2,'v7-vintage-2025','manual','seed','[]'::jsonb,'seed')`, [ORG, job]);
    for (const [v7] of rows) {
      await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,
          calculated_tco2e,review_status,enabled,origin,migrated_record,source_system,legacy_db_id)
        VALUES ($1,$2,$3,$4,$5,$5,'v7','v7',$6,$7,$8,'pending',true,'migrated',$9::jsonb,'nzi-pro-v7',$2)`,
        [ORG, v7.id, job, v7.scope, v7.label, v7.qty, v7.unit, v7.reported, JSON.stringify(record(v7))]);
    }
    return { jobId: job, crosswalkVersion: "v1", crosswalkSha256: SHA, vintageDatasetIds: ["v7-vintage-2025"], rows: rows.map(([, plan]) => plan) };
  }
  class Rollback extends Error {}
  /** The runner's own shape: one job, its own transaction; kept only when asked to commit and it passed or flagged. */
  async function runJob(plan: V7BookPlan, commit: boolean, open: ReadonlySet<string> = new Set()): Promise<V7BookJobOutcome> {
    const held: { outcome: V7BookJobOutcome | null } = { outcome: null };
    const runId = `v7-reingest-${randomUUID()}`;
    try {
      await withTenantWrite(database.pool, ORG, async (client) => {
        held.outcome = await runV7BookJobInTransaction(client, plan, runId, open, { ...context(V7_REINGEST_ACTOR, "system"), idempotencyKey: runId, correlationId: runId });
        if (!commit || (held.outcome.status !== "PASS" && held.outcome.status !== "FLAGGED")) throw new Rollback();
      });
    } catch (error) { if (!(error instanceof Rollback)) throw error; }
    return held.outcome!;
  }

  before(async () => {
    database = (await createDisposableDatabase("v7book"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Kinetics (test)','active')`, [ORG, CLIENT]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence) VALUES
        ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.'),
        ($1,'ie-one-2025','IE 2025 a','1','2025-01-01','2025-12-31','IE','active','Test','Source: test.'),
        ($1,'ie-two-2025','IE 2025 b','1','2025-01-01','2025-12-31','IE','active','Test','Source: test.')`, [ORG]);
    for (const [id, label, unit, kg, scope] of [["gas", "Natural gas", "kWh", 0.2, "1"], ["oil", "Gas oil", "kWh", 0.3, "1"], ["water", "Water supply", "m3", 0.15, "3"]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6])`,
        [ORG, id, label, unit, kg, scope]);
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("R2/R3: carries v7's input; a v7-drift row passes on its quantity at the calc's figure, and is flagged in the delta report", async () => {
    // v7 reported 0.25 t for 1,000 kWh of gas; the factor gives 0.2 t. The calc is authoritative.
    const plan = await seedJob("drift-job", [gas("d-gas", 1000, 0.25), water("d-water")]);
    const outcome = await runJob(plan, true);
    assert.equal(outcome.status, "FLAGGED");
    if (outcome.status !== "FLAGGED") return;
    const live = (await db.query(`SELECT quantity::float AS q, unit, calculated_tco2e::float AS t FROM nzi_console.job_scope_rows WHERE job_id='drift-job' AND origin='live' AND reingested_from_row_id='d-gas'`)).rows[0]!;
    assert.deepEqual([live.q, live.unit], [1000, "kWh"], "v7's quantity, exactly");
    assert.ok(Math.abs(live.t - 0.2) < 1e-9, "the console's figure, not v7's 0.25");
    const row = outcome.result.deltas.rows.find((delta) => delta.v7RowId === "d-gas")!;
    assert.deepEqual([row.flag, row.relative!.toFixed(2)], ["material", "-0.20"]);
    assert.deepEqual(outcome.result.deltas.flagged, ["job", "d-gas"], "the job moves −19.9% with it; the water row reproduces");
    assert.equal(await v7On("drift-job"), 0, "v7's rows switched off: no double count");
    assert.equal(await runs("drift-job"), 1);
    assert.equal(outcome.yearEditionAdded, null, "its year edition was already selected");
    const [audit] = (await db.query(`SELECT after_json FROM nzi_console.audit_events WHERE action='v7_job_reingested' AND entity_id='drift-job' ORDER BY occurred_at DESC LIMIT 1`)).rows;
    assert.deepEqual(audit?.after_json?.deltas?.flagged, ["job", "d-gas"], "the delta report is in the run's audit");
    assert.doesNotMatch(JSON.stringify(audit?.after_json?.deltas), /Gas d-gas|Water Supply/, "ids and tCO2e only, never a label");
  });

  it("R3: a mis-mapped factor shows as a > 5% delta and is flagged; as a dry run, nothing is written", async () => {
    // The crosswalk bound gas oil (0.3) to a natural-gas row: +50% against v7.
    const plan = await seedJob("mismap-job", [gas("m-gas", 1000, 0.2, "oil")]);
    const outcome = await runJob(plan, false);
    assert.equal(outcome.status, "FLAGGED");
    if (outcome.status === "FLAGGED") assert.equal(outcome.result.deltas.rows[0]!.relative!.toFixed(2), "0.50");
    assert.deepEqual([await liveRows("mismap-job"), await v7On("mismap-job"), await runs("mismap-job")], [0, 1, 0], "the dry run wrote nothing");
  });

  it("R2: a plan that moves v7's quantity, unit or apportionment is refused — PLAN_QUANTITY_MISMATCH — and writes nothing", async () => {
    const [v7, row] = gas("q-gas", 1000, 0.2);
    const plan = await seedJob("quantity-job", [[{ ...v7, applyPct: 40 }, row]]);
    for (const moved of [{ quantity: 999 }, { unit: "litres" }, { applyPct: 100 }] as const) {
      const outcome = await runJob({ ...plan, rows: [{ ...plan.rows[0]!, applyPct: 40, ...moved }] }, true);
      assert.equal(outcome.status, "REFUSED", JSON.stringify(moved));
      if (outcome.status === "REFUSED") assert.deepEqual(outcome.issues.map((issue) => issue.code), ["PLAN_QUANTITY_MISMATCH"], JSON.stringify(moved));
    }
    assert.deepEqual([await liveRows("quantity-job"), await v7On("quantity-job"), await runs("quantity-job")], [0, 1, 0]);
    // Carried faithfully — v7's 40% included — it runs, and the live row is apportioned as v7's was.
    const ok = await runJob({ ...plan, rows: [{ ...plan.rows[0]!, applyPct: 40, v7Tco2e: 0.2 }] }, true);
    assert.equal(ok.status, "FLAGGED", "40% of 0.2 t against v7's 0.2 t is a delta to investigate, not a refusal");
    assert.equal(Number((await db.query(`SELECT apply_pct FROM nzi_console.job_scope_rows WHERE job_id='quantity-job' AND origin='live'`)).rows[0]!.apply_pct), 40);
  });

  it("R4: a totals-only job carries v7's figures as reported totals — no calculation — and passes", async () => {
    const plan = await seedJob("totals-job", [total("t-1", 2.19), total("t-2", 40.5)]);
    const outcome = await runJob(plan, true);
    assert.equal(outcome.status, "PASS");
    const rows = (await db.query(`SELECT override_tco2e::float AS o, calculated_tco2e, quantity FROM nzi_console.job_scope_rows WHERE job_id='totals-job' AND origin='live' ORDER BY reingested_from_row_id`)).rows;
    assert.deepEqual(rows.map((r) => [r.o, r.calculated_tco2e, r.quantity]), [[2.19, null, null], [40.5, null, null]]);
  });

  it("R7: a job naming an open residual is skipped and writes nothing; once Francis signs it off, it runs", async () => {
    const plan = await seedJob("residual-job", [gas("r-gas", 500, 0.1), water("r-water")]);
    const csv = "disposition,job,scope_row_id\nFOR-FRANCIS,J9,r-water\n";
    const skipped = await runJob(plan, true, openV7Residuals(csv));
    assert.deepEqual([skipped.status, "reason" in skipped ? skipped.reason : ""], ["OPEN_RESIDUAL", "1 of its 2 rows await Francis's sign-off (residuals-for-francis.csv)"]);
    assert.deepEqual([await liveRows("residual-job"), await runs("residual-job")], [0, 0]);
    assert.equal((await runJob(plan, true, openV7Residuals(csv, new Set(["r-water"])))).status, "PASS");
  });

  it("R1: J000663 is held — never re-run — whatever its plan", async () => {
    const outcome = await runJob({ jobId: "v7-job-663", crosswalkVersion: "v1", crosswalkSha256: SHA, vintageDatasetIds: [], rows: [gas("x", 1, 0.0002)[1]] }, true);
    assert.equal(outcome.status, "HELD");
  });

  it("R6: a job without its year's edition gets the one preferred edition; none, or a tie, is flagged and skipped", async () => {
    const added = await runJob(await seedJob("no-year-job", [gas("y-gas", 1000, 0.2)], { selectYear: false }), true);
    assert.equal(added.status, "PASS");
    if (added.status === "PASS") { assert.equal(added.yearEditionAdded, "v7-vintage-2025"); assert.deepEqual(added.result.datasetsAdded, ["v7-vintage-2025"], "added through the command's own, audited selection"); }
    const none = await runJob(await seedJob("fr-job", [gas("fr-gas", 1000, 0.2)], { country: "FR", selectYear: false }), true);
    assert.deepEqual([none.status, "reason" in none ? none.reason : ""], ["NO_YEAR_EDITION", "no FR edition of 2025 exists to select"]);
    const tie = await runJob(await seedJob("ie-job", [gas("ie-gas", 1000, 0.2)], { country: "IE", selectYear: false }), true);
    assert.equal(tie.status, "NO_YEAR_EDITION");
    assert.match("reason" in tie ? tie.reason : "", /2 IE editions of 2025 are equally preferred \(ie-one-2025, ie-two-2025\)/);
    assert.deepEqual([await liveRows("fr-job"), await liveRows("ie-job")], [0, 0], "never guessed, nothing written");
  });

  it("a re-run is refused by the command — ALREADY_REINGESTED — and writes nothing", async () => {
    const plan = { jobId: "totals-job", crosswalkVersion: "v1", crosswalkSha256: SHA, vintageDatasetIds: ["v7-vintage-2025"], rows: [total("t-1", 2.19)[1], total("t-2", 40.5)[1]] };
    const outcome = await runJob(plan, true);
    assert.equal(outcome.status, "REFUSED");
    if (outcome.status === "REFUSED") assert.ok(outcome.issues.some((issue) => issue.code === "ALREADY_REINGESTED"));
    assert.equal(await runs("totals-job"), 1);
  });

  it("end to end: a person attests the flagged run with its deltas acknowledged, the snapshot issues, and the client's analytics year appears", async () => {
    const reviewer = () => context(REVIEWER, "staff", "inputs carried; gas delta is v7's arithmetic, confirmed against the bill");
    const plan = await previewReingestAttestation(database.pool, "drift-job", reviewer());
    assert.deepEqual(plan.blocked, []);
    assert.deepEqual(plan.deltas!.flagged, ["job", "d-gas"]);
    const outcome = await attestReingestRows(database.pool, { jobId: "drift-job", runId: plan.runId!, rows: plan.attest.map((row) => ({ rowId: row.rowId, expectedReviewVersion: row.version })),
      gapKeys: plan.gaps.map((gap) => gap.gapKey), acknowledgedDeltas: plan.deltas!.flagged }, reviewer());
    assert.deepEqual([outcome.data.approved, outcome.data.acknowledgedDeltas], [2, ["job", "d-gas"]]);
    const note = (await db.query(`SELECT reviewer_note FROM nzi_console.scope_row_review_history WHERE job_id='drift-job' LIMIT 1`)).rows[0]!.reviewer_note as string;
    assert.match(note, /2 emission delta\(s\) against v7 investigated/);
    const snapshot = await createReviewedCrpSnapshot(database.pool, { jobId: "drift-job", expectedJobVersion: 1 }, reviewer());
    assert.ok(snapshot.data.snapshotId, "the normal snapshot path");
    const workspace = await withTenantRead(database.pool, ORG, (client) => getClientWorkspace(client, CLIENT));
    const year = workspace!.history.find((figure) => figure.year === 2025);
    assert.ok(year, "the client's analytics now have the year");
    assert.ok(Math.abs(Number(year!.totalTco2e) - 0.2015) < 1e-6, `at the console's figure (${year!.totalTco2e}), not v7's 0.2515`);
  });
});
