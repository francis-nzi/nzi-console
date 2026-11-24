import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agreesToOneDecimalPlace, rankV7Candidates, v7AutoPick, v7CategoryCode, v7CodeKeys, v7FactorKeys, v7MatchCandidate, v7ScopeAgreement, type V7MatchFactor, type V7MatchRow,
} from "../src";

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

describe("the suffix-insensitive ID, stripped in order (autopick fix §3)", () => {
  const SUFFIXES = ["-c", "-b", "-p", "-u", "-d", "-vcp", "-bcp"];
  it("a registered variant suffix first; the trailing unit index only for a code with none, as the fallback — never both", () => {
    assert.deepEqual(v7CodeKeys("25_301_3069_9_1", SUFFIXES), { core: "25_301_3069_9_1", fallback: "25_301_3069_9" });
    assert.deepEqual(v7CodeKeys("99_316_3160_11_2-c", SUFFIXES), { core: "99_316_3160_11_2", fallback: null }, "Walking stays Walking");
    assert.deepEqual(v7CodeKeys("SPEND-SIC-49.3-5-u", SUFFIXES), { core: "spend-sic-49.3-5", fallback: null });
    assert.deepEqual(v7CodeKeys("Puerto Rico", SUFFIXES), { core: "puerto-rico", fallback: null }, "a name is not cut");
    assert.deepEqual(v7CodeKeys("1", SUFFIXES), { core: "1", fallback: null });
    assert.deepEqual(v7CodeKeys(null), { core: null, fallback: null });
  });
  it("_11_2-c is _11_2, never Cycling's _11_3: their cores differ, and only the unitless fallback (not offered to a suffixed row) would join them", () => {
    const walkingRow = v7CodeKeys("99_316_3160_11_2-c", SUFFIXES);
    const walking = v7FactorKeys("99_316_3160_11_2", SUFFIXES), cycling = v7FactorKeys("99_316_3160_11_3", SUFFIXES);
    assert.equal(walking.core, walkingRow.core);
    assert.notEqual(cycling.core, walkingRow.core);
    assert.equal(cycling.unitless, walking.unitless, "the unitless keys would collide — so a suffixed row never falls back to them");
    assert.equal(walkingRow.fallback, null);
  });
});

describe("the previous system's category names a console one (autopick fix §5)", () => {
  it("by the taxonomy's name, or the previous system's own name, of the row's scope — else nothing", () => {
    assert.equal(v7CategoryCode("Business Travel", "3"), "3.6");
    assert.equal(v7CategoryCode(" employee  commuting ", "3"), "3.7");
    assert.equal(v7CategoryCode("Fuels", "1"), "1.other-stationary-fuels");
    assert.equal(v7CategoryCode("Fuels", "3"), null, "another scope's category does not cross");
    assert.equal(v7CategoryCode("Something else", "1"), null);
    assert.equal(v7CategoryCode(null, "1"), null);
  });
  it("breaks a two-category tie; a name outside the two leaves it a person's choice", () => {
    const gasOil: V7MatchRow = { scope: "1", quantity: 1000, applyPct: 100, previousTco2e: 2.7, categories: ["1.company-vehicles", "1.other-stationary-fuels"] };
    const twoWay = factor({ rate: 2.7, scopes: ["1"], categories: ["1.company-vehicles", "1.other-stationary-fuels"] });
    assert.equal(v7MatchCandidate(gasOil, twoWay, NONE).categoryCode, null);
    assert.equal(v7MatchCandidate({ ...gasOil, v7Category: "1.other-stationary-fuels" }, twoWay, NONE).categoryCode, "1.other-stationary-fuels");
    assert.equal(v7MatchCandidate({ ...gasOil, v7Category: "1.natural-gas" }, twoWay, NONE).categoryCode, null);
    const travel: V7MatchRow = { ...ROW, categories: [] };
    assert.equal(v7MatchCandidate({ ...travel, v7Category: "3.7" }, factor({ categories: ["3.6", "3.7"] }), NONE).categoryCode, "3.7", "no levels known: V7's category files it");
  });
});

describe("a zero rate never wins on its own (autopick fix §4)", () => {
  const WALK: V7MatchRow = { scope: "3", quantity: 1_200, applyPct: 100, previousTco2e: 0, categories: ["3.7"] };
  it("a zero-rate factor that is not the anchor gives the figure only; the anchor reproduces", () => {
    assert.equal(v7MatchCandidate(WALK, factor({ rate: 0, categories: ["3.7"] }), NONE).verdict, "figure-only");
    assert.equal(v7MatchCandidate(WALK, factor({ rate: 0, categories: ["3.7"], anchor: true }), NONE).verdict, "reproduces");
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
  it("the job-year anchor beats other years that also reproduce (10353: 2024 @1.40489 and 2023 @1.40341 both to 28.9)", () => {
    const fuel: V7MatchRow = { scope: "1", quantity: 20_563.4, applyPct: 100, previousTco2e: 28.889, categories: ["1.company-vehicles"] };
    const year = (rate: number, label: string, anchor: boolean) => ({ label, anchor, identity: anchor, match: v7MatchCandidate(fuel, factor({ rate, scopes: ["1"], categories: ["1.company-vehicles"], anchor }), NONE) });
    const y2024 = year(1.40489, "diesel · 2024", true), y2023 = year(1.40341, "diesel · 2023", false), y2022 = year(1.40417, "diesel · 2022", false);
    assert.deepEqual([y2024, y2023, y2022].map((entry) => entry.match.verdict), ["reproduces", "reproduces", "reproduces"], "three years, one figure to 1 dp");
    assert.equal(v7AutoPick([y2023, y2022]), null, "without the anchor: ambiguity");
    assert.equal(v7AutoPick([y2023, y2024, y2022]), y2024);
    assert.equal(rankV7Candidates([y2023, y2022, y2024])[0], y2024, "ranked first; the other years stay as alternatives");
  });
  it("a variant row's core at the job year is its anchor, and auto-picks — a zero rate included (Walking, nzi-gb-2024)", () => {
    const walk: V7MatchRow = { scope: "3", quantity: 1_200, applyPct: 100, previousTco2e: 0, categories: ["3.7"] };
    const of = (label: string, anchor: boolean) => ({ label, anchor, identity: false, match: v7MatchCandidate(walk, factor({ rate: 0, categories: ["3.7"], anchor }), NONE) });
    const y2024 = of("Walking · nzi-gb-2024", true), y2019 = of("Walking · nzi-gb-2019", false), y2023 = of("Walking · nzi-gb-2023", false);
    assert.equal(v7AutoPick([y2019, y2023, y2024]), y2024);
    assert.equal(v7AutoPick([y2019, y2023]), null, "zeros alone never auto-win");
  });
  it("an anchor that does not reproduce is no auto-pick, and two reproducing anchors are ambiguity", () => {
    const off = { ...RIGHT, anchor: true, match: v7MatchCandidate(ROW, factor({ rate: 0.26473, anchor: true }), NONE) };
    assert.equal(v7AutoPick([off, AVERAGE]), null);
    assert.equal(v7AutoPick([off, RIGHT]), RIGHT, "a non-reproducing anchor does not block the one clean reproduction");
    assert.equal(v7AutoPick([{ ...RIGHT, anchor: true }, { ...RIGHT, label: "twin", anchor: true }]), null);
  });
});

describe("the reconcile gate's agreement", () => {
  it("each scope agrees to one decimal place, or does not", () => {
    assert.deepEqual(v7ScopeAgreement({ "1": { v7Tco2e: 1052.61, liveTco2e: 1052.58 }, "2": { v7Tco2e: 15.3, liveTco2e: 15.9 }, "3": { v7Tco2e: 0, liveTco2e: 0 } })
      .map((entry) => [entry.scope, entry.agrees]), [["1", true], ["2", false], ["3", true]]);
  });
});
