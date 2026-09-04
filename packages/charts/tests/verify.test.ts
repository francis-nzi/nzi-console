import assert from "node:assert/strict";
import test from "node:test";
import { resolveCrpCoreCharts, type ReviewedCrpSnapshotCore } from "../src/crp";
import { verifyChartsAgainstSnapshot } from "../src/verify";
import type { ScopeDonutData } from "../src/types";

const snapshot: ReviewedCrpSnapshotCore = {
  id: "reviewed-crp-J000712-v1",
  jobId: "712",
  jobNumber: "J000712",
  client: "Bushy Tails Ltd",
  reportingYear: 2024,
  generatedAt: "2026-08-24T00:00:00Z",
  dataHash: "sha256-demo",
  target: { baselineYear: 2022, baselineTco2e: 1650, interimYear: 2035, interimReductionPercent: 50, netZeroYear: 2045 },
  intensityTarget: null,
  annualComparison: [],
  measurements: [
    { rowId: "r1", scope: "1", sourceLabel: "Company vehicle diesel", tco2e: 146, factorSet: "DEFRA 2024 v1.2" },
    { rowId: "r2", scope: "2", sourceLabel: "Purchased electricity", tco2e: 96.1, factorSet: "DESNZ 2024 v1.0" },
    { rowId: "r3", scope: "3", scopeCode: "3.1", sourceLabel: "Raw materials", purchasedGoodsCategoryId: "raw", purchasedGoodsCategoryLabel: "Raw materials", tco2e: 700, factorSet: "CEDA 2025 v1.0" },
    { rowId: "r4", scope: "3", sourceLabel: "Upstream freight", tco2e: 475.9, factorSet: "CEDA 2025 v1.0" },
  ],
};

test("charts resolved from a snapshot reconcile to Outputs", () => {
  const charts = resolveCrpCoreCharts(snapshot);
  const result = verifyChartsAgainstSnapshot(snapshot, charts);
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok), null, 2));
  // the scope donut contributes a total + three subtotal checks
  assert.ok(result.checks.some((c) => c.label === "Scope donut — total" && c.expected === 1418));
  assert.ok(result.checks.some((c) => c.label.startsWith("Scope donut — Scope 3") && c.expected === 1175.9));
  // purchased-goods breakdown reconciles to the 3.1 rows only
  assert.ok(result.checks.some((c) => c.label === "Purchased goods breakdown — sum" && c.expected === 700));
  // reduction pathway baseline equals the target baseline
  assert.ok(result.checks.some((c) => c.label === "Reduction pathway — baseline" && c.expected === 1650));
});

test("a chart figure that drifts from the snapshot fails verification", () => {
  const charts = resolveCrpCoreCharts(snapshot);
  const donut = charts.find((c) => c.spec.type === "emissions_scope_donut") as ScopeDonutData;
  // Tamper: inflate the Scope 1 segment as if a stale chart were published.
  donut.segments = donut.segments.map((seg) => (seg.scope === "1" ? { ...seg, value: seg.value + 25 } : seg));

  const result = verifyChartsAgainstSnapshot(snapshot, charts);
  assert.equal(result.ok, false);
  const failed = result.checks.filter((c) => !c.ok);
  // both the Scope 1 subtotal and the donut total no longer reconcile
  assert.ok(failed.some((c) => c.label.startsWith("Scope donut — Scope 1")));
  assert.ok(failed.some((c) => c.label === "Scope donut — total"));
});

test("non-success charts are left to the manifest validator, not figure-checked", () => {
  const charts = resolveCrpCoreCharts({ ...snapshot, measurements: [], target: null });
  const result = verifyChartsAgainstSnapshot({ measurements: [], target: null, intensityTarget: null }, charts);
  assert.equal(result.checks.length, 0);
  assert.equal(result.ok, true);
});
