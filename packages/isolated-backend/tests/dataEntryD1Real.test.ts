import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, createScopeRow, listEntryBasisDefaults, readJobEntryBasis, updateEntryBasisDefault, withTenantRead } from "../src/index";
import { VersionConflictError } from "../src/errors";

/**
 * Data entry D1 against Postgres: a spend entry is no longer PG&S's alone (R2) — any category with a spend factor holds one, written
 * as a spend-based scope row and calculated as PG&S's are — the drawer's basis is remembered per client (R4), and the per-category
 * default is an Admin setting, versioned, gated and audited (R4, R6). Factors are invented, named as such; nothing here is a claim
 * about the library's data.
 */
const ORG = "demo-nzi-console";
const OTHER = "other-org-d1";
const CLIENT = "client-d1";
const JOB = "job-d1";
const ADMIN = "staff-d1-admin";
const CONSULTANT = "staff-d1-consultant";
const DS = "d1-dataset";

describe("Data entry D1: spend on any category with a spend factor, and the basis remembered", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (actor = ADMIN, role: StaffRole = "admin", organisationId = ORG) => {
    keys += 1;
    return { organisationId, actorId: actor, principal: "staff" as const, idempotencyKey: `d1-${keys}`, correlationId: `corr-d1-${keys}`,
      grant: commandGrantForRole(role, organisationId, actor) };
  };
  const row = (over: Record<string, unknown>): any => ({
    jobId: JOB, scope: "3.6", categoryCode: "3.6", sourceLabel: "Travel agency invoices", quantity: 1200, unit: "GBP",
    datasetId: DS, factorId: "d1-travel-spend", factorVersion: "d1", factorLabel: "Business travel spend · GBP", qualityTier: "spend-based", ...over,
  });
  const stored = async (rowId: string) => (await db.query<{ unit: string; quality_tier: string | null; category_code: string; version: number; quantity: string }>(
    `SELECT unit, quality_tier, category_code, version, quantity::text FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [rowId])).rows[0]!;
  const issues = async (promise: Promise<unknown>) => {
    try { await promise; return []; } catch (error: any) { return (error.issues ?? [{ code: error.code ?? error.name }]).map((issue: any) => issue.code); }
  };
  const choice = async (category: string) => (await db.query<{ basis: string; chosen_by: string }>(
    `SELECT basis, chosen_by FROM nzi_console.client_entry_basis_choices WHERE organisation_id = $1 AND client_id = $2 AND category_code = $3`,
    [ORG, CLIENT, category])).rows[0] ?? null;

  before(async () => {
    database = (await createDisposableDatabase("dataentryd1"))!;
    db = await database.admin();
    for (const org of [ORG, OTHER]) {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
    }
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Co', 'active', 'GBP')`, [ORG, CLIENT]);
    for (const [user, role] of [[ADMIN, "admin"], [CONSULTANT, "consultant"]]) {
      await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ($1, $2, $3, 'active')`, [ORG, user, role]);
    }
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, reporting_period_start, reporting_period_end)
       VALUES ($1, $2, $3, 1, 'crp', 'CRP', 'open', 'Data entry', 2026, '2026-01-01', '2026-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2026-01-01', '2026-12-31', 'GB')`, [ORG, JOB]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
       VALUES ($1, $2, 'D1 test factors', 'd1', '2026-01-01', '2026-12-31', 'GB', 'active', 'D1 test', 'Test only')`, [ORG, DS]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES
         ($1, $2, 'd1-travel-spend', 'Business travel spend (test)', 'GBP', 0.25, ARRAY['3']),
         ($1, $2, 'd1-rail-km', 'Rail — national (test)', 'km', 0.035, ARRAY['3']),
         ($1, $2, 'd1-fleet-spend', 'Vehicle fuel spend (test)', 'GBP', 0.5, ARRAY['1']),
         ($1, $2, 'd1-diesel-litres', 'Diesel (test)', 'litres', 2.5, ARRAY['1']),
         ($1, $2, 'd1-paper-spend', 'Paper and paper products (test)', 'GBP', 0.4, ARRAY['3']),
         ($1, $2, 'd1-energy-spend', 'Electricity spend (test)', 'GBP', 0.1, ARRAY['2'])`, [ORG, DS]);
    await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, $3, 'manual', 'D1 test', 'test')`, [ORG, JOB, DS]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("the ground: where the write refused money before D1 — the categories whose spec collects activity units only", async () => {
    // Most Scope 3 categories declare no units, and 3.5 / 3.6 already list GBP (NZC-146): there the form, not the write, held spend
    // to PG&S. These seven list physical units only, so the write itself refused a spend entry in them.
    const closed = (await db.query<{ category_code: string }>(
      `SELECT category_code FROM nzi_console.input_spec_fields
        WHERE field_key = 'unit' AND accepted_units IS NOT NULL AND NOT ('GBP' = ANY(accepted_units)) ORDER BY category_code`)).rows.map((r) => r.category_code);
    assert.deepEqual(closed, ["1.company-vehicles", "1.natural-gas", "1.other-stationary-fuels", "2.purchased-electricity", "2.renewable-electricity", "3.7"]);
  });

  it("R2: a spend entry records under Business Travel (3.6) as a spend-based row, and calculates as PG&S's do", async () => {
    const created = await createScopeRow(database.pool, row({ entryBasis: "spend" }), context());
    const saved = await stored(created.data.rowId);
    assert.deepEqual([saved.unit, saved.quality_tier, saved.category_code], ["GBP", "spend-based", "3.6"]);
    await calculateScopeRow(database.pool, { jobId: JOB, rowId: created.data.rowId, expectedVersion: saved.version }, context());
    const tonnes = Number((await db.query<{ t: string }>(`SELECT calculated_tco2e::text AS t FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [created.data.rowId])).rows[0]!.t);
    assert.equal(tonnes, 0.3, "£1,200 × 0.25 kg/£ = 0.3 t");
  });

  it("R2: and under Company Vehicles (Scope 1, its declared rules switched on) where a Scope 1 spend factor is selected", async () => {
    const created = await createScopeRow(database.pool, row({ scope: "1", categoryCode: "1.company-vehicles", sourceLabel: "Fuel card spend",
      quantity: 800, factorId: "d1-fleet-spend", factorLabel: "Vehicle fuel spend · GBP", entryBasis: "spend" }), context());
    const saved = await stored(created.data.rowId);
    assert.deepEqual([saved.unit, saved.category_code], ["GBP", "1.company-vehicles"]);
    const factor = (await db.query<{ factor_id: string }>(`SELECT factor_id FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [created.data.rowId])).rows[0]!.factor_id;
    assert.equal(factor, "d1-fleet-spend", "the person's spend factor stands: no declared vehicle rule prices money");
  });

  it("R2: and under Purchased Electricity (Scope 2, its declared primary switched on), with no T&D companion conjured", async () => {
    const created = await createScopeRow(database.pool, row({ scope: "2", categoryCode: "2.purchased-electricity", sourceLabel: "Energy supplier invoices",
      quantity: 5000, factorId: "d1-energy-spend", factorLabel: "Electricity spend · GBP", entryBasis: "spend" }), context());
    const saved = await stored(created.data.rowId);
    assert.deepEqual([saved.unit, saved.category_code], ["GBP", "2.purchased-electricity"]);
    const companions = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE linked_row_id = $1`, [created.data.rowId])).rows[0]!.n;
    assert.equal(companions, 0);
  });

  it("money against an activity factor is still refused — spend is a currency against a spend factor, nothing looser", async () => {
    assert.deepEqual(await issues(createScopeRow(database.pool, row({ factorId: "d1-rail-km", factorLabel: "Rail" }), context())), ["UNIT_INCOMPATIBLE"]);
    // In a category whose spec lists physical units only, money against an activity factor is not spend, so the spec refuses it.
    assert.deepEqual(await issues(createScopeRow(database.pool, row({ scope: "1", categoryCode: "1.company-vehicles", factorId: "d1-diesel-litres", factorLabel: "Diesel" }), context())), ["UNIT_NOT_ACCEPTED"]);
  });

  it("an activity entry in a spend factor's category is unchanged: its spec's units still govern it", async () => {
    assert.deepEqual(await issues(createScopeRow(database.pool, row({ unit: "tonnes", quantity: 3, factorId: "d1-rail-km", factorLabel: "Rail", qualityTier: "measured" }), context())), ["UNIT_NOT_ACCEPTED"]);
    const ok = await createScopeRow(database.pool, row({ unit: "km", quantity: 300, factorId: "d1-rail-km", factorLabel: "Rail", qualityTier: "measured", entryBasis: "activity" }), context());
    assert.equal((await stored(ok.data.rowId)).unit, "km");
  });

  it("the basis said must agree with the unit", async () => {
    assert.deepEqual(await issues(createScopeRow(database.pool, row({ entryBasis: "activity" }), context())), ["BASIS_UNIT_MISMATCH"]);
    assert.deepEqual(await issues(createScopeRow(database.pool, row({ unit: "km", factorId: "d1-rail-km", entryBasis: "spend" }), context())), ["BASIS_UNIT_MISMATCH"]);
  });

  it("the PG&S spend path is as it was: 3.1 in GBP with its sub-category; a sub-category off 3.1 is still refused", async () => {
    await db.query(`INSERT INTO nzi_console.purchased_goods_categories (organisation_id, category_id, client_id, name, created_by) VALUES ($1, 'pgs-paper', $2, 'Paper', 'test')`, [ORG, CLIENT]);
    const pgs = await createScopeRow(database.pool, row({ scope: "3.1", categoryCode: "3.1", sourceLabel: "Stationers", factorId: "d1-paper-spend", factorLabel: "Paper", purchasedGoodsCategoryId: "pgs-paper", entryBasis: "spend" }), context());
    assert.equal((await stored(pgs.data.rowId)).unit, "GBP");
    assert.deepEqual(await issues(createScopeRow(database.pool, row({ purchasedGoodsCategoryId: "pgs-paper" }), context())), ["WRONG_SCOPE"]);
  });

  it("R4: an entry the drawer made is the client's last choice for its category; one that states no basis moves nothing", async () => {
    assert.deepEqual(await choice("3.6"), { basis: "activity", chosen_by: ADMIN }, "the last 3.6 entry above was activity");
    await createScopeRow(database.pool, row({}), context(CONSULTANT, "consultant"));
    assert.equal((await choice("3.6"))!.basis, "activity", "a create without a basis (seeding, the re-ingest) is not a choice");
    await createScopeRow(database.pool, row({ entryBasis: "spend" }), context(CONSULTANT, "consultant"));
    assert.deepEqual(await choice("3.6"), { basis: "spend", chosen_by: CONSULTANT });
    const read = await withTenantRead(database.pool, ORG, (tx) => readJobEntryBasis(tx, ORG, JOB));
    assert.deepEqual(read, { defaults: {}, choices: { "3.6": "spend", "1.company-vehicles": "spend", "2.purchased-electricity": "spend", "3.1": "spend" }, currency: "GBP" });
  });

  it("R4/R6: Admin sets a category's default — versioned, audited with the seed it replaced; unchanged and stale saves refused", async () => {
    const first = await updateEntryBasisDefault(database.pool, { categoryCode: "3.6", defaultBasis: "spend", expectedVersion: null }, context());
    assert.equal(first.data.version, 1);
    const audit = (await db.query<{ action: string; before_json: unknown; after_json: unknown }>(
      `SELECT action, before_json, after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [first.auditEventId])).rows[0]!;
    assert.equal(audit.action, "entry_basis_default_updated");
    assert.deepEqual(audit.before_json, { defaultBasis: "activity", seeded: true });
    assert.deepEqual(audit.after_json, { categoryCode: "3.6", defaultBasis: "spend", version: 1 });
    assert.deepEqual(await issues(updateEntryBasisDefault(database.pool, { categoryCode: "3.6", defaultBasis: "spend", expectedVersion: 1 }, context())), ["UNCHANGED"]);
    await assert.rejects(updateEntryBasisDefault(database.pool, { categoryCode: "3.6", defaultBasis: "activity", expectedVersion: null }, context()), VersionConflictError,
      "a save that did not see version 1 is stale");
    assert.deepEqual(await issues(updateEntryBasisDefault(database.pool, { categoryCode: "3.1", defaultBasis: "spend", expectedVersion: null }, context())), ["UNCHANGED"], "PG&S is already Spend by its seed");
    const listed = await withTenantRead(database.pool, ORG, (tx) => listEntryBasisDefaults(tx, ORG));
    assert.deepEqual(listed.find((entry) => entry.categoryCode === "3.6"), { categoryCode: "3.6", name: "Business Travel", scope: "3", seed: "activity", setting: "spend", version: 1 });
    assert.deepEqual(listed.find((entry) => entry.categoryCode === "3.1"), { categoryCode: "3.1", name: "Purchased Goods and Services", scope: "3", seed: "spend", setting: null, version: null });
  });

  it("R6: the setting is admin.settings's — a consultant is refused — and another organisation never sees it", async () => {
    await assert.rejects(updateEntryBasisDefault(database.pool, { categoryCode: "3.7", defaultBasis: "spend", expectedVersion: null }, context(CONSULTANT, "consultant")),
      (error: any) => /AuthorizationError|Forbidden|permission/i.test(`${error.name} ${error.message}`));
    const theirs = await withTenantRead(database.pool, OTHER, (tx) => listEntryBasisDefaults(tx, OTHER));
    assert.equal(theirs.find((entry) => entry.categoryCode === "3.6")!.setting, null, "the other organisation reads its own seed");
    const leaked = await withTenantRead(database.pool, OTHER, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM nzi_console.organisation_entry_basis_defaults`)).rows[0]);
    assert.equal(leaked!.n, 0);
  });
});
