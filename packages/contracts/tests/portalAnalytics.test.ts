import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  derivePortalBaseline, derivePortalTrendYear, portalTargetProgress,
  type ReviewedCrpSnapshotReadModel,
} from "../src/index";

const measurement = (over: Partial<ReviewedCrpSnapshotReadModel["measurements"][number]>) => ({
  rowId: "r", rowVersion: 1, scope: "1" as const, sourceLabel: "src", tco2e: 0,
  factorSet: "DEFRA 2024", qualityTier: "measured" as const, reviewedBy: "rev",
  ...over,
});

const snapshot = (over: Partial<ReviewedCrpSnapshotReadModel> = {}): ReviewedCrpSnapshotReadModel => ({
  id: "s1", jobId: "j1", jobNumber: "J000712", client: "Acme", reportingYear: 2025, version: 2, jobVersion: 3,
  createdAt: "2026-01-01T00:00:00.000Z", createdBy: "consultant", dataHash: "sha256:abc",
  target: null, intensityTarget: null, annualComparison: [], sections: [], gapResolutions: [],
  measurements: [
    measurement({ rowId: "a", scope: "1", scopeCode: "1", siteId: "s-a", siteLabel: "Plant A", tco2e: 100 }),
    measurement({ rowId: "b", scope: "2", scopeCode: "2", siteId: "s-a", siteLabel: "Plant A", tco2e: 40 }),
    measurement({ rowId: "c", scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, tco2e: 260 }),
    measurement({ rowId: "d", scope: "3", scopeCode: "3.6", siteId: "s-b", siteLabel: "Plant B", tco2e: 100 }),
  ],
  ...over,
});

describe("derivePortalBaseline (portal A1, §0)", () => {
  it("aggregates the published snapshot by scope, category and site — total is the plain sum", () => {
    const baseline = derivePortalBaseline(snapshot());
    assert.equal(baseline.reportingYear, 2025);
    assert.equal(baseline.total, 500);
    assert.deepEqual(baseline.byScope, { "1": 100, "2": 40, "3": 360 });
    assert.deepEqual(baseline.byCategory.map((c) => [c.scopeCode, c.tco2e]), [["3.1", 260], ["1", 100], ["3.6", 100], ["2", 40]]);
    assert.deepEqual(baseline.bySite.map((s) => [s.label, s.tco2e]), [["Unallocated", 260], ["Plant A", 140], ["Plant B", 100]]);
    assert.equal(baseline.intensity, null);
  });

  it("carries the target and computes intensity when the snapshot has an intensity denominator", () => {
    const baseline = derivePortalBaseline(snapshot({
      target: { jobId: "j1", baselineYear: 2019, baselineTco2e: 1000, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "c" },
      intensityTarget: { jobId: "j1", metric: "turnover", denominatorUnit: "£m", reportingDenominator: 10, baselineYear: 2019, baselineIntensity: 100, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "c" },
    }));
    assert.equal(baseline.intensity, 50); // 500 / 10
    assert.equal(baseline.intensityUnit, "tCO₂e / £m");
    assert.equal(baseline.target?.baselineTco2e, 1000);
  });
});

describe("derivePortalTrendYear", () => {
  it("aggregates a prior year's frozen snapshot", () => {
    const row = derivePortalTrendYear({ year: 2024, kind: "prior", snapshot: snapshot({ reportingYear: 2024 }) });
    assert.deepEqual([row.year, row.kind, row.total], [2024, "prior", 500]);
    assert.deepEqual(row.byScope, { "1": 100, "2": 40, "3": 360 });
  });

  it("returns a null-total row when a year has no history", () => {
    const row = derivePortalTrendYear({ year: 2022, kind: "baseline", snapshot: null });
    assert.deepEqual([row.total, row.byScope], [null, { "1": 0, "2": 0, "3": 0 }]);
  });
});

describe("portalTargetProgress", () => {
  it("is the fraction of the baseline→interim gap the assured total has closed", () => {
    // baseline 1000, interim −50% → 500; current 500 → 100% of the way.
    const baseline = derivePortalBaseline(snapshot({
      target: { jobId: "j1", baselineYear: 2019, baselineTco2e: 1000, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "c" },
    }));
    assert.equal(portalTargetProgress(baseline), 1);
  });
  it("is null with no target", () => {
    assert.equal(portalTargetProgress(derivePortalBaseline(snapshot())), null);
  });
});
