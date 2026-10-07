import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyVehicle,
  fuelKeyword,
  vehicleAttributes,
  lookupVehicleByRegistration,
  normaliseRegistration,
  resolveVehicleFactor,
  vehicleClassOf,
  type Queryable,
  type VehicleSpec,
} from "../src/index";

const spec = (over: Partial<VehicleSpec> = {}): VehicleSpec => ({
  make: "Ford", fuelType: "DIESEL", engineCapacity: 1995, revenueWeight: null,
  co2Emissions: 150, wheelplan: "2 AXLE RIGID BODY", typeApproval: "M1", yearOfManufacture: 2020, ...over,
});

describe("normaliseRegistration", () => {
  it("strips separators and upper-cases", () => {
    assert.equal(normaliseRegistration(" ab12 cde "), "AB12CDE");
    assert.equal(normaliseRegistration("mn64-xyz"), "MN64XYZ");
  });
});

describe("vehicleClassOf / fuelKeyword", () => {
  it("routes N1 / light weight to van, N2·N3 / heavy to hgv, else car", () => {
    assert.equal(vehicleClassOf(spec({ typeApproval: "N1" })), "van");
    assert.equal(vehicleClassOf(spec({ typeApproval: null, revenueWeight: 2400 })), "van");
    assert.equal(vehicleClassOf(spec({ typeApproval: "N3", revenueWeight: 18000 })), "hgv");
    assert.equal(vehicleClassOf(spec({ typeApproval: "M1", revenueWeight: null })), "car");
  });
  it("maps DVLA fuel strings to keywords, electric ≠ hybrid", () => {
    assert.equal(fuelKeyword("DIESEL"), "diesel");
    assert.equal(fuelKeyword("ELECTRICITY"), "electric");
    assert.equal(fuelKeyword("HYBRID ELECTRIC"), "hybrid");
    assert.equal(fuelKeyword("GAS/PETROL"), "petrol");
    assert.equal(fuelKeyword(null), null);
    assert.equal(fuelKeyword("NUCLEAR"), null);
  });
});

/**
 * JW-11 (ruled 6 Oct): v7's classification and banding (`services/vehicle_categorization.py`), at every boundary, so
 * the rules seeded against these categories mean what v7 meant. Each upper bound is inclusive, as v7's `_band` is.
 */
describe("JW-11: v7's class, at the approval and weight edges", () => {
  it("decides by type approval first — an M1 is a car even with a plated weight", () => {
    assert.equal(vehicleClassOf(spec({ typeApproval: "M1", revenueWeight: 2400 })), "car");
    assert.equal(vehicleClassOf(spec({ typeApproval: "N1", revenueWeight: 3100 })), "van");
    assert.equal(vehicleClassOf(spec({ typeApproval: "N2", revenueWeight: 7000 })), "hgv");
  });
  it("without an approval, the plated weight decides: 3,500 kg is still a van, 3,501 an HGV", () => {
    assert.equal(vehicleClassOf(spec({ typeApproval: null, revenueWeight: 3500 })), "van");
    assert.equal(vehicleClassOf(spec({ typeApproval: null, revenueWeight: 3501 })), "hgv");
  });
  it("a motorbike only without a weight and at 2,500 cc or less; past that, unclassified rather than guessed", () => {
    assert.equal(vehicleClassOf(spec({ typeApproval: null, revenueWeight: null, engineCapacity: 2500 })), "motorbike");
    assert.equal(vehicleClassOf(spec({ typeApproval: "L3", revenueWeight: null, engineCapacity: 650 })), "motorbike");
    assert.equal(vehicleClassOf(spec({ typeApproval: null, revenueWeight: null, engineCapacity: 2501 })), null);
    assert.equal(vehicleClassOf(spec({ typeApproval: null, revenueWeight: null, engineCapacity: null })), null);
  });
  it("reads v7's gas fuels: gas bi-fuel and gas/petrol are petrol, plain gas is CNG", () => {
    assert.equal(fuelKeyword("GAS BI-FUEL"), "petrol");
    assert.equal(fuelKeyword("GAS/PETROL"), "petrol");
    assert.equal(fuelKeyword("GAS"), "cng");
    assert.equal(fuelKeyword("LIQUID PETROLEUM GAS"), "lpg");
  });
});

describe("JW-11: classifyVehicle — cars by engine size, vans by weight, at v7's boundaries", () => {
  const car = (fuelType: string | null, engineCapacity: number | null) => classifyVehicle(spec({ typeApproval: "M1", fuelType, engineCapacity }));
  const van = (fuelType: string | null, revenueWeight: number | null) => classifyVehicle(spec({ typeApproval: "N1", fuelType, revenueWeight }));

  it("a petrol (or any non-diesel) car: small to 1,400 cc, medium to 2,000, large above", () => {
    assert.equal(car("PETROL", 1400).category, "car|small|petrol");
    assert.equal(car("PETROL", 1401).category, "car|medium|petrol");
    assert.equal(car("PETROL", 2000).category, "car|medium|petrol");
    assert.equal(car("PETROL", 2001).category, "car|large|petrol");
    assert.equal(car("HYBRID ELECTRIC", 1400).category, "car|small|hybrid");
    assert.equal(car("HYBRID ELECTRIC", 1598).category, "car|medium|hybrid");
  });
  it("a diesel car: small to 1,700 cc (diesel runs larger for the class), medium to 2,000, large above", () => {
    assert.equal(car("DIESEL", 1700).category, "car|small|diesel");
    assert.equal(car("DIESEL", 1701).category, "car|medium|diesel");
    assert.equal(car("DIESEL", 2000).category, "car|medium|diesel");
    assert.equal(car("DIESEL", 2001).category, "car|large|diesel");
    assert.equal(car("PETROL", 1500).category, "car|medium|petrol", "the same 1,500 cc is medium as petrol and small as diesel");
    assert.equal(car("DIESEL", 1500).category, "car|small|diesel");
  });
  it("a van: Class I to 1,305 kg, Class II to 1,740, Class III to 3,500", () => {
    assert.equal(van("DIESEL", 1305).category, "van|class-i|diesel");
    assert.equal(van("DIESEL", 1306).category, "van|class-ii|diesel");
    assert.equal(van("DIESEL", 1740).category, "van|class-ii|diesel");
    assert.equal(van("DIESEL", 1741).category, "van|class-iii|diesel");
    assert.equal(van("PETROL", 3500).category, "van|class-iii|petrol");
  });
  it("no measurement is v7's Average band; an unknown fuel is v7's Unknown", () => {
    assert.equal(car("PETROL", null).category, "car|average|petrol");
    assert.equal(van("DIESEL", null).category, "van|average|diesel");
    assert.equal(car(null, 1200).category, "car|small|unknown");
    assert.equal(car("STEAM", 1200).category, "car|small|unknown");
  });
  it("always offers v7's Average-band fallback for the same class and fuel, and says what the vehicle is", () => {
    assert.deepEqual(car("PETROL", 1390), { category: "car|small|petrol", fallbackCategory: "car|average|petrol", label: "Small car · Petrol" });
    assert.deepEqual(van("DIESEL", 1500), { category: "van|class-ii|diesel", fallbackCategory: "van|average|diesel", label: "Van, Class II (1.305 to 1.74 tonnes) · Diesel" });
    assert.equal(car("PETROL", null).label, "Average car · Petrol");
    assert.equal(van("LPG", null).label, "Van, Average (up to 3.5 tonnes) · LPG");
  });
  it("bands only cars and vans: an HGV, a motorbike or an unclassified vehicle has no category", () => {
    const none = { category: null, fallbackCategory: null, label: null };
    assert.deepEqual(classifyVehicle(spec({ typeApproval: "N3", revenueWeight: 18000 })), none);
    assert.deepEqual(classifyVehicle(spec({ typeApproval: null, revenueWeight: null, engineCapacity: 125 })), none);
    assert.deepEqual(classifyVehicle(spec({ typeApproval: null, revenueWeight: null, engineCapacity: null })), none);
  });
  it("carries the category in the resolver's attributes — and never the plate", async () => {
    const found = await lookupVehicleByRegistration("AB12 CDE", { allowStub: true });
    assert.ok(found.ok);
    const attributes = vehicleAttributes(found.vehicle);
    assert.equal(attributes.category, classifyVehicle(found.vehicle).category);
    assert.equal(attributes.fallback, classifyVehicle(found.vehicle).fallbackCategory);
    assert.ok(!JSON.stringify({ attributes, banded: classifyVehicle(found.vehicle) }).includes("AB12CDE"));
  });
  it("classifies each staging stub vehicle as v7 would", () => {
    // The stub's four vehicles (vehicleLookup.ts): a 3,100 kg diesel N1 van, a 1,390 cc petrol car, an electric car and
    // a 1,598 cc hybrid car.
    assert.equal(van("DIESEL", 3100).category, "van|class-iii|diesel");
    assert.equal(car("PETROL", 1390).category, "car|small|petrol");
    assert.equal(car("ELECTRICITY", null).category, "car|average|electric");
    assert.equal(car("HYBRID ELECTRIC", 1598).category, "car|medium|hybrid");
  });
});

describe("lookupVehicleByRegistration", () => {
  it("rejects an implausible plate before any network call", async () => {
    let called = false;
    const result = await lookupVehicleByRegistration("X", { apiKey: "k", fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.status, 400);
    assert.equal(called, false);
  });

  it("returns a deterministic stub on staging when no key is configured — same plate, same vehicle", async () => {
    const a = await lookupVehicleByRegistration("AB12 CDE", { allowStub: true });
    const b = await lookupVehicleByRegistration("ab12cde", { allowStub: true });
    assert.equal(a.ok, true);
    assert.equal(a.ok && a.source, "stub");
    assert.deepEqual(a.ok && a.vehicle, b.ok && b.vehicle);
    assert.ok(a.ok && a.suggestedClass);
  });

  it("is 503 when there is no key and no stub allowance (prod-like, misconfigured)", async () => {
    const result = await lookupVehicleByRegistration("AB12 CDE", {});
    assert.equal(result.ok === false && result.status, 503);
  });

  it("calls DVLA VES with the api key and parses the spec — never echoing the registration back", async () => {
    let sentBody = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return new Response(JSON.stringify({ make: "VOLKSWAGEN", fuelType: "PETROL", engineCapacity: 1390, revenueWeight: null, co2Emissions: 121, wheelplan: "2 AXLE RIGID BODY", typeApproval: "M1", yearOfManufacture: 2019 }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await lookupVehicleByRegistration("MN64 XYZ", { apiKey: "secret", fetchImpl });
    assert.ok(sentBody.includes("MN64XYZ"));
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.source, "dvla");
    assert.equal(result.ok && result.vehicle.make, "VOLKSWAGEN");
    assert.equal(result.ok && result.vehicle.engineCapacity, 1390);
    assert.ok(!JSON.stringify(result).includes("MN64XYZ"), "the response never carries the registration");
  });

  it("maps DVLA 404 / 429 through", async () => {
    const at = (status: number) => lookupVehicleByRegistration("AB12CDE", { apiKey: "k", fetchImpl: (async () => new Response("{}", { status })) as typeof fetch });
    assert.equal((await at(404)).ok === false && (await at(404)).ok === false, true);
    assert.equal(((await at(404)) as { status: number }).status, 404);
    assert.equal(((await at(429)) as { status: number }).status, 429);
    assert.equal(((await at(500)) as { status: number }).status, 503);
  });

  it("degrades to 503 on a network error, never throws", async () => {
    const result = await lookupVehicleByRegistration("AB12CDE", { apiKey: "k", fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as typeof fetch });
    assert.equal(result.ok === false && result.status, 503);
  });
});

describe("resolveVehicleFactor", () => {
  const db = (rows: unknown[]): Queryable => ({ query: async () => ({ rows: rows as never[] }) });

  it("matches a Scope 1 dataset factor by fuel + vehicle class", async () => {
    const factor = await resolveVehicleFactor(
      db([{ factor_id: "f-diesel-van", dataset_id: "d-2024", label: "Vans — Class III diesel", activity_unit: "litres" }]),
      "job-a",
      spec({ typeApproval: "N1", fuelType: "DIESEL" }),
    );
    assert.equal(factor?.factorId, "f-diesel-van");
    assert.equal(factor?.scope, "1");
    assert.equal(factor?.vehicleClass, "van");
  });

  it("returns null when the fuel is unknown (manual fallback)", async () => {
    assert.equal(await resolveVehicleFactor(db([]), "job-a", spec({ fuelType: "NUCLEAR" })), null);
  });

  it("returns null when no factor row matches", async () => {
    assert.equal(await resolveVehicleFactor(db([]), "job-a", spec({ fuelType: "DIESEL" })), null);
  });
});
