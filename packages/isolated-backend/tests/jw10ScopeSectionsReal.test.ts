import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { UNASSIGNED_SITE_ID } from "@nzi/contracts";
import { aggregateJobEmissions, listJobApplicableCategories, listScopeRows, withTenantRead } from "../src/index";

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
      assert.equal(crm.categories.length, 22, `${jobId}: the full taxonomy (22 with Purchased Heat & Steam, 0212)`);
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

/**
 * The CRM site tabs against a real database: the category list narrows with the tab exactly as the totals band does (#2), and
 * "Unassigned" (UNASSIGNED_SITE_ID) narrows both to the rows with no site (#3). The categories offered never change.
 */
describe("site tabs narrow the category view and the totals band, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "net-zero-international", JOB = "site-tabs";
  let database: DisposableDatabase;
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };

  before(async () => {
    database = (await createDisposableDatabase("sitetabs"))!;
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, location, owner_name, website) VALUES ($1, 'c1', 'Client One Ltd', 'active', NULL, NULL, NULL)`, [ORG]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage) VALUES ($1, $2, 'c1', 9801, 'crp', 'CRP', 'open', 'Open')`, [ORG, JOB]);
    for (const site of ["site-a", "site-b"]) {
      await q(`INSERT INTO nzi_console.client_sites (organisation_id, site_id, client_id, name, created_by) VALUES ($1, $2, 'c1', $2, 'test')`, [ORG, site]);
    }
    // 3.7: two at site A, one at site B, one with no site. 3.6: one at site B.
    const rows: Array<[string, string, string | null, number]> = [
      ["r1", "3.7", "site-a", 1], ["r2", "3.7", "site-a", 2], ["r3", "3.7", "site-b", 4], ["r4", "3.7", null, 8], ["r5", "3.6", "site-b", 16],
    ];
    for (const [id, code, site, tco2e] of rows) {
      await q(`INSERT INTO nzi_console.job_scope_rows (organisation_id, scope_row_id, job_id, scope, category_code, source_label, report_label, level_1, level_2, site_id, quantity, unit,
                 dataset_id, factor_id, factor_label, calculated_tco2e, enabled)
               VALUES ($1, $2, $3, $4, $4, $2, $2, 'Level 1', 'Level 2', $5, 1, 'km', 'ds', 'f', 'Factor (test)', $6, true)`, [ORG, id, JOB, code, site, tco2e]);
    }
  });
  after(async () => { await database?.end(); });

  const categories = (siteId: string | null) => withTenantRead(database.pool, ORG, (db) => listJobApplicableCategories(db, JOB, "crm", siteId));
  const figures = async (siteId: string | null) => Object.fromEntries((await categories(siteId)).categories
    .filter((c) => c.code === "3.6" || c.code === "3.7").map((c) => [c.code, [c.entryCount, c.tco2e, c.noData]]));
  const headline = (siteId: string | null) => withTenantRead(database.pool, ORG, (db) => aggregateJobEmissions(db, { organisationId: ORG, jobId: JOB, siteId }));

  it("#2: each category's entries and tCO₂e follow the site tab; the categories offered do not", async () => {
    assert.deepEqual(await figures(null), { "3.6": [1, 16, false], "3.7": [4, 15, false] }, "all sites: every row");
    assert.deepEqual(await figures("site-a"), { "3.6": [0, 0, true], "3.7": [2, 3, false] }, "site A only");
    assert.deepEqual(await figures("site-b"), { "3.6": [1, 16, false], "3.7": [1, 4, false] }, "site B only");
    const offered = async (siteId: string | null) => (await categories(siteId)).categories.map((c) => c.code);
    assert.deepEqual(await offered("site-a"), await offered(null), "the same categories under every tab");
  });

  it("#2: the category list and the totals band agree under a site tab", async () => {
    for (const siteId of [null, "site-a", "site-b", UNASSIGNED_SITE_ID]) {
      const list = (await categories(siteId)).categories.reduce((sum, c) => sum + c.entryCount, 0);
      assert.equal(list, (await headline(siteId)).headline.entries, `entries agree under ${siteId ?? "all sites"}`);
    }
  });

  it("#3: Unassigned narrows both reads to the rows with no site, and the site breakdown still counts it", async () => {
    assert.deepEqual(await figures(UNASSIGNED_SITE_ID), { "3.6": [0, 0, true], "3.7": [1, 8, false] });
    const band = await headline(UNASSIGNED_SITE_ID);
    assert.deepEqual([band.headline.entries, band.headline.tco2e], [1, 8]);
    assert.equal(band.bySite.find((site) => site.siteId === null)?.entries, 1, "the Unassigned tab's count");
    assert.equal(band.bySite.reduce((sum, site) => sum + site.entries, 0), 5, "bySite stays unnarrowed");
  });
});
