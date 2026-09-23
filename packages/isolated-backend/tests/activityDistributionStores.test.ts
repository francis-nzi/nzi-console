import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, monthsBetween } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  CommandValidationError, createEmissionSource, createScopeRow, updateEmissionSourceActivity, updateScopeRow,
} from "../src/index";

/**
 * Distribution, through both stores, against a real database (NZC-107).
 *
 * **Assert-correct, not pin-current.** The arithmetic itself is proved in
 * `@nzi/contracts/tests/activityDistribution.test.ts`; what is proved here is that both stores
 * reach the same arithmetic and record the same thing about it — the scope row (0031) and the
 * source register (0036) share one resolver, and a client whose figures pass through one must not
 * get a different answer from the other.
 *
 * The reporting period is April–March throughout, because a period that does not start in January
 * is where an assumption about calendar quarters shows itself.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const CLIENT = "client-a";
const JOB = "job-a";
const ACTOR = "consultant-a";

const PERIOD = monthsBetween("2025-04-01", "2026-03-31");

const context = (key: string) => ({
  organisationId: ORG, actorId: ACTOR, principal: "staff" as const,
  idempotencyKey: key, correlationId: `corr-${key}`,
  grant: commandGrantForRole("admin", ORG, ACTOR),
});

const row = (over: Record<string, unknown> = {}) => ({
  jobId: JOB, scope: "1", sourceLabel: "Fleet diesel", reportLabel: "Fleet diesel",
  quantity: null, unit: "litres",
  datasetId: "ds-1", factorId: "f-diesel", factorVersion: "2025.1", factorLabel: "Diesel — LGV",
  qualityTier: "measured" as const,
  ...over,
});

const source = (over: Record<string, unknown> = {}) => ({
  jobId: JOB, groupId: null, scope: "1", sourceType: "asset" as const, sourceSubtype: null,
  siteId: null, sourceName: "Site boiler", assetIdentifier: null, purchasedGoodsCategoryId: null,
  datasetId: "ds-1", factorId: "f-diesel", factorSource: "dataset" as const, clientFactorId: null,
  quantity: null, unit: "litres", applyPct: 100, dataSource: "Invoice",
  dataConfidence: "H" as const, monthlyActivity: [], detail: { kind: "asset" as const },
  notes: null, ...over,
});

describe("a figure lands the same way in both stores (NZC-107)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("distribution"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, ACTOR]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,data_reporting_frequency) VALUES ($1,$2,'Client','active','quarterly')`,
      [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2025,'2025-04-01','2026-03-31')`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2025-04-01','2026-03-31','GB')`, [ORG, JOB]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'ds-1','Synthetic GB','2025.1','2025-01-01','2026-12-31','GB','active','Synthetic','OGL')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'ds-1','f-diesel','Diesel — LGV','litres',2.5,ARRAY['1'])`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,$2,'ds-1','automatic','Fixture',$3)`, [ORG, JOB, ACTOR]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  type Stored = {
    monthly_activity_json: Array<{ month: string; quantity: number | null }>;
    quantity: string | null;
    activity_frequency: string | null;
    activity_distributed: boolean;
  };

  const storedRow = async (rowId: string) => (await db.query<Stored>(
    `SELECT monthly_activity_json, quantity::text, activity_frequency, activity_distributed
       FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!;

  const storedSource = async (sourceId: string) => (await db.query<Stored>(
    `SELECT monthly_activity_json, quantity::text, activity_frequency, activity_distributed
       FROM nzi_console.job_emission_sources WHERE source_id=$1`, [sourceId])).rows[0]!;

  it("spreads one annual figure across the period's twelve months, in both stores", async () => {
    const created = await createScopeRow(pool, row({ activityFrequency: "annual", activityFigures: [1200] }), context("d-row-annual"));
    const stored = await storedRow(created.data.rowId);
    assert.equal(stored.monthly_activity_json.length, 12);
    assert.equal(stored.monthly_activity_json[0]!.month, "2025-04");
    assert.ok(stored.monthly_activity_json.every((slot) => slot.quantity === 100));
    assert.equal(Number(stored.quantity), 1200, "the derived annual figure is what was typed");
    assert.equal(stored.activity_frequency, "annual");
    assert.equal(stored.activity_distributed, true);

    const madeSource = await createEmissionSource(pool, source({ activityFrequency: "annual", activityFigures: [1200] }), context("d-src-annual"));
    const sourceStored = await storedSource(madeSource.data.sourceId);
    // The same figure, the same period, the other store: identical months, identical total.
    assert.deepEqual(sourceStored.monthly_activity_json, stored.monthly_activity_json);
    assert.equal(Number(sourceStored.quantity), 1200);
    assert.equal(sourceStored.activity_frequency, "annual");
    assert.equal(sourceStored.activity_distributed, true);
  });

  it("spreads four quarterly figures across their own quarters, counted from the period", async () => {
    const created = await createScopeRow(pool, row({
      sourceLabel: "Quarterly gas", activityFrequency: "quarterly", activityFigures: [300, 600, 300, 0],
    }), context("d-row-quarterly"));
    const stored = await storedRow(created.data.rowId);
    assert.equal(stored.monthly_activity_json.length, 12);
    // Q1 is April–June because the period starts in April, not because the calendar says so.
    assert.deepEqual(stored.monthly_activity_json.slice(0, 3).map((slot) => slot.quantity), [100, 100, 100]);
    assert.deepEqual(stored.monthly_activity_json.slice(3, 6).map((slot) => slot.quantity), [200, 200, 200]);
    assert.deepEqual(stored.monthly_activity_json.slice(9).map((slot) => slot.quantity), [0, 0, 0]);
    assert.equal(Number(stored.quantity), 1200);
    assert.equal(stored.activity_frequency, "quarterly");
    assert.equal(stored.activity_distributed, true);
  });

  it("does not call a month-by-month entry distributed", async () => {
    const figures = PERIOD.map(() => 100);
    const created = await createScopeRow(pool, row({
      sourceLabel: "Metered", activityFrequency: "monthly",
      monthlyActivity: PERIOD.map((month) => ({ month, quantity: 100 })),
    }), context("d-row-monthly"));
    const stored = await storedRow(created.data.rowId);
    assert.equal(Number(stored.quantity), figures.reduce((sum, value) => sum + value, 0));
    assert.equal(stored.activity_frequency, "monthly");
    assert.equal(stored.activity_distributed, false, "supplied is not derived");
  });

  it("keeps a figure that will not divide, exactly", async () => {
    // 120,001 litres over twelve months. The stored months sum back to the figure that was typed — the
    // defect this mechanism exists to prevent is a client's total quietly becoming 120,000.
    //
    // The unit is the fixture's own litres, matching `f-diesel`. It read `GBP` until NZC-146 refused it:
    // spend against a per-litre factor is the mismatch that guard exists for, and it was only ever here
    // to make this comment read in pounds. What is under test is the arithmetic of an indivisible
    // figure, which does not care what the figure counts.
    const created = await createScopeRow(pool, row({
      sourceLabel: "Awkward", activityFrequency: "annual", activityFigures: [120001],
    }), context("d-row-awkward"));
    const stored = await storedRow(created.data.rowId);
    const summed = stored.monthly_activity_json
      .filter((slot) => slot.quantity !== null)
      .reduce((sum, slot) => sum + (slot.quantity ?? 0), 0);
    assert.equal(summed, 120001);
    assert.equal(Number(stored.quantity), 120001);
    // And the spare pennies went to the earliest months rather than being dropped.
    assert.ok(stored.monthly_activity_json[0]!.quantity! >= stored.monthly_activity_json[11]!.quantity!);
  });

  it("apportions a part-year period only to the months it covers", async () => {
    const partial = "job-partial";
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,2,'crp','Part year','open','Data entry',2026,'2025-11-01','2026-03-31')`, [ORG, partial, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2025-11-01','2026-03-31','GB')`, [ORG, partial]);
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,$2,'ds-1','automatic','Fixture',$3)`, [ORG, partial, ACTOR]);

    const created = await createScopeRow(pool, row({
      jobId: partial, sourceLabel: "Five months", activityFrequency: "annual", activityFigures: [500],
    }), context("d-partial"));
    const stored = await storedRow(created.data.rowId);
    assert.equal(stored.monthly_activity_json.length, 5, "five months, not twelve");
    assert.equal(stored.monthly_activity_json[0]!.month, "2025-11");
    assert.equal(stored.monthly_activity_json.at(-1)!.month, "2026-03");
    assert.ok(stored.monthly_activity_json.every((slot) => slot.quantity === 100));
    assert.equal(Number(stored.quantity), 500);
  });

  it("refuses the wrong number of figures for the period's grain", async () => {
    // Four figures for a twelve-month annual entry is a question the server cannot answer, so it
    // asks rather than guessing which four months were meant.
    await assert.rejects(() => createScopeRow(pool, row({
      sourceLabel: "Bad count", activityFrequency: "annual", activityFigures: [1, 2, 3, 4],
    }), context("d-bad-count")), CommandValidationError);
    await assert.rejects(() => createScopeRow(pool, row({
      sourceLabel: "Bad quarters", activityFrequency: "quarterly", activityFigures: [1, 2, 3],
    }), context("d-bad-quarters")), CommandValidationError);
  });

  it("refuses figures to spread on a month-by-month entry", async () => {
    await assert.rejects(() => createScopeRow(pool, row({
      sourceLabel: "Two answers", activityFrequency: "monthly", activityFigures: [1200],
    }), context("d-two-answers")), CommandValidationError);
  });

  it("records nothing about grain when an entry says nothing about it", async () => {
    // The honest default: a row written without a frequency does not acquire one, and is not
    // described as distributed.
    const created = await createScopeRow(pool, row({ sourceLabel: "Silent", quantity: 900 }), context("d-silent"));
    const stored = await storedRow(created.data.rowId);
    assert.equal(stored.activity_frequency, null);
    assert.equal(stored.activity_distributed, false);
    assert.equal(Number(stored.quantity), 900);
  });

  it("re-spreads when the figure is edited, and stops claiming distribution when months are typed", async () => {
    const created = await createScopeRow(pool, row({
      sourceLabel: "Edited", activityFrequency: "annual", activityFigures: [1200],
    }), context("d-edit-1"));
    const first = await db.query<{ version: number }>(
      `SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId]);

    await updateScopeRow(pool, {
      ...row({ sourceLabel: "Edited", activityFrequency: "annual", activityFigures: [2400] }),
      rowId: created.data.rowId, expectedVersion: first.rows[0]!.version, enabled: true,
    }, context("d-edit-2"));
    const spread = await storedRow(created.data.rowId);
    assert.ok(spread.monthly_activity_json.every((slot) => slot.quantity === 200));
    assert.equal(Number(spread.quantity), 2400);
    assert.equal(spread.activity_distributed, true);

    const second = await db.query<{ version: number }>(
      `SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId]);
    await updateScopeRow(pool, {
      ...row({ sourceLabel: "Edited", activityFrequency: "monthly", monthlyActivity: PERIOD.map((month) => ({ month, quantity: 50 })) }),
      rowId: created.data.rowId, expectedVersion: second.rows[0]!.version, enabled: true,
    }, context("d-edit-3"));
    const typed = await storedRow(created.data.rowId);
    assert.equal(typed.activity_frequency, "monthly");
    assert.equal(typed.activity_distributed, false, "the row stops claiming its months were derived");
    assert.equal(Number(typed.quantity), 600);
  });

  it("re-spreads a source's figure through the same resolver", async () => {
    const created = await createEmissionSource(pool, source({
      sourceName: "Edited source", activityFrequency: "quarterly", activityFigures: [100, 100, 100, 100],
    }), context("d-src-edit-1"));
    const before = await db.query<{ version: number }>(
      `SELECT version FROM nzi_console.job_emission_sources WHERE source_id=$1`, [created.data.sourceId]);

    await updateEmissionSourceActivity(pool, {
      jobId: JOB, sourceId: created.data.sourceId, expectedVersion: before.rows[0]!.version,
      quantity: null, unit: "litres", applyPct: 100, dataConfidence: "H",
      monthlyActivity: [], notes: null, activityFrequency: "annual", activityFigures: [1200],
    }, context("d-src-edit-2"));

    const stored = await storedSource(created.data.sourceId);
    assert.ok(stored.monthly_activity_json.every((slot) => slot.quantity === 100));
    assert.equal(Number(stored.quantity), 1200);
    assert.equal(stored.activity_frequency, "annual");
    assert.equal(stored.activity_distributed, true);
  });

  it("refuses to distribute before the reporting period is configured", async () => {
    const unconfigured = "job-no-period";
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year)
       VALUES ($1,$2,$3,3,'crp','No period','open','Data entry',2025)`, [ORG, unconfigured, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,$2,'ds-1','automatic','Fixture',$3)`, [ORG, unconfigured, ACTOR]);
    // There is nothing to spread across, and inventing twelve calendar months would be a guess
    // about the client's year.
    await assert.rejects(() => createScopeRow(pool, row({
      jobId: unconfigured, sourceLabel: "No period", activityFrequency: "annual", activityFigures: [1200],
    }), context("d-no-period")), CommandValidationError);
  });
});
