// Data entry D5 (R6) in the console: the Business Travel template — headers only, named by the universal convention — and each
// filled row resolved by its mode (+ haul and class for a flight) against the factor library's own labels, never a guess. The import
// files trips by mode and factor, one roll-up row each; a grey-fleet registration goes to the lookup and nowhere else. Amalgamation,
// the pattern roll-forward and the Lines drawer by mode are proved in isolated-backend's dataEntryD5TravelCarryReal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { greyFleetFactorFor, parseTravelTemplate, resolveTravelTemplateRow, travelSourceName, travelTemplateCsv, TRAVEL_TEMPLATE_COLUMNS } from "../app/jobs/travelTemplate";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");
const OPTIONS = [
  { id: "lh-bus-rf", label: "Business travel- air - Flights - Long-haul, to/from UK - Business class - With RF", unit: "passenger.km" },
  { id: "lh-bus", label: "Business travel- air - Flights - Long-haul, to/from UK - Business class - Without RF", unit: "passenger.km" },
  { id: "sh-eco", label: "Business travel- air - Flights - Short-haul, to/from UK - Economy class - With RF", unit: "passenger.km" },
  { id: "rail", label: "Business travel- land - Rail - National rail", unit: "passenger.km" },
  { id: "bus-avg", label: "Business travel- land - Bus - Average local bus", unit: "passenger.km" },
  { id: "bus-ldn", label: "Business travel- land - Bus - Local London bus", unit: "passenger.km" },
  { id: "taxi-reg", label: "Business travel- land - Taxis - Regular taxi", unit: "km" },
  { id: "taxi-cab", label: "Business travel- land - Taxis - Black cab", unit: "km" },
  { id: "hotel-uk", label: "Hotel stay - United Kingdom", unit: "nights" },
  { id: "hotel-fr", label: "Hotel stay - France", unit: "nights" },
  { id: "car-s-d", label: "Business travel- land - Cars (by size) - Small car - Diesel", unit: "miles" },
  { id: "travel-spend", label: "Business travel services — spend", unit: "GBP" },
];
const SITES = [{ id: "site-hq", name: "Head office" }];
const csv = (...lines: string[]) => [TRAVEL_TEMPLATE_COLUMNS.join(","), ...lines].join("\n");
// Mode,From,To,Distance,Unit,Nights,Spend,Passengers,Date,Site,Haul (air),Cabin class (air),Registration (grey fleet)
const rows = (...lines: string[]) => parseTravelTemplate(csv(...lines)).rows.map((row) => resolveTravelTemplateRow(row, OPTIONS, SITES));

describe("D5 R6: the travel template", () => {
  it("is the ruled columns, then haul and cabin class for a flight and a grey-fleet registration — headers only", () => {
    assert.deepEqual(TRAVEL_TEMPLATE_COLUMNS.slice(0, 10), ["Mode", "From", "To", "Distance", "Unit", "Nights", "Spend", "Passengers", "Date", "Site"]);
    assert.deepEqual(TRAVEL_TEMPLATE_COLUMNS.slice(10), ["Haul (air)", "Cabin class (air)", "Registration (grey fleet)"]);
    assert.equal(travelTemplateCsv().trim().split(/\r?\n/).length, 1);
  });
  it("is named by the universal convention, as Business Travel", () => {
    const importer = source("app/jobs/TravelTemplateImport.tsx");
    assert.match(importer, /templateFileName\(\{ jobNumber: job\.jobNumber, clientName: job\.clientName, jobName: job\.jobName, contents: "Business Travel"/);
  });
  it("is read by header name, blank rows dropped; a file without a Mode column is refused by name", () => {
    assert.equal(parseTravelTemplate(csv("Rail,Leeds,London,300,km,,,,,,,,", ",,,,,,,,,,,,")).rows.length, 1);
    assert.deepEqual(parseTravelTemplate("Trip,Distance\nRail,300").missing, ["Mode", "Nights", "Spend"]);
  });
});

describe("D5 R3/R6: a row resolved by its mode — never a guess", () => {
  it("prices a flight by its haul and class, with the RF factor; the haul may be in the mode's own words", () => {
    const [named, inMode] = rows("Air,LHR,JFK,5540,km,,,1,2025-03-02,,Long haul,Business,", "Flight — long haul,LHR,JFK,5540,km,,,,,,,business,");
    assert.equal(named!.option?.id, "lh-bus-rf");
    assert.equal(inMode!.option?.id, "lh-bus-rf");
    assert.deepEqual([named!.quantity, named!.tripDate, named!.issues], [5540, "2025-03-02", []]);
  });
  it("says what a flight lacks, and when no factor is published for its haul and class", () => {
    const [noClass, unpublished] = rows("Air,,,500,km,,,,,,Short haul,,", "Air,,,500,km,,,,,,Short haul,First,");
    assert.match(noClass!.issues.join(" "), /cabin class/);
    assert.match(unpublished!.issues.join(" "), /No factor for Air · Short haul · First/);
  });
  it("takes a mode's one factor, or its one average; says when it has several", () => {
    const [rail, bus, taxi] = rows("Rail,Leeds,London,300,km,,,,,,,,", "Bus,,,12,km,,,,,,,,", "Taxi,,,20,km,,,,,,,,");
    assert.equal(rail!.option?.id, "rail");
    assert.equal(bus!.option?.id, "bus-avg");
    assert.equal(taxi!.option, null);
    assert.match(taxi!.issues.join(" "), /Several Taxi \/ private hire factors/);
  });
  it("converts miles to the factor's km, and counts passengers where the factor is per passenger", () => {
    const [row] = rows("Rail,,,100,miles,,,2,,,,,");
    assert.equal(row!.quantity, 321.869);
    assert.deepEqual(row!.notes, ["Converted from miles to km.", "× 2 passengers."]);
  });
  it("a hotel by its nights, by the country To names where the library publishes several", () => {
    const [france, unnamed] = rows("Hotel,,France,,,4,,,,,,,", "Hotel,,,,,2,,,,,,,");
    assert.deepEqual([france!.option?.id, france!.quantity, france!.basis], ["hotel-fr", 4, "nights"]);
    assert.match(unnamed!.issues.join(" "), /Several Hotel factors/);
  });
  it("a trip with only its cost is priced by the business-travel spend factor (R4)", () => {
    const [row] = rows("Air,,,,,,420,,,,Short haul,Economy,");
    assert.deepEqual([row!.basis, row!.option?.id, row!.quantity], ["spend", "travel-spend", 420]);
  });
  it("says what it does not know: a mode, a site, a date", () => {
    const [unknown, site, date] = rows("Hovercraft,,,10,km,,,,,,,,", "Rail,,,10,km,,,,,Depot,,,", "Rail,,,10,km,,,,31/02/2025,,,,");
    assert.match(unknown!.issues.join(" "), /Mode "Hovercraft" is not one of the travel modes/);
    assert.match(site!.issues.join(" "), /Site "Depot" is not one of this job's sites/);
    assert.match(date!.issues.join(" "), /Date "31\/02\/2025" is not a date/);
  });
});

describe("D5 R5/R6: grey fleet through the lookup, the plate kept nowhere", () => {
  it("a grey-fleet row with a registration goes to the lookup; without one it is asked for", () => {
    const [withReg, without] = rows("Grey fleet,,,240,miles,,,,,,,,AB12 CDE", "Grey fleet,,,240,miles,,,,,,,,");
    assert.equal(withReg!.needsLookup, true);
    assert.match(without!.issues.join(" "), /needs the car's registration/);
    const looked = resolveTravelTemplateRow(parseTravelTemplate(csv("Grey fleet,,,240,miles,,,,,,,,AB12 CDE")).rows[0]!, OPTIONS, SITES, OPTIONS.find((option) => option.id === "car-s-d"));
    assert.deepEqual([looked.option?.id, looked.quantity, looked.needsLookup], ["car-s-d", 240, false]);
  });
  it("maps the lookup's car to the job's business-travel car of the same size and fuel", () => {
    assert.equal(greyFleetFactorFor(OPTIONS, "Passenger vehicles - Cars (by size) - Small car - Diesel")?.id, "car-s-d");
  });
  it("names a trip by its leg or mode — never a person or a plate; the import files it with no identifier and no registration", () => {
    assert.equal(travelSourceName({ from: "LHR", to: "JFK" }, { mode: "air", haul: null, cabinClass: null }), "LHR → JFK");
    const importer = source("app/jobs/TravelTemplateImport.tsx");
    assert.match(importer, /assetIdentifier: null/);
    assert.deepEqual(importer.match(/row\.registration/g), ["row.registration"], "the registration is read once — for the lookup request");
    assert.match(importer, /JSON\.stringify\(\{ registration: row\.registration, categoryCode: "3\.6", scope: "3" \}\)/);
    assert.doesNotMatch(importer, /vehicleRegistration/);
  });
  it("R7: files trips in one roll-up group per mode and factor — found, or made — and rolls each up once", () => {
    const importer = source("app/jobs/TravelTemplateImport.tsx");
    assert.match(importer, /groups\.get\(`\$\{option\.datasetId\}\|\$\{option\.id\}`\)/);
    assert.match(importer, /name: travelGroupName\(pattern\?\.label \?\? option\.label\)/);
    assert.match(importer, /for \(const groupId of touched\) await postBrowserCommand\(`\/api\/isolated\/jobs\/\$\{jobId\}\/emission-source-groups\/\$\{groupId\}\/sync`/);
    assert.match(source("app/jobs/CrpScopeWorkspace.tsx"), /if\(category\.code==="3\.6"\)return dataEntryAdapterEnabled\("travel"\)\?\{title:`\$\{category\.name\} — import & templates`,body:<TravelTemplateImport /);
  });
});
