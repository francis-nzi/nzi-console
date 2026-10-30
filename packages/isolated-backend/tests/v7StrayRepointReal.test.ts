import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR, type V7ReingestJobInput, type V7ReingestPlanRow } from "@nzi/contracts";
import { withTenantWrite } from "../src/postgres";
import { reingestV7JobInTransaction } from "../src/v7Reingest";
import { batchAttestReingestRuns } from "../src/v7BatchAttest";
import { RULED_STRAY_ROWS, repointStrayRows, STRAY_FACTOR_ID, STRAY_REPOINT_AUDIT_ACTION } from "../src/v7StrayRepoint";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * RULING 30 Oct 2026 — the four stray 2019 diesel-van rows, against a real database: each moves to its own reporting year's edition of the
 * same factor id, is recalculated (as the re-ingest's own principal — a re-ingested row admits no one else) and is re-attested by the
 * person; the job's now-unused 2019 selection goes; a flagged delta against v7, a missing target factor, an overridden row, an issued
 * snapshot, a wrong year and a row that is not the ruled one each stop the job and write nothing; a dry run is the whole act, rolled
 * back; a re-run does nothing; the shipped ruled set is the four rows.
 */
const ORG = "v7-stray-repoint";
const PERSON = "francis";
const REASON = "re-point the four stray 2019 diesel-van rows to their reporting year's edition (ruled 30 Oct 2026)";
const CROSSWALK_SHA = "d4c14407379377d20aeccebd9256eaf7ef7124846b07e05b3a0bf4afd233c8f2";
const FROM = "uk-ghg-gb-2019";
const OLD_VALUE = 2.54603;
const VALUE: Record<number, number | null> = { 2020: 2.54603, 2021: 2.51233, 2022: null, 2023: 2.0 };
const record = (over: Record<string, unknown>) => ({ qty: 0, uom: "kWh", factor: 0, ghg_unit: "kgCO2e", original_id: "7_x", reported_tco2e: 0, data_source: "Company Data", enabled: true, ...over });
type V7 = { id: string; label: string; qty: number; unit: string; reported: number };
const dieselRow = (id: string, qty: number): [V7, V7ReingestPlanRow] => {
  const reported = (qty * OLD_VALUE) / 1000;
  return [{ id, label: "Company Vehicles: Diesel Vans", qty, unit: "litres", reported },
    { v7RowId: id, disposition: "RE-INGEST", categoryCode: "1.company-vehicles", scope: "1", sourceLabel: "Company Vehicles: Diesel Vans", quantity: qty, unit: "litres",
      datasetId: FROM, factorId: STRAY_FACTOR_ID, qualityTier: "measured", v7Tco2e: reported, rule: "S1-DIESEL" }];
};
const gasRow = (id: string, year: number): [V7, V7ReingestPlanRow] => [
  { id, label: "Natural gas", qty: 1000, unit: "kWh", reported: 0.2 },
  { v7RowId: id, disposition: "RE-INGEST", categoryCode: "1.natural-gas", scope: "1", sourceLabel: "Natural gas", quantity: 1000, unit: "kWh",
    datasetId: `uk-ghg-gb-${year}`, factorId: "gas", qualityTier: "measured", v7Tco2e: 0.2, rule: "S1-GAS" }];

describe("the stray 2019 rows are re-pointed to their own year, recalculated and re-attested, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0]!.n);
  const rowOf = async (job: string, v7: string) => (await db.query(
    `SELECT scope_row_id AS id, dataset_id, factor_id, version, review_status, reviewed_by, calculated_tco2e::float8 AS tco2e, lineage_json::text AS lineage
       FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' AND enabled AND reingested_from_row_id=$2`, [job, v7])).rows[0]!;
  const selects = (job: string, dataset: string) => count(`SELECT count(*) AS n FROM nzi_console.job_dataset_selections WHERE job_id=$1 AND dataset_id=$2`, [job, dataset]);
  const audits = () => count(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE organisation_id=$1 AND action=$2`, [ORG, STRAY_REPOINT_AUDIT_ACTION]);
  const run = (rows: Array<{ jobNumber: string; rowId: string; year: number }>, over: Partial<Parameters<typeof repointStrayRows>[1]> = {}) =>
    repointStrayRows(database.pool, { organisationId: ORG, actorId: PERSON, reason: REASON, commit: false, rows, ...over });

  async function seedJob(job: string, number: string, sequence: number, year: number, rows: Array<[V7, V7ReingestPlanRow]>) {
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
      VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',$4,$5,$6,'nzi-pro-v7',$7,$8)`, [ORG, job, sequence, year, `${year}-01-01`, `${year}-12-31`, String(sequence), number]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`, [ORG, job, `${year}-01-01`, `${year}-12-31`]);
    for (const [v7] of rows) {
      await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,
          calculated_tco2e,review_status,enabled,origin,migrated_record,source_system,legacy_db_id)
        VALUES ($1,$2,$3,'1',$4,$4,'v7','v7',$5,$6,$7,'pending',true,'migrated',$8::jsonb,'nzi-pro-v7',$2)`,
        [ORG, v7.id, job, v7.label, v7.qty, v7.unit, v7.reported, JSON.stringify(record({ qty: v7.qty, uom: v7.unit, reported_tco2e: v7.reported }))]);
    }
    const input: V7ReingestJobInput = { jobId: job, runId: `v7-reingest-${randomUUID()}`, crosswalkVersion: "v1", crosswalkSha256: CROSSWALK_SHA,
      vintageDatasetIds: [...new Set(rows.map(([, plan]) => plan.datasetId!))], rows: rows.map(([, plan]) => plan) };
    keys += 1;
    await withTenantWrite(database.pool, ORG, (client) => reingestV7JobInTransaction(client, input, { organisationId: ORG, actorId: V7_REINGEST_ACTOR, principal: "system",
      idempotencyKey: `seed-${keys}`, correlationId: `seed-${keys}`, reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", ORG, V7_REINGEST_ACTOR) }));
    // The job selects its own year's edition and the stray 2019 one, as on staging.
    for (const dataset of [`uk-ghg-gb-${year}`, FROM])
      await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,'manual','test','policy:v7-reingest') ON CONFLICT DO NOTHING`, [ORG, job, dataset]);
  }

  before(async () => {
    database = (await createDisposableDatabase("v7stray"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Stray Test','active')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'reviewer','active')`, [ORG, PERSON]);
    for (const year of [2019, 2020, 2021, 2022, 2023]) {
      await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                      VALUES ($1,$2,$3,$4,$5,$6,'GB','active','Test','Source: test.')`, [ORG, `uk-ghg-gb-${year}`, `DESNZ ${year}`, `v${year}`, `${year}-01-01`, `${year}-12-31`]);
      if (year > 2019) await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,$2,'gas','Natural gas','kWh',0.2,ARRAY['1'])`, [ORG, `uk-ghg-gb-${year}`]);
      const value = year === 2019 ? OLD_VALUE : VALUE[year];
      if (value !== null && value !== undefined)
        await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,$2,$3,'Diesel (average biofuel blend)','litres',$4,ARRAY['1'])`, [ORG, `uk-ghg-gb-${year}`, STRAY_FACTOR_ID, value]);
    }
    await seedJob("j2020", "J000724", 1, 2020, [dieselRow("d-2020", 35475.396), gasRow("g-2020", 2020)]);
    await seedJob("j2021", "J000725", 2, 2021, [dieselRow("d-2021", 38619.4), gasRow("g-2021", 2021)]);
    await seedJob("j2022", "J000726", 3, 2022, [dieselRow("d-2022", 27050.13), gasRow("g-2022", 2022)]);
    await seedJob("j2023", "J000727", 4, 2023, [dieselRow("d-2023", 23743.4), gasRow("g-2023", 2023)]);
    await seedJob("j-snap", "J000728", 5, 2021, [dieselRow("d-snap", 1000), gasRow("g-snap", 2021)]);
    await seedJob("j-ovr", "J000729", 6, 2021, [dieselRow("d-ovr", 1000), gasRow("g-ovr", 2021)]);
    // As on staging, every row is already approved when the correction runs.
    const batch = await batchAttestReingestRuns(database.pool, { organisationId: ORG, actorId: PERSON, reason: "batch attest before the correction (test)", commit: true });
    assert.equal(batch.tally.ATTESTED, 6, "the seed is six approved jobs");
    await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id,snapshot_id,job_id,snapshot_version,job_version,data_hash,payload_json,created_by)
                    VALUES ($1,'snap-1','j-snap',1,1,$2,'{}'::jsonb,'x')`, [ORG, `sha256:${"a".repeat(64)}`]);
    await db.query(`UPDATE nzi_console.job_scope_rows SET override_tco2e = 5, override_reason = 'measured', version = version + 1 WHERE job_id = 'j-ovr' AND origin = 'live' AND reingested_from_row_id = 'd-ovr'`);
  });
  after(async () => { await db?.end(); await database?.end(); });

  const ids = async () => ({ a: (await rowOf("j2021", "d-2021")).id as string, b: (await rowOf("j2022", "d-2022")).id as string, c: (await rowOf("j2023", "d-2023")).id as string, d: (await rowOf("j2020", "d-2020")).id as string });

  it("refuses without a reason and for a person who cannot attest, before touching a job", async () => {
    await assert.rejects(run([], { reason: "short" }), /^Error: REASON_REQUIRED/);
    await assert.rejects(run([], { actorId: "nobody" }), /^Error: NOT_A_MEMBER/);
    await assert.rejects(run([], { actorId: V7_REINGEST_ACTOR }), /^Error: NOT_A_MEMBER/, "the re-ingest's own principal is not a person");
  });

  it("a dry run is every job's whole act, rolled back: the report is real, nothing is written", async () => {
    const { a, b, c, d } = await ids();
    const rows = [{ jobNumber: "J000725", rowId: a, year: 2021 }, { jobNumber: "J000726", rowId: b, year: 2022 }, { jobNumber: "J000727", rowId: c, year: 2023 }, { jobNumber: "J000724", rowId: d, year: 2020 }];
    const report = await run(rows);
    assert.equal(report.committed, false);
    const by = Object.fromEntries(report.rows.map((row) => [row.jobNumber, row]));
    assert.equal(by.J000725!.status, "REPOINTED");
    assert.ok(Math.abs(by.J000725!.newTco2e! - (38619.4 * 2.51233) / 1000) < 1e-9);
    assert.ok(Math.abs(by.J000725!.deltaTco2e! - (38619.4 * (2.51233 - OLD_VALUE)) / 1000) < 1e-9);
    assert.ok(Math.abs(by.J000725!.jobTotalAfter! - by.J000725!.jobTotalBefore! - by.J000725!.deltaTco2e!) < 1e-9, "the job total moves by exactly the row's delta");
    assert.deepEqual([by.J000725!.attestedRows, by.J000725!.selectionRemoved], [1, true]);
    assert.equal(by.J000724!.status, "REPOINTED");
    assert.ok(Math.abs(by.J000724!.deltaTco2e!) < 1e-9, "2020's value is the same figure: re-pointed, unchanged");
    assert.deepEqual([by.J000726!.status, by.J000726!.codes], ["REFUSED", ["TARGET_FACTOR_MISSING"]]);
    assert.deepEqual([by.J000727!.status, by.J000727!.codes], ["REFUSED", ["DELTAS_FLAGGED"]]);
    const now = await rowOf("j2021", "d-2021");
    assert.deepEqual([now.dataset_id, now.review_status, await selects("j2021", FROM), await audits()], [FROM, "approved", 1, 0]);
  });

  it("commits: the row sits on its own year, recalculated, re-attested by the person; the 2019 selection goes; nothing else moves", async () => {
    const { a, b, c, d } = await ids();
    const gasBefore = await rowOf("j2021", "g-2021");
    const report = await run([{ jobNumber: "J000725", rowId: a, year: 2021 }, { jobNumber: "J000726", rowId: b, year: 2022 }, { jobNumber: "J000727", rowId: c, year: 2023 }, { jobNumber: "J000724", rowId: d, year: 2020 }], { commit: true });
    assert.deepEqual(report.rows.map((row) => [row.jobNumber, row.status]), [["J000725", "REPOINTED"], ["J000726", "REFUSED"], ["J000727", "REFUSED"], ["J000724", "REPOINTED"]]);
    const moved = await rowOf("j2021", "d-2021");
    assert.deepEqual([moved.dataset_id, moved.factor_id, moved.review_status, moved.reviewed_by], ["uk-ghg-gb-2021", STRAY_FACTOR_ID, "approved", PERSON]);
    assert.ok(Math.abs(moved.tco2e - (38619.4 * 2.51233) / 1000) < 1e-9);
    assert.match(moved.lineage, /Re-pointed to the reporting year's edition/);
    assert.deepEqual([await selects("j2021", FROM), await selects("j2021", "uk-ghg-gb-2021")], [0, 1]);
    const gasAfter = await rowOf("j2021", "g-2021");
    assert.deepEqual([gasAfter.version, gasAfter.dataset_id, gasAfter.tco2e], [gasBefore.version, gasBefore.dataset_id, gasBefore.tco2e], "the job's other rows are untouched");
    const same = await rowOf("j2020", "d-2020");
    assert.deepEqual([same.dataset_id, same.review_status, await selects("j2020", FROM)], ["uk-ghg-gb-2020", "approved", 0]);
    // The refused jobs wrote nothing: still on 2019, still approved, still selecting it.
    for (const [job, v7] of [["j2022", "d-2022"], ["j2023", "d-2023"]] as const) {
      const row = await rowOf(job, v7);
      assert.deepEqual([row.dataset_id, row.review_status, await selects(job, FROM)], [FROM, "approved", 1]);
    }
    assert.equal(await audits(), 2);
    const event = (await db.query(`SELECT actor_id, before_json::text AS b, after_json::text AS a FROM nzi_console.audit_events WHERE organisation_id=$1 AND action=$2 AND entity_id=$3`, [ORG, STRAY_REPOINT_AUDIT_ACTION, a])).rows[0]!;
    assert.equal(event.actor_id, PERSON);
    assert.match(event.b, /uk-ghg-gb-2019/); assert.match(event.a, /uk-ghg-gb-2021/);
  });

  it("is a no-op the second time: the moved rows are already on their year, the refused ones refuse again", async () => {
    const { a, b, c, d } = await ids();
    const report = await run([{ jobNumber: "J000725", rowId: a, year: 2021 }, { jobNumber: "J000726", rowId: b, year: 2022 }, { jobNumber: "J000727", rowId: c, year: 2023 }, { jobNumber: "J000724", rowId: d, year: 2020 }], { commit: true });
    assert.deepEqual(report.rows.map((row) => row.status), ["ALREADY_REPOINTED", "REFUSED", "REFUSED", "ALREADY_REPOINTED"]);
    assert.equal(await audits(), 2);
  });

  it("refuses a wrong year, a row that is not the ruled one, an issued snapshot and an overridden row — and writes nothing", async () => {
    const { a } = await ids();
    const gas = (await rowOf("j2021", "g-2021")).id as string;
    const snap = (await rowOf("j-snap", "d-snap")).id as string, ovr = (await rowOf("j-ovr", "d-ovr")).id as string;
    const report = await run([{ jobNumber: "J000725", rowId: a, year: 2020 }, { jobNumber: "J000725", rowId: gas, year: 2021 },
      { jobNumber: "J000728", rowId: snap, year: 2021 }, { jobNumber: "J000729", rowId: ovr, year: 2021 }, { jobNumber: "J999999", rowId: a, year: 2021 }], { commit: true });
    assert.deepEqual(report.rows.map((row) => row.codes), [["YEAR_MISMATCH"], ["NOT_THE_RULED_ROW"], ["FIGURES_ISSUED"], ["ROW_OVERRIDDEN"], ["JOB_NOT_FOUND"]]);
    for (const [job, v7] of [["j-snap", "d-snap"], ["j-ovr", "d-ovr"]] as const) assert.equal((await rowOf(job, v7)).dataset_id, FROM);
    assert.equal(await audits(), 2);
  });

  it("the shipped ruled set is the four rows, one per job, 2020 to 2023", () => {
    assert.deepEqual(RULED_STRAY_ROWS.map((entry) => [entry.jobNumber, entry.year]), [["J000724", 2020], ["J000725", 2021], ["J000726", 2022], ["J000727", 2023]]);
    assert.deepEqual(RULED_STRAY_ROWS.map((entry) => entry.rowId.slice(0, 8)), ["84512322", "22d16a49", "3a054b5e", "c31826c9"]);
  });
});
