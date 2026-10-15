import assert from "node:assert/strict";
import test from "node:test";
import { resolveCrpCoreCharts, type ReviewedCrpSnapshotCore } from "../src/crp";

// RULING-report-denominator: a currency measure reaches the client with the year's intensity in place of its turnover. The
// pathway draws it as given — the same chart, mark for mark, as dividing the turnover — and otherwise divides as it always has.
type Target = NonNullable<ReviewedCrpSnapshotCore["intensityTarget"]>;
const target = (figure: Partial<Target>): Target => ({ metric: "turnover", denominatorUnit: "£m", baselineYear: 2024, baselineIntensity: 4,
  interimYear: 2030, interimReductionPercent: 50, netZeroYear: null, targetYear: 2045, targetReductionPercent: 100, ...figure });
const charts = (intensityTarget: Target, tco2e = [30, 13.4, 20]) => resolveCrpCoreCharts({ id: "s", jobId: "j", jobNumber: "J1", client: "Co", reportingYear: 2025,
  generatedAt: "2026-01-01T00:00:00Z", dataHash: "sha256:a", intensityTarget,
  measurements: tco2e.map((value, index) => ({ rowId: `r${index}`, scope: "1" as const, sourceLabel: "Gas", tco2e: value, factorSet: "demo" })) });
const pathway = (all: ReturnType<typeof charts>) => all.find((chart) => chart.spec.type === "intensity_pathway");

test("the year's intensity draws the same pathway as dividing the turnover — for any figures", () => {
  let seed = 11;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let index = 0; index < 200; index++) {
    const rows = Array.from({ length: 1 + Math.floor(random() * 5) }, () => Math.round(random() * 1e6) / 100);
    const denominator = Math.round(random() * 1e8) / 1e6 + 0.01;
    const intensity = rows.reduce((sum, value) => sum + value, 0) / denominator;
    assert.deepEqual(pathway(charts(target({ reportingIntensity: intensity }), rows)), pathway(charts(target({ reportingDenominator: denominator }), rows)));
  }
});

test("no intensity for the year is drawn as unavailable, exactly as a missing turnover was", () => {
  const absent = pathway(charts(target({ reportingIntensity: null })));
  assert.deepEqual(absent, pathway(charts(target({ reportingDenominator: null }))));
  assert.ok(absent && "state" in absent && absent.state === "degraded");
});

test("a frozen denominator still divides — a composition frozen before the ruling draws as it did", () => {
  const drawn = pathway(charts(target({ reportingDenominator: 12.68 })));
  assert.ok(drawn && "actual" in drawn);
  if (drawn && "actual" in drawn) assert.equal(drawn.actual.at(-1)?.value, 63.4 / 12.68);
});
