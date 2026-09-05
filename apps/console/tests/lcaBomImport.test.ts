import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lcaBomTemplateCsv, matchModuleCode, parseLcaBomLines } from "../app/jobs/lca/lcaBomImport";

describe("matchModuleCode", () => {
  it("passes a controlled code through unchanged", () => assert.equal(matchModuleCode("a1"), "A1"));
  it("extracts a code mentioned in free text", () => {
    assert.equal(matchModuleCode("A1 · Raw material supply"), "A1");
    assert.equal(matchModuleCode("Module C3 (waste processing)"), "C3");
  });
  it("returns null for an unrecognised module", () => assert.equal(matchModuleCode("Z9"), null));
  it("returns null for blank input", () => assert.equal(matchModuleCode(""), null));
});

describe("parseLcaBomLines", () => {
  it("parses a comma-separated BOM with a header row", () => {
    const lines = parseLcaBomLines("Module,Label,Quantity,Unit,Origin country\nA1,rPET tray,31.5,kg,GB\nA3,Corrugated carton,0.22,kg,");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { moduleCode: "A1", lineLabel: "rPET tray", quantity: 31.5, unit: "kg", originCountry: "GB" });
    assert.deepEqual(lines[1], { moduleCode: "A3", lineLabel: "Corrugated carton", quantity: 0.22, unit: "kg", originCountry: null });
  });
  it("parses a tab-separated BOM with no header row, defaulting the unit to kg", () => {
    const lines = parseLcaBomLines("A1\tFood-grade adhesive\t0.35");
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], { moduleCode: "A1", lineLabel: "Food-grade adhesive", quantity: 0.35, unit: "kg", originCountry: null });
  });
  it("drops blank lines and rows with neither a label nor a quantity", () => {
    assert.equal(parseLcaBomLines("\n \n").length, 0);
    assert.equal(parseLcaBomLines("A1,,,kg,").length, 0);
  });
  it("keeps a row with a quantity but no recognised module (left for the operator to fix)", () => {
    const lines = parseLcaBomLines("Unknown,Widget,4");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.moduleCode, null);
    assert.equal(lines[0]?.lineLabel, "Widget");
    assert.equal(lines[0]?.quantity, 4);
  });
  it("ships a template with the controlled header and worked rows", () => {
    const csv = lcaBomTemplateCsv();
    assert.ok(csv.includes("Module,Label,Quantity,Unit,Origin country"));
    assert.ok(csv.includes("rPET tray"));
  });
});
