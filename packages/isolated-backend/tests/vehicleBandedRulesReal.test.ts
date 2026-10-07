import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, classifyVehicle, createJob, createScopeRow, lookupVehicleByRegistration, withTenantRead } from "../src/index";
import { listCategoryVariants } from "../src/factorCategoryVariants";
import { planV7Load, type ExtractRow } from "../src/v7ReferenceImport";
import { loadV7Plan } from "../src/v7ReferenceLoad";
import * as suggestionModule from "../../../apps/console/app/lib/vehicleSuggestion";

const { suggestVehicleFactor } = ((suggestionModule as any).suggestVehicleFactor ? suggestionModule : (suggestionModule as any).default) as typeof import("../../../apps/console/app/lib/vehicleSuggestion");

/**
 * JW-11 steps 3(a) + 4 (0160, ruled 6 Oct) against a real database, in the capture home, on data that came through the
 * real v7 transform: a looked-up car or van is priced **per mile at its v7 size band**, falls back to the Average band
 * as v7 does when the band's own factor is missing, and the per-litre `dvla-diesel` default is gone from the
 * registration flow — per-litre entry is a Fuels method now.
 *
 * The extract is synthetic (NZC-020): v7's shape and real codes at invented values, so a figure can only have come from
 * the row the rule names. The medium petrol car's own factor is left out on purpose, so its fallback is exercised.
 */
const ORG = "net-zero-international";
const CLIENT = "client-banded";
const STAFF = "staff-banded";

const SMALL_PETROL = "uk-ghg-4_301_3046_9_1";
const AVERAGE_PETROL = "uk-ghg-4_301_3070_9_1";
const AVERAGE_LPG = "uk-ghg-4_301_3073_9_1";
const MEDIUM_DIESEL = "uk-ghg-4_301_3053_9_1";
const VAN_III_DIESEL = "uk-ghg-5_303_3095_9_1";

const extractRow = (dbId: string, code: string, factor: string, uom: string, text: string): ExtractRow => ({
  db_id: dbId, original_id: code, dataset_id: "8", year: "2025", factor, currency: "", valid_from: "2025-01-01",
  valid_to: "2025-12-31", scope: "Scope 1", category: "Passenger vehicles", level_1: text, level_2: "NaN", level_3: "NaN",
  level_4: "NaN", column_text: text, report_label: text, uom, ghg_unit: "kgCO2e", method: "Activity", region: "UK",
  source: "DESNZ", file_name: "Synthetic extract",
});
const EXTRACT = [
  extractRow("1", "4_301_3046_9_1", "0.25", "miles", "Small car - Petrol"),
  extractRow("2", "4_301_3070_9_1", "0.30", "miles", "Average car - Petrol"),
  extractRow("3", "4_301_3073_9_1", "0.20", "miles", "Average car - LPG"),
  extractRow("4", "4_301_3053_9_1", "0.27", "miles", "Medium car - Diesel"),
  extractRow("5", "5_303_3095_9_1", "0.40", "miles", "Van Class III - Diesel"),
  extractRow("6", "1_101_1011_8_1", "2.6", "litres", "Diesel (average biofuel blend)"),
];

describe("company vehicles are priced per mile at their v7 band (0160)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let job: string;
  let keys = 0;
  const context = () => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff" as const, idempotencyKey: `banded-${keys}`,
      correlationId: `corr-banded-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) };
  };
  const vehicle = (attributes: Record<string, unknown>, over: Record<string, unknown> = {}): any => ({
    jobId: job, scope: "1", sourceLabel: "Fleet", reportLabel: "Fleet", categoryCode: "1.company-vehicles", quantity: 1000,
    // `mi`: the unit 1.company-vehicles collects (0111); the factors are published per `miles`, which reconciles.
    unit: "mi", datasetId: null, factorId: null, factorVersion: null, factorLabel: null, qualityTier: "measured",
    assertedVehicleAttributes: { source: "stub", ...attributes }, ...over,
  });
  const banded = (vehicleClass: string, fuel: string, category: string | null) => ({
    fuel, vehicleClass, category, fallbackCategory: category ? category.replace(/\|[^|]+\|/, "|average|") : null,
  });
  const stored = async (rowId: string) => (await db.query<{ factor_id: string | null; version: number; provenance_json: Record<string, any> }>(
    `SELECT factor_id, version, provenance_json FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!;
  const tonnes = async (rowId: string) => {
    await calculateScopeRow(database.pool, { jobId: job, rowId, expectedVersion: (await stored(rowId)).version }, context());
    return Number((await db.query<{ t: string }>(`SELECT calculated_tco2e::text AS t FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!.t);
  };
  const refusedForAPerson = (error: any) => error.issues?.some((issue: any) => issue.code === "FACTOR_REQUIRED");

  before(async () => {
    database = (await createDisposableDatabase("bandedrules"))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    const plan = planV7Load(EXTRACT, await listCategoryVariants(db));
    assert.deepEqual(plan.refusals, [], "the synthetic extract did not plan cleanly");
    await loadV7Plan(database.pool, plan);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`, [ORG, STAFF]);
    job = ((await createJob(database.pool, { clientId: CLIENT, family: "crp", title: "FY2025", workflowStage: "Setup", owner: "A",
      startDate: "2026-01-01", dueDate: "2026-06-30", reportingPeriodStart: "2025-01-01", reportingPeriodEnd: "2025-12-31" } as never,
      context())) as { data: { jobId: string } }).data.jobId;
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("retires dvla-diesel and seeds 33 per-mile rules: 22 bands and 11 Average-band fallbacks", async () => {
    const rules = await db.query<{ rule_key: string; factor_base: string; basis_field_key: string; basis_value: string; active: boolean; ordering: number }>(
      `SELECT rule_key, factor_base, basis_field_key, basis_value, active, ordering FROM nzi_console.input_spec_factor_rules
        WHERE category_code = '1.company-vehicles' AND enrichment_source = 'dvla' ORDER BY ordering`);
    const active = rules.rows.filter((rule) => rule.active);
    assert.deepEqual(rules.rows.filter((rule) => !rule.active).map((rule) => rule.rule_key), ["dvla-diesel"]);
    assert.equal(active.length, 33);
    assert.equal(active.filter((rule) => rule.basis_field_key === "category").length, 22);
    assert.equal(active.filter((rule) => rule.basis_field_key === "fallback").length, 11);
    assert.ok(active.every((rule) => rule.factor_base.endsWith("_9_1")), "every active rule names a per-mile factor");
    assert.ok(Math.max(...active.filter((r) => r.basis_field_key === "category").map((r) => r.ordering))
      < Math.min(...active.filter((r) => r.basis_field_key === "fallback").map((r) => r.ordering)), "every band is tried before any fallback");
    assert.deepEqual(active.find((rule) => rule.rule_key === "dvla-car-small-petrol"),
      { rule_key: "dvla-car-small-petrol", factor_base: SMALL_PETROL, basis_field_key: "category", basis_value: "car|small|petrol", active: true, ordering: 10 });
  });

  it("a small petrol car is priced per mile at its band: 1,000 miles × 0.25 = 0.25 t", async () => {
    const created = await createScopeRow(database.pool, vehicle(banded("car", "petrol", "car|small|petrol")), context());
    const row = await stored(created.data.rowId);
    assert.equal(row.factor_id, SMALL_PETROL);
    assert.equal(row.provenance_json.declarativeResolution.ruleKey, "dvla-car-small-petrol");
    assert.equal(await tonnes(created.data.rowId), 0.25);
  });

  it("v7's fallback: a medium petrol car whose band has no factor in the dataset takes the Average car", async () => {
    const created = await createScopeRow(database.pool, vehicle(banded("car", "petrol", "car|medium|petrol")), context());
    const row = await stored(created.data.rowId);
    assert.equal(row.factor_id, AVERAGE_PETROL);
    assert.equal(row.provenance_json.declarativeResolution.ruleKey, "dvla-car-average-petrol");
    assert.equal(await tonnes(created.data.rowId), 0.3);
  });

  it("a band the library does not publish — a small LPG car — is priced as the Average LPG car", async () => {
    const created = await createScopeRow(database.pool, vehicle(banded("car", "lpg", "car|small|lpg")), context());
    assert.equal((await stored(created.data.rowId)).factor_id, AVERAGE_LPG);
  });

  it("a diesel car and a diesel van take their own bands per mile — never the per-litre diesel", async () => {
    const car = await createScopeRow(database.pool, vehicle(banded("car", "diesel", "car|medium|diesel")), context());
    assert.equal((await stored(car.data.rowId)).factor_id, MEDIUM_DIESEL);
    const van = await createScopeRow(database.pool, vehicle(banded("van", "diesel", "van|class-iii|diesel")), context());
    assert.equal((await stored(van.data.rowId)).factor_id, VAN_III_DIESEL);
    assert.equal(await tonnes(van.data.rowId), 0.4);
  });

  it("step 4: a registration entry in litres is no longer priced per litre — it is left for a person (per-litre is a Fuels method)", async () => {
    await assert.rejects(() => createScopeRow(database.pool, vehicle(banded("van", "diesel", "van|class-iii|diesel"), { quantity: 400, unit: "litres" }), context()),
      refusedForAPerson);
  });

  it("an EV, an HGV and an unbanded draft (captured before the banding) are left for a person, not guessed", async () => {
    for (const attributes of [
      banded("car", "electric", "car|small|electric"),
      { fuel: "diesel", vehicleClass: "hgv", category: null, fallbackCategory: null },
      { fuel: "diesel", vehicleClass: "van" },
    ]) {
      await assert.rejects(() => createScopeRow(database.pool, vehicle(attributes), context()), refusedForAPerson, JSON.stringify(attributes));
    }
  });

  it("the lookup's suggestion names the banded factor and says what the vehicle is", async () => {
    // Find a stub plate that is the stub's 1,390 cc petrol car (the stub is deterministic per plate).
    let plate = "";
    for (const candidate of ["AB12CDE", "AB12CDF", "AB12CDG", "AB12CDH", "BC23DEF", "CD34EFG", "DE45FGH", "EF56GHJ"]) {
      const found = await lookupVehicleByRegistration(candidate, { allowStub: true });
      if (found.ok && found.vehicle.fuelType === "PETROL") { plate = candidate; break; }
    }
    assert.ok(plate, "no stub plate resolved to the petrol car");
    const found = await lookupVehicleByRegistration(plate, { allowStub: true });
    assert.ok(found.ok);
    assert.equal(classifyVehicle(found.vehicle).category, "car|small|petrol");
    const suggestion = await withTenantRead(database.pool, ORG, (read) =>
      suggestVehicleFactor(read, ORG, job, found.vehicle, found.source, "1.company-vehicles", "1"));
    assert.equal(suggestion.factor?.factorId, SMALL_PETROL);
    assert.equal(suggestion.factor?.resolvedBy, "declared");
    assert.equal(suggestion.classification, "Small car · Petrol");
    assert.ok(!JSON.stringify(suggestion).includes(plate), "the suggestion echoed the plate");
  });
});
