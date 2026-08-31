import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMUTE_MODES, commutingTemplateCsv, matchCommuteMode, parseCommutingLedger } from "../app/jobs/commutingBulk";

describe("matchCommuteMode", () => {
  it("passes a controlled mode through unchanged", () => assert.equal(matchCommuteMode("Rail"), "Rail"));
  it("maps free text to the controlled list", () => {
    assert.equal(matchCommuteMode("drives a diesel car"), "Car — diesel");
    assert.equal(matchCommuteMode("EV"), null); // no vehicle word — ambiguous
    assert.equal(matchCommuteMode("battery electric car"), "Car — battery electric");
    assert.equal(matchCommuteMode("the tube"), "Underground / tram");
    assert.equal(matchCommuteMode("bicycle"), "Cycle");
  });
  it("returns null for an unrecognised mode", () => assert.equal(matchCommuteMode("teleport"), null));
});

describe("parseCommutingLedger", () => {
  it("parses a tab-separated survey with a header row", () => {
    const rows = parseCommutingLedger("Employee\tMode\tDistance\tUnit\tWFH days\tWFH hours\nA. Example\tCar — petrol\t7500\tkm\t52\t7.5\nB. Example\ttrain\t3200\tkm\t104\t7.5");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { employee: "A. Example", mode: "Car — petrol", distance: 7500, distanceUnit: "km", wfhDaysPerYear: 52, wfhHoursPerDay: 7.5 });
    assert.equal(rows[1]?.mode, "Rail"); // free-text "train" matched to the controlled mode
  });
  it("detects miles and positional (headerless) columns", () => {
    const rows = parseCommutingLedger("C. Example, Rail, 1200 mi, mi, 0, 0");
    assert.equal(rows[0]?.distanceUnit, "mi");
    assert.equal(rows[0]?.distance, 1200);
  });
  it("drops blank lines and keeps a row with only a distance", () => {
    assert.equal(parseCommutingLedger("\n\n").length, 0);
  });
  it("ships a template with the controlled headers and worked rows", () => {
    const csv = commutingTemplateCsv();
    assert.ok(csv.includes("Employee,Commute mode,Distance per year,Distance unit,WFH days per year,WFH hours per day"));
    assert.ok(COMMUTE_MODES.some((mode) => csv.includes(mode)));
  });
});
