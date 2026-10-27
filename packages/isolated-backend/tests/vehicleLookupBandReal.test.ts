import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createJob, lookupVehicleByRegistration, resolveVehicleFactor, withTenantRead, type VehicleSpec } from "../src/index";
import { listCategoryVariants } from "../src/factorCategoryVariants";
import { planV7Load, type ExtractRow } from "../src/v7ReferenceImport";
import { loadV7Plan } from "../src/v7ReferenceLoad";
import * as suggestionModule from "../../../apps/console/app/lib/vehicleSuggestion";
import * as modelModule from "../../../apps/console/app/jobs/emissionEntryModel";

const { suggestVehicleFactor } = ((suggestionModule as any).suggestVehicleFactor ? suggestionModule : (suggestionModule as any).default) as typeof import("../../../apps/console/app/lib/vehicleSuggestion");
const { vehicleLookupPatch, quickAddSaveIssue } = ((modelModule as any).vehicleLookupPatch ? modelModule : (modelModule as any).default) as typeof import("../../../apps/console/app/jobs/emissionEntryModel");

/**
 * DVLA lookup fix (27 Oct), against Postgres: the label match resolves the vehicle's **size**, not just its fuel and
 * class. Before, it took the shortest label naming the fuel and a class term, so a 1,995 cc diesel car got whichever of
 * "Small car" / "Large car" sorted first — never its own "Medium car". Now its own band, then the Average band (v7's
 * fallback, as 0160 declares it), then a label naming no band; never another band's.
 *
 * The labels come through the real v7 transform at DESNZ's wording (`column_text`), at real codes and invented values
 * (NZC-020). The lookup is asked with no category, which is the path that reaches the label match (a switched-on
 * category answers from its declared rules instead, already banded by 0160).
 */
const ORG = "net-zero-international";
const CLIENT = "client-lookup-band";
const STAFF = "staff-lookup-band";

const row = (dbId: string, code: string, category: string, text: string): ExtractRow => ({
  db_id: dbId, original_id: code, dataset_id: "8", year: "2025", factor: "0.2", currency: "", valid_from: "2025-01-01",
  valid_to: "2025-12-31", scope: "Scope 1", category, level_1: text, level_2: "NaN", level_3: "NaN",
  level_4: "NaN", column_text: text, report_label: text, uom: "miles", ghg_unit: "kgCO2e", method: "Activity", region: "UK",
  source: "DESNZ", file_name: "Synthetic extract",
});
const CARS = "Passenger vehicles - Cars (by size) - ";
const VANS = "Delivery vehicles - Vans - ";
const EXTRACT = [
  row("1", "4_301_3045_9_1", "Passenger vehicles", `${CARS}Small car - Diesel`),
  row("2", "4_301_3053_9_1", "Passenger vehicles", `${CARS}Medium car - Diesel`),
  row("3", "4_301_3061_9_1", "Passenger vehicles", `${CARS}Large car - Diesel`),
  row("4", "4_301_3069_9_1", "Passenger vehicles", `${CARS}Average car - Diesel`),
  // Petrol: no small-car row, so a small petrol car takes the Average band, never the medium.
  row("5", "4_301_3054_9_1", "Passenger vehicles", `${CARS}Medium car - Petrol`),
  row("6", "4_301_3070_9_1", "Passenger vehicles", `${CARS}Average car - Petrol`),
  row("7", "5_303_3081_9_1", "Delivery vehicles", `${VANS}Class I (up to 1.305 tonnes) - Diesel`),
  row("8", "5_303_3088_9_1", "Delivery vehicles", `${VANS}Class II (1.305 to 1.74 tonnes) - Diesel`),
  row("9", "5_303_3095_9_1", "Delivery vehicles", `${VANS}Class III (1.74 to 3.5 tonnes) - Diesel`),
  row("10", "5_303_3102_9_1", "Delivery vehicles", `${VANS}Average (up to 3.5 tonnes) - Diesel`),
];
const id = (code: string) => `uk-ghg-${code}`;

describe("the DVLA lookup's label match resolves size: type · size · fuel", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let job: string;
  const car = (fuelType: string, engineCapacity: number | null): VehicleSpec => ({
    make: "MERCEDES-BENZ", fuelType, engineCapacity, revenueWeight: null, co2Emissions: null, wheelplan: null, typeApproval: "M1", yearOfManufacture: 2021 });
  const van = (revenueWeight: number | null): VehicleSpec => ({
    make: "FORD", fuelType: "DIESEL", engineCapacity: 1995, revenueWeight, co2Emissions: null, wheelplan: null, typeApproval: "N1", yearOfManufacture: 2021 });
  const match = (vehicle: VehicleSpec) => resolveVehicleFactor(db, job, vehicle);

  before(async () => {
    database = (await createDisposableDatabase("lookupband"))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    const plan = planV7Load(EXTRACT, await listCategoryVariants(db));
    assert.deepEqual(plan.refusals, [], "the synthetic extract did not plan cleanly");
    await loadV7Plan(database.pool, plan);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`, [ORG, STAFF]);
    job = ((await createJob(database.pool, { clientId: CLIENT, family: "crp", title: "FY2025", workflowStage: "Setup", owner: "A",
      startDate: "2026-01-01", dueDate: "2026-06-30", reportingPeriodStart: "2025-01-01", reportingPeriodEnd: "2025-12-31" } as never,
      { organisationId: ORG, actorId: STAFF, principal: "staff" as const, idempotencyKey: "lookup-band-job", correlationId: "corr-lookup-band",
        grant: commandGrantForRole("admin", ORG, STAFF) })) as { data: { jobId: string } }).data.jobId;
    const selected = await db.query(`SELECT 1 FROM nzi_console.job_dataset_selections WHERE job_id=$1`, [job]);
    assert.ok(selected.rowCount! > 0, "the job selected the loaded dataset");
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("a medium diesel car resolves the medium-car diesel factor, not the shortest-named match", async () => {
    const found = await match(car("DIESEL", 1995));
    assert.equal(found?.factorId, id("4_301_3053_9_1"));
    assert.equal(found?.label, `${CARS}Medium car - Diesel`);
    assert.equal(found?.band, "medium");
  });

  it("each car band at its v7 boundary: a small (1,700 cc) and a large (2,001 cc) diesel", async () => {
    assert.equal((await match(car("DIESEL", 1700)))?.factorId, id("4_301_3045_9_1"));
    assert.equal((await match(car("DIESEL", 2001)))?.factorId, id("4_301_3061_9_1"));
  });

  it("a band the library lacks falls back to the Average band (v7's rule) — never a neighbouring band", async () => {
    const small = await match(car("PETROL", 1200));
    assert.equal(small?.factorId, id("4_301_3070_9_1"));
    assert.equal(small?.band, "average");
  });

  it("no engine size from the DVLA is the Average band", async () => {
    assert.equal((await match(car("DIESEL", null)))?.factorId, id("4_301_3069_9_1"));
  });

  it("vans by revenue weight: Class II is not Class I or III, and Class III is not Class II", async () => {
    assert.equal((await match(van(1500)))?.factorId, id("5_303_3088_9_1"));
    assert.equal((await match(van(1305)))?.factorId, id("5_303_3081_9_1"));
    assert.equal((await match(van(3100)))?.factorId, id("5_303_3095_9_1"));
    assert.equal((await match(van(null)))?.factorId, id("5_303_3102_9_1"));
  });

  it("with neither its band nor the Average band selected, it is a person's pick — not another band's factor", async () => {
    await db.query("BEGIN");
    try {
      await db.query(`UPDATE nzi_console.emission_factors SET active=false WHERE factor_id=$1`, [id("4_301_3070_9_1")]);
      assert.equal(await match(car("PETROL", 1200)), null, "a small petrol car was given the medium petrol factor");
      // A label that names no band is still a candidate, as it always was.
      await db.query(`UPDATE nzi_console.emission_factors SET label='Cars - Petrol' WHERE factor_id=$1`, [id("4_301_3054_9_1")]);
      const plain = await match(car("PETROL", 1200));
      assert.equal(plain?.factorId, id("4_301_3054_9_1"));
      assert.equal(plain?.band, null);
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("end to end: the suggestion's label becomes the entry's Activity, which the save gate accepts — no 'No factor matched'", async () => {
    const found = await lookupVehicleByRegistration("AB12CDH", { allowStub: true });
    assert.ok(found.ok && found.vehicle.typeApproval === "N1", "the stub's diesel van");
    const suggestion = await withTenantRead(database.pool, ORG, (tx) =>
      suggestVehicleFactor(tx, ORG, job, found.vehicle, found.source, null, null));
    assert.equal(suggestion.factor?.factorId, id("5_303_3095_9_1"));
    assert.equal(suggestion.factor?.resolvedBy, "label-match");
    assert.equal(suggestion.classification, "Van, Class III (1.74 to 3.5 tonnes) · Diesel");
    assert.equal(suggestion.sizeBasis, "Size read from its 3,100 kg revenue weight");

    // The CRM client's mapping of the route's answer, then "Use this".
    const factorId = `dataset:${suggestion.factor!.datasetId}|${suggestion.factor!.factorId}`;
    const options = [{ id: factorId, label: suggestion.factor!.label, unit: suggestion.factor!.unit }];
    const draft = { activity: "", quantity: "", unit: "mi", vatPercent: "", glCode: "", spendCategoryId: "", registration: "AB12 CDH",
      manualMode: false, manualDetail: "", factorId: "", qualityTier: "Measured", dataConfidence: "M — Medium", supplySource: "",
      factorOverrideReason: "", note: "", monthlyOpen: false, monthly: {} };
    const applied = { ...draft, ...vehicleLookupPatch(draft, { ok: true, make: found.vehicle.make, fuelType: found.vehicle.fuelType,
      suggestedClass: found.suggestedClass, year: found.vehicle.yearOfManufacture, factorId, factorLabel: suggestion.factor!.label,
      attributes: suggestion.attributes, classification: suggestion.classification }, options, null) };
    assert.equal(applied.activity, `${VANS}Class III (1.74 to 3.5 tonnes) - Diesel`);
    assert.equal(applied.unit, "miles");
    assert.equal(applied.manualDetail, "Ford · DIESEL");
    assert.equal(quickAddSaveIssue(applied, options, { scope: "1", name: "Company Vehicles", kind: "vehicles" } as never, "crm"), null);
  });

  it("the plate is not stored by the lookup: nothing written holds it (NZC-103, unchanged)", async () => {
    const hits = await db.query(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE after_json::text ILIKE '%AB12CDH%' OR before_json::text ILIKE '%AB12CDH%'`);
    assert.equal(hits.rows[0].n, 0);
  });
});
