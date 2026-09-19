import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  CommandValidationError, createEmissionSource, createReviewedCrpSnapshot, createScopeRow,
  updateEmissionSourceActivity, updateScopeRow, utcDay,
} from "../src/index";

/**
 * What monthly activity (`0031`) and the report label (`0030`) do today, pinned before PR 2 extends
 * either.
 *
 * PR 2 adds annual/quarterly distribution over `monthly_activity_json` and a per-client override
 * layered over `report_label`. Both are extensions of mechanisms that already carry live data, so
 * the same rule as the input spec applies: write down what they do now, then prove the extension
 * did not change it.
 *
 * **This records behaviour, not correctness.** If something below is wrong it is wrong in the
 * running product, and changing it is its own decision with its own reasoning — not something to
 * fold into a feature.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const CLIENT = "client-a";
const JOB = "job-a";
const ACTOR = "consultant-a";

const context = (key: string) => ({
  organisationId: ORG, actorId: ACTOR, principal: "staff" as const,
  idempotencyKey: key, correlationId: `corr-${key}`,
  grant: commandGrantForRole("admin", ORG, ACTOR),
});

/** The reporting period's months, as both resolvers demand them: in order, none missing. */
const months = (from: number, count: number, quantity: number | null = null) =>
  Array.from({ length: count }, (_, index) => {
    // Built and read in UTC, so the month keys do not depend on where the suite runs (NZC-106).
    const date = new Date(Date.UTC(2025, from - 1 + index, 1));
    return { month: utcDay(date).slice(0, 7), quantity };
  });

/** The minimum a scope row needs, with the factor provenance the calculation gate expects. */
const row = (over: Record<string, unknown> = {}) => ({
  jobId: JOB, scope: "1", sourceLabel: "Fleet diesel", reportLabel: "Fleet diesel",
  quantity: 1200, unit: "litres",
  datasetId: "ds-1", factorId: "f-diesel", factorVersion: "2025.1", factorLabel: "Diesel — LGV",
  qualityTier: "measured" as const,
  ...over,
});

describe("monthly activity today (0031)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("monthlylabel"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, ACTOR]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
      [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2025,'2025-04-01','2026-03-31')`, [ORG, JOB, CLIENT]);
    // A March year end: the reporting period is April to March, which is where an assumption that
    // months run January to December shows up.
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2025-04-01','2026-03-31','GB')`, [ORG, JOB]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'ds-1','Synthetic GB','2025.1','2025-01-01','2026-12-31','GB','active','Synthetic','OGL')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'ds-1','f-diesel','Diesel — LGV','litres',2.5,ARRAY['1'])`, [ORG]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("stores nothing monthly when none is given, and keeps the annual figure", async () => {
    const created = await createScopeRow(pool, row(), context("m-none"));
    const { rows } = await db.query<{ monthly_activity_json: unknown[]; quantity: string }>(
      `SELECT monthly_activity_json, quantity::text FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`,
      [created.data.rowId]);
    assert.deepEqual(rows[0]!.monthly_activity_json, [], "the default is an empty vector, never null");
    assert.equal(Number(rows[0]!.quantity), 1200);
  });

  it("requires every reporting month, in order, when any is given", async () => {
    // The rule that makes a monthly vector meaningful: it is the reporting period, not a sample of
    // it. A partial vector is refused rather than padded.
    await assert.rejects(
      () => createScopeRow(pool, row({ monthlyActivity: months(4, 3) }), context("m-partial")),
      CommandValidationError);
  });

  it("accepts the full twelve months of an April-to-March period", async () => {
    // Twelve months starting in April, not January: the period comes from the job's config, and a
    // calendar-year assumption would fail here.
    const created = await createScopeRow(pool, row({ monthlyActivity: months(4, 12, 100) }), context("m-full"));
    const { rows } = await db.query<{ monthly_activity_json: Array<{ month: string; quantity: number }> }>(
      `SELECT monthly_activity_json FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId]);
    const stored = rows[0]!.monthly_activity_json;
    assert.equal(stored.length, 12);
    assert.equal(stored[0]!.month, "2025-04", "the period starts in April");
    assert.equal(stored[11]!.month, "2026-03", "and ends the following March");
  });

  it("derives the annual quantity from the months when they are populated", async () => {
    // The annual figure stops being typed and becomes the sum — the behaviour the distribution
    // work in PR 2 has to preserve in the other direction.
    const created = await createScopeRow(pool, row({ quantity: 999, monthlyActivity: months(4, 12, 100) }), context("m-sum"));
    const { rows } = await db.query<{ quantity: string }>(
      `SELECT quantity::text FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId]);
    assert.equal(Number(rows[0]!.quantity), 1200, "twelve months of 100 — not the 999 that was typed");
  });

  it("treats an all-empty vector as no annual figure rather than as zero", async () => {
    // Truth before apparent availability: months present but unfilled is "not reported", and a
    // zero would read as a measured absence of emissions.
    const created = await createScopeRow(pool, row({ monthlyActivity: months(4, 12, null) }), context("m-empty"));
    const { rows } = await db.query<{ quantity: string | null }>(
      `SELECT quantity::text FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId]);
    assert.equal(rows[0]!.quantity, null);
  });

  it("sums only the populated months when the vector is partly filled", async () => {
    const partial = months(4, 12, null).map((slot, index) => (index < 3 ? { ...slot, quantity: 50 } : slot));
    const created = await createScopeRow(pool, row({ monthlyActivity: partial }), context("m-partial-fill"));
    const { rows } = await db.query<{ quantity: string }>(
      `SELECT quantity::text FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId]);
    assert.equal(Number(rows[0]!.quantity), 150);
  });

  it("refuses a month outside the reporting period", async () => {
    const outside = months(4, 12, 100);
    outside[0] = { month: "2025-03", quantity: 100 };
    await assert.rejects(
      () => createScopeRow(pool, row({ monthlyActivity: outside }), context("m-outside")),
      CommandValidationError);
  });

  it("refuses a duplicated month and a negative quantity", async () => {
    const duped = months(4, 12, 100);
    duped[1] = { month: "2025-04", quantity: 100 };
    await assert.rejects(
      () => createScopeRow(pool, row({ monthlyActivity: duped }), context("m-dupe")),
      CommandValidationError);
    await assert.rejects(
      () => createScopeRow(pool, row({ monthlyActivity: months(4, 12, -1) }), context("m-negative")),
      CommandValidationError);
  });
});

describe("the report label today (0030)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("labelpin"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, ACTOR]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
      [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2025)`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'ds-1','Synthetic GB','2025.1','2025-01-01','2026-12-31','GB','active','Synthetic','OGL')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'ds-1','f-diesel','Diesel — LGV','litres',2.5,ARRAY['1'])`, [ORG]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("is stored on the row, distinct from the source label", async () => {
    // Two different jobs for two different words: `source_label` is what the consultant called the
    // source; `report_label` is what the client's report calls it. PR 2 layers a per-client
    // override over the second and must not touch the first.
    const created = await createScopeRow(pool, row({ sourceLabel: "Diesel — fleet", reportLabel: "Company vehicles" }), context("l-1"));
    const { rows } = await db.query<{ source_label: string; report_label: string }>(
      `SELECT source_label, report_label FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId]);
    assert.equal(rows[0]!.source_label, "Diesel — fleet");
    assert.equal(rows[0]!.report_label, "Company vehicles");
  });

  it("never carries the factor with it — relabelling is not remapping", async () => {
    // The property PR 2's override must preserve: a label is display, the factor is the
    // measurement. Changing one has never changed the other.
    const created = await createScopeRow(pool, row({ reportLabel: "Before" }), context("l-2"));
    const before = await db.query<{ factor_id: string; factor_version: string; version: number }>(
      `SELECT factor_id, factor_version, version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId]);

    await updateScopeRow(pool, {
      ...row({ reportLabel: "After" }), rowId: created.data.rowId,
      expectedVersion: before.rows[0]!.version, enabled: true,
    }, context("l-3"));

    const after = await db.query<{ factor_id: string; factor_version: string; report_label: string }>(
      `SELECT factor_id, factor_version, report_label FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId]);
    assert.equal(after.rows[0]!.report_label, "After", "the label moved");
    assert.equal(after.rows[0]!.factor_id, before.rows[0]!.factor_id, "the factor did not");
    assert.equal(after.rows[0]!.factor_version, before.rows[0]!.factor_version, "nor its pinned version");
  });

  it("is required and non-blank, so a row always has something to print", async () => {
    // `job_scope_rows_report_label_present` (0030). A per-client override may replace what is
    // shown; it may not leave a row with nothing to show.
    await assert.rejects(
      () => db.query(
        `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2)
         VALUES ($1,'blank',$2,'1','Source','   ','Scope 1','Direct')`, [ORG, JOB]),
      /report_label_present/);
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────────
 * The source register's own monthly vector (0036), pinned alongside the scope row's (0031).
 *
 * PR 2 distributes an annual or quarterly figure across the reporting period's months, and the
 * ruling is that one shared mechanism serves both stores — not two implementations that drift
 * until the register disagrees with the row. Pinning the second store's *current* behaviour is
 * what makes "the shared mechanism changed nothing" a claim either side can be checked against.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

describe("monthly activity on the source register today (0036)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("sourcemonthly"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, ACTOR]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
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
    // A source's factor must sit in a dataset the job selected — the register refuses one that does not.
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,$2,'ds-1','automatic','Fixture',$3)`, [ORG, JOB, ACTOR]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  /** The minimum an asset source needs to exist on this job. */
  const source = (over: Record<string, unknown> = {}) => ({
    jobId: JOB, groupId: null, scope: "1", sourceType: "asset" as const, sourceSubtype: null,
    siteId: null, sourceName: "Site boiler", assetIdentifier: null, purchasedGoodsCategoryId: null,
    datasetId: "ds-1", factorId: "f-diesel", factorSource: "dataset" as const, clientFactorId: null,
    quantity: 1200, unit: "litres", applyPct: 100, dataSource: "Meter read",
    dataConfidence: "H" as const, monthlyActivity: [], detail: { kind: "asset" as const },
    notes: null, ...over,
  });

  const storedSource = async (sourceId: string) =>
    (await db.query<{ monthly_activity_json: Array<{ month: string; quantity: number | null }>; quantity: string | null; version: number }>(
      `SELECT monthly_activity_json, quantity::text, version FROM nzi_console.job_emission_sources WHERE source_id=$1`,
      [sourceId])).rows[0]!;

  it("keeps the annual figure when no monthly vector is given", async () => {
    const created = await createEmissionSource(pool, source(), context("s-none"));
    const stored = await storedSource(created.data.sourceId);
    assert.deepEqual(stored.monthly_activity_json, []);
    assert.equal(Number(stored.quantity), 1200);
  });

  it("accepts the full twelve months of an April-to-March period and derives the annual figure", async () => {
    const created = await createEmissionSource(pool, source({
      sourceName: "Metered boiler", monthlyActivity: months(4, 12, 100),
    }), context("s-full"));
    const stored = await storedSource(created.data.sourceId);
    assert.equal(stored.monthly_activity_json.length, 12);
    assert.equal(stored.monthly_activity_json[0]!.month, "2025-04");
    assert.equal(stored.monthly_activity_json.at(-1)!.month, "2026-03");
    // The annual figure is the sum of the months, not whatever was passed alongside them.
    assert.equal(Number(stored.quantity), 1200);
  });

  it("requires every reporting month, in order, when any is given", async () => {
    const created = await createEmissionSource(pool, source({ sourceName: "Short vector" }), context("s-short"));
    const stored = await storedSource(created.data.sourceId);
    await assert.rejects(() => updateEmissionSourceActivity(pool, {
      jobId: JOB, sourceId: created.data.sourceId, expectedVersion: stored.version,
      quantity: 1200, unit: "litres", applyPct: 100, dataConfidence: "H",
      monthlyActivity: months(4, 11, 100), notes: null,
    }, context("s-short-2")), CommandValidationError);
    await assert.rejects(() => updateEmissionSourceActivity(pool, {
      jobId: JOB, sourceId: created.data.sourceId, expectedVersion: stored.version,
      quantity: 1200, unit: "litres", applyPct: 100, dataConfidence: "H",
      monthlyActivity: months(1, 12, 100), notes: null,
    }, context("s-wrong-start")), CommandValidationError);
  });

  it("treats an all-empty vector as no annual figure rather than as zero", async () => {
    // The distinction PR 2's distribution must preserve: a period nobody has filled in is not a
    // period of zero emissions.
    const created = await createEmissionSource(pool, source({ sourceName: "Empty vector", monthlyActivity: months(4, 12) }), context("s-empty"));
    const stored = await storedSource(created.data.sourceId);
    assert.equal(stored.monthly_activity_json.length, 12);
    assert.equal(stored.quantity, null);
  });

  it("sums only the populated months when the vector is partly filled", async () => {
    const partial = months(4, 12).map((slot, index) => (index < 3 ? { ...slot, quantity: 50 } : slot));
    const created = await createEmissionSource(pool, source({ sourceName: "Partial vector", monthlyActivity: partial }), context("s-partial"));
    const stored = await storedSource(created.data.sourceId);
    assert.equal(Number(stored.quantity), 150);
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────────
 * Which label the client's report actually renders.
 *
 * The Q2 verify, settled against the database rather than by reading: the two labels are given
 * deliberately different values and the issued snapshot is inspected. Whatever a per-client
 * override resolves to has to reach *this* field, or it renames something nobody sees.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

describe("which label the report renders today (0030)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("labelrender"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, ACTOR]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
      [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Review & QA',2025,'2025-01-01','2025-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [ORG, JOB]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'ds-1','Synthetic GB','2025.1','2025-01-01','2025-12-31','GB','active','Synthetic','OGL')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'ds-1','f-diesel','Diesel — LGV','litres',2.5,ARRAY['1'])`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,$2,'ds-1','automatic','Fixture',$3)`, [ORG, JOB, ACTOR]);
    // The two labels deliberately different, so the snapshot cannot agree with both.
    await db.query(
      `INSERT INTO nzi_console.job_scope_rows
         (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,
          quantity,unit,calculated_tco2e,quality_tier,review_status,reviewed_by,reviewed_row_version,
          reviewed_at,dataset_id,factor_id,factor_label,factor_version,enabled,version)
       VALUES ($1,'row-a',$2,'1','Diesel — fleet','What the client calls it','Scope 1','Direct',
               1000,'litres',2.5,'measured','approved',$3,1,now(),'ds-1','f-diesel','Diesel — LGV','2025.1',true,1)`,
      [ORG, JOB, ACTOR]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("renders the scope row's report label, not its source label", async () => {
    const created = await createReviewedCrpSnapshot(pool, { jobId: JOB, expectedJobVersion: 1 }, context("render-1"));
    const { rows } = await db.query<{ payload_json: { measurements: Array<Record<string, unknown>> } }>(
      `SELECT payload_json FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id=$1`, [created.data.snapshotId]);
    const measurement = rows[0]!.payload_json.measurements[0]!;
    // The answer a per-client override has to aim at: this is the field the portal's published
    // report returns to the client, and it comes from `job_scope_rows.report_label`.
    assert.equal(measurement.reportLabel, "What the client calls it");
    assert.equal(measurement.sourceLabel, "Diesel — fleet");
    // And the factor travels unrenamed — the label is display, the factor is the measurement.
    assert.equal(measurement.factorSet, "Diesel — LGV · 2025.1");
  });

});
