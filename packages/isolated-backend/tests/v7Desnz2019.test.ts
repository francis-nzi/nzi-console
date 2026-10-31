import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { correctionCsv, correctionMarkdown, FlatFileRefused, parseFlatFile, planCorrection, type FlatDocument } from "../src/v7Desnz2019";
import { FLAT_DOC, flatFile, STORED } from "./support/desnz2019Fixture";

/** The pure half of the 2019 correction: the flat file, the composite-key join, the three named rules, and the report that is signed. */
describe("the DESNZ 2019 correction plan", () => {
  const plan = planCorrection(STORED, flatFile());
  const line = (factorId: string) => plan.lines.find((entry) => entry.factorId === factorId)!;

  it("matches a stored factor to its one real row on the composite key and corrects only the value", () => {
    const diesel = line("uk-ghg-1_101_1011_8_1");
    assert.deepEqual([diesel.match, diesel.oldValue, diesel.newValue, diesel.changes], ["KEY", "2.54603", "2.59411", true]);
    assert.ok(Math.abs(diesel.pctChange! - 1.888) < 0.01);
    assert.match(diesel.flatKey!, /kg co2e/, "the CO2e row, not the CO2 row beside it");
    const rail = line("uk-ghg-25_315_3147_11_1");
    assert.deepEqual([rail.match, rail.newValue], ["KEY", "0.04115"]);
  });

  it("a value that already equals the real 2019 number is matched and not changed", () => {
    const electricity = line("uk-ghg-7_400_4000_5_1");
    assert.deepEqual([electricity.match, electricity.changes], ["KEY", false]);
  });

  it("the three named rules: gas by its Gross CV label, air With RF, waste as a documented rename", () => {
    const gas = line("uk-ghg-1_100_1004_6_1");
    assert.deepEqual([gas.match, gas.newValue], ["RULE_GAS_GROSS_CV", "0.18385"], "Gross CV, not Net CV (0.20428)");
    const air = line("uk-ghg-21_316_3160_11_1");
    assert.deepEqual([air.match, air.newValue], ["RULE_AIR_WITH_RF", "0.25493"], "With RF, not Without RF (0.13483)");
    const waste = line("uk-ghg-20_507_5283_15_1");
    assert.deepEqual([waste.match, waste.newValue], ["RULE_WASTE_RENAME", "21.3538"]);
    assert.match(waste.note, /rename/);
  });

  it("never guesses: ambiguous, unmatched, blank-in-source and NZI-defined factors keep their value and are reported", () => {
    assert.deepEqual([line("uk-ghg-twin").match, line("uk-ghg-twin").newValue, line("uk-ghg-twin").changes], ["AMBIGUOUS", null, false]);
    assert.deepEqual([line("uk-ghg-SPEND-SIC-50").match, line("uk-ghg-SPEND-SIC-50").changes], ["UNMATCHED", false]);
    assert.deepEqual([line("uk-ghg-lube").match, line("uk-ghg-lube").newValue, line("uk-ghg-lube").changes], ["BLANK_IN_SOURCE", null, false], "a blank is not zero");
    const walking = line("nzi-99_316_3160_11_2");
    assert.deepEqual([walking.match, walking.newValue, walking.changes], ["NZI_CUSTOM", null, false]);
  });

  it("the waste rename applies to that one id only; the same path under another id is unmatched", () => {
    const other = planCorrection([{ ...STORED.find((entry) => entry.factorId === "uk-ghg-20_507_5283_15_1")!, factorId: "uk-ghg-20_507_5285_15_1" }], flatFile());
    assert.equal(other.lines[0]!.match, "UNMATCHED");
  });

  it("counts, the sha and the report are deterministic and carry the signed facts", () => {
    assert.equal(plan.counts.changed, 5);
    assert.deepEqual([plan.counts.inUse, plan.counts.inUseChanged], [6, 4]);
    assert.equal(planCorrection([...STORED].reverse(), flatFile()).sha256, plan.sha256, "the order the factors are read in does not matter");
    const moved = planCorrection(STORED.map((entry) => (entry.factorId === "uk-ghg-1_101_1011_8_1" ? { ...entry, value: "2.5" } : entry)), flatFile());
    assert.notEqual(moved.sha256, plan.sha256, "any stored value moving changes the sha");
    const csv = correctionCsv(plan);
    assert.equal(csv.trim().split("\n").length, STORED.length + 1);
    assert.match(csv, /uk-ghg-1_101_1011_8_1.*,2\.54603,2\.59411,1\.89,true,KEY/);
    const md = correctionMarkdown(plan, flatFile(), { generatedFor: "test", consumers: ["J000723"] });
    assert.match(md, new RegExp(plan.sha256));
    assert.match(md, /NZI-defined factors \(not in the DESNZ file/);
  });

  it("the flat file refuses a duplicate composite key and a wrong source, and counts blanks", () => {
    const duplicate: FlatDocument = { ...FLAT_DOC, source: { ...FLAT_DOC.source, sheetDataRows: FLAT_DOC.rows.length + 1 }, rows: [...FLAT_DOC.rows, FLAT_DOC.rows[0]!] };
    assert.throws(() => parseFlatFile(duplicate), FlatFileRefused);
    assert.throws(() => parseFlatFile({ ...FLAT_DOC, source: { ...FLAT_DOC.source, file: "other.xls" } }), FlatFileRefused);
    assert.throws(() => parseFlatFile({ ...FLAT_DOC, source: { ...FLAT_DOC.source, sheetDataRows: 99 } }), FlatFileRefused);
    assert.equal(flatFile().blankValueRows, 1);
  });

  it("the committed extract is the real file: 6,990 rows, 2,724 kg CO2e, long-haul business With RF is 0.43446", () => {
    const real = parseFlatFile(JSON.parse(readFileSync(new URL("../data/desnz-2019/factors-by-category-2019.json", import.meta.url), "utf8")) as FlatDocument);
    assert.deepEqual([real.rows.length, real.co2eRows.length, real.source.sha256.slice(0, 12)], [6990, 2724, "82461e6d6ad2"]);
    const longHaul = real.co2eRows.find((entry) => entry.l1 === "Business travel- air" && entry.l3 === "Long-haul, to/from UK" && entry.l4 === "Business class" && entry.columnText === "With RF");
    assert.equal(longHaul?.value, 0.43446);
  });
});
