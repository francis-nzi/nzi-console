import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, encodeImportIdentity, V7_REINGEST_ACTOR, type CommandContext, type SpendImportIdentity, type SpendImportRow, type V7ReingestJobInput, type V7ReingestPlanRow } from "@nzi/contracts";
import { calculateLcaAssessment, commitSpendImport, createEmissionSource, listClientFactors, previewSpendImport, signSpendImportIdentity, syncEmissionSourceToScope, withTenantRead } from "../src/index";
import { withTenantWrite } from "../src/postgres";
import { recalculateScopeRowInTransaction } from "../src/postgresCommands";
import type { V7Row } from "../src/v7ClientExtract";
import { CUSTOM_FACTOR_REPOINT_AUDIT_ACTION, repointCustomFactorRows } from "../src/v7CustomFactorRepoint";
import { CUSTOM_FACTORS_AUDIT_ACTION, loadV7CustomFactors, planV7CustomFactors } from "../src/v7CustomFactorsLoad";
import { reingestV7JobInTransaction, revertV7ReingestInTransaction } from "../src/v7Reingest";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * V7's client custom factors (cause 7; PLAN-v7-client-custom-factors, D-1/D-2/D-3; 0240), against a real database:
 *   - the load: one client factor per V7 factor, both families, a global one organisation-level, year values per version; a dry
 *     run writes nothing; a re-run changes nothing; a changed V7 factor is a version bump with a new set of values;
 *   - pricing: a native row prices each month at its year's value (the closest earlier, else the earliest), a spanning job by
 *     month, an annual row split; an organisation-level factor serves the client's jobs; a factor with no year values as before;
 *   - the re-point: each re-ingested row moves to the factor its V7 row names and is recalculated — an imported job-only row at
 *     V7's stored value (D-1) — only where it reproduces (D-2); the carried factor is folded (archived, pointing at its target); a
 *     row that does not reproduce, or has no loaded factor, stays; a dry run is the whole act rolled back; a re-run moves nothing;
 *     and a later re-ingest of the job reuses the folded-into factor.
 */
const ORG = "v7-custom-factors";
const PERSON = "francis";
const REASON = "fold the re-ingest's carried factors into V7's own custom factors (PLAN-v7-client-custom-factors)";
const CROSSWALK_SHA = "d4c14407379377d20aeccebd9256eaf7ef7124846b07e05b3a0bf4afd233c8f2";
const row = (cells: Record<string, string | null>): V7Row => cells;

const EXTRACT = (gas2025 = "0.25") => ({
  custom_factors: [
    row({ factor_id: "1", custom_id: "CF-GAS", client_db_id: "501", is_global: "false", is_active: "true", archived: "false", scope: "Scope 1", category: "Fuels",
      country: null, uom: "kWh", ghg_unit: "kgCO2e", report_label: "Site gas", factor_2023: "0.18", factor_2024: "0.2" }),
    row({ factor_id: "2", custom_id: "CF-GLOBAL", client_db_id: null, is_global: null, scope: "3", uom: "km", ghg_unit: "tCO2e", report_label: "Courier", factor_2024: "0.0001" }),
    row({ factor_id: "3", custom_id: "CF-OTHER", client_db_id: "777", is_global: "false", scope: "1", uom: "kWh", ghg_unit: "kgCO2e", factor_2024: "1" }),
    row({ factor_id: "4", custom_id: "", client_db_id: "501", is_global: "false", scope: "1", uom: "kWh", factor_2024: "1" }),
  ],
  custom_factor_year_values: [row({ factor_id: "1", year: "2025", factor: gas2025 })],
  job_custom_factors: [
    row({ factor_id: "115", custom_id: "JCF-10-115", client_db_id: "501", job_id: "10", is_active: "true", archived: "false", scope: "Scope 1", uom: "kWh", ghg_unit: "kgCO2e",
      report_label: "Generator diesel", factor: "0.5", factor_year: "2023" }),
    row({ factor_id: "116", custom_id: "JCF-10-116", client_db_id: "501", job_id: "10", scope: "1", uom: "kWh", ghg_unit: "kgCO2e", factor: "0.7", factor_year: "2023" }),
    row({ factor_id: "117", custom_id: "JCF-10-117", client_db_id: "501", job_id: "10", is_active: "false", scope: "1", uom: "kWh", ghg_unit: "kgCO2e", factor: "0.3", factor_year: "2023" }),
  ],
  job_custom_factor_year_values: [row({ factor_id: "115", year: "2024", factor: "0.9" })],
});

describe("V7's client custom factors — loaded, priced by year and re-pointed, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0]!.n);
  const fingerprint = async () => (await db.query(
    `SELECT md5(coalesce((SELECT string_agg(to_jsonb(f)::text, '|' ORDER BY f.client_factor_id) FROM nzi_console.client_factors f WHERE f.organisation_id = $1), '')
             || coalesce((SELECT string_agg(to_jsonb(v)::text, '|' ORDER BY v.client_factor_id, v.version, v.year) FROM nzi_console.client_factor_year_values v WHERE v.organisation_id = $1), '')
             || coalesce((SELECT string_agg(to_jsonb(r)::text, '|' ORDER BY r.scope_row_id) FROM nzi_console.job_scope_rows r WHERE r.organisation_id = $1), '')
             || coalesce((SELECT string_agg(a.audit_event_id, '|' ORDER BY a.occurred_at, a.audit_event_id) FROM nzi_console.audit_events a WHERE a.organisation_id = $1), '')) AS h`, [ORG])).rows[0]!.h as string;
  const loaded = async (legacyCustomId: string) => (await db.query(
    `SELECT client_factor_id AS id, client_id, job_id, scope, unit, kgco2e_per_unit::float8 AS kg, vintage_year, version, archived, report_label, category_path_json
       FROM nzi_console.client_factors WHERE organisation_id = $1 AND legacy_custom_id = $2`, [ORG, legacyCustomId])).rows[0];
  const staff = (): CommandContext => { keys += 1; return { organisationId: ORG, actorId: PERSON, principal: "staff", idempotencyKey: `k-${keys}`, correlationId: `c-${keys}`,
    grant: commandGrantForRole("admin", ORG, PERSON) }; };
  const system = (): CommandContext => { keys += 1; return { organisationId: ORG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: `s-${keys}`, correlationId: `s-${keys}`,
    reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", ORG, V7_REINGEST_ACTOR) }; };

  async function job(jobId: string, number: string, sequence: number, from: string, to: string) {
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
      VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',$4,$5,$6,'nzi-pro-v7',$7,$8)`, [ORG, jobId, sequence, Number(to.slice(0, 4)), from, to, String(sequence), number]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`, [ORG, jobId, from, to]);
  }
  /** A console-native row on a client factor, calculated by the one row calculation. */
  async function nativeRow(jobId: string, clientFactorId: string, scope: string, quantity: number, unit: string, months: Array<{ month: string; quantity: number | null }> = []) {
    const rowId = randomUUID();
    await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,
        factor_source,client_factor_id,factor_id,is_custom_entry,monthly_activity_json,review_status,enabled,origin)
      VALUES ($1,$2,$3,$4,'Native','Native','n','n',$5,$6,'client',$7,$7,true,$8::jsonb,'pending',true,'live')`, [ORG, rowId, jobId, scope, quantity, unit, clientFactorId, JSON.stringify(months)]);
    const version = (await db.query(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [rowId])).rows[0]!.version as number;
    await withTenantWrite(database.pool, ORG, (client) => recalculateScopeRowInTransaction(client, { jobId, rowId, expectedVersion: version }, staff()));
    return (await db.query(`SELECT calculated_tco2e::float8 AS tco2e, lineage_json, provenance_json FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [rowId])).rows[0]!;
  }
  const lineage = (rowLineage: Array<{ title: string; detail: string }>, title: string) => rowLineage.find((line) => line.title === title)?.detail;

  before(async () => {
    database = (await createDisposableDatabase("v7cf"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,source_system,legacy_db_id) VALUES ($1,'c1','Custom Factor Test','active','nzi-pro-v7','501')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'reviewer','active')`, [ORG, PERSON]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("plans one factor per V7 factor, both families: a global one organisation-level, values overlaid as V7 overlays them", () => {
    const plan = planV7CustomFactors(EXTRACT());
    assert.deepEqual(plan.factors.map((factor) => factor.legacyCustomId), ["CF-GAS", "CF-GLOBAL", "CF-OTHER", "JCF-10-115", "JCF-10-116", "JCF-10-117"]);
    assert.deepEqual(plan.skipped, [{ legacyDbId: "custom_factors:4", reason: "no custom id: no V7 row can name it" }]);
    const gas = plan.factors[0]!;
    assert.deepEqual(gas.yearValues, [{ year: 2023, kgco2ePerUnit: 0.18 }, { year: 2024, kgco2ePerUnit: 0.2 }, { year: 2025, kgco2ePerUnit: 0.25 }]);
    assert.equal(gas.kgco2ePerUnit, 0.25, "a custom factor's headline is its latest year (V7's choice with no year)");
    assert.equal(gas.vintageYear, 2025);
    assert.deepEqual(gas.categoryPath, ["Fuels"]);
    const global = plan.factors[1]!;
    assert.equal(global.v7ClientDbId, null, "is_global unset reads as TRUE, as V7 reads it");
    assert.equal(global.kgco2ePerUnit, 0.1, "a per-tonne V7 value is carried per kg");
    const jcf = plan.factors[3]!;
    assert.equal(jcf.family, "job-only");
    assert.equal(jcf.kgco2ePerUnit, 0.5, "a job-only factor's headline is its stored factor");
    assert.equal(jcf.vintageYear, 2023);
    assert.deepEqual(jcf.yearValues, [{ year: 2023, kgco2ePerUnit: 0.5 }, { year: 2024, kgco2ePerUnit: 0.9 }]);
    assert.equal(plan.factors[5]!.archived, true, "inactive in V7 → archived");
  });

  it("a dry run of the load writes nothing", async () => {
    const before = await fingerprint();
    const outcome = await loadV7CustomFactors(database.pool, ORG, planV7CustomFactors(EXTRACT()), { commit: false });
    assert.equal(outcome.inserted, 5);
    assert.equal(await fingerprint(), before);
  });

  it("loads them, skipping a factor whose client was not imported; a re-run changes nothing; a changed factor is a version bump", async () => {
    const outcome = await loadV7CustomFactors(database.pool, ORG, planV7CustomFactors(EXTRACT()), { commit: true });
    assert.deepEqual({ inserted: outcome.inserted, organisationLevel: outcome.organisationLevel, yearValues: outcome.yearValues, byFamily: outcome.byFamily },
      { inserted: 5, organisationLevel: 1, yearValues: 8, byFamily: { custom: 2, "job-only": 3 } });
    assert.deepEqual(outcome.skipped, [{ legacyDbId: "custom_factors:3", reason: "its client (V7 777) was not imported" }]);
    const global = await loaded("CF-GLOBAL");
    assert.equal(global.client_id, null, "organisation-level (D-3)");
    const jcf = await loaded("JCF-10-115");
    assert.deepEqual([jcf.client_id, jcf.job_id, jcf.scope, jcf.unit, jcf.kg, jcf.vintage_year, jcf.archived], ["c1", null, "1", "kWh", 0.5, 2023, false], "client-scoped, never pinned to V7's job");
    assert.equal((await loaded("JCF-10-117")).archived, true);
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE organisation_id=$1 AND action=$2`, [ORG, CUSTOM_FACTORS_AUDIT_ACTION]), 1);

    const again = await loadV7CustomFactors(database.pool, ORG, planV7CustomFactors(EXTRACT()), { commit: true });
    assert.deepEqual([again.inserted, again.updated, again.unchanged, again.yearValues], [0, 0, 5, 0]);
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE organisation_id=$1 AND action=$2`, [ORG, CUSTOM_FACTORS_AUDIT_ACTION]), 1, "nothing written, nothing audited");

    const changed = await loadV7CustomFactors(database.pool, ORG, planV7CustomFactors(EXTRACT("0.26")), { commit: true });
    assert.deepEqual([changed.inserted, changed.updated, changed.unchanged, changed.yearValues], [0, 1, 4, 3]);
    const gas = await loaded("CF-GAS");
    assert.deepEqual([gas.version, gas.kg], [2, 0.26]);
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.client_factor_year_values WHERE client_factor_id=$1`, [gas.id]), 6, "version 1's values are kept beside version 2's");
  });

  it("prices a native row by its months' years: a spanning job by month, an annual row split; a calendar year at its year's value", async () => {
    const gas = await loaded("CF-GAS"); // v2: 2023 0.18 · 2024 0.2 · 2025 0.26
    await job("j-span", "J000801", 1, "2024-04-01", "2025-03-31");
    const months = ["2024-04", "2024-05", "2024-06", "2024-07", "2024-08", "2024-09", "2024-10", "2024-11", "2024-12", "2025-01", "2025-02", "2025-03"].map((month) => ({ month, quantity: 100 }));
    const monthly = await nativeRow("j-span", gas.id, "1", 1200, "kWh", months);
    assert.ok(Math.abs(monthly.tco2e - (900 * 0.2 + 300 * 0.26) / 1000) < 1e-9, `${monthly.tco2e}`);
    assert.equal(lineage(monthly.lineage_json, "Priced by month"), "9 months @ 2024 value (0.2) · 3 @ 2025 value (0.26)");
    assert.deepEqual(monthly.provenance_json.spans.map((span: { factorYear: number; months: number }) => [span.factorYear, span.months]), [[2024, 9], [2025, 3]]);
    const annual = await nativeRow("j-span", gas.id, "1", 1200, "kWh");
    assert.ok(Math.abs(annual.tco2e - 0.258) < 1e-9, `${annual.tco2e}`);
    assert.match(lineage(annual.lineage_json, "Annual quantity split by month")!, /each priced at its year's value/);

    await job("j-2022", "J000802", 2, "2022-01-01", "2022-12-31");
    const early = await nativeRow("j-2022", gas.id, "1", 1000, "kWh");
    assert.ok(Math.abs(early.tco2e - 0.18) < 1e-9, "no 2022 value and none earlier: the earliest year's");
    assert.equal(lineage(early.lineage_json, "Priced at its year's value"), "12 months @ 2023 value (0.18)");
  });

  it("an organisation-level factor serves the client's job, at any category of its scope; a factor with no year values prices as before", async () => {
    const global = await loaded("CF-GLOBAL");
    const courier = await nativeRow("j-2022", global.id, "3.4", 1000, "km");
    assert.ok(Math.abs(courier.tco2e - 0.1) < 1e-9, `${courier.tco2e}`);
    await db.query(`INSERT INTO nzi_console.client_factors (organisation_id,client_factor_id,client_id,scope,report_label,unit,kgco2e_per_unit,vintage_year,created_by)
      VALUES ($1,'cf-hand','c1','1','Hand-made','kWh',0.3,2022,'francis')`, [ORG]);
    const hand = await nativeRow("j-span", "cf-hand", "1", 1000, "kWh");
    assert.ok(Math.abs(hand.tco2e - 0.3) < 1e-9);
    assert.equal(hand.provenance_json.spans, undefined, "no year values: exactly as before, one product, no spans");
  });

  describe("the re-point of re-ingested rows onto V7's factors", () => {
    const JOB = "j-re";
    const migrated = [
      // A job-only factor: V7 priced it at its stored 0.5 though the factor holds 0.9 for 2024 (D-1).
      { id: "m1", originalId: "JCF-10-115", qty: 1000, factor: 0.5, months: null as number[] | null },
      // V7's stored value (0.6) is not the loaded factor's (0.7): it does not reproduce (D-2).
      { id: "m2", originalId: "JCF-10-116", qty: 1000, factor: 0.6, months: null },
      // No loaded factor names it.
      { id: "m3", originalId: "CF-MISSING", qty: 1000, factor: 0.4, months: null },
      // A custom factor, monthly: V7 priced each 2024 month at the 2024 value.
      { id: "m4", originalId: "CF-GAS", qty: 1200, factor: 0.2, months: Array(12).fill(100) as number[] },
    ];
    let runId = "";
    const live = async (v7: string) => (await db.query(
      `SELECT r.scope_row_id AS id, r.client_factor_id, r.calculated_tco2e::float8 AS tco2e, r.review_status, r.lineage_json, cf.legacy_custom_id
         FROM nzi_console.job_scope_rows r JOIN nzi_console.client_factors cf ON (cf.organisation_id, cf.client_factor_id) = (r.organisation_id, r.client_factor_id)
        WHERE r.job_id = $1 AND r.origin = 'live' AND r.enabled AND r.reingested_from_row_id = $2`, [JOB, v7])).rows[0];
    const carried = async (v7: string) => (await db.query(
      `SELECT client_factor_id AS id, archived, folded_into_client_factor_id AS folded FROM nzi_console.client_factors WHERE source_system = 'nzi-pro-v7-reingest' AND legacy_db_id = $1`, [v7])).rows[0];
    const audits = () => count(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE organisation_id=$1 AND action=$2`, [ORG, CUSTOM_FACTOR_REPOINT_AUDIT_ACTION]);
    const reingest = async () => {
      runId = `v7-reingest-${randomUUID()}`;
      const rows: V7ReingestPlanRow[] = migrated.map((m) => ({ v7RowId: m.id, disposition: "CARRY-V7-FACTOR", categoryCode: "1.natural-gas", scope: "1", sourceLabel: `V7 ${m.id}`,
        quantity: m.qty, unit: "kWh", carriedFactor: { label: `V7 ${m.originalId}`, unit: "kWh", kgco2ePerUnit: m.factor, vintageYear: 2024 }, qualityTier: "measured",
        v7Tco2e: (m.qty * m.factor) / 1000, rule: "CARRY" }));
      const input: V7ReingestJobInput = { jobId: JOB, runId, crosswalkVersion: "v1", crosswalkSha256: CROSSWALK_SHA, vintageDatasetIds: [], rows };
      await withTenantWrite(database.pool, ORG, (client) => reingestV7JobInTransaction(client, input, system()));
    };

    before(async () => {
      await job(JOB, "J000901", 3, "2024-01-01", "2024-12-31");
      for (const m of migrated) {
        await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,
            calculated_tco2e,review_status,enabled,origin,migrated_record,source_system,legacy_db_id)
          VALUES ($1,$2,$3,'1',$4,$4,'v7','v7',$5,'kWh',$6,'pending',true,'migrated',$7::jsonb,'nzi-pro-v7',$2)`,
          [ORG, m.id, JOB, `V7 ${m.id}`, m.qty, (m.qty * m.factor) / 1000, JSON.stringify({ qty: m.qty, uom: "kWh", factor: m.factor, ghg_unit: "kgCO2e", original_id: m.originalId,
            reported_tco2e: (m.qty * m.factor) / 1000, data_source: "Company Data", enabled: true, ...(m.months ? { months: m.months } : {}) })]);
      }
      await reingest();
    });

    it("a dry run is every job's whole act, rolled back", async () => {
      const before = await fingerprint();
      const report = await repointCustomFactorRows(database.pool, { organisationId: ORG, actorId: PERSON, reason: REASON, commit: false });
      const ours = report.jobs.find((entry) => entry.jobId === JOB)!;
      assert.deepEqual(ours.rows.map((entry) => [entry.v7RowId, entry.status, entry.code]),
        [["m1", "MOVED", null], ["m2", "NOT_MOVED", "DOES_NOT_REPRODUCE"], ["m3", "NOT_MOVED", "NO_LOADED_FACTOR"], ["m4", "MOVED", null]]);
      assert.equal(await fingerprint(), before);
      assert.equal(report.auditEvents, 0);
    });

    it("moves only what reproduces, folds the carried factors, and audits the job once", async () => {
      const report = await repointCustomFactorRows(database.pool, { organisationId: ORG, actorId: PERSON, reason: REASON, commit: true });
      const ours = report.jobs.find((entry) => entry.jobId === JOB)!;
      assert.equal(ours.totals.afterTco2e.toFixed(6), ours.totals.beforeTco2e.toFixed(6), "the job's total is unchanged");
      const m1 = await live("m1");
      assert.equal(m1.legacy_custom_id, "JCF-10-115");
      assert.ok(Math.abs(m1.tco2e - 0.5) < 1e-9, "D-1: a job-only row at V7's stored value, not the factor's 2024 value");
      assert.equal(lineage(m1.lineage_json, "Priced as the previous system prices it"), "A job-only factor: the previous system prices it at its stored value, every month");
      const m4 = await live("m4");
      assert.equal(m4.legacy_custom_id, "CF-GAS");
      assert.ok(Math.abs(m4.tco2e - 0.24) < 1e-9, "a custom factor's monthly row at its year's value, as V7's resolver prices it");
      assert.equal(lineage(m4.lineage_json, "Priced at its year's value"), "12 months @ 2024 value (0.2)");
      for (const v7 of ["m1", "m4"]) {
        const factor = await carried(v7);
        assert.equal(factor.archived, true);
        assert.equal(factor.folded, (await live(v7)).client_factor_id, "folded, pointing at its target");
      }
      for (const v7 of ["m2", "m3"]) {
        assert.equal((await live(v7)).client_factor_id, (await carried(v7)).id, "not moved: still on its carried factor");
        assert.equal((await carried(v7)).archived, false, "D-2: its carried factor stays live");
      }
      assert.ok(Math.abs((await live("m2")).tco2e - 0.6) < 1e-9, "its figure is untouched");
      assert.equal(await audits(), 1);
      assert.equal(report.auditEvents, 1);
    });

    it("a re-run moves nothing", async () => {
      const before = await fingerprint();
      const report = await repointCustomFactorRows(database.pool, { organisationId: ORG, actorId: PERSON, reason: REASON, commit: true });
      assert.deepEqual(report.jobs.flatMap((entry) => entry.rows.map((r) => [r.v7RowId, r.status])), [["m2", "NOT_MOVED"], ["m3", "NOT_MOVED"]]);
      assert.equal(await fingerprint(), before);
      assert.equal(await audits(), 1);
    });

    it("a later re-ingest of the job reuses the factor its carried factor was folded into", async () => {
      const into = (await carried("m1")).folded;
      await withTenantWrite(database.pool, ORG, (client) => revertV7ReingestInTransaction(client, { jobId: JOB, runId }, system()));
      await reingest();
      const m1 = await live("m1");
      assert.equal(m1.client_factor_id, into);
      assert.ok(Math.abs(m1.tco2e - 0.5) < 1e-9);
    });
  });

  /**
   * GAPS-client-custom-factors PR A (BRIEF 28 Nov 2026): after the load, the console's other paths take these factors —
   * spend import and LCA take an organisation-level one (G4, G5), LCA prices by the assessment's reference year (G5), the list
   * says where a folded factor went (G7), and a template import's source on a client factor prices (G8).
   */
  describe("in the console's other paths: spend import, LCA, a folded factor, a template import", () => {
    const SECRET = "client-factor-gaps-secret-at-least-thirty-two-bytes";
    const SPEND_JOB = "j-spend";
    const LCA_JOB = "j-lca";
    const identity = (): SpendImportIdentity => ({ jobId: SPEND_JOB, jobNumber: "J000951", clientName: "Custom Factor Test", jobName: "CRP", reportingYear: 2024,
      reportingFrom: "2024-01-01", reportingTo: "2024-12-31", domain: "spend", templateVersion: 1 });
    const orgFactor = (id: string, scope: string, unit: string, kg: number) => db.query(
      `INSERT INTO nzi_console.client_factors (organisation_id,client_factor_id,client_id,scope,report_label,unit,kgco2e_per_unit,vintage_year,created_by)
       VALUES ($1,$2,NULL,$3,$2,$4,$5,2025,'francis')`, [ORG, id, scope, unit, kg]);
    /** A synced row, calculated by the one row calculation. */
    const priced = async (jobId: string, rowId: string) => {
      const version = (await db.query(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [rowId])).rows[0]!.version as number;
      await withTenantWrite(database.pool, ORG, (client) => recalculateScopeRowInTransaction(client, { jobId, rowId, expectedVersion: version }, staff()));
      return (await db.query(`SELECT factor_source, client_factor_id, calculated_tco2e::float8 AS tco2e FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [rowId])).rows[0]!;
    };

    before(async () => {
      await orgFactor("cf-org-spend", "3", "GBP", 0.3);
      await orgFactor("cf-org-material", "3", "kg", 2);
      await orgFactor("cf-org-flat", "3", "kg", 4);
      await db.query(`INSERT INTO nzi_console.client_factor_year_values (organisation_id,client_factor_id,version,year,kgco2e_per_unit,created_by)
        VALUES ($1,'cf-org-material',1,2023,1,'francis'),($1,'cf-org-material',1,2025,1.5,'francis')`, [ORG]);
      await db.query(`INSERT INTO nzi_console.client_factors (organisation_id,client_factor_id,client_id,scope,report_label,unit,kgco2e_per_unit,vintage_year,created_by)
        VALUES ($1,'cf-van','c1','1','Cars - Medium car - Diesel','km',0.2,2024,'francis'),($1,'cf-rail','c1','3','Rail - National rail','km',0.035,2024,'francis')`, [ORG]);
      await db.query(`INSERT INTO nzi_console.purchased_goods_categories (organisation_id,category_id,client_id,name,created_by) VALUES ($1,'pgs-general','c1','General','test')`, [ORG]);
      await job(SPEND_JOB, "J000951", 4, "2024-01-01", "2024-12-31");
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year)
        VALUES ($1,$2,'c1',5,'lca','LCA','open','Data entry',2024)`, [ORG, LCA_JOB]);
    });

    // Its pricing is PR B's: the commit files a client-factor line without the factor id the calculation needs (any client factor,
    // not only an organisation-level one), and the fix is in postgresCommands.ts, a governed path.
    it("G4: a spend-import line on an organisation-level factor validates and files on that factor", async () => {
      const lines: SpendImportRow[] = [{ rowNumber: 1, description: "Courier account", netValue: 1000, vatPercent: 20, glCode: null, invoiceDate: "2024-03-01",
        purchasedGoodsCategoryId: "pgs-general", factorSource: "client", factorId: null, datasetId: null, clientFactorId: "cf-org-spend", monthly: [] }];
      const preview = await previewSpendImport(database.pool, ORG, identity(), lines, 1);
      assert.equal(preview.kind, "preview");
      const review = preview.kind === "preview" ? preview.reviews[0]! : null;
      assert.deepEqual(review?.issues.map((issue) => issue.code), [], "the factor resolves, and is a Scope 3 factor for a Scope 3 line");
      assert.notEqual(review?.status, "blocked");
      const token = encodeImportIdentity(identity(), signSpendImportIdentity(identity(), SECRET));
      const committed = await commitSpendImport(database.pool, { jobId: SPEND_JOB, token, rows: lines }, staff(), SECRET);
      assert.equal(committed.data.created, 1);
      const source = (await db.query(`SELECT source_id, factor_source, client_factor_id FROM nzi_console.job_emission_sources WHERE job_id = $1`, [SPEND_JOB])).rows[0]!;
      assert.deepEqual([source.factor_source, source.client_factor_id], ["client", "cf-org-spend"]);
    });

    it("G5: an LCA line on an organisation-level factor prices at its reference year's value, else the headline", async () => {
      const assessment = async (id: string, referenceYear: number | null) => {
        await db.query(`INSERT INTO nzi_console.lca_assessments (organisation_id,assessment_id,job_id,name,reference_year,created_by) VALUES ($1,$2,$3,$2,$4,'francis')`,
          [ORG, id, LCA_JOB, referenceYear]);
        for (const factor of ["cf-org-material", "cf-org-flat"]) {
          await db.query(`INSERT INTO nzi_console.lca_line_items (organisation_id,line_item_id,assessment_id,module_code,line_label,quantity,unit,factor_source,client_factor_id,created_by)
            VALUES ($1,$2,$3,'A1',$4,10,'kg','client',$4,'francis')`, [ORG, `${id}-${factor}`, id, factor]);
        }
        const version = (await db.query(`SELECT version FROM nzi_console.lca_assessments WHERE assessment_id = $1`, [id])).rows[0]!.version as number;
        await calculateLcaAssessment(database.pool, { jobId: LCA_JOB, assessmentId: id, expectedVersion: version }, staff());
        return Object.fromEntries((await db.query(`SELECT client_factor_id, calculated_kgco2e::float8 AS kg FROM nzi_console.lca_line_items WHERE assessment_id = $1`, [id])).rows
          .map((line) => [line.client_factor_id, line.kg]));
      };
      assert.deepEqual(await assessment("a-2024", 2024), { "cf-org-material": 10, "cf-org-flat": 40 },
        "2024 has no value: the closest earlier year's (2023, 1.0); a factor with no year values at its headline");
      assert.deepEqual(await assessment("a-2025", 2025), { "cf-org-material": 15, "cf-org-flat": 40 }, "the year's own value");
      assert.deepEqual(await assessment("a-none", null), { "cf-org-material": 20, "cf-org-flat": 40 }, "no reference year: the headline");
    });

    it("G7: the list says where a folded factor went", async () => {
      const factors = await withTenantRead(database.pool, ORG, (client) => listClientFactors(client, ORG, "c1"));
      const folded = factors.filter((factor) => factor.foldedInto !== null);
      assert.ok(folded.length >= 2, "the re-point folded m1's and m4's carried factors");
      for (const factor of folded) {
        assert.equal(factor.archived, true);
        const target = factors.find((entry) => entry.clientFactorId === factor.foldedInto!.clientFactorId)!;
        assert.equal(factor.foldedInto!.reportLabel, target.reportLabel);
        assert.ok(target.legacyCustomId, "folded into a loaded V7 factor, which carries V7's id");
      }
      assert.equal(factors.find((factor) => factor.clientFactorId === "cf-van")!.foldedInto, null, "a factor never folded says so");
    });

    // A trip on an organisation-level factor is PR B's: emission.source.create's factor check is still client-only (postgresCommands.ts).
    it("G8: a template import's source on a client factor files ungrouped and prices — a vehicle, and a trip", async () => {
      const vehicle = await createEmissionSource(database.pool, { jobId: SPEND_JOB, groupId: null, scope: "1", sourceType: "vehicle", sourceSubtype: null, siteId: null,
        sourceName: "Company vehicle · Medium car · Diesel", assetIdentifier: null, purchasedGoodsCategoryId: null, datasetId: null,
        factorId: "cf-van", factorSource: "client", clientFactorId: "cf-van", quantity: 1000, unit: "km", applyPct: 100, dataSource: "Company vehicles template import", dataConfidence: "M",
        monthlyActivity: [], detail: { kind: "vehicle", vehicleRegistration: null, make: null, model: null, fuel: "Diesel" }, notes: null, importBatchId: randomUUID() }, staff());
      const vehicleRow = await priced(SPEND_JOB, (await syncEmissionSourceToScope(database.pool, { jobId: SPEND_JOB, sourceId: vehicle.data.sourceId }, staff())).data.rowId);
      assert.deepEqual([vehicleRow.factor_source, vehicleRow.client_factor_id], ["client", "cf-van"]);
      assert.ok(Math.abs(vehicleRow.tco2e - 0.2) < 1e-9, `${vehicleRow.tco2e}`);

      const trip = await createEmissionSource(database.pool, { jobId: SPEND_JOB, groupId: null, scope: "3.6", sourceType: "travel", sourceSubtype: null, siteId: null,
        sourceName: "Rail · London → Leeds", assetIdentifier: null, purchasedGoodsCategoryId: null, datasetId: null,
        factorId: "cf-rail", factorSource: "client", clientFactorId: "cf-rail", quantity: 400, unit: "km", applyPct: 100, dataSource: "Business travel template import", dataConfidence: "M",
        monthlyActivity: [], detail: { kind: "travel", travelMode: "rail", airHaul: null, cabinClass: null, nights: null, tripDate: "2024-05-01", origin: "London", destination: "Leeds",
          carrier: null, distanceUnit: "km", passengers: 1 }, notes: null, importBatchId: randomUUID() }, staff());
      const tripRow = await priced(SPEND_JOB, (await syncEmissionSourceToScope(database.pool, { jobId: SPEND_JOB, sourceId: trip.data.sourceId }, staff())).data.rowId);
      assert.deepEqual([tripRow.factor_source, tripRow.client_factor_id], ["client", "cf-rail"]);
      assert.ok(Math.abs(tripRow.tco2e - 0.014) < 1e-9, `${tripRow.tco2e}`);
    });
  });
});
