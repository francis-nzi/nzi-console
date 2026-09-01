import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fuelKeyword,
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
