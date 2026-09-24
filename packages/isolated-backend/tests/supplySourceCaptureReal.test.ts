import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, SUPPLY_SOURCES } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createScopeRow, updateScopeRow } from "../src/index";

/**
 * `supplySource` is captured and stored, and nothing resolves from it (NZC-159).
 *
 * Two claims, and the second is the one that keeps the capture/consumption boundary honest. Storing the
 * value is capture and belongs here. Reading it to *fire* the transmission companion is the wiring commit,
 * and the proposer that does so is a pure function this write path does not call — asserted below by
 * writing a grid-supplied row and showing that no companion row appears beside it.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-supply";
const CLIENT = "client-supply";
const JOB = "job-supply";
const ACTOR = "admin-supply";

describe("supply source is captured and stored, and consumed by nothing (NZC-159)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  const context = (key: string) => ({
    organisationId: ORG, actorId: ACTOR, principal: "staff" as const,
    idempotencyKey: key, correlationId: `corr-${key}`,
    grant: commandGrantForRole("admin", ORG, ACTOR),
  });

  const row = (over: Record<string, unknown> = {}) => ({
    jobId: JOB, scope: "2", sourceLabel: "Metered electricity", reportLabel: "Metered electricity",
    quantity: 1000, unit: "kWh",
    datasetId: "ds-s", factorId: "electricity-demo", factorVersion: "2025.1", factorLabel: "UK grid",
    qualityTier: "measured" as const, categoryCode: "2.purchased-electricity", ...over,
  });

  before(async () => {
    database = (await createDisposableDatabase("supply"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`,
      [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [ORG, JOB]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'ds-s','Synthetic GB','2025.1','2025-01-01','2026-12-31','GB','active','Synthetic','OGL')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'ds-s','electricity-demo','UK grid','kWh',0.3,ARRAY['2'])`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,$2,'ds-s','automatic','Fixture',$3)`, [ORG, JOB, ACTOR]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  const stored = async (rowId: string) => (await db.query<{ supply_source: string | null }>(
    `SELECT supply_source FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!;

  it("stores what was captured, through the create path", async () => {
    const created = await createScopeRow(pool, row({ supplySource: "grid" }), context("s-create"));
    assert.equal((await stored(created.data.rowId)).supply_source, "grid");
  });

  it("stores it through the update path too, because it is a second call site", async () => {
    const created = await createScopeRow(pool, row({ supplySource: "grid" }), context("s-update-seed"));
    const version = (await db.query<{ version: number }>(
      `SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId])).rows[0]!.version;

    await updateScopeRow(pool, {
      ...row({ supplySource: "self-generated" }),
      rowId: created.data.rowId, expectedVersion: version, enabled: true,
    }, context("s-update"));
    assert.equal((await stored(created.data.rowId)).supply_source, "self-generated");
  });

  it("keeps unanswered distinguishable from every answer", async () => {
    // Blank is not a value: the companion declines while it is unanswered rather than assuming grid, so
    // "not stated" has to survive the round trip as NULL rather than becoming an empty string.
    const created = await createScopeRow(pool, row({ supplySource: null }), context("s-null"));
    assert.equal((await stored(created.data.rowId)).supply_source, null);
  });

  it("accepts every value the contract enumerates, and refuses one it does not", async () => {
    // The enumeration in the column and the enumeration in the type are two statements of one fact, so
    // they are checked against each other rather than each against a list written here.
    for (const [index, value] of SUPPLY_SOURCES.entries()) {
      const created = await createScopeRow(pool, row({ supplySource: value }), context(`s-enum-${index}`));
      assert.equal((await stored(created.data.rowId)).supply_source, value);
    }

    await assert.rejects(
      () => db.query(`INSERT INTO nzi_console.job_scope_rows
        (organisation_id, scope_row_id, job_id, scope, source_label, report_label, level_1, level_2, supply_source)
        VALUES ($1,'s-bad',$2,'2','X','X','Scope 2','Purchased energy','nuclear-ppa')`, [ORG, JOB]),
      /supply_source/);
  });

  it("fires no companion row: the write path stores the value and resolves nothing from it", async () => {
    // The capture/consumption boundary, asserted rather than described. A grid-supplied electricity row
    // is exactly the case the transmission companion is declared for — and the write path does not call
    // the proposer, so the row stands alone. When that changes, it changes in the wiring commit and this
    // assertion is what will say so.
    const before = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE job_id=$1`, [JOB])).rows[0]!.n;

    await createScopeRow(pool, row({ supplySource: "grid" }), context("s-no-companion"));

    const after = await db.query<{ n: number; scopes: string }>(
      `SELECT count(*)::int AS n, coalesce(string_agg(DISTINCT scope, ','), '') AS scopes
         FROM nzi_console.job_scope_rows WHERE job_id=$1`, [JOB]);
    assert.equal(after.rows[0]!.n, before + 1, "more than the captured row was written");
    assert.ok(!after.rows[0]!.scopes.split(",").includes("3.3"),
      "a transmission-and-distribution row was created, so the write path is consuming the proposer");
  });
});
