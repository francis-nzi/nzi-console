// D5-air (R4, ruled 28 Oct 2026) — D5's air resolution pinned on the library's REAL labels: the 14 business-travel flight labels the
// v7 reference load holds (one per haul × class, no RF suffix — the with-RF value under DESNZ's with-RF id), each read for its haul and
// class, and each haul × class resolving to exactly one factor in a dataset. Labels, ids and 2025 values as in v7's factor_lookup and
// DESNZ's 2025 flat file; the WTT flights beside them in the same dataset must never be taken for the flight.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AIR_HAULS, airChoices, airFactorFor, CABIN_CLASSES, readTravelFactorLabel, type AirHaul, type CabinClass } from "../src/index";

const FLIGHTS: ReadonlyArray<[id: string, haul: string, cls: string, value: string]> = [
  ["3160", "Domestic, to/from UK", "Average passenger", "0.22928"],
  ["3162", "Short-haul, to/from UK", "Average passenger", "0.12786"], ["3164", "Short-haul, to/from UK", "Economy class", "0.12576"],
  ["3166", "Short-haul, to/from UK", "Business class", "0.18863"],
  ["3168", "Long-haul, to/from UK", "Average passenger", "0.15282"], ["3170", "Long-haul, to/from UK", "Economy class", "0.11704"],
  ["3172", "Long-haul, to/from UK", "Premium economy class", "0.18726"], ["3174", "Long-haul, to/from UK", "Business class", "0.3394"],
  ["3176", "Long-haul, to/from UK", "First class", "0.46814"],
  ["3178", "International, to/from non-UK", "Average passenger", "0.14253"], ["3180", "International, to/from non-UK", "Economy class", "0.10916"],
  ["3182", "International, to/from non-UK", "Premium economy class", "0.17465"], ["3184", "International, to/from non-UK", "Business class", "0.31656"],
  ["3186", "International, to/from non-UK", "First class", "0.43663"],
];
const OPTIONS = [
  ...FLIGHTS.map(([id, haul, cls]) => ({ id: `uk-ghg-21_316_${id}_11_1`, label: `Business travel- air - Flights - ${haul} - ${cls}`, unit: "passenger.km" })),
  // The same dataset's well-to-tank flights: a different factor (upstream fuel), never the flight itself.
  ...FLIGHTS.map(([id, haul, cls]) => ({ id: `uk-ghg-22_912_${id}_11_1`, label: `WTT- business travel- air - WTT- flights - ${haul} - ${cls}`, unit: "passenger.km" })),
];
const HAUL: Record<string, AirHaul> = { "Domestic, to/from UK": "domestic", "Short-haul, to/from UK": "short-haul", "Long-haul, to/from UK": "long-haul", "International, to/from non-UK": "international" };
const CLASS: Record<string, CabinClass> = { "Average passenger": "average", "Economy class": "economy", "Premium economy class": "premium-economy", "Business class": "business", "First class": "first" };

describe("D5-air: air resolution on the library's real labels", () => {
  it("reads each real flight label for its haul and class — no RF suffix in the library, so withRf is null, not false", () => {
    for (const [, haul, cls] of FLIGHTS) {
      const read = readTravelFactorLabel(`Business travel- air - Flights - ${haul} - ${cls}`);
      assert.deepEqual([read?.mode, read?.haul, read?.cabinClass, read?.withRf], ["air", HAUL[haul], CLASS[cls], null], `${haul} · ${cls}`);
    }
  });
  it("resolves every haul × class to exactly one factor — the flight, never its WTT, in whatever order the library lists them", () => {
    for (const options of [OPTIONS, [...OPTIONS].reverse()]) {
      for (const [id, haul, cls] of FLIGHTS) {
        const matches = options.filter((option) => { const read = readTravelFactorLabel(option.label); return read?.mode === "air" && read.haul === HAUL[haul] && read.cabinClass === CLASS[cls]; });
        assert.deepEqual(matches.map((option) => option.id), [`uk-ghg-21_316_${id}_11_1`], `${haul} · ${cls}: exactly one factor`);
        assert.equal(airFactorFor(options, HAUL[haul]!, CLASS[cls]!)?.id, `uk-ghg-21_316_${id}_11_1`, `${haul} · ${cls}`);
      }
    }
  });
  it("reads a well-to-tank factor as no travel mode — air, rail or any other", () => {
    for (const label of ["WTT- business travel- air - WTT- flights - Long-haul, to/from UK - Business class", "WTT- business travel- land - WTT- rail - National rail"]) {
      assert.equal(readTravelFactorLabel(label), null, label);
    }
  });
  it("offers exactly the hauls and classes the library publishes", () => {
    assert.deepEqual(airChoices(OPTIONS, null).hauls.map((entry) => entry.value), AIR_HAULS.map((entry) => entry.value));
    assert.deepEqual(airChoices(OPTIONS, "domestic").classes.map((entry) => entry.value), ["average"]);
    assert.deepEqual(airChoices(OPTIONS, "short-haul").classes.map((entry) => entry.value), ["average", "economy", "business"]);
    assert.deepEqual(airChoices(OPTIONS, "long-haul").classes.map((entry) => entry.value), CABIN_CLASSES.map((entry) => entry.value));
  });
});
