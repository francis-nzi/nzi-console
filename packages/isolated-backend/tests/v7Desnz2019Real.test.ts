import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR, type V7ReingestJobInput, type V7ReingestPlanRow } from "@nzi/contracts";
import { withTenantWrite } from "../src/postgres";
import { reingestV7JobInTransaction } from "../src/v7Reingest";
import { batchAttestReingestRuns } from "../src/v7BatchAttest";
import { correctDesnz2019, DESNZ_2019_AUDIT_ACTION, planFromDatabase } from "../src/v7Desnz2019Apply";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { flatFile, STORED, UK_2019 } from "./support/desnz2019Fixture";

/**
 * RULING 30 Oct 2026 — the 2019 dataset correction, against a real database: values corrected in place on the existing ids to the real
 * DESNZ 2019 numbers; the rows on a changed factor recalculated and re-attested by the person; rows on unchanged factors keep their
 * approval; a commit needs the signed plan sha and (when a row flags against v7) the hash of the reviewed flagged set; another consumer
 * or an issued snapshot refuses everything; a dry run is the whole act, rolled back; a re-run finds nothing to change.
 */
const ORG = "v7-desnz-2019";
const PERSON = "francis";
const REASON = "align uk-ghg-gb-2019 to the real DESNZ 2019 edition (ruled 30 Oct 2026)";
const CROSSWALK_SHA = "d4c14407379377d20aeccebd9256eaf7ef7124846b07e05b3a0bf4afd233c8f2";
const JOB = "j2019";
const flat = flatFile();
const DIESEL = "uk-ghg-1_101_1011_8_1";
const VARIANT_SUFFIXES = ["-c", "-b"];

type Seed = { id: string; factorId: string; datasetId: string; scope: string; category: string; label: string; qty: number; unit: string; oldValue: number };
const SEEDS: Seed[] = [
  { id: "r-diesel", factorId: "uk-ghg-1_101_1011_8_1", datasetId: UK_2019, scope: "1", category: "1.company-vehicles", label: "Diesel vans", qty: 35000, unit: "litres", oldValue: 2.54603 },
  { id: "r-gas", factorId: "uk-ghg-1_100_1004_6_1", datasetId: UK_2019, scope: "1", category: "1.natural-gas", label: "Natural gas", qty: 50000, unit: "kWh", oldValue: 0.18387 },
  { id: "r-elec", factorId: "uk-ghg-7_400_4000_5_1", datasetId: UK_2019, scope: "2", category: "2.purchased-electricity", label: "Electricity", qty: 80000, unit: "kWh", oldValue: 0.2556 },
  { id: "r-rail", factorId: "uk-ghg-25_315_3147_11_1", datasetId: UK_2019, scope: "3.6", category: "3.6", label: "National rail", qty: 100000, unit: "passenger.km", oldValue: 0.03694 },
  { id: "r-walk", factorId: "nzi-99_316_3160_11_2", datasetId: "nzi-gb-2019", scope: "3.6", category: "3.6", label: "Walking", qty: 100, unit: "miles", oldValue: 0 },
];
const plan = (seed: Seed): [Seed, V7ReingestPlanRow] => [seed, { v7RowId: seed.id, disposition: "RE-INGEST", categoryCode: seed.category, scope: seed.scope, sourceLabel: seed.label, quantity: seed.qty, unit: seed.unit,
  datasetId: seed.datasetId, factorId: seed.factorId, qualityTier: "measured", v7Tco2e: (seed.qty * seed.oldValue) / 1000, rule: "TEST" }];

describe("the 2019 dataset is corrected in place, recalculated and re-attested, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0]!.n);
  const value = async (factorId: string) => Number((await db.query(`SELECT kgco2e_per_unit::text AS v FROM nzi_console.emission_factors WHERE organisation_id=$1 AND factor_id=$2`, [ORG, factorId])).rows[0]!.v);
  const rowOf = async (v7: string) => (await db.query(
    `SELECT scope_row_id AS id, version, review_status, reviewed_by, calculated_tco2e::float8 AS tco2e, lineage_json::text AS lineage
       FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' AND enabled AND reingested_from_row_id=$2`, [JOB, v7])).rows[0]!;
  const audits = () => count(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE organisation_id=$1 AND action=$2`, [ORG, DESNZ_2019_AUDIT_ACTION]);
  const shas = async () => (await db.query(`SELECT dataset_id, content_sha256 FROM nzi_console.emission_factor_datasets WHERE organisation_id=$1 ORDER BY 1`, [ORG])).rows;
  const run = (over: Partial<Parameters<typeof correctDesnz2019>[1]> = {}) => correctDesnz2019(database.pool, { organisationId: ORG, actorId: PERSON, reason: REASON, commit: false, flat, ...over });
  const signed = async () => (await planFromDatabase(database.pool, ORG, flat)).plan.sha256;

  before(async () => {
    database = (await createDisposableDatabase("v7desnz"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Desnz Test','active')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'reviewer','active')`, [ORG, PERSON]);
    for (const dataset of [UK_2019, "nzi-gb-2019"])
      await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence,synthetic,source_system,source_family,legacy_dataset_id,content_sha256)
                      VALUES ($1,$2,$2,'DESNZ DEFRA Conversion Factors 2019-2025.xlsx','2019-01-01','2019-12-31','GB','active','Test','Source: test.',false,'nzi-pro-v7',$3,'7',$4)`,
        [ORG, dataset, dataset === UK_2019 ? "uk-ghg" : "nzi", dataset === UK_2019 ? "a".repeat(64) : "b".repeat(64)]);
    for (const factor of STORED)
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ORG, factor.datasetId, factor.factorId, factor.label, factor.activityUnit, factor.value, factor.scopes, factor.sourceLevels]);

    // The base's same-dataset category variants (0110), at the stored copy-of-2020 value and with no source levels — as on staging, they
    // join to nothing on their own. 0170's guard refuses a base corrected without them, so the plan must carry them to the base's value.
    for (const suffix of VARIANT_SUFFIXES)
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,$2,$3,$4,'litres',2.54603,'{1}','{}')`,
        [ORG, UK_2019, `${DIESEL}${suffix}`, `Diesel variant ${suffix}`]);

    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
      VALUES ($1,$2,'c1',1,'crp','CRP','open','Data entry',2019,'2019-01-01','2019-12-31','nzi-pro-v7','1','J000723')`, [ORG, JOB]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2019-01-01','2019-12-31','GB')`, [ORG, JOB]);
    const rows = SEEDS.map(plan);
    for (const [seed] of rows) {
      const reported = (seed.qty * seed.oldValue) / 1000;
      await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,
          calculated_tco2e,review_status,enabled,origin,migrated_record,source_system,legacy_db_id)
        VALUES ($1,$2,$3,$4,$5,$5,'v7','v7',$6,$7,$8,'pending',true,'migrated',$9::jsonb,'nzi-pro-v7',$2)`,
        [ORG, seed.id, JOB, seed.scope, seed.label, seed.qty, seed.unit, reported,
          JSON.stringify({ qty: seed.qty, uom: seed.unit, factor: 0, ghg_unit: "kgCO2e", original_id: "7_x", reported_tco2e: reported, data_source: "Company Data", enabled: true })]);
    }
    const input: V7ReingestJobInput = { jobId: JOB, runId: `v7-reingest-${randomUUID()}`, crosswalkVersion: "v1", crosswalkSha256: CROSSWALK_SHA,
      vintageDatasetIds: [UK_2019, "nzi-gb-2019"], rows: rows.map(([, row]) => row) };
    await withTenantWrite(database.pool, ORG, (client) => reingestV7JobInTransaction(client, input, { organisationId: ORG, actorId: V7_REINGEST_ACTOR, principal: "system",
      idempotencyKey: "seed-1", correlationId: "seed-1", reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", ORG, V7_REINGEST_ACTOR) }))
    for (const dataset of [UK_2019, "nzi-gb-2019"])
      await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,'manual','test','policy:v7-reingest') ON CONFLICT DO NOTHING`, [ORG, JOB, dataset]);
    const batch = await batchAttestReingestRuns(database.pool, { organisationId: ORG, actorId: PERSON, reason: "batch attest before the correction (test)", commit: true });
    assert.equal(batch.tally.ATTESTED, 1, "the seed is one approved job");
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("refuses without a reason, for a non-person, and a commit without the signed sha — before touching anything", async () => {
    await assert.rejects(run({ reason: "short" }), /^Error: REASON_REQUIRED/);
    await assert.rejects(run({ actorId: "nobody" }), /^Error: NOT_A_MEMBER/);
    await assert.rejects(run({ commit: true }), /^Error: PLAN_SHA_REQUIRED/);
  });

  it("a dry run is the whole act, rolled back: real deltas and the flagged set with its hash, nothing written", async () => {
    const before = await shas();
    const report = await run({ expectedPlanSha: await signed() });
    assert.equal(report.committed, false);
    assert.deepEqual(report.consumers, ["J000723"]);
    assert.equal(report.factorsUpdated, 7, "diesel, gas, rail (and the unused air and waste) change, and diesel's two variants with it");
    const v7Of = Object.fromEntries(await Promise.all(SEEDS.map(async (seed) => [(await rowOf(seed.id)).id as string, seed.id])));
    const by = Object.fromEntries(report.rows.map((row) => [v7Of[row.rowId]!, row]));
    assert.deepEqual(Object.keys(by).sort(), ["r-diesel", "r-gas", "r-rail"], "only rows on a changed factor are recalculated; electricity and walking are not");
    assert.ok(Math.abs(by["r-diesel"]!.newTco2e! - (35000 * 2.59411) / 1000) < 1e-9);
    assert.ok(Math.abs(by["r-rail"]!.deltaTco2e! - (100000 * (0.04115 - 0.03694)) / 1000) < 1e-9);
    assert.equal(report.flaggedDeltas.length, 1, "the rail row moves 11% against v7 — the correction is what flags it");
    assert.match(report.flaggedSha!, /^[0-9a-f]{12}$/);
    assert.equal(report.attestedRows, 0, "a dry run without the acknowledgement claims no approval");
    assert.equal(await value("uk-ghg-1_101_1011_8_1"), 2.54603);
    assert.equal((await rowOf("r-rail")).review_status, "approved");
    assert.deepEqual([await audits(), await shas()], [0, before]);
  });

  it("the 0-flag guardrail holds: a commit that flags without the reviewed hash, or on a different plan sha, writes nothing", async () => {
    const sha = await signed();
    await assert.rejects(run({ commit: true, expectedPlanSha: sha }), /DELTAS_FLAGGED/);
    await assert.rejects(run({ commit: true, expectedPlanSha: sha, acknowledgeFlagged: "0".repeat(12) }), /DELTAS_FLAGGED/);
    await assert.rejects(run({ commit: true, expectedPlanSha: "f".repeat(64), acknowledgeFlagged: "0".repeat(12) }), /PLAN_SHA_MISMATCH/);
    assert.equal(await value("uk-ghg-25_315_3147_11_1"), 0.03694, "the transaction rolled back, values included");
    assert.equal((await rowOf("r-rail")).review_status, "approved");
    assert.equal(await audits(), 0);
  });

  it("commits against the signed sha and the reviewed hash: values corrected in place, rows recalculated and re-attested, the rest untouched", async () => {
    const sha = await signed();
    const dry = await run({ expectedPlanSha: sha });
    const elecBefore = await rowOf("r-elec"), walkBefore = await rowOf("r-walk");
    const shasBefore = await shas();
    const report = await run({ commit: true, expectedPlanSha: sha, acknowledgeFlagged: dry.flaggedSha! });
    assert.equal(report.committed, true);
    assert.deepEqual([await value("uk-ghg-1_101_1011_8_1"), await value("uk-ghg-1_100_1004_6_1"), await value("uk-ghg-25_315_3147_11_1"), await value("uk-ghg-7_400_4000_5_1"), await value("nzi-99_316_3160_11_2")],
      [2.59411, 0.18385, 0.04115, 0.2556, 0], "the real 2019 numbers; electricity already equal; the NZI-defined walking factor untouched");
    assert.equal(await value("uk-ghg-21_316_3160_11_1"), 0.25493, "an unused air factor is aligned (With RF)");
    assert.equal(await value("uk-ghg-twin"), 1.5, "an ambiguous factor is left alone");
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.emission_factors WHERE organisation_id=$1`, [ORG]), STORED.length + VARIANT_SUFFIXES.length, "no id added or retired");
    for (const suffix of VARIANT_SUFFIXES) assert.equal(await value(`${DIESEL}${suffix}`), 2.59411, "a variant carries its base's corrected value, so the guard passes rather than being relaxed");
    for (const id of ["r-diesel", "r-gas", "r-rail"]) {
      const row = await rowOf(id);
      assert.deepEqual([row.review_status, row.reviewed_by], ["approved", PERSON]);
      assert.match(row.lineage, /Factor value corrected to the DESNZ 2019 edition/);
    }
    assert.ok(Math.abs((await rowOf("r-rail")).tco2e - (100000 * 0.04115) / 1000) < 1e-9);
    const elec = await rowOf("r-elec"), walk = await rowOf("r-walk");
    assert.deepEqual([elec.version, elec.review_status, elec.reviewed_by], [elecBefore.version, "approved", elecBefore.reviewed_by], "a row on an unchanged factor keeps its approval");
    assert.deepEqual([walk.version, walk.review_status], [walkBefore.version, "approved"]);
    assert.deepEqual(await shas(), shasBefore, "content_sha256 is the v7 import's identity and the loader reads it: left alone");
    assert.equal(await audits(), 1);
    const event = (await db.query(`SELECT actor_id, after_json::text AS a FROM nzi_console.audit_events WHERE organisation_id=$1 AND action=$2`, [ORG, DESNZ_2019_AUDIT_ACTION])).rows[0]!;
    assert.equal(event.actor_id, PERSON);
    assert.match(event.a, new RegExp(sha));
    const total = report.jobTotals[0]!;
    assert.ok(Math.abs(total.after - total.before - report.rows.reduce((sum, row) => sum + row.deltaTco2e!, 0)) < 1e-9, "the job total moves by exactly the rows' deltas");
  });

  it("a re-run finds nothing to change: no write, no audit; the signed sha no longer matches a commit", async () => {
    const dry = await run();
    assert.deepEqual([dry.factorsUpdated, dry.rows.length, dry.auditEvents, dry.plan.counts.changed], [0, 0, 0, 0]);
    await assert.rejects(run({ commit: true, expectedPlanSha: "f".repeat(64) }), /PLAN_SHA_MISMATCH/);
    assert.equal(await audits(), 1);
  });

  it("another consumer of the datasets, or an issued snapshot, refuses everything", async () => {
    await assert.rejects(run({ allowedJobs: [] }), /OTHER_CONSUMERS/);
    await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id,snapshot_id,job_id,snapshot_version,job_version,data_hash,payload_json,created_by)
                    VALUES ($1,'snap-1',$2,1,1,$3,'{}'::jsonb,'x')`, [ORG, JOB, `sha256:${"a".repeat(64)}`]);
    await assert.rejects(run(), /FIGURES_ISSUED/);
  });
});
