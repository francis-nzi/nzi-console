// Data entry D5 (R2–R5) — Business Travel capture, pure: the controlled mode list shared with commuting, air by haul and cabin
// class read from the library's own labels, the basis per mode, and a travel detail that can hold no registration.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  airChoices, airFactorFor, commandDefinitions, commandGrantForRole, COMMUTE_MODES, GROUND_MODES, matchCabinClass, matchTravelMode, normaliseTravelDetail,
  readTravelFactorLabel, TRAVEL_MODES, travelDetailIssues, travelGroupName, travelPatternOf, travelFactorsForMode, travelModeDef, travelModeGroupOf, travelModeLabel,
  type CommandContext,
} from "../src/index";

const option = (id: string, label: string, unit: string) => ({ id, label, unit });
// DESNZ-shaped labels, as the library stores them: Level 1 - Level 2 - Level 3 - column.
const LIBRARY = [
  option("lh-bus-rf", "Business travel- air - Flights - Long-haul, to/from UK - Business class - With RF", "passenger.km"),
  option("lh-bus", "Business travel- air - Flights - Long-haul, to/from UK - Business class - Without RF", "passenger.km"),
  option("lh-eco", "Business travel- air - Flights - Long-haul, to/from UK - Economy class", "passenger.km"),
  option("lh-pe", "Business travel- air - Flights - Long-haul, to/from UK - Premium economy class", "passenger.km"),
  option("sh-avg", "Business travel- air - Flights - Short-haul, to/from UK - Average passenger", "passenger.km"),
  option("dom-avg", "Business travel- air - Flights - Domestic, to/from UK - Average passenger", "passenger.km"),
  option("rail", "Business travel- land - Rail - National rail", "passenger.km"),
  option("rail-int", "Business travel- land - Rail - International rail", "passenger.km"),
  option("tram", "Business travel- land - Rail - Light rail and tram", "passenger.km"),
  option("coach", "Business travel- land - Bus - Coach", "passenger.km"),
  option("bus", "Business travel- land - Bus - Average local bus", "passenger.km"),
  option("taxi", "Business travel- land - Taxis - Regular taxi", "km"),
  option("car-s-d", "Business travel- land - Cars (by size) - Small car - Diesel", "miles"),
  option("car-m-p", "Business travel- land - Cars (by size) - Medium car - Petrol", "miles"),
  option("ferry", "Business travel- sea - Ferry - Foot passenger", "passenger.km"),
  option("hotel-uk", "Hotel stay - United Kingdom", "Room per night"),
];

describe("D5 R2: one controlled mode list, shared with commuting", () => {
  it("leaves commuting's list exactly as it was, now read from the shared ground modes", () => {
    assert.deepEqual(COMMUTE_MODES, ["Car — petrol", "Car — diesel", "Car — hybrid", "Car — plug-in hybrid", "Car — battery electric", "Motorcycle", "Bus", "Rail", "Underground / tram", "Cycle", "Walk"]);
  });
  it("is commuting's ground modes plus the travel-only ones — air, rail abroad, coach, taxi, grey fleet, ferry and hotel", () => {
    const labels = TRAVEL_MODES.map((mode) => mode.label);
    for (const ground of GROUND_MODES) assert.ok(labels.includes(ground.label), `${ground.label} is not a travel mode`);
    for (const added of ["air", "rail-international", "coach", "taxi", "grey-fleet", "ferry", "hotel"]) assert.ok(travelModeDef(added), `${added} is missing`);
    assert.ok(!labels.includes("Cycle") && !labels.includes("Walk"), "a mode that emits nothing is not a business-travel mode");
  });
  it("says each mode's basis — distance, or nights for a hotel (R4)", () => {
    assert.equal(travelModeDef("hotel")!.basis, "nights");
    assert.ok(TRAVEL_MODES.filter((mode) => mode.value !== "hotel").every((mode) => mode.basis === "distance"));
  });
});

describe("D5 R2/R3: a factor's label read for travel, in the library's own words", () => {
  it("reads a flight into its haul, cabin class and RF basis", () => {
    assert.deepEqual(readTravelFactorLabel(LIBRARY[0]!.label), { mode: "air", haul: "long-haul", cabinClass: "business", withRf: true, car: false });
    assert.deepEqual(readTravelFactorLabel(LIBRARY[3]!.label), { mode: "air", haul: "long-haul", cabinClass: "premium-economy", withRf: null, car: false });
    assert.equal(readTravelFactorLabel(LIBRARY[5]!.label)!.haul, "domestic");
    assert.equal(readTravelFactorLabel("Business travel- air - Flights - International, to/from non-UK - First class")!.haul, "international");
  });
  it("reads the ground, sea and hotel factors into their modes", () => {
    const modes = LIBRARY.slice(6).map((entry) => readTravelFactorLabel(entry.label)?.mode);
    assert.deepEqual(modes, ["rail", "rail-international", "underground-tram", "coach", "bus", "taxi", "car-diesel", "car-petrol", "ferry", "hotel"]);
    assert.equal(readTravelFactorLabel("Natural gas"), null);
  });
  it("offers a mode its own factors; grey fleet any car's, picked by type · size · fuel", () => {
    assert.deepEqual(travelFactorsForMode(LIBRARY, "car-diesel").map((entry) => entry.id), ["car-s-d"]);
    assert.deepEqual(travelFactorsForMode(LIBRARY, "grey-fleet").map((entry) => entry.id), ["car-s-d", "car-m-p"]);
    assert.deepEqual(travelFactorsForMode(LIBRARY, "hotel").map((entry) => entry.id), ["hotel-uk"]);
  });
});

describe("D5 R3: air by haul, then cabin class", () => {
  it("offers only the hauls the library publishes, and the classes it publishes for the haul chosen", () => {
    const choices = airChoices(LIBRARY, "long-haul");
    assert.deepEqual(choices.hauls.map((entry) => entry.value), ["domestic", "short-haul", "long-haul"]);
    assert.deepEqual(choices.classes.map((entry) => entry.value), ["economy", "premium-economy", "business"]);
    assert.deepEqual(airChoices(LIBRARY, "short-haul").classes.map((entry) => entry.value), ["average"]);
  });
  it("picks the haul and class's factor — with the RF uplift where both are published — and nothing where neither is", () => {
    assert.equal(airFactorFor(LIBRARY, "long-haul", "business")?.id, "lh-bus-rf");
    assert.equal(airFactorFor([...LIBRARY].reverse(), "long-haul", "business")?.id, "lh-bus-rf", "the RF flight is chosen by what it is, not where it sits");
    assert.equal(airFactorFor(LIBRARY, "long-haul", "economy")?.id, "lh-eco");
    assert.equal(airFactorFor(LIBRARY, "long-haul", "first"), null);
  });
});

describe("D5 R2–R5: a travel detail", () => {
  const air = { travelMode: "air", airHaul: "long-haul", cabinClass: "business", origin: "LHR", destination: "JFK", carrier: null, distanceUnit: "km", passengers: 1 };
  it("is a controlled mode — free text is refused, the words a past trip was saved with included", () => {
    assert.deepEqual(travelDetailIssues(air), []);
    assert.ok(travelDetailIssues({ ...air, travelMode: "Flight — long haul" }).some((issue) => issue.field === "detail.travelMode"));
    assert.ok(travelDetailIssues({ ...air, travelMode: "a plane" }).some((issue) => issue.field === "detail.travelMode"));
  });
  it("says a flight's haul and class; nothing else has them; passengers are whole", () => {
    assert.ok(travelDetailIssues({ ...air, cabinClass: null }).some((issue) => issue.field === "detail.cabinClass"));
    assert.ok(travelDetailIssues({ ...air, airHaul: "very-long" }).some((issue) => issue.field === "detail.airHaul"));
    assert.ok(travelDetailIssues({ ...air, travelMode: "rail" }).some((issue) => issue.message.includes("Only a flight")));
    assert.ok(travelDetailIssues({ ...air, passengers: 1.5 }).some((issue) => issue.field === "detail.passengers"));
    assert.deepEqual(travelDetailIssues({ travelMode: "hotel", nights: 3, distanceUnit: "km", passengers: null }), []);
  });
  it("R5 (pinned): is stored as exactly its own fields — a registration sent with it is never kept", () => {
    const stored = normaliseTravelDetail({ ...air, travelMode: "grey-fleet", airHaul: "long-haul", vehicleRegistration: "AB12 CDE", plate: "AB12CDE" } as never);
    assert.deepEqual(Object.keys(stored).sort(), ["airHaul", "cabinClass", "carrier", "destination", "distanceUnit", "kind", "nights", "origin", "passengers", "travelMode", "tripDate"]);
    assert.equal(stored.airHaul, null, "only a flight keeps a haul");
    assert.ok(!JSON.stringify(stored).includes("AB12"), "the plate was kept");
  });
  it("is refused by the create command when its mode is free text", () => {
    const context: CommandContext = { organisationId: "org", actorId: "staff", principal: "staff", idempotencyKey: "k", correlationId: "c", grant: commandGrantForRole("admin", "org", "staff") };
    const input = { jobId: "job", groupId: null, scope: "3.6", sourceType: "travel", sourceSubtype: null, siteId: null, sourceName: "Trip", assetIdentifier: null, purchasedGoodsCategoryId: null, datasetId: "d", factorId: "f", factorSource: "dataset", clientFactorId: null, quantity: 100, unit: "passenger.km", applyPct: 100, dataSource: "Test", dataConfidence: null, monthlyActivity: [], detail: { kind: "travel", ...air, travelMode: "Plane" }, notes: null };
    assert.ok(commandDefinitions["emission.source.create"].validate(input as never, context).some((issue) => issue.field === "detail.travelMode"));
  });
});

describe("D5: modes read from words — for a file, or a trip saved before the list", () => {
  it("matches what it can tell apart, and nothing it cannot", () => {
    assert.deepEqual(matchTravelMode("Flight — long haul"), { mode: "air", haul: "long-haul" });
    assert.deepEqual(matchTravelMode("Eurostar"), { mode: "rail-international", haul: null });
    assert.equal(matchTravelMode("Grey fleet")?.mode, "grey-fleet");
    assert.equal(matchTravelMode("hire car"), null, "a car with no fuel is not guessed");
    assert.equal(matchCabinClass("Premium economy"), "premium-economy");
    assert.equal(matchCabinClass("Business"), "business");
  });
  it("labels a stored mode — a flight with its haul and class; a past trip as it was saved", () => {
    assert.equal(travelModeLabel({ travelMode: "air", airHaul: "long-haul", cabinClass: "business" }), "Air · Long haul · Business");
    assert.equal(travelModeLabel({ travelMode: "Flight — long haul" }), "Flight — long haul");
    assert.equal(travelModeGroupOf({ travelMode: "Flight — short haul" }), "air");
    assert.equal(travelModeGroupOf({ travelMode: null, factorLabel: "Hotel stay - United Kingdom" }), "hotel");
  });
});

describe("D5 R7/R8: a travel factor's pattern — what a year carries and an import groups by", () => {
  it("is the mode, and for a flight its haul and class; named as the mode reads; null for no travel mode", () => {
    assert.deepEqual(travelPatternOf(LIBRARY[0]!.label), { key: "air:long-haul:business", label: "Air · Long haul · Business", group: "air" });
    assert.equal(travelPatternOf(LIBRARY[1]!.label)!.key, travelPatternOf(LIBRARY[0]!.label)!.key, "with or without RF, one flight pattern");
    assert.deepEqual(travelPatternOf("Hotel stay - United Kingdom"), { key: "hotel", label: "Hotel", group: "hotel" });
    assert.equal(travelPatternOf("Business travel services — spend"), null);
    assert.equal(travelGroupName("Air · Long haul · Business"), "Business travel · Air · Long haul · Business");
  });
});
