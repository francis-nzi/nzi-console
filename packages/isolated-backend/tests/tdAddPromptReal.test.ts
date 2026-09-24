import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type ScopeRowReadModel } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, createScopeRow, withTenantRead } from "../src/index";
import { listScopeRows } from "../src/readModels";

/**
 * Every manual 3.3 entry is prompted to consider adding T&D losses, and nothing is blocked (NZC-160 H4, as ruled).
 *
 * The ruling: manual 3.3 entries are not prevented; 3.3 is mostly spend-based, and a spend line for fuel- and
 * energy-related activities may not include transmission & distribution losses. So every one carries a completeness
 * prompt — "Add T&D?" — in the row list and the evidence drawer. Ungated: it does not depend on companions being on,
 * or on anything else in the job. Derived T&D beside a manual 3.3 entry is the activation stop's concern (NZC-164),
 * not this prompt's.
 *
 * Rows go in through the real create command; the prompt is read back through the read model the job workspace
 * renders. Companions are switched on inside one test only, and restored.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "demo-nzi-console";
const CLIENT = "client-td";
const JOB = "job-td";
const ACTOR = "admin-td";
const here = dirname(fileURLToPath(import.meta.url));

describe("every manual 3.3 entry is prompted to consider adding T&D, and nothing is blocked (H4)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = () => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff" as const, idempotencyKey: `td-${keys}`,
      correlationId: `corr-td-${keys}`, grant: commandGrantForRole("admin", ORG, ACTOR) };
  };
  const electricity = (supplySource: string | null): any => ({
    jobId: JOB, scope: "2", sourceLabel: "Meter", reportLabel: "Meter", categoryCode: "2.purchased-electricity",
    quantity: 1000, unit: "kWh", datasetId: null, factorId: null, factorVersion: null, factorLabel: null, qualityTier: "measured", supplySource,
  });
  const spend33 = (label: string): any => ({
    jobId: JOB, scope: "3.3", sourceLabel: label, reportLabel: label, categoryCode: "3.3", quantity: 1000, unit: "GBP",
    datasetId: "synthetic-global-2026", factorId: "spend-demo", factorVersion: "2026 demo v1", factorLabel: "Spend", qualityTier: "spend-based",
  });
  const activity33 = (label: string): any => ({
    jobId: JOB, scope: "3.3", sourceLabel: label, reportLabel: label, categoryCode: "3.3", quantity: 1000, unit: "kWh",
    datasetId: "synthetic-gb-2026", factorId: "electricity-td-demo", factorVersion: "2026 demo v1", factorLabel: "T&D", qualityTier: "measured",
  });
  const gas = (): any => ({
    jobId: JOB, scope: "1", sourceLabel: "Boiler", reportLabel: "Boiler", categoryCode: "1.natural-gas", quantity: 10, unit: "kWh",
    datasetId: "synthetic-gb-2026", factorId: "gas-demo", factorVersion: "2026 demo v1", factorLabel: "Gas", qualityTier: "measured",
  });
  const prompted = async () => Object.fromEntries(
    (await withTenantRead(database.pool, ORG, (reader) => listScopeRows(reader, JOB)) as ScopeRowReadModel[])
      .map((row) => [row.sourceLabel, row.tdAddPrompt === true]));
  const companions = (on: boolean) => db.query(
    `UPDATE nzi_console.input_spec_categories SET companions_enabled=$1 WHERE category_code='2.purchased-electricity'`, [on]);

  before(async () => {
    database = (await createDisposableDatabase("tdprompt"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, JOB]);
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    await createScopeRow(database.pool, electricity("grid"), context());
    await createScopeRow(database.pool, gas(), context());
    await createScopeRow(database.pool, spend33("Energy-related spend"), context());
    await createScopeRow(database.pool, activity33("Energy-related activity"), context());
  });

  after(async () => { await companions(false).catch(() => {}); await db?.end(); await database?.end(); });

  it("prompts every manual 3.3 entry, spend-based or activity-based, and no other row", async () => {
    assert.deepEqual(await prompted(), {
      "Meter": false, "Boiler": false, "Energy-related spend": true, "Energy-related activity": true,
    });
  });

  it("prompts whether companions are on or off — it is ungated", async () => {
    const off = await prompted();
    await companions(true);
    try {
      assert.deepEqual(await prompted(), off, "switching companions on changed which rows are prompted");
    } finally { await companions(false); }
  });

  it("blocks nothing: a prompted entry still calculates", async () => {
    const spend = (await db.query<{ scope_row_id: string; version: number }>(
      `SELECT scope_row_id, version FROM nzi_console.job_scope_rows WHERE job_id=$1 AND source_label='Energy-related spend'`, [JOB])).rows[0]!;
    assert.equal((await prompted())["Energy-related spend"], true);
    await calculateScopeRow(database.pool, { jobId: JOB, rowId: spend.scope_row_id, expectedVersion: spend.version }, context());
    const t = await db.query<{ t: string }>(`SELECT calculated_tco2e::text AS t FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [spend.scope_row_id]);
    assert.equal(Number(t.rows[0]!.t), 0.15);
  });
});
