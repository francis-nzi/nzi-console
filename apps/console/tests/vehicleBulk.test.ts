import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchFuel, parseVehicleLedger, vehicleTemplateCsv, VEHICLE_FUELS } from "../app/jobs/vehicleBulk";

describe("matchFuel", () => {
  it("passes a controlled fuel through unchanged", () => assert.equal(matchFuel("Diesel"), "Diesel"));
  it("maps free text to the controlled list", () => {
    assert.equal(matchFuel("battery electric"), "Battery electric");
    assert.equal(matchFuel("PHEV / plug-in"), "Plug-in hybrid");
    assert.equal(matchFuel("unleaded"), "Petrol");
    assert.equal(matchFuel("autogas"), "LPG");
  });
  it("returns null for an unrecognised fuel", () => assert.equal(matchFuel("nuclear"), null));
});

describe("parseVehicleLedger", () => {
  it("parses a tab-separated fleet list with a header row and normalises the plate", () => {
    const rows = parseVehicleLedger("Registration\tMake\tModel\tFuel\tActivity\tUnit\nab12 cde\tFord\tTransit\tdiesel\t3200\tlitres\nFG34HIJ\tNissan\tLeaf\telectric\t9800\tkWh");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { registration: "AB12CDE", make: "Ford", model: "Transit", fuel: "Diesel", activity: 3200, activityUnit: "litres" });
    assert.equal(rows[1]?.fuel, "Battery electric");
    assert.equal(rows[1]?.activityUnit, "kWh");
  });
  it("infers the unit from the activity cell when there is no unit column", () => {
    const rows = parseVehicleLedger("AB12CDE, Ford, Transit, Diesel, 4200 litres");
    assert.equal(rows[0]?.activityUnit, "litres");
    assert.equal(rows[0]?.activity, 4200);
  });
  it("drops blank lines", () => assert.equal(parseVehicleLedger("\n \n").length, 0));
  it("ships a template with the controlled headers and worked rows", () => {
    const csv = vehicleTemplateCsv();
    assert.ok(csv.includes("Registration,Make,Model,Fuel,Activity per year,Unit"));
    assert.ok(VEHICLE_FUELS.some((fuel) => csv.includes(fuel)));
  });
});
