// NZC-072 — the forward target model. The pathway and the gap both read these functions,
// so a target change moves both or neither.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  benchmarkFromClientRecord, benchmarkIsStale, emptyTargetModel, hasForwardTargets, latestTargetGap,
  scopeTargetTrajectory, targetForYear, targetGaps, targetTrajectory, type ForwardTargetModel, type TargetBenchmark,
} from "../src/index";

/** Floating point: a target is a percentage of a total, so compare to the penny, not the bit. */
const close = (actual: number | null, expected: number, message?: string) => assert.ok(actual !== null && Math.abs(actual - expected) < 0.001, message ?? `${actual} ≉ ${expected}`);

const benchmark: TargetBenchmark = { year: 2023, totalTco2e: 1842, scopes: { "1": 120, "2": 400, "3": 1322 }, source: "client-record", reference: null };
const model: ForwardTargetModel = {
  nearTerm: { year: 2030, pct: 50 },
  netZero: { year: 2045, pct: 90 },
  scopes: { "1": { year: 2040, pct: 80 }, "2": { year: 2030, pct: 100 } },
};

describe("the target line", () => {
  it("is the benchmark and each committed milestone — benchmark × (1 − pct), in year order", () => {
    const points = targetTrajectory(benchmark, model);
    assert.deepEqual(points.map((point) => [point.year, point.kind, point.pct]), [[2023, "benchmark", 0], [2030, "near-term", 50], [2045, "net-zero", 90]]);
    close(points[0]!.tco2e, 1842);
    close(points[1]!.tco2e, 921);
    close(points[2]!.tco2e, 184.2);
  });

  it("ends where the commitment does — a 90% target keeps its residual rather than reaching zero", () => {
    const netZero = targetTrajectory(benchmark, model).at(-1)!;
    assert.ok(netZero.tco2e > 0);
    close(netZero.tco2e, 184.2);
    // A 100% commitment does reach zero, because that is what was committed to.
    assert.equal(targetTrajectory(benchmark, { ...model, netZero: { year: 2045, pct: 100 } }).at(-1)!.tco2e, 0);
  });

  it("draws only what is set — no invented milestones", () => {
    assert.deepEqual(targetTrajectory(benchmark, { nearTerm: { year: 2030, pct: 50 }, netZero: null, scopes: {} }).map((point) => point.kind), ["benchmark", "near-term"]);
    assert.deepEqual(targetTrajectory(benchmark, emptyTargetModel()).map((point) => point.kind), ["benchmark"]);
    assert.equal(hasForwardTargets(emptyTargetModel()), false);
    assert.equal(hasForwardTargets(model), true);
  });

  it("reads between the anchors, holds after the last, and has nothing to say before the benchmark", () => {
    const points = targetTrajectory(benchmark, model);
    assert.equal(targetForYear(points, 2022), null);
    assert.equal(targetForYear(points, 2023), 1842);
    assert.equal(targetForYear(points, 2030), 921);
    // Half way from 2023 to 2030 is half the reduction.
    close(targetForYear(points, 2026.5), (1842 + 921) / 2);
    close(targetForYear(points, 2050), 184.2);
  });

  it("measures one scope against that scope's share of the benchmark", () => {
    const scope1 = scopeTargetTrajectory(benchmark, model, "1")!;
    assert.deepEqual(scope1.map((point) => [point.year, point.kind]), [[2023, "benchmark"], [2040, "near-term"]]);
    close(scope1[0]!.tco2e, 120);
    close(scope1[1]!.tco2e, 24);
    // Scope 3 has no target, and a scope with no benchmark figure has no line either.
    assert.equal(scopeTargetTrajectory(benchmark, model, "3"), null);
    assert.equal(scopeTargetTrajectory({ ...benchmark, scopes: {} }, model, "1"), null);
  });
});

describe("the gap against the line", () => {
  const actuals = [{ year: 2023, tco2e: 1842 }, { year: 2024, tco2e: 1706 }, { year: 2025, tco2e: 1000 }];

  it("measures each year against the same line the chart draws", () => {
    const gaps = targetGaps(benchmark, model, actuals);
    const line = targetTrajectory(benchmark, model);
    for (const gap of gaps) assert.equal(gap.targetTco2e, targetForYear(line, gap.year));
    assert.equal(gaps[0]!.status, "on-track");
    // 2024's line is 1710.4 and the year came in at 1706 — inside the tolerance, so on track
    // rather than a win worth claiming.
    close(gaps[1]!.targetTco2e, 1710.429);
    assert.equal(gaps[1]!.status, "on-track");
    assert.equal(gaps[2]!.status, "ahead");
    assert.equal(latestTargetGap(gaps)?.year, 2025);
  });

  it("calls a year behind when it sits above the line", () => {
    const [gap] = targetGaps(benchmark, model, [{ year: 2028, tco2e: 1800 }]);
    assert.equal(gap!.status, "behind");
    assert.ok(gap!.gapTco2e! > 0);
    assert.ok(gap!.gapPct! > 0);
  });

  it("says there is no target rather than inventing one", () => {
    const gaps = targetGaps(benchmark, emptyTargetModel(), actuals);
    assert.deepEqual([...new Set(gaps.map((gap) => gap.status))], ["no-target"]);
    assert.deepEqual([...new Set(gaps.map((gap) => gap.targetTco2e))], [null]);
    assert.equal(latestTargetGap(gaps), null);
    // A year before the benchmark has no line to be measured against either.
    assert.equal(targetGaps(benchmark, model, [{ year: 2019, tco2e: 2088 }])[0]!.status, "no-target");
  });

  it("moves with the model — the only way the chart and the gap can disagree is if they read different models", () => {
    const stretched = { ...model, nearTerm: { year: 2030, pct: 70 } };
    const before = targetGaps(benchmark, model, [{ year: 2028, tco2e: 1100 }])[0]!;
    const after = targetGaps(benchmark, stretched, [{ year: 2028, tco2e: 1100 }])[0]!;
    assert.ok(after.targetTco2e! < before.targetTco2e!);
    assert.equal(before.status, "ahead");
    assert.equal(after.status, "behind");
  });
});

describe("the benchmark a target is measured against", () => {
  it("is read from the baseline, labelled by the year the period starts in", () => {
    const resolved = benchmarkFromClientRecord({ baselinePeriodStart: "2023-04-01", baselinePeriodEnd: "2024-03-31", baselineTotalTco2e: 1842, baselineScope1Tco2e: 120 });
    assert.equal(resolved?.year, 2023);
    assert.equal(resolved?.totalTco2e, 1842);
    assert.deepEqual(resolved?.scopes, { "1": 120 });
  });

  it("sums the scopes when no total is recorded, and is null without a baseline", () => {
    assert.equal(benchmarkFromClientRecord({ baselinePeriodStart: "2023-01-01", baselineScope1Tco2e: 10, baselineScope2Tco2e: 20 })?.totalTco2e, 30);
    assert.equal(benchmarkFromClientRecord({ baselinePeriodStart: "2023-01-01" }), null);
    assert.equal(benchmarkFromClientRecord({ baselineTotalTco2e: 100 }), null);
  });

  it("knows when a re-baseline has moved out from under the targets (NZC-068)", () => {
    assert.equal(benchmarkIsStale(benchmark, benchmark), false);
    assert.equal(benchmarkIsStale(benchmark, { year: 2023, totalTco2e: 1900 }), true);
    assert.equal(benchmarkIsStale(benchmark, { year: 2024, totalTco2e: 1842 }), true);
    // Nothing in force to compare against is not staleness.
    assert.equal(benchmarkIsStale(benchmark, null), false);
  });
});
