import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type ScopeRowReadModel } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, createScopeRow, updateScopeRow, withTenantRead } from "../src/index";
import { listScopeRows } from "../src/readModels";

/**
 * A manual 3.3 entry is flagged, never refused, where T&D is being derived beside it (NZC-160 H4, as ruled).
 *
 * The ruling: the derived T&D companion is the system of record, and a manual entry in 3.3 is not prevented — 3.3 is
 * mostly spend-based, and a spend line for "fuel and energy related activities" may or may not include losses. So it
 * gets a non-blocking flag, shown in the row list and the row's evidence drawer, and only where the companion is
 * actually being derived in the same job: a category with companions switched on, and an enabled electricity row
 * whose supply source fires the T&D rule. Until companions are switched on the flag is dormant — before then a
 * manual entry is the only T&D there is, and flagging it would say the opposite of the truth.
 *
 * Rows go in through the real create and update commands; the flag is read back through the read model the job
 * workspace renders. Companions are switched on inside the test only, and restored.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "demo-nzi-console";
const CLIENT = "client-td";
const JOB = "job-td";
const OTHER_JOB = "job-td-other";
const ACTOR = "admin-td";
const here = dirname(fileURLToPath(import.meta.url));

describe("a manual 3.3 entry is flagged, not refused, where T&D is derived beside it (H4)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = () => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff" as const, idempotencyKey: `td-${keys}`,
      correlationId: `corr-td-${keys}`, grant: commandGrantForRole("admin", ORG, ACTOR) };
  };
  const electricity = (jobId: string, supplySource: string | null): any => ({
    jobId, scope: "2", sourceLabel: "Meter", reportLabel: "Meter", categoryCode: "2.purchased-electricity",
    quantity: 1000, unit: "kWh", datasetId: null, factorId: null, factorVersion: null, factorLabel: null, qualityTier: "measured", supplySource,
  });
  const manualTd = (jobId: string, label: string): any => ({
    jobId, scope: "3.3", sourceLabel: label, reportLabel: label, categoryCode: "3.3", quantity: 1000, unit: "GBP",
    datasetId: "synthetic-global-2026", factorId: "spend-demo", factorVersion: "2026 demo v1", factorLabel: "Spend", qualityTier: "spend-based",
  });
  const flagged = async (jobId: string) => Object.fromEntries(
    (await withTenantRead(database.pool, ORG, (reader) => listScopeRows(reader, jobId)) as ScopeRowReadModel[])
      .map((row) => [row.sourceLabel, row.tdDerivedAlongside === true]));
  const companions = (on: boolean) => db.query(
    `UPDATE nzi_console.input_spec_categories SET companions_enabled=$1 WHERE category_code='2.purchased-electricity'`, [on]);

  let meterId = "";
  before(async () => {
    database = (await createDisposableDatabase("tdflag"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
    for (const [index, job] of [JOB, OTHER_JOB].entries()) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
         VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, job, CLIENT, index + 1]);
      await db.query(
        `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
         VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, job]);
    }
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    meterId = (await createScopeRow(database.pool, electricity(JOB, "grid"), context())).data.rowId;
    await createScopeRow(database.pool, manualTd(JOB, "Energy-related spend"), context());
    // In another job with only self-generated electricity: nothing there carries losses.
    await createScopeRow(database.pool, electricity(OTHER_JOB, "self-generated"), context());
    await createScopeRow(database.pool, manualTd(OTHER_JOB, "Energy-related spend"), context());
  });

  after(async () => { await companions(false).catch(() => {}); await db?.end(); await database?.end(); });

  it("is dormant while companions are off — a manual entry is then the only T&D there is", async () => {
    assert.deepEqual(await flagged(JOB), { "Meter": false, "Energy-related spend": false });
  });

  it("flags the manual 3.3 entry, and only it, once T&D is derived from the job's grid electricity", async () => {
    await companions(true);
    try {
      assert.deepEqual(await flagged(JOB), { "Meter": false, "Energy-related spend": true });
      // Self-generated electricity carries no losses, so nothing is derived and nothing is flagged.
      assert.deepEqual(await flagged(OTHER_JOB), { "Meter": false, "Energy-related spend": false });
    } finally { await companions(false); }
  });

  it("never flags a derived companion row itself", async () => {
    await companions(true);
    try {
      const derived = await createScopeRow(database.pool, manualTd(JOB, "Derived T&D"), context());
      await db.query(`UPDATE nzi_console.job_scope_rows SET provenance_json=provenance_json || '{"companionOf":"x"}'::jsonb WHERE scope_row_id=$1`, [derived.data.rowId]);
      assert.equal((await flagged(JOB))["Derived T&D"], false, "the derived companion was flagged as overlapping itself");
      await db.query(`UPDATE nzi_console.job_scope_rows SET enabled=false WHERE scope_row_id=$1`, [derived.data.rowId]);
    } finally { await companions(false); }
  });

  it("follows the electricity: a supply that stops carrying losses clears the flag", async () => {
    await companions(true);
    try {
      const meter = (await db.query<{ version: number }>(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [meterId])).rows[0]!;
      await updateScopeRow(database.pool, { ...electricity(JOB, "self-generated"), rowId: meterId, expectedVersion: meter.version, enabled: true }, context());
      assert.equal((await flagged(JOB))["Energy-related spend"], false, "the flag did not follow the electricity's supply source");
    } finally { await companions(false); }
  });

  it("blocks nothing: a flagged entry still calculates", async () => {
    const meter = (await db.query<{ version: number }>(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [meterId])).rows[0]!;
    await updateScopeRow(database.pool, { ...electricity(JOB, "grid"), rowId: meterId, expectedVersion: meter.version, enabled: true }, context());
    await companions(true);
    try {
      const spend = (await db.query<{ scope_row_id: string; version: number }>(
        `SELECT scope_row_id, version FROM nzi_console.job_scope_rows WHERE job_id=$1 AND source_label='Energy-related spend'`, [JOB])).rows[0]!;
      assert.equal((await flagged(JOB))["Energy-related spend"], true);
      await calculateScopeRow(database.pool, { jobId: JOB, rowId: spend.scope_row_id, expectedVersion: spend.version }, context());
      const t = await db.query<{ t: string }>(`SELECT calculated_tco2e::text AS t FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [spend.scope_row_id]);
      assert.equal(Number(t.rows[0]!.t), 0.15);
    } finally { await companions(false); }
  });
});
