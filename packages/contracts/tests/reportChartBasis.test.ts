import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeReportChartBasis, type ChartBasisSnapshot } from "../src/reportChartBasis";
import type { ReportEmissionsComparison } from "../src/reportComposition";

/** F-2: the charts' frozen input — the portal's fields, cut to the report's scope. */
const snapshot: ChartBasisSnapshot = {
  id: "snap", jobId: "job", jobNumber: "J1", client: "Co", reportingYear: 2025, dataHash: "sha256:x", createdAt: "2026-01-01T00:00:00.000Z",
  intensityTarget: { metric: "turnover", denominatorUnit: "£m", reportingDenominator: 12.5 },
  annualComparison: [{ year: 2024, values: [{ scope: "1", value: 14 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }],
  measurements: [
    { rowId: "a", scope: "1", scopeCode: "1", sourceLabel: "Gas", siteId: "s-a", siteLabel: "Works", tco2e: 10, factorSet: "demo", qualityTier: "measured", notes: "internal" },
    { rowId: "b", scope: "2", scopeCode: "2", sourceLabel: "Electricity", siteId: "s-b", siteLabel: "Annex", tco2e: 5, factorSet: "demo" },
    { rowId: "g", scope: "3", scopeCode: "3.1", sourceLabel: "Goods", siteId: null, siteLabel: null, tco2e: 20, factorSet: "demo", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" },
  ],
};
const comparison: ReportEmissionsComparison = {
  columns: [{ key: "baseline", year: 2023, label: "Baseline (FY2023)" }, { key: "previous", year: 2024, label: "Previous (FY2024)" }, { key: "current", year: 2025, label: "Current (FY2025)" }],
  rows: [{ scope: "1", values: [null, 12, 10] }, { scope: "2", values: [null, 0, 0] }, { scope: "3", values: [null, 0, 0] }],
  totals: [null, 12, 10], changeVsBaselinePct: null, notes: [],
};

describe("a report's chart basis (F-2)", () => {
  it("whole client: every row, the reported intensity and the snapshot's year-on-year — as the portal passes them", () => {
    const basis = composeReportChartBasis({ snapshot, scope: { kind: "whole" } });
    assert.deepEqual([basis.generatedAt, basis.dataHash, basis.measurements.length], ["2026-01-01T00:00:00.000Z", "sha256:x", 3]);
    assert.deepEqual(basis.intensityTarget, snapshot.intensityTarget);
    // The superseded job-level target is never frozen: the report's pathway is its own Targets section (NZC-072).
    assert.ok(!("target" in basis), "no job-level target in the basis");
    assert.deepEqual(basis.annualComparison.map((year) => year.year), [2024, 2025]);
  });

  it("carries only the fields the resolver reads — nothing else on a row reaches the frozen basis", () => {
    const [row] = composeReportChartBasis({ snapshot, scope: { kind: "whole" } }).measurements;
    assert.deepEqual(Object.keys(row!).sort(), ["factorSet", "purchasedGoodsCategoryId", "purchasedGoodsCategoryLabel", "rowId", "scope", "scopeCode", "siteId", "siteLabel", "sourceLabel", "tco2e"]);
    assert.ok(!("notes" in row!) && !("qualityTier" in row!));
  });

  it("a site scope: only its sites' rows, its own attributable year-on-year, and no client-level intensity pathway", () => {
    const basis = composeReportChartBasis({ snapshot, scope: { kind: "sites", siteIds: ["s-a"] }, comparison });
    assert.deepEqual(basis.measurements.map((row) => row.rowId), ["a"], "not Annex, not organisation-level");
    assert.deepEqual(basis.annualComparison, [{ year: 2024, values: [{ scope: "1", value: 12 }, { scope: "2", value: 0 }, { scope: "3", value: 0 }] }, { year: 2025, values: [{ scope: "1", value: 10 }, { scope: "2", value: 0 }, { scope: "3", value: 0 }] }],
      "the not-attributable baseline column is left out, never drawn as nought");
    assert.equal(basis.intensityTarget, null);
  });
});
