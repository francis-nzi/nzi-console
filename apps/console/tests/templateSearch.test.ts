import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fuzzyScore } from "../app/jobs/templateSearch";

// The whole-library template index and its search went with "Add rows from template" (Phase 3b, JW-6 retired); the fuzzy
// match stays for the LCA inventory's quick-add, so its tests stay.
describe("fuzzyScore (NZC-062)", () => {
  it("ranks an exact substring hit above a subsequence match, and earlier over later", () => {
    const exact = fuzzyScore("diesel", "Diesel — LGV")!;
    const later = fuzzyScore("lgv", "Diesel — LGV")!;
    const subsequence = fuzzyScore("dsl", "Diesel — LGV")!;
    assert.ok(exact > later);
    assert.ok(later > 0 && subsequence > 0);
  });

  it("matches out-of-order-free but in-sequence characters (forgiving)", () => {
    assert.ok(fuzzyScore("dlgv", "Diesel — LGV") !== null);
    assert.equal(fuzzyScore("xyz", "Diesel — LGV"), null);
  });

  it("an empty query matches everything with a neutral score", () => {
    assert.equal(fuzzyScore("", "anything"), 0);
  });

  it("is case-insensitive", () => {
    assert.equal(fuzzyScore("DIESEL", "diesel fuel"), fuzzyScore("diesel", "diesel fuel"));
  });
});
