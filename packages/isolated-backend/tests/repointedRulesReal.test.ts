import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, roleCapabilityGrants } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, createJob, createScopeRow, lookupVehicleByRegistration, withTenantRead } from "../src/index";
import type { PortalPrincipal, StaffPrincipal } from "../src/index";
import { listCategoryVariants } from "../src/factorCategoryVariants";
import { listPortalDataEntryBuckets, setPortalDataEntryBucketGrant } from "../src/portalDataEntry";
import { createPortalDataEntryRecord, decidePortalDataEntryReview, submitPortalDataEntryRecord } from "../src/portalDataEntryRecords";
import { planV7Load, type ExtractRow } from "../src/v7ReferenceImport";
import { loadV7Plan } from "../src/v7ReferenceLoad";
import * as modelModule from "../../../apps/console/app/jobs/emissionEntryModel";
import * as defaultModule from "../../../apps/console/app/portal/portalFactorDefault";
import * as suggestionModule from "../../../apps/console/app/lib/vehicleSuggestion";

const form = ((modelModule as any).emissionEntryDraftToPortalRecord ? modelModule : (modelModule as any).default) as typeof import("../../../apps/console/app/jobs/emissionEntryModel");
const { defaultPortalFactorId } = ((defaultModule as any).defaultPortalFactorId ? defaultModule : (defaultModule as any).default) as typeof import("../../../apps/console/app/portal/portalFactorDefault");
const { suggestVehicleFactor } = ((suggestionModule as any).suggestVehicleFactor ? suggestionModule : (suggestionModule as any).default) as typeof import("../../../apps/console/app/lib/vehicleSuggestion");

/**
 * The enabled rules name the real, imported factors (0130) — proved in the capture home, `net-zero-international`, on
 * data that came through the real v7 transform, on the console's write path and the portal's acceptance alike.
 *
 * The extract below is synthetic (NZC-020): v7's shape and v7's real codes, at invented values, so a number here can
 * only have come from the row the rule names. The demonstration set is retired by 0130 — proved by planting a synthetic
 * dataset before it runs.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "net-zero-international";
const CLIENT = "client-repoint";
const STAFF = "staff-repoint";
const USER = "portal-repoint";

const GRID = "uk-ghg-7_400_4000_5_1";
const TD = "uk-ghg-13_402_4000_5_1";
const DIESEL = "uk-ghg-1_101_1011_8_1";

/** A factor_lookup row as v7 writes it: DESNZ, 2025, UK. */
const extractRow = (dbId: string, code: string, factor: string, uom: string, scope: string, category: string, text: string): ExtractRow => ({
  db_id: dbId, original_id: code, dataset_id: "8", year: "2025", factor, currency: "", valid_from: "2025-01-01",
  valid_to: "2025-12-31", scope, category, level_1: text, level_2: "NaN", level_3: "NaN", level_4: "NaN",
  column_text: text, report_label: text, uom, ghg_unit: "kgCO2e", method: "Activity", region: "UK", source: "DESNZ",
  file_name: "Synthetic extract",
});
const EXTRACT = [
  extractRow("1", "7_400_4000_5_1", "0.2", "kWh", "Scope 2", "Energy", "UK electricity - Electricity generated"),
  extractRow("2", "13_402_4000_5_1", "0.02", "kWh", "Scope 3", "Fuels and Energy Related Activities", "T&D - UK electricity"),
  extractRow("3", "1_101_1011_8_1", "2.6", "litres", "Scope 1", "Fuels", "Diesel (average biofuel blend)"),
  extractRow("4", "1_101_1011_8_1-vcd", "2.6", "litres", "Scope 1", "Company Vehicles", "Company Vehicles - Diesel Car"),
];

const staff: StaffPrincipal = {
  organisationId: ORG, userId: STAFF, sessionId: "s", issuedAt: 1, expiresAt: 2,
  role: "admin", matrixVersion: 1, capabilities: roleCapabilityGrants("admin"),
} as StaffPrincipal;
const portal = {
  principal: "portal", organisationId: ORG, userId: USER, clientId: CLIENT, sessionId: "p",
  issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid",
} as unknown as PortalPrincipal;

describe("the enabled rules resolve to the real factors in net-zero-international (0130)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let job: string;
  let keys = 0;
  const context = () => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff" as const, idempotencyKey: `repoint-${keys}`,
      correlationId: `corr-repoint-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) };
  };
  const stored = async (rowId: string) => (await db.query<{ factor_id: string | null; dataset_id: string | null; version: number; provenance_json: Record<string, any> }>(
    `SELECT factor_id, dataset_id, version, provenance_json FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!;
  const tonnes = async (rowId: string) => {
    await calculateScopeRow(database.pool, { jobId: job, rowId, expectedVersion: (await stored(rowId)).version }, context());
    return Number((await db.query<{ t: string }>(`SELECT calculated_tco2e::text AS t FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!.t);
  };
  const rowsInScope = async (scope: string) => (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND scope=$2`, [job, scope])).rows[0]!.n;

  before(async () => {
    database = (await createDisposableDatabase("repoint", {
      // A synthetic dataset already in place when 0130 runs, as staging's demonstration set is.
      onMigration: async (filename, admin) => {
        if (!filename.startsWith("0128_")) return;
        await admin.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
        await admin.query(
          `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence,synthetic)
           VALUES ($1,'synthetic-before-0130','Synthetic','1','2025-01-01','2025-12-31','GB','active','Fixture','Demonstration only',true)`, [ORG]);
        await admin.query(
          `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
           VALUES ($1,'synthetic-before-0130','electricity-demo','UK electricity — demonstration factor','kWh',0.3,ARRAY['2'])`, [ORG]);
        await admin.query(`SELECT set_config('app.organisation_id', '', false)`);
      },
    }))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);

    const plan = planV7Load(EXTRACT, await listCategoryVariants(db));
    assert.deepEqual(plan.refusals, [], "the synthetic extract did not plan cleanly");
    await loadV7Plan(database.pool, plan);

    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`, [ORG, STAFF]);
    const created = await createJob(database.pool, { clientId: CLIENT, family: "crp", title: "FY2025", workflowStage: "Setup", owner: "A",
      startDate: "2026-01-01", dueDate: "2026-06-30", reportingPeriodStart: "2025-01-01", reportingPeriodEnd: "2025-12-31" } as never,
      context()) as { data: { jobId: string } };
    job = created.data.jobId;
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,status) VALUES ($1,$2,$3,'active')`, [ORG, USER, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at)
       VALUES ($1,'grant-repoint',$2,$3,$4,now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, USER, job]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── The rules ───────────────────────────────────────────────────────────────────────────────────────────

  it("names the ruled real ids, leaves fuel-litres inactive, and no active rule or companion names a -demo id", async () => {
    const rules = await db.query<{ key: string; factor_base: string; active: boolean }>(
      `SELECT category_code || '/' || rule_key AS key, factor_base, active FROM nzi_console.input_spec_factor_rules
        WHERE category_code IN ('1.company-vehicles','2.purchased-electricity','2.renewable-electricity') ORDER BY 1`);
    assert.deepEqual(rules.rows, [
      { key: "1.company-vehicles/dvla-diesel", factor_base: DIESEL, active: true },
      { key: "1.company-vehicles/fuel-litres", factor_base: "diesel-demo", active: false },
      { key: "2.purchased-electricity/grid-electricity", factor_base: GRID, active: true },
      { key: "2.renewable-electricity/grid-electricity", factor_base: GRID, active: true },
    ]);
    const companions = await db.query<{ factor_base: string }>(`SELECT factor_base FROM nzi_console.input_spec_companion_rules WHERE active ORDER BY category_code`);
    assert.deepEqual(companions.rows.map((row) => row.factor_base), [TD, TD]);
    const demo = await db.query(
      `SELECT 1 FROM nzi_console.input_spec_factor_rules WHERE active AND factor_base LIKE '%-demo%'
       UNION ALL SELECT 1 FROM nzi_console.input_spec_companion_rules WHERE active AND factor_base LIKE '%-demo%'`);
    assert.equal(demo.rows.length, 0, "an active rule still names a demonstration factor");
    const switches = await db.query<{ category_code: string }>(
      `SELECT category_code FROM nzi_console.input_spec_categories WHERE declarative_resolution_enabled OR companions_enabled ORDER BY 1`);
    assert.deepEqual(switches.rows.map((row) => row.category_code), ["1.company-vehicles", "2.purchased-electricity", "2.renewable-electricity"]);
    assert.equal((await db.query(`SELECT 1 FROM nzi_console.input_spec_categories WHERE companions_enabled`)).rows.length, 0, "a companion was switched on");
  });

  it("retires the synthetic set it found — superseded and inactive, never deleted", async () => {
    const dataset = await db.query<{ status: string }>(`SELECT status FROM nzi_console.emission_factor_datasets WHERE dataset_id='synthetic-before-0130'`);
    assert.deepEqual(dataset.rows, [{ status: "superseded" }]);
    const factor = await db.query<{ active: boolean }>(`SELECT active FROM nzi_console.emission_factors WHERE dataset_id='synthetic-before-0130'`);
    assert.deepEqual(factor.rows, [{ active: false }]);
  });

  it("selects the imported edition for a 2025 job in the capture home, and not the retired synthetic one", async () => {
    const selected = (await db.query<{ dataset_id: string }>(
      `SELECT dataset_id FROM nzi_console.job_dataset_selections WHERE job_id=$1 ORDER BY 1`, [job])).rows.map((row) => row.dataset_id);
    assert.deepEqual(selected, ["uk-ghg-gb-2025"]);
  });

  // ── The console's write path ────────────────────────────────────────────────────────────────────────────

  for (const category of ["2.purchased-electricity", "2.renewable-electricity"]) {
    it(`${category}: fills the real grid factor, prices 1000 kWh at its value — 0.2 t — and adds no T&D row`, async () => {
      const tdBefore = await rowsInScope("3.3");
      const created = await createScopeRow(database.pool, {
        jobId: job, scope: "2", sourceLabel: "Metered electricity", reportLabel: "Metered electricity", categoryCode: category,
        quantity: 1000, unit: "kWh", supplySource: "grid", datasetId: null, factorId: null, factorVersion: null, factorLabel: null,
        qualityTier: "measured",
      } as never, context());
      const row = await stored(created.data.rowId);
      assert.equal(row.factor_id, GRID);
      assert.equal(row.dataset_id, "uk-ghg-gb-2025");
      assert.equal(row.provenance_json.declarativeResolution.decision, "filled");
      assert.equal(await tonnes(created.data.rowId), 0.2);
      assert.equal(await rowsInScope("3.3"), tdBefore, "a T&D row appeared while companions are held");
    });
  }

  it("1.company-vehicles: a diesel the lookup names fills the real diesel base, and 400 litres is 1.04 t", async () => {
    const created = await createScopeRow(database.pool, {
      jobId: job, scope: "1", sourceLabel: "Fleet", reportLabel: "Fleet", categoryCode: "1.company-vehicles", quantity: 400,
      unit: "litres", datasetId: null, factorId: null, factorVersion: null, factorLabel: null, qualityTier: "measured",
      assertedVehicleAttributes: { source: "stub", fuel: "diesel", vehicleClass: "van" },
    } as never, context());
    const row = await stored(created.data.rowId);
    assert.equal(row.factor_id, DIESEL, "the base was not filled — a van must not be filed as the -vcd car variant");
    assert.equal(row.provenance_json.declarativeResolution.ruleKey, "dvla-diesel");
    assert.equal(await tonnes(created.data.rowId), 1.04);
  });

  it("still reconciles units: a declared per-litre factor is never applied to kilometres", async () => {
    const created = await createScopeRow(database.pool, {
      jobId: job, scope: "1", sourceLabel: "Fleet km", reportLabel: "Fleet km", categoryCode: "1.company-vehicles", quantity: 1000,
      unit: "km", datasetId: null, factorId: null, factorVersion: null, factorLabel: null, qualityTier: "measured",
      assertedVehicleAttributes: { source: "stub", fuel: "diesel", vehicleClass: "van" },
    } as never, context());
    assert.equal((await stored(created.data.rowId)).factor_id, null, "a per-litre factor was filled for a distance");
  });

  // ── The portal ──────────────────────────────────────────────────────────────────────────────────────────

  const scopeRow = (id: string, scope: string, category: string) => db.query(
    `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code)
     VALUES ($1,$2,$3,$4,$2,$2,'Scope x','x',$5)`, [ORG, id, job, scope, category]);
  const draft = (over: Record<string, unknown>) => ({
    activity: "Meter", quantity: "1000", unit: "", vatPercent: "", glCode: "", spendCategoryId: "", registration: "",
    manualMode: false, manualDetail: "", factorId: "", qualityTier: "Measured", dataConfidence: "M — Medium",
    supplySource: "", factorOverrideReason: "", note: "", monthlyOpen: false, monthly: {}, ...over,
  }) as any;
  const captureAndAccept = async (scopeRowId: string, over: Record<string, unknown>, pick?: string) => {
    const bucket = (await listPortalDataEntryBuckets(database.pool, portal, job)).find((entry) => entry.scopeRowId === scopeRowId)!;
    const factorId = pick ?? defaultPortalFactorId(bucket.factors, bucket.declaredFactorId);
    const mapped = form.emissionEntryDraftToPortalRecord(draft({ ...over, factorId }), bucket as never, { id: null });
    assert.ok(!("error" in mapped), `the draft did not map: ${"error" in mapped ? mapped.error : ""}`);
    const saved = await createPortalDataEntryRecord(database.pool, portal, job, mapped as never);
    const submitted = await submitPortalDataEntryRecord(database.pool, portal, job, saved.recordId, saved.version);
    await decidePortalDataEntryReview(database.pool, staff, { queueId: submitted.queueId, expectedSubmittedVersion: submitted.version, decision: "accept", note: "" });
    return bucket;
  };

  it("portal, electricity: the bucket declares the real grid factor, pre-selects it, and acceptance lands it — 0.2 t", async () => {
    await scopeRow("row-portal-elec", "2", "2.purchased-electricity");
    await setPortalDataEntryBucketGrant(database.pool, staff, { portalUserId: USER, jobId: job, scopeRowId: "row-portal-elec",
      entryKind: "manual_activity", factorIds: [GRID], siteIds: [] });
    const bucket = await captureAndAccept("row-portal-elec", { unit: "kWh" });
    assert.equal(bucket.declaredFactorId, GRID);
    const row = await stored("row-portal-elec");
    assert.equal(row.factor_id, GRID);
    assert.equal(row.provenance_json.declarativeResolution.decision, "matched");
    assert.equal(await tonnes("row-portal-elec"), 0.2);
  });

  it("portal, vehicle: a looked-up diesel is re-resolved at acceptance to the real diesel base, as the console resolves it — 2.6 t", async () => {
    await scopeRow("row-portal-van", "1", "1.company-vehicles");
    await setPortalDataEntryBucketGrant(database.pool, staff, { portalUserId: USER, jobId: job, scopeRowId: "row-portal-van",
      entryKind: "manual_activity", factorIds: [DIESEL], siteIds: [] });
    const found = await lookupVehicleByRegistration("AB12CDH", { allowStub: true });
    assert.ok(found.ok);
    const suggestion = await withTenantRead(database.pool, ORG, (reader) =>
      suggestVehicleFactor(reader, ORG, job, found.vehicle, found.source, "1.company-vehicles", "1"));
    assert.equal(suggestion.factor?.factorId, DIESEL);
    await captureAndAccept("row-portal-van", { registration: "AB12 CDH", assertedVehicleAttributes: suggestion.attributes, unit: "litres" }, DIESEL);
    const row = await stored("row-portal-van");
    assert.equal(row.factor_id, DIESEL);
    assert.equal(row.provenance_json.declarativeResolution.decision, "matched");
    assert.equal(await tonnes("row-portal-van"), 2.6);
  });
});
