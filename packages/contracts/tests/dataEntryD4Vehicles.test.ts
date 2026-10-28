import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandDefinitions, COMPANY_VEHICLES_CODE, normaliseVehicleRegistration, parseVehicleFactorLabel, preferMiles, vehicleChoices, vehicleUnitOptions,
  type CommandContext,
} from "../src/index";

const option = (id: string, label: string, unit: string) => ({ id, label, unit });
const LIBRARY = [
  option("car-s-d-mi", "Passenger vehicles - Cars (by size) - Small car - Diesel", "miles"),
  option("car-s-d-km", "Passenger vehicles - Cars (by size) - Small car - Diesel", "km"),
  option("car-s-p-mi", "Passenger vehicles - Cars (by size) - Small car - Petrol", "miles"),
  option("car-m-h-km", "Passenger vehicles - Cars (by size) - Medium car - Hybrid", "km"),
  option("van-3-d-mi", "Delivery vehicles - Vans - Class III (1.74 to 3.5 tonnes) - Diesel", "miles"),
  option("van-a-d-mi", "Delivery vehicles - Vans - Average (up to 3.5 tonnes) - Diesel", "miles"),
  option("fuel-diesel", "Fuels - Liquid fuels - Diesel (average biofuel blend)", "litres"),
  option("fuel-petrol", "Fuels - Liquid fuels - Petrol (average biofuel blend)", "litres"),
];

describe("Data entry D4 — which entry holds a plate (R1)", () => {
  it("only a company vehicle; a plate compares letters and digits, upper case", () => {
    assert.equal(COMPANY_VEHICLES_CODE, "1.company-vehicles");
    assert.equal(normaliseVehicleRegistration(" ab12 cde "), "AB12CDE");
    assert.equal(normaliseVehicleRegistration("AB-12-CDE"), "AB12CDE");
  });
});

describe("Data entry D4 — the manual fallback: type → size → fuel (R4)", () => {
  it("reads a library label into type, size and fuel, in the library's own words", () => {
    assert.deepEqual(parseVehicleFactorLabel("Passenger vehicles - Cars (by size) - Small car - Diesel"), { type: "car", size: "Small car", fuel: "Diesel" });
    assert.deepEqual(parseVehicleFactorLabel("Delivery vehicles - Vans - Class III (1.74 to 3.5 tonnes) - Diesel"), { type: "van", size: "Class III (1.74 to 3.5 tonnes)", fuel: "Diesel" });
    assert.equal(parseVehicleFactorLabel("Fuels - Liquid fuels - Diesel (average biofuel blend)"), null, "a fuel is not a vehicle");
  });
  it("offers the types, then a type's sizes, then a type and size's fuels", () => {
    assert.deepEqual(vehicleChoices(LIBRARY, {}).types, ["car", "van"]);
    assert.deepEqual(vehicleChoices(LIBRARY, { type: "car" }).sizes, ["Small car", "Medium car"]);
    assert.deepEqual(vehicleChoices(LIBRARY, { type: "car", size: "Small car" }).fuels, ["Diesel", "Petrol"]);
    assert.deepEqual(vehicleChoices(LIBRARY, { type: "van", size: "Class III (1.74 to 3.5 tonnes)" }).fuels, ["Diesel"]);
  });
});

describe("Data entry D4 — the basis: miles by default, km, litres of fuel (R3)", () => {
  it("the same vehicle in each distance unit the library publishes, and litres of its fuel; miles first", () => {
    const small = { type: "car" as const, size: "Small car", fuel: "Diesel" };
    assert.deepEqual(vehicleUnitOptions(LIBRARY, small).map((entry) => [entry.kind, entry.option.id]), [["miles", "car-s-d-mi"], ["km", "car-s-d-km"], ["litres", "fuel-diesel"]]);
    assert.deepEqual(vehicleUnitOptions(LIBRARY, { type: "car", size: "Small car", fuel: "Petrol" }).map((entry) => entry.kind), ["miles", "litres"], "no km published for it: not offered");
  });
  it("opens on the miles factor when one is published; keeps the chosen one when not", () => {
    assert.equal(preferMiles(LIBRARY, LIBRARY[1]!).id, "car-s-d-mi");
    assert.equal(preferMiles(LIBRARY, LIBRARY[3]!).id, "car-m-h-km", "the hybrid is published in km only");
    assert.equal(preferMiles(LIBRARY, LIBRARY[6]!).id, "fuel-diesel", "a fuel factor is left as chosen");
  });
});

describe("Data entry D4 — the opt-out command (R1, R8)", () => {
  const context = { organisationId: "org", actorId: "u", principal: "staff", idempotencyKey: "k", correlationId: "c" } as CommandContext;
  const definition = commandDefinitions["client.vehicle_registrations.set"];
  it("is the client editor's, audited, versioned, and takes a yes or no", () => {
    assert.equal(definition.permission, "client.edit");
    assert.equal(definition.auditAction, "client_vehicle_registrations_set");
    assert.deepEqual(definition.validate({ clientId: "c", optOut: true, expectedVersion: 3 }, context), []);
    assert.deepEqual(definition.validate({ clientId: "c", optOut: "yes" as never, expectedVersion: 0 }, context).map((issue) => issue.field), ["optOut", "expectedVersion"]);
  });
});
