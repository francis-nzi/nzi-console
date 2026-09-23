import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * A distributed row names the grain it was distributed from (NZC-152).
 *
 * The constraint 0094 wrote said this and did not enforce it: `false OR NULL` is NULL, so a row claiming
 * `activity_distributed = true` with no `activity_frequency` was admitted. 0114 closes it.
 *
 * What makes this suite worth its runtime is the **pair**. A constraint that refused everything would pass
 * the refusal test and break the application, so each refusal is written beside the rows that must still be
 * accepted: months typed by hand carry no frequency and are not distributed; months derived from an annual
 * figure carry both. Only the third combination — derived, from nothing — is new.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-grain";
const CLIENT = "client-grain";
const JOB = "job-grain";

describe("a distributed row must say what it was distributed from (NZC-152)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("grain"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Grain Ltd','active')`,
      [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31')`, [ORG, JOB, CLIENT]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  /** A scope row with the two columns under test, and the minimum the table otherwise requires. */
  const scopeRow = (rowId: string, distributed: boolean, frequency: string | null) => db.query(
    `INSERT INTO nzi_console.job_scope_rows
       (organisation_id, scope_row_id, job_id, scope, source_label, report_label, level_1, level_2,
        activity_distributed, activity_frequency)
     VALUES ($1,$2,$3,'1','Fleet diesel','Fleet diesel','Scope 1','Direct emissions',$4,$5)`,
    [ORG, rowId, JOB, distributed, frequency]);

  const emissionSource = (sourceId: string, distributed: boolean, frequency: string | null) => db.query(
    `INSERT INTO nzi_console.job_emission_sources
       (organisation_id, source_id, job_id, scope, source_type, source_name, apply_pct, data_source,
        data_confidence, detail_json, activity_distributed, activity_frequency)
     VALUES ($1,$2,$3,'1','asset','Site boiler',100,'Invoice','H','{"kind":"asset"}'::jsonb,$4,$5)`,
    [ORG, sourceId, JOB, distributed, frequency]);

  it("refuses a scope row that claims derivation with no grain — the row 0094 admitted", async () => {
    await assert.rejects(() => scopeRow("grain-bad", true, null), /job_scope_rows_distribution_grain/);
  });

  it("refuses the same on an emission source, because the constraint was wrong in both places", async () => {
    await assert.rejects(() => emissionSource("grain-bad-source", true, null),
      /job_emission_sources_distribution_grain/);
  });

  it("still accepts months typed by hand, which carry no frequency at all", async () => {
    // The pair. A constraint that refused this would be refusing the ordinary case: a row whose months
    // were entered rather than derived has nothing to say about grain, and `activity_distributed` is
    // false precisely to record that.
    await scopeRow("grain-typed", false, null);
    await emissionSource("grain-typed-source", false, null);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE scope_row_id = 'grain-typed'`);
    assert.equal(rows[0]!.n, 1);
  });

  it("still accepts months derived from a figure that names its grain", async () => {
    await scopeRow("grain-annual", true, "annual");
    await scopeRow("grain-quarterly", true, "quarterly");
    await emissionSource("grain-annual-source", true, "annual");
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE activity_distributed = true`);
    assert.equal(rows[0]!.n, 2, "the two legitimate distributed rows were not stored");
  });

  it("still refuses a grain outside the two the mechanism can distribute", async () => {
    // Unchanged by 0114 and asserted so the tightening is not mistaken for a loosening: `monthly` is a
    // frequency, and it is not something a monthly breakdown can be *derived* from.
    await assert.rejects(() => scopeRow("grain-monthly", true, "monthly"),
      /job_scope_rows_distribution_grain/);
  });

  it("the constraint reads as intended rather than as it was", async () => {
    // Read from the catalogue, so a future edit that reintroduces the bare disjunction fails here rather
    // than waiting for a row to exercise it. `false OR NULL` is the shape this exists to keep out.
    const { rows } = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'job_scope_rows_distribution_grain'`);
    assert.match(rows[0]!.def, /activity_frequency IS NOT NULL/,
      "the constraint no longer closes its null, and admits a derived row with no grain again");
  });
});
