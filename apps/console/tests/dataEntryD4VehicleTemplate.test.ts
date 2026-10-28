// Data entry D4 (R5) in the console: the Company Vehicles template — its columns and months, its file name by the universal
// convention, and each filled row resolved by type · size · fuel and unit against the factor library's own labels, never a guess.
// The import files a vehicle's plate only as the sealed identifier — never in its name, note or detail. Carry-forward by identity
// and the vehicle-by-vehicle Lines drawer are proved in dataEntryD4VehicleCarryReal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parseVehicleTemplate, resolveVehicleTemplateRow, templateFileName, vehicleRowBlocking, vehicleTemplateCsv, vehicleTemplateHeaders } from "../app/jobs/vehicleTemplate";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");
const MONTHS = ["2025-01", "2025-02", "2025-03"];
const SMALL_DIESEL = "Passenger vehicles - Cars (by size) - Small car - Diesel";
const OPTIONS = [
  { id: "car-mi", label: SMALL_DIESEL, unit: "miles" },
  { id: "car-km", label: SMALL_DIESEL, unit: "km" },
  { id: "diesel-l", label: "Fuels - Liquid fuels - Diesel (average biofuel blend)", unit: "litres" },
  { id: "van-km", label: "Delivery vehicles - Vans - Class II (1.305 to 1.74 tonnes) - Petrol", unit: "km" },
];
const SITES = [{ id: "site-hq", name: "Head office" }];
const csv = (...lines: string[]) => [vehicleTemplateHeaders(MONTHS).join(","), ...lines].join("\n");
const parsed = (...lines: string[]) => parseVehicleTemplate(csv(...lines), MONTHS).rows;

describe("D4 R5: the vehicle template", () => {
  it("is the confirmed columns then one per reporting month, headers only — nothing invented to import by leaving it in", () => {
    assert.deepEqual(vehicleTemplateHeaders(MONTHS), ["Registration (optional)", "Vehicle name", "Type", "Size", "Fuel", "Annual mileage", "Unit", "Site", "Jan 2025", "Feb 2025", "Mar 2025"]);
    assert.equal(vehicleTemplateCsv(MONTHS).trim().split(/\r?\n/).length, 1);
  });

  it("is named by the universal convention — job no · client · job · contents · the period as days — with unsafe characters dropped", () => {
    assert.equal(templateFileName({ jobNumber: "J000663", clientName: "Harbourside Foods Ltd", jobName: "CRP FY2025", contents: "Company Vehicles", from: "2025-01-01", to: "2025-12-31" }),
      "J000663 · Harbourside Foods Ltd · CRP FY2025 · Company Vehicles · 01-01-2025–31-12-2025.csv");
    assert.equal(templateFileName({ jobNumber: "J1", clientName: "A/B: Co?", jobName: "CRP", contents: "Company Vehicles", from: null, to: null }), "J1 · AB Co · CRP · Company Vehicles · period not set.csv");
  });

  it("is read by header name, blank rows dropped; a file without the vehicle columns is refused by name", () => {
    const rows = parsed("AB12 CDE,Van 1,Car,Small car,Diesel,9000,miles,Head office,,,", ",,,,,,,,,,");
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.rowNumber, rows[0]!.registration, rows[0]!.name, rows[0]!.annual], [2, "AB12 CDE", "Van 1", 9000]);
    assert.deepEqual(parseVehicleTemplate("Registration,Mileage\nAB12CDE,10", MONTHS).missing, ["Type", "Size", "Fuel", "Unit"]);
  });
});

describe("D4 R3/R4/R5: a template row resolved — type · size · fuel, then the unit (miles by default)", () => {
  it("resolves the miles factor by default, km when asked, and litres to the fuel's factor", () => {
    const [miles, km, litres] = parsed("AB12 CDE,,Car,Small car,Diesel,9000,,,,,", ",Pool 2,car,small car,diesel,12000,km,,,,", ",Pool 3,Car,Small car,Diesel,800,litres,,,,")
      .map((row) => resolveVehicleTemplateRow(row, OPTIONS, SITES, false));
    assert.deepEqual([miles!.option?.id, km!.option?.id, litres!.option?.id], ["car-mi", "car-km", "diesel-l"]);
    assert.ok([miles, km, litres].every((row) => vehicleRowBlocking(row!).length === 0));
  });

  it("says what does not match — never a guess: no factor, a unit not published, a unit or site it does not know", () => {
    const [unknown, notInMiles, badUnit] = parsed(",Truck 9,HGV,Rigid,Diesel,100,,,,,", ",Van 2,Van,Class II (1.305 to 1.74 tonnes),Petrol,100,miles,,,,", ",Car 4,Car,Small car,Diesel,100,gallons,Depot,,,")
      .map((row) => resolveVehicleTemplateRow(row, OPTIONS, SITES, false));
    assert.equal(unknown!.option, null);
    assert.match(unknown!.issues.join(" "), /No factor for HGV · Rigid · Diesel/);
    assert.match(notInMiles!.issues.join(" "), /not published in miles/);
    assert.match(badUnit!.issues.join(" "), /Unit "gallons"/);
    assert.match(badUnit!.issues.join(" "), /Site "Depot" is not one of this job's sites/);
  });

  it("takes the months over the annual figure, and says when they disagree (not blocking)", () => {
    const [row] = parsed("AB12 CDE,,Car,Small car,Diesel,1000,miles,Head office,300,300,300").map((entry) => resolveVehicleTemplateRow(entry, OPTIONS, SITES, false));
    assert.deepEqual([row!.quantity, row!.siteId, row!.monthly.length], [900, "site-hq", 3]);
    assert.match(row!.issues.join(" "), /months add up to 900/);
    assert.equal(vehicleRowBlocking(row!).length, 0);
  });

  it("a registration alone goes to the lookup — unless the client holds no registrations, then a name and type · size · fuel are asked for", () => {
    const [plateOnly] = parsed("AB12 CDE,,,,,5000,miles,,,,");
    assert.equal(resolveVehicleTemplateRow(plateOnly!, OPTIONS, SITES, false).needsLookup, true);
    const optedOut = resolveVehicleTemplateRow(plateOnly!, OPTIONS, SITES, true);
    assert.equal(optedOut.needsLookup, false);
    assert.match(optedOut.issues.join(" "), /holds no registrations/);
    const [nameless] = parsed(",,Car,Small car,Diesel,5000,miles,,,,");
    assert.match(resolveVehicleTemplateRow(nameless!, OPTIONS, SITES, false).issues.join(" "), /Give a vehicle name/);
  });
});

describe("D4 R2/R5: the import files the plate only as the sealed identifier", () => {
  const importer = source("app/jobs/VehicleTemplateImport.tsx");
  it("names the source by the vehicle's name or type, never its plate; the detail carries none; opted out, the name is the identifier", () => {
    assert.match(importer, /sourceName: row\.name \|\| \["Company vehicle", read\?\.size, read\?\.fuel\]/);
    assert.match(importer, /assetIdentifier: optedOut \? row\.name \|\| null : row\.registration \|\| null/);
    assert.match(importer, /vehicleRegistration: null/);
    assert.match(importer, /notes: null/);
    assert.doesNotMatch(importer, /\$\{row\.registration\}/, "the plate is never interpolated into text");
  });
  it("downloads by the convention name, and the bulk panel offers it in place of the old fixed template", () => {
    assert.match(importer, /templateFileName\(\{ jobNumber: job\.jobNumber/);
    const panel = source("app/jobs/VehicleBulkPanel.tsx");
    assert.match(panel, /<VehicleTemplateImport /);
    assert.doesNotMatch(panel, /company-vehicles-template\.csv/);
  });
});
