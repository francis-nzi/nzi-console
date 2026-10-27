import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, encodeImportIdentity, type SpendImportIdentity, type SpendImportRow, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  archiveSpendAllocation, commitSpendImport, createScopeRow, createSpendAllocation, listClientSpendAllocations, previewSpendImport,
  reallocateScopeRow, reinstateSpendAllocation, signSpendImportIdentity, syncEmissionSourceToScope, updateSpendAllocation, withTenantRead,
} from "../src/index";
import { VersionConflictError } from "../src/errors";

/**
 * Data entry D2 against Postgres: a client's allocation map routes a spend line to its proper category — by GL code, else by
 * description, else the PG&S residual — on import (filed there as a spend-basis source and synced to a row in that category);
 * VAT-applies comes from the map; a reviewer's move re-files the line and teaches the map, so the same GL code routes there on the
 * next job; the map is admin.lookups's, versioned, archived never deleted, audited. Factors are invented, named as such.
 */
const ORG = "demo-nzi-console";
const OTHER = "other-org-d2";
const CLIENT = "client-d2";
const JOB = "job-d2";
const JOB_NEXT = "job-d2-next";
const ADMIN = "staff-d2-admin";
const CONSULTANT = "staff-d2-consultant";
const DS = "d2-dataset";
const SECRET = "d2-import-secret-at-least-thirty-two-bytes-long";

describe("Data entry D2: the allocation map routes spend to its proper category", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (actor = ADMIN, role: StaffRole = "admin", organisationId = ORG) => {
    keys += 1;
    return { organisationId, actorId: actor, principal: "staff" as const, idempotencyKey: `d2-${keys}`, correlationId: `corr-d2-${keys}`,
      grant: commandGrantForRole(role, organisationId, actor) };
  };
  const identity = (jobId: string): SpendImportIdentity => ({ jobId, jobNumber: "J1", clientName: "Co", jobName: "CRP", reportingYear: 2026,
    reportingFrom: "2026-01-01", reportingTo: "2026-12-31", domain: "spend", templateVersion: 1 });
  const token = (jobId: string) => encodeImportIdentity(identity(jobId), signSpendImportIdentity(identity(jobId), SECRET));
  const line = (over: Partial<SpendImportRow>): SpendImportRow => ({
    rowNumber: 1, description: "Line", netValue: 1000, vatPercent: 20, glCode: null, invoiceDate: "2026-03-01", purchasedGoodsCategoryId: "pgs-general",
    factorSource: "dataset", factorId: "d2-paper-spend", datasetId: DS, clientFactorId: null, monthly: [], ...over,
  });
  const sources = async (jobId: string) => (await db.query<{ source_id: string; source_name: string; scope: string; category_code: string | null; purchased_goods_category_id: string | null; factor_id: string | null; detail_json: any }>(
    `SELECT source_id, source_name, scope, category_code, purchased_goods_category_id, factor_id, detail_json FROM nzi_console.job_emission_sources WHERE job_id = $1 ORDER BY source_name`, [jobId])).rows;
  const issues = async (promise: Promise<unknown>) => {
    try { await promise; return []; } catch (error: any) { return (error.issues ?? [{ code: error.name }]).map((issue: any) => issue.code); }
  };

  before(async () => {
    database = (await createDisposableDatabase("dataentryd2"))!;
    db = await database.admin();
    for (const org of [ORG, OTHER]) {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
    }
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Co', 'active')`, [ORG, CLIENT]);
    for (const [user, role] of [[ADMIN, "admin"], [CONSULTANT, "consultant"]]) {
      await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ($1, $2, $3, 'active')`, [ORG, user, role]);
    }
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
       VALUES ($1, $2, 'D2 test factors', 'd2', '2026-01-01', '2026-12-31', 'GB', 'active', 'D2 test', 'Test only')`, [ORG, DS]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES
         ($1, $2, 'd2-paper-spend', 'Paper — spend (test)', 'GBP', 0.4, ARRAY['3']),
         ($1, $2, 'd2-pensions-spend', 'Financial services — spend (test)', 'GBP', 0.1, ARRAY['3']),
         ($1, $2, 'd2-fuel-spend', 'Vehicle fuel — spend (test)', 'GBP', 0.5, ARRAY['1']),
         ($1, $2, 'd2-rail-km', 'Rail — national (test)', 'km', 0.035, ARRAY['3'])`, [ORG, DS]);
    await db.query(`INSERT INTO nzi_console.purchased_goods_categories (organisation_id, category_id, client_id, name, created_by) VALUES ($1, 'pgs-general', $2, 'General', 'test')`, [ORG, CLIENT]);
    for (const [index, job] of [JOB, JOB_NEXT].entries()) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, reporting_period_start, reporting_period_end)
         VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'Data entry', 2026, '2026-01-01', '2026-12-31')`, [ORG, job, CLIENT, index + 1]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2026-01-01', '2026-12-31', 'GB')`, [ORG, job]);
      await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, $3, 'manual', 'D2 test', 'test')`, [ORG, job, DS]);
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("R1/R8: Admin maps a GL code and a description — admin.lookups, versioned, one live entry per key, audited", async () => {
    const pensions = await createSpendAllocation(database.pool, { clientId: CLIENT, keyKind: "gl", key: " 74 20 ", targetCategoryCode: "3.15", vatApplies: false,
      defaultDatasetId: DS, defaultFactorId: "d2-pensions-spend" }, context());
    await createSpendAllocation(database.pool, { clientId: CLIENT, keyKind: "description", key: "Fuel card — fleet", targetCategoryCode: "1.company-vehicles", vatApplies: true }, context());
    assert.deepEqual(await issues(createSpendAllocation(database.pool, { clientId: CLIENT, keyKind: "gl", key: "7420", targetCategoryCode: "3.6", vatApplies: true }, context())), ["DUPLICATE"],
      "' 74 20 ' and '7420' are one GL code");
    assert.deepEqual(await issues(createSpendAllocation(database.pool, { clientId: CLIENT, keyKind: "gl", key: "9999", targetCategoryCode: "3.6", vatApplies: true,
      defaultDatasetId: DS, defaultFactorId: "d2-fuel-spend" }, context())), ["FACTOR_NOT_IN_CATEGORY"], "a Scope 1 factor cannot price a Scope 3 line");
    await assert.rejects(createSpendAllocation(database.pool, { clientId: CLIENT, keyKind: "gl", key: "1234", targetCategoryCode: "3.6", vatApplies: true }, context(CONSULTANT, "consultant")),
      (error: any) => /Authori[sz]ation|Forbidden|permission/i.test(`${error.name} ${error.message}`), "the map is admin.lookups's");
    const audit = (await db.query<{ action: string }>(`SELECT action FROM nzi_console.audit_events WHERE audit_event_id = $1`, [pensions.auditEventId])).rows[0]!;
    assert.equal(audit.action, "spend_allocation.created");
    const listed = await withTenantRead(database.pool, ORG, (tx) => listClientSpendAllocations(tx, ORG, CLIENT));
    assert.deepEqual(listed.map((row) => [row.keyKind, row.matchKey, row.displayKey, row.targetCategoryCode, row.vatApplies, row.source]),
      [["description", "fuel card fleet", "Fuel card — fleet", "1.company-vehicles", true, "admin"], ["gl", "7420", "74 20", "3.15", false, "admin"]]);
  });

  it("R2/R3/R6: an import routes each line — GL code, else description, else the PG&S residual — with VAT from the map", async () => {
    const rows = [
      line({ rowNumber: 1, description: "Pension admin fees", glCode: "7420", factorId: null, datasetId: null, vatPercent: 20 }),
      line({ rowNumber: 2, description: "FUEL CARD - FLEET 03/26", glCode: null, factorId: "d2-fuel-spend", vatPercent: 20 }),
      line({ rowNumber: 3, description: "Office stationery", glCode: "5100" }),
    ];
    const preview = await previewSpendImport(database.pool, ORG, identity(JOB), rows, 1);
    assert.equal(preview.kind, "preview");
    const reviews = preview.kind === "preview" ? preview.reviews : [];
    assert.deepEqual(reviews.map((review) => [review.routing?.categoryCode, review.routing?.by, review.status]),
      [["3.15", "gl", "advisory"], ["1.company-vehicles", "description", "accepted"], ["3.1", "residual", "accepted"]]);
    assert.deepEqual(reviews[0]!.issues.map((issue) => issue.code), ["VAT_NOT_APPLICABLE"], "Investments takes no VAT — said, not silently dropped");

    const committed = await commitSpendImport(database.pool, { jobId: JOB, token: token(JOB), rows }, context(), SECRET);
    assert.equal(committed.data.created, 3);
    const filed = await sources(JOB);
    assert.deepEqual(filed.map((source) => [source.source_name, source.scope, source.category_code, source.purchased_goods_category_id, source.factor_id, source.detail_json.vatPercent]), [
      ["FUEL CARD - FLEET 03/26", "1", "1.company-vehicles", null, "d2-fuel-spend", 20],
      ["Office stationery", "3.1", "3.1", "pgs-general", "d2-paper-spend", 20],
      ["Pension admin fees", "3.15", "3.15", null, "d2-pensions-spend", null],
    ], "filed where routed; the map's default factor prices the pension line; PG&S keeps its sub-category; no VAT on Investments");

    for (const source of filed) await syncEmissionSourceToScope(database.pool, { jobId: JOB, sourceId: source.source_id }, context());
    const rowsNow = (await db.query<{ source_label: string; scope: string; category_code: string; unit: string; quality_tier: string }>(
      `SELECT source_label, scope, category_code, unit, quality_tier FROM nzi_console.job_scope_rows WHERE job_id = $1 ORDER BY source_label`, [JOB])).rows;
    assert.deepEqual(rowsNow.map((row) => [row.source_label, row.scope, row.category_code, row.unit, row.quality_tier]), [
      ["FUEL CARD - FLEET 03/26", "1", "1.company-vehicles", "GBP", "spend-based"],
      ["Office stationery", "3.1", "3.1", "GBP", "spend-based"],
      ["Pension admin fees", "3.15", "3.15", "GBP", "spend-based"],
    ], "each synced as a spend-basis row in its own category");
  });

  it("a line routed to a category its factor cannot price is held, not filed somewhere wrong", async () => {
    const preview = await previewSpendImport(database.pool, ORG, identity(JOB), [line({ description: "Fuel card - fleet", factorId: "d2-paper-spend" })], 1);
    assert.deepEqual(preview.kind === "preview" ? preview.reviews[0]!.issues.map((issue) => issue.code) : [], ["FACTOR_NOT_IN_CATEGORY"]);
  });

  it("R4: a reviewer moves a line; the row and its source are re-filed, back to pending, and the map learns its GL code", async () => {
    const stationery = (await db.query<{ scope_row_id: string; version: number }>(`SELECT scope_row_id, version FROM nzi_console.job_scope_rows WHERE job_id = $1 AND source_label = 'Office stationery'`, [JOB])).rows[0]!;
    const moved = await reallocateScopeRow(database.pool, { jobId: JOB, rowId: stationery.scope_row_id, expectedVersion: stationery.version, categoryCode: "3.2" }, context(CONSULTANT, "consultant"));
    assert.equal(moved.data.categoryCode, "3.2");
    assert.equal(moved.data.allocation?.created, true);
    const row = (await db.query<{ scope: string; category_code: string; purchased_goods_category_id: string | null; review_status: string; calculated_tco2e: string | null; source_id: string }>(
      `SELECT scope, category_code, purchased_goods_category_id, review_status, calculated_tco2e, source_id FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [stationery.scope_row_id])).rows[0]!;
    assert.deepEqual([row.scope, row.category_code, row.purchased_goods_category_id, row.review_status, row.calculated_tco2e], ["3.2", "3.2", null, "pending", null]);
    const source = (await db.query<{ scope: string; category_code: string }>(`SELECT scope, category_code FROM nzi_console.job_emission_sources WHERE source_id = $1`, [row.source_id])).rows[0]!;
    assert.deepEqual([source.scope, source.category_code], ["3.2", "3.2"], "a re-sync keeps the move");
    const learnt = await withTenantRead(database.pool, ORG, (tx) => listClientSpendAllocations(tx, ORG, CLIENT));
    assert.deepEqual(learnt.filter((entry) => entry.matchKey === "5100").map((entry) => [entry.targetCategoryCode, entry.source, entry.vatApplies]), [["3.2", "reallocation", true]]);
    const audit = (await db.query<{ action: string; before_json: any; after_json: any }>(`SELECT action, before_json, after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [moved.auditEventId])).rows[0]!;
    assert.equal(audit.action, "scope_row_reallocated");
    assert.equal(audit.before_json.categoryCode, "3.1");
    assert.equal(audit.after_json.allocation.key, "5100");
  });

  it("R4: the same GL code auto-routes to where it was moved on the next job", async () => {
    const preview = await previewSpendImport(database.pool, ORG, identity(JOB_NEXT), [line({ description: "Stationery, next year", glCode: "5100" })], 1);
    assert.deepEqual(preview.kind === "preview" ? [preview.reviews[0]!.routing?.categoryCode, preview.reviews[0]!.routing?.by] : [], ["3.2", "gl"]);
  });

  it("R4/R6: moving a mapped line re-targets its entry, and VAT follows the new category — not the old one's rule", async () => {
    const pension = (await db.query<{ scope_row_id: string; version: number }>(`SELECT scope_row_id, version FROM nzi_console.job_scope_rows WHERE job_id = $1 AND source_label = 'Pension admin fees'`, [JOB])).rows[0]!;
    const moved = await reallocateScopeRow(database.pool, { jobId: JOB, rowId: pension.scope_row_id, expectedVersion: pension.version, categoryCode: "3.1" }, context());
    assert.equal(moved.data.allocation?.created, false, "the existing 7420 entry moves; no second entry");
    const entry = (await withTenantRead(database.pool, ORG, (tx) => listClientSpendAllocations(tx, ORG, CLIENT))).find((row) => row.matchKey === "7420")!;
    assert.deepEqual([entry.targetCategoryCode, entry.vatApplies, entry.source, entry.version], ["3.1", true, "reallocation", 2]);
    assert.equal(entry.defaultFactorId, "d2-pensions-spend", "a Scope 3 default factor can still price a Scope 3 line, so it stays");
  });

  it("a move needs a factor that can price the line where it goes; activity lines are not moved by the map", async () => {
    const fuel = (await db.query<{ scope_row_id: string; version: number }>(`SELECT scope_row_id, version FROM nzi_console.job_scope_rows WHERE job_id = $1 AND source_label LIKE 'FUEL%'`, [JOB])).rows[0]!;
    assert.deepEqual(await issues(reallocateScopeRow(database.pool, { jobId: JOB, rowId: fuel.scope_row_id, expectedVersion: fuel.version, categoryCode: "3.6" }, context())), ["FACTOR_REQUIRED"]);
    const ok = await reallocateScopeRow(database.pool, { jobId: JOB, rowId: fuel.scope_row_id, expectedVersion: fuel.version, categoryCode: "3.6", datasetId: DS, factorId: "d2-paper-spend" }, context());
    assert.equal(ok.data.categoryCode, "3.6");
    const activity = await createScopeRow(database.pool, { jobId: JOB, scope: "3.6", categoryCode: "3.6", sourceLabel: "Rail", quantity: 10, unit: "km",
      datasetId: DS, factorId: "d2-rail-km", factorVersion: "d2", factorLabel: "Rail", qualityTier: "measured" }, context());
    assert.deepEqual(await issues(reallocateScopeRow(database.pool, { jobId: JOB, rowId: activity.data.rowId, expectedVersion: 1, categoryCode: "3.7" }, context())), ["NOT_SPEND"]);
  });

  it("R1: an entry is changed with its version and archived, never deleted; archived, it stops routing; reinstated, it routes again", async () => {
    const entry = (await withTenantRead(database.pool, ORG, (tx) => listClientSpendAllocations(tx, ORG, CLIENT))).find((row) => row.matchKey === "7420")!;
    const changed = await updateSpendAllocation(database.pool, { allocationId: entry.allocationId, expectedVersion: entry.version, targetCategoryCode: "3.15", vatApplies: false }, context());
    assert.equal(changed.data.version, entry.version + 1);
    await assert.rejects(updateSpendAllocation(database.pool, { allocationId: entry.allocationId, expectedVersion: entry.version, targetCategoryCode: "3.1", vatApplies: true }, context()), VersionConflictError);
    await archiveSpendAllocation(database.pool, { allocationId: entry.allocationId, expectedVersion: changed.data.version }, context());
    const preview = await previewSpendImport(database.pool, ORG, identity(JOB_NEXT), [line({ glCode: "7420" })], 1);
    assert.equal(preview.kind === "preview" ? preview.reviews[0]!.routing?.by : null, "residual", "an archived entry routes nothing");
    assert.equal((await db.query(`SELECT 1 FROM nzi_console.client_spend_allocations WHERE allocation_id = $1`, [entry.allocationId])).rowCount, 1, "kept");
    await reinstateSpendAllocation(database.pool, { allocationId: entry.allocationId, expectedVersion: changed.data.version + 1 }, context());
    const again = await previewSpendImport(database.pool, ORG, identity(JOB_NEXT), [line({ glCode: "7420" })], 1);
    assert.equal(again.kind === "preview" ? again.reviews[0]!.routing?.categoryCode : null, "3.15");
  });

  it("R8: another organisation never sees the map", async () => {
    const leaked = await withTenantRead(database.pool, OTHER, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM nzi_console.client_spend_allocations`)).rows[0]);
    assert.equal(leaked!.n, 0);
  });
});
