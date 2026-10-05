import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { listJobApplicableCategories, listScopeRows, withTenantRead } from "../src/index";

/**
 * JW-10 against a real database: the CRM's category view shows Scopes 1–3 for every CRP job — an empty job, and a job
 * with no Scope 1 rows, included — and a row imported from v7 reads back as imported, so the accordion can say so.
 */
describe("JW-10 scope sections and imported rows, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "net-zero-international";
  let database: DisposableDatabase;
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };

  before(async () => {
    database = (await createDisposableDatabase("jw10scopes"))!;
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, location, owner_name, website) VALUES ($1, 'c1', 'Client One Ltd', 'active', NULL, NULL, NULL)`, [ORG]);
    for (const [id, sequence] of [["empty", 9701], ["no-s1", 9702]] as const) {
      await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, source_system, legacy_db_id)
               VALUES ($1, $2, 'c1', $3, 'crp', 'CRP', 'open', 'Open', 'nzi-pro-v7', $2)`, [ORG, id, sequence]);
    }
    const record = { qty: 1, uom: "kWh", factor: 0.2, ghg_unit: "kgCO2e", original_id: "f1", reported_tco2e: 0.0002, data_source: "manual", enabled: true };
    await q(`INSERT INTO nzi_console.job_scope_rows (organisation_id, scope_row_id, job_id, scope, source_label, report_label, level_1, level_2, calculated_tco2e,
               origin, migrated_record, source_system, legacy_db_id)
             VALUES ($1, 'v7-row-1', 'no-s1', '2', 'Electricity', 'Electricity', 'UK electricity', 'Electricity generated', 0.0002, 'migrated', $2, 'nzi-pro-v7', '1')`, [ORG, record]);
  });
  after(async () => { await database?.end(); });

  it("the CRM view includes Scopes 1–3 for an empty job and for a job with no Scope 1 rows; the portal's stays derived", async () => {
    const view = (jobId: string, audience: "crm" | "portal") => withTenantRead(database.pool, ORG, (db) => listJobApplicableCategories(db, jobId, audience));
    for (const jobId of ["empty", "no-s1"]) {
      const crm = await view(jobId, "crm");
      assert.deepEqual(crm.includedScopes, ["1", "2", "3"], `${jobId}: every scope is shown`);
      assert.equal(crm.categories.length, 20, `${jobId}: the full taxonomy`);
    }
    assert.ok((await view("empty", "crm")).categories.every((c) => c.noData), "an empty job's categories are all marked no data");
    assert.deepEqual((await view("no-s1", "portal")).includedScopes, ["2"], "the portal still derives its scopes");
  });

  it("a row imported from v7 reads back as imported; the accordion shows it as such", async () => {
    const rows = await withTenantRead(database.pool, ORG, (db) => listScopeRows(db, "no-s1"));
    assert.deepEqual(rows.map((r) => [r.id, r.origin, r.categoryCode ?? null, r.categoryPath.slice(0, 2)]),
      [["v7-row-1", "migrated", null, ["UK electricity", "Electricity generated"]]]);
  });
});
