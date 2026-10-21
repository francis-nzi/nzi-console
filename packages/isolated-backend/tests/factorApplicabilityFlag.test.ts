import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { factorApplicabilityResolution } from "../src/factorApplicability";

/**
 * Dedup slice 5 Step D: REPORT_FACTOR_APPLICABILITY is on by default. Only an explicit "false" — the kill-switch, kept until Step E
 * removes the off path — turns it off; absent, empty, or anything else is on. One switch: the resolver, every write path and the import.
 */
describe("REPORT_FACTOR_APPLICABILITY defaults to on (dedup slice 5 Step D)", () => {
  it("is on when absent, empty or anything but \"false\"", () => {
    for (const value of [undefined, "", "true", "TRUE", " true ", "1", "on", "yes", "flase"]) {
      assert.equal(factorApplicabilityResolution(value === undefined ? {} : { REPORT_FACTOR_APPLICABILITY: value }), true, JSON.stringify(value));
    }
  });

  it("is off only for an explicit \"false\" — the kill-switch — in any case, with any spacing", () => {
    for (const value of ["false", "FALSE", " False ", "false\n"]) {
      assert.equal(factorApplicabilityResolution({ REPORT_FACTOR_APPLICABILITY: value }), false, JSON.stringify(value));
    }
  });
});
