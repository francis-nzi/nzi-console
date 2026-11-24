import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agreesToOneDecimalPlace, rankV7Candidates, v7AutoPick, v7CoreCode, v7MatchCandidate, v7ScopeAgreement, type V7MatchFactor, type V7MatchRow } from "../src";

/**
 * The import rows modal's matcher (BRIEF-v7-import-rows-modal §A, decisions 1–2): each candidate recomputed for the row, judged
 * against the previous system's figure, ranked — and a row auto-picked only on exactly one clean reproduction on its own basis.
 * J000434's business-travel row is the worked case: 12,400 miles, the previous system 2.953 t (3.0 to one decimal place).
 */
const ROW: V7MatchRow = { scope: "3", quantity: 12_400, applyPct: 100, previousTco2e: 2.953432, categories: ["3.6"] };
const factor = (over: Partial<V7MatchFactor>): V7MatchFactor => ({ rate: 0.23818, scopes: ["3"], categories: ["3.6"], sameUnit: true, ...over });
const NONE: string[] = [];

describe("one candidate, judged against the previous system's figure", () => {
  it("reproduces: quantity × rate × apportionment, to one decimal place, on the row's scope and category", () => {
    const match = v7MatchCandidate(ROW, factor({}), NONE);
    assert.deepEqual([match.tco2e, match.verdict, match.rightBasis, match.categoryCode], [2.953432, "reproduces", true, "3.6"]);
    assert.equal(v7MatchCandidate({ ...ROW, applyPct: 50, previousTco2e: 1.476716 }, factor({}), NONE).verdict, "reproduces", "the apportionment is applied");
  });
  it("figure-only — the wrong-basis guard: the right figure from a Scope 1 factor, for a Scope 3 row", () => {
    const match = v7MatchCandidate(ROW, factor({ scopes: ["1"], categories: ["1.company-vehicles"] }), NONE);
    assert.deepEqual([match.verdict, match.rightBasis, match.categoryCode], ["figure-only", false, null]);
    const otherCategory = v7MatchCandidate(ROW, factor({ categories: ["3.7"] }), NONE);
    assert.deepEqual([otherCategory.verdict, otherCategory.rightBasis], ["figure-only", false], "another Scope 3 category than the row's");
  });
  it("close (within 5%), differs, unit-mismatch and no-figure", () => {
    assert.equal(v7MatchCandidate(ROW, factor({ rate: 0.245 }), NONE).verdict, "close", "3.04 against 2.95: not to one decimal place, within 5%");
    const average = v7MatchCandidate(ROW, factor({ rate: 0.26473 }), NONE);
    assert.deepEqual([average.verdict, average.delta], ["differs", 0.329220]);
    assert.equal(v7MatchCandidate(ROW, factor({ rate: 0.148, sameUnit: false }), NONE).verdict, "unit-mismatch", "per km, for a row in miles");
    assert.equal(v7MatchCandidate({ ...ROW, quantity: null }, factor({}), NONE).verdict, "no-figure");
    assert.equal(v7MatchCandidate({ ...ROW, previousTco2e: null }, factor({}), NONE).verdict, "no-figure");
  });
  it("a row with no known category: a factor its family files once names that category; a family-less category takes its whole scope", () => {
    const unknown = { ...ROW, categories: [] };
    assert.equal(v7MatchCandidate(unknown, factor({}), NONE).categoryCode, "3.6");
    assert.equal(v7MatchCandidate(unknown, factor({ categories: ["3.6", "3.7"] }), NONE).categoryCode, null, "two categories: a person files it");
    const open = v7MatchCandidate(unknown, factor({ categories: [] }), ["3.5"]);
    assert.deepEqual([open.rightBasis, open.categoryCode], [true, "3.5"]);
    assert.equal(v7MatchCandidate(unknown, factor({ categories: [] }), NONE).rightBasis, false, "filed nowhere: not on any basis");
  });
  it("one decimal place is half a unit of it, either way", () => {
    assert.ok(agreesToOneDecimalPlace(3.049, 3.001) && agreesToOneDecimalPlace(2.953, 2.96));
    assert.ok(!agreesToOneDecimalPlace(3.0, 3.05) && !agreesToOneDecimalPlace(1052.6, 1052.7));
  });
});

describe("the suffix-insensitive ID", () => {
  const SUFFIXES = ["-c", "-b", "-p", "-u", "-d", "-vcp", "-bcp"];
  it("takes off a registered variant suffix and the trailing unit index, case and spacing folded", () => {
    assert.equal(v7CoreCode("25_301_3069_9_1", SUFFIXES), "25_301_3069_9");
    assert.equal(v7CoreCode("25_301_3069_9_2", SUFFIXES), "25_301_3069_9");
    assert.equal(v7CoreCode("99_316_3160_11_2-c", SUFFIXES), "99_316_3160_11");
    assert.equal(v7CoreCode("SPEND-SIC-49.3-5-u", SUFFIXES), "spend-sic-49.3-5");
    assert.equal(v7CoreCode("Puerto Rico", SUFFIXES), "puerto-rico", "a name is not cut");
    assert.equal(v7CoreCode("1", SUFFIXES), "1");
    assert.equal(v7CoreCode(null), null);
  });
});

describe("ranking and the auto-pick (decision 1)", () => {
  const candidate = (label: string, over: Partial<V7MatchFactor>, extra: { identity?: boolean; exactCode?: boolean; invalid?: string | null } = {}) =>
    ({ label, match: v7MatchCandidate(ROW, factor(over), NONE), ...extra });
  const RIGHT = candidate("Business travel · car · petrol · small · per mile", {});
  const WRONG = candidate("Passenger vehicles · small car · petrol · per mile", { scopes: ["1"], categories: ["1.company-vehicles"] });
  const AVERAGE = candidate("Business travel · car (average) · petrol · per mile", { rate: 0.26473 });
  const KM = candidate("Business travel · car · petrol · small · per km", { rate: 0.148, sameUnit: false });
  it("right basis first, then the verdict, then the smallest delta", () => {
    assert.deepEqual(rankV7Candidates([KM, WRONG, AVERAGE, RIGHT]).map((entry) => entry.label), [RIGHT.label, AVERAGE.label, KM.label, WRONG.label]);
  });
  it("picks exactly one clean reproduction — never a wrong-basis figure, never one of two, never one that would not save", () => {
    assert.equal(v7AutoPick([RIGHT, WRONG, AVERAGE, KM]), RIGHT);
    assert.equal(v7AutoPick([WRONG, AVERAGE, KM]), null, "the Scope 1 factor reproduces the figure, and still does not win");
    assert.equal(v7AutoPick([RIGHT, { ...RIGHT, label: "the same, another year" }]), null, "ambiguity: a person chooses");
    assert.equal(v7AutoPick([{ ...RIGHT, invalid: "not active" }]), null);
    assert.equal(v7AutoPick([{ ...RIGHT, match: { ...RIGHT.match, categoryCode: null } }]), null, "no single category to name");
  });
});

describe("the reconcile gate's agreement", () => {
  it("each scope agrees to one decimal place, or does not", () => {
    assert.deepEqual(v7ScopeAgreement({ "1": { v7Tco2e: 1052.61, liveTco2e: 1052.58 }, "2": { v7Tco2e: 15.3, liveTco2e: 15.9 }, "3": { v7Tco2e: 0, liveTco2e: 0 } })
      .map((entry) => [entry.scope, entry.agrees]), [["1", true], ["2", false], ["3", true]]);
  });
});
