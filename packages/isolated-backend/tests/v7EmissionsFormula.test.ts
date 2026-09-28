import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calcTco2e, pyRound2, registerSourceFigure, scopeRowFigure, scopeTotals, type ScopeRowInput } from "../src/v7EmissionsFormula";

/**
 * The port of v7's report-time arithmetic (decision 9). Each expectation is v7's behaviour as its code reads, worked by
 * hand — including the quirks, because they are what clients were shown.
 */

const row = (over: Partial<ScopeRowInput> = {}): ScopeRowInput => ({
  scope: "Scope 1", qty: "1000", uom: "kWh", factor: "0.2", ghgUnit: "kgCO2e", applyPct: "100",
  months: Array.from({ length: 12 }, () => null), datasetId: "7", factorDbId: "55", originalId: "7_400_4000_5_1",
  notes: null, referenceFactor: null, referenceGhgUnit: null, ...over,
});

describe("v7's emissions arithmetic, ported (decision 9)", () => {
  it("rounds as Python's round(x, 2) does: the double's exact value, exact ties to even", () => {
    // Values checked against CPython: round(0.125,2)=0.12, round(0.375,2)=0.38, round(2.675,2)=2.67 (2.675 is below
    // its decimal spelling in binary), round(1.005,2)=1.0, round(-0.125,2)=-0.12, round(0.135,2)=0.14.
    assert.equal(pyRound2(0.125), 0.12);
    assert.equal(pyRound2(0.375), 0.38);
    assert.equal(pyRound2(2.675), 2.67);
    assert.equal(pyRound2(1.005), 1);
    assert.equal(pyRound2(-0.125), -0.12);
    assert.equal(pyRound2(0.135), 0.14);
    assert.equal(pyRound2(21.08), 21.08);
  });

  it("keeps v7's quirks: apply_pct 0 reads as 100, a missing unit reads as per-kg, tCO2e is not divided", () => {
    assert.equal(calcTco2e(1000, 0.2, "kgCO2e", 0), 0.2, "apply_pct 0 falls through `or 100`");
    assert.equal(calcTco2e(1000, 0.2, "kgCO2e", null), 0.2);
    assert.equal(calcTco2e(1000, 0.2, "kgCO2e", 50), 0.1);
    assert.equal(calcTco2e(1000, 0.2, null, 100), 0.2, "no unit is read as kgCO2e");
    assert.equal(calcTco2e(12.5, 1, "tCO2e", 100), 12.5);
    assert.equal(calcTco2e(null, 0.2, "kgCO2e", 100), 0);
  });

  it("prices an annual row from its quantity and a monthly row from its months, never both", () => {
    assert.equal(scopeRowFigure(row()).tco2e, 0.2);
    const monthly = scopeRowFigure(row({ qty: "999999", months: Array.from({ length: 12 }, () => "100") }));
    assert.ok(Math.abs(monthly.tco2e - 0.24) < 1e-12, "12 × 100 kWh × 0.2 — the stored qty is not read");
    assert.equal(monthly.displayQty, 1200);
  });

  it("flags, rather than guesses, a month v7 would price from another dataset", () => {
    const months = Array.from({ length: 12 }, () => "100");
    const absent = scopeRowFigure(row({ months }));
    assert.deepEqual(absent.notReplayable, ["monthly-dataset-map-absent"]);
    const map = new Map(Array.from({ length: 12 }, (_, index) => [index + 1, new Map([["Scope 1", index < 6 ? "7" : "8"]])]));
    const split = scopeRowFigure(row({ months }), map);
    assert.deepEqual(split.notReplayable, ["monthly-factor-relookup"], "July–December priced from dataset 8 needs v7's factor tables");
    const same = scopeRowFigure(row({ months }), new Map(Array.from({ length: 12 }, (_, index) => [index + 1, new Map([["Scope 1", "7"]])])));
    assert.deepEqual(same.notReplayable, [], "every month in the row's own dataset replays exactly");
  });

  it("takes v7's emissions-fallback path for a tCO2e-as-quantity row, and flags it only when the choice is unknowable", () => {
    const token = scopeRowFigure(row({ uom: "tCO2e", ghgUnit: "tCO2e", factor: "1", qty: "12.5", notes: "storage_reason=wfm_total" }));
    assert.equal(token.tco2e, 12.5);
    assert.deepEqual(token.notReplayable, []);
    const months = Array.from({ length: 12 }, (_, index) => (index === 0 ? "1" : null));
    const unknowable = scopeRowFigure(row({ uom: "tCO2e", ghgUnit: "tCO2e", factor: "1", qty: "12.5", months, referenceFactor: undefined, referenceGhgUnit: undefined }));
    assert.deepEqual(unknowable.notReplayable, ["fallback-needs-lookup"], "fallback 12.5 vs monthly 1 turns on a lookup the extract lacks");
  });

  it("uses the lookup's unit where v7 would, and flags the row when the extract did not carry it", () => {
    const stored = scopeRowFigure(row({ ghgUnit: "tCO2e", uom: "kWh", referenceFactor: "0.2", referenceGhgUnit: "kgCO2e" }));
    assert.equal(stored.tco2e, 0.2, "a non-kg stored unit yields to a kg reference unit: v7 divides by 1000");
    const unknown = scopeRowFigure(row({ ghgUnit: "tCO2e", uom: "kWh", referenceFactor: undefined, referenceGhgUnit: undefined }));
    assert.deepEqual(unknown.notReplayable, ["unit-needs-lookup"]);
  });

  it("reports a register source at its stored figure, recomputing only when v7 stored none", () => {
    assert.equal(registerSourceFigure({ qty: "1000", factor: "2.5", ghgUnit: "kgCO2e", applyPct: null, calcTco2e: "7" }), 7);
    assert.equal(registerSourceFigure({ qty: "1000", factor: "0.15", ghgUnit: "kgCO2e", applyPct: null, calcTco2e: null }), 0.15);
    assert.equal(registerSourceFigure({ qty: "1000", factor: "0.15", ghgUnit: "kgCO2e", applyPct: "0", calcTco2e: null }), 0.15, "0% reads as 100% here too");
  });

  it("totals as _build_scope_summary does: rows rounded, then scopes; the grand total from the raw sum", () => {
    const totals = scopeTotals([
      { scope: "Scope 1", tco2e: 0.004 }, { scope: "Scope 1", tco2e: 0.004 }, { scope: "Scope 1", tco2e: 0.004 },
      { scope: "Scope 2", tco2e: 1.006 }, { scope: "Scope 9", tco2e: 5 },
    ]);
    assert.deepEqual(totals, { "Scope 1": 0, "Scope 2": 1.01, "Scope 3": 0, Total: 6.02 },
      "three rows of 0.004 each round to nothing in their scope but count in the total; an unknown scope counts only in the total");
  });
});
