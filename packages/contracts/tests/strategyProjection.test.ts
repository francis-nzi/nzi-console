import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  projectedTrajectory, projectionGap, projectionOverClaims, projectionVsActual,
  resolveEstimateTco2e, splitProjectionInputs,
  type ProjectionContribution, type StrategyEstimate,
} from "../src/strategyProjection";
import type { ClientStrategy } from "../src/reductionStrategies";
import type { TargetBenchmark, TargetPoint } from "../src/targets";

/**
 * The projected trajectory. The rule that outranks everything else here: a projection is an
 * **estimate**, and is never the measured footprint.
 */

const benchmark: TargetBenchmark = {
  year: 2024, totalTco2e: 1000,
  scopes: { "1": 200, "2": 300, "3": 500 },
  source: "baseline-record", reference: "FY2024 baseline",
};

const estimate = (over: Partial<StrategyEstimate> = {}): StrategyEstimate => ({
  amount: 50, unit: "tco2e_per_year", scope: "1", tco2ePerYear: 50,
  assumptions: "Supplier quote, 2026 prices.", confidence: "medium",
  source: "consultant", sourceVersion: null, ...over,
});

const strategy = (id: string, over: Partial<ClientStrategy> = {}): ClientStrategy => ({
  id, clientId: "client-a", leverIds: [], srsRequirementIds: ["req-1"], includeInReport: true,
  strategyId: null, title: id, scope: "1", category: "Energy", controlLevel: "direct_control",
  iconKey: "energy", status: "planned", owner: "", targetDate: "2027-06-30", progressPct: 0,
  notes: "", active: true, version: 1, estimate: estimate(), ...over,
});

const targetTrajectory: TargetPoint[] = [
  { year: 2024, tco2e: 1000, kind: "benchmark", pct: 0 },
  { year: 2030, tco2e: 500, kind: "near-term", pct: 50 },
  { year: 2040, tco2e: 50, kind: "net-zero", pct: 95 },
];

describe("an estimate is never a measurement", () => {
  it("draws nothing from the assured snapshot, in the module or the schema", () => {
    // The non-negotiable, asserted where it can actually be broken: if this module ever
    // reaches for a reviewed snapshot, the projected line has become a claim about measured
    // emissions rather than a forward estimate.
    const source = readFileSync(new URL("../src/strategyProjection.ts", import.meta.url), "utf8");
    // Asserted against what it imports and touches, not against the word — the comments
    // necessarily name the assured snapshot in order to say it is kept separate from it.
    const imports = source.split("\n").filter((line) => line.startsWith("import"));
    assert.deepEqual(imports.length, 2, "it depends on the plan and the target model, and nothing else");
    for (const line of imports) assert.match(line, /reductionStrategies|targets/);
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const needle of ["snapshot", "Snapshot", "measurement", "assured"]) {
      assert.ok(!code.includes(needle), `no code path may reach for ${needle}`);
    }
    const migration = readFileSync(new URL("../../isolated-backend/migrations/0085_strategy_reduction_estimate.sql", import.meta.url), "utf8");
    const ddl = migration.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    assert.ok(!ddl.includes("reviewed_crp_snapshots"), "nor may the estimate columns reference one");
    assert.match(migration, /never a measurement/i, "and the schema says so");
  });

  it("keeps the projected series separate from the actual one it is compared against", () => {
    // They are compared, never combined: projectionVsActual reports the difference and does
    // not fold the measured figure into the projected line.
    const contributions = splitProjectionInputs([strategy("a", { targetDate: "2026-01-01" })]).contributions;
    const projected = projectedTrajectory(contributions, benchmark, targetTrajectory);
    const comparison = projectionVsActual(projected, [{ year: 2030, tco2e: 900 }]);
    assert.ok(comparison);
    assert.equal(comparison.projectedTco2e, 950, "the projection is unchanged by the actual");
    assert.equal(comparison.actualTco2e, 900);
    assert.equal(comparison.state, "tracking");
  });

  it("says when the measured footprint has overtaken the projection", () => {
    const contributions = splitProjectionInputs([strategy("a", { targetDate: "2026-01-01" })]).contributions;
    const projected = projectedTrajectory(contributions, benchmark, targetTrajectory);
    const comparison = projectionVsActual(projected, [{ year: 2030, tco2e: 980 }]);
    assert.equal(comparison?.state, "behind", "the plan claimed a saving the measurement does not show");
    assert.equal(comparison?.differenceTco2e, 30);
  });
});

describe("resolving what a strategy saves", () => {
  it("takes tCO₂e per year as entered", () => {
    assert.equal(resolveEstimateTco2e({ amount: 42, unit: "tco2e_per_year", scope: "1" }, benchmark), 42);
  });

  it("resolves a percent against that scope's share of the benchmark in force", () => {
    // The same denominator the target pathway uses — which is what makes bottom-up and
    // top-down comparable rather than two numbers that merely share a chart.
    assert.equal(resolveEstimateTco2e({ amount: 10, unit: "percent", scope: "2" }, benchmark), 30);
    assert.equal(resolveEstimateTco2e({ amount: 100, unit: "percent", scope: "1" }, benchmark), 200);
  });

  it("refuses a percent it cannot resolve rather than calling it zero", () => {
    // "We have no baseline for that scope" and "this saves nothing" are opposite claims.
    assert.equal(resolveEstimateTco2e({ amount: 10, unit: "percent", scope: "1" }, null), null);
    const noScope: TargetBenchmark = { ...benchmark, scopes: { "3": 500 } };
    assert.equal(resolveEstimateTco2e({ amount: 10, unit: "percent", scope: "1" }, noScope), null);
  });

  it("refuses a negative reduction — that is an increase wearing the wrong name", () => {
    assert.equal(resolveEstimateTco2e({ amount: -5, unit: "tco2e_per_year", scope: "1" }, benchmark), null);
  });
});

describe("what contributes, and what is flagged instead", () => {
  it("flags a strategy with no estimate rather than counting it as zero", () => {
    const { contributions, excluded } = splitProjectionInputs([strategy("a", { estimate: null })]);
    assert.deepEqual(contributions, []);
    assert.equal(excluded[0]?.reason, "no-estimate");
    assert.match(excluded[0]!.detail, /contributes nothing/);
  });

  it("flags an undated strategy rather than inventing a date for it", () => {
    // The reduction steps in at the target date; with no date there is no year to step in.
    const { contributions, excluded } = splitProjectionInputs([strategy("a", { targetDate: null })]);
    assert.deepEqual(contributions, []);
    assert.equal(excluded[0]?.reason, "no-target-date");
  });

  it("leaves a withdrawn strategy out entirely", () => {
    const { contributions, excluded } = splitProjectionInputs([strategy("a", { active: false })]);
    assert.deepEqual(contributions, []);
    assert.deepEqual(excluded, [], "it is not on the plan at all, so there is nothing to flag");
  });
});

describe("the projected trajectory", () => {
  it("steps each reduction in at its target date and not before", () => {
    const { contributions } = splitProjectionInputs([
      strategy("early", { targetDate: "2026-01-01", estimate: estimate({ tco2ePerYear: 100 }) }),
      strategy("late", { targetDate: "2035-01-01", estimate: estimate({ tco2ePerYear: 200 }) }),
    ]);
    const line = projectedTrajectory(contributions, benchmark, targetTrajectory);
    assert.deepEqual(line, [
      { year: 2024, tco2e: 1000 },  // neither has stepped in
      { year: 2030, tco2e: 900 },   // the early one has
      { year: 2040, tco2e: 700 },   // both have
    ]);
  });

  it("plots on the same years and baseline as the target pathway", () => {
    const { contributions } = splitProjectionInputs([strategy("a")]);
    const line = projectedTrajectory(contributions, benchmark, targetTrajectory);
    assert.deepEqual(line.map((point) => point.year), targetTrajectory.map((point) => point.year));
    assert.equal(line[0]!.tco2e, benchmark.totalTco2e, "it starts from the benchmark the target starts from");
  });

  it("draws nothing without a benchmark rather than a line from nowhere", () => {
    const { contributions } = splitProjectionInputs([strategy("a")]);
    assert.deepEqual(projectedTrajectory(contributions, null, targetTrajectory), []);
  });
});

describe("the gap the consultant acts on", () => {
  it("states plan against target at the target's own horizon", () => {
    const { contributions } = splitProjectionInputs([
      strategy("a", { targetDate: "2026-01-01", estimate: estimate({ tco2ePerYear: 100 }) }),
    ]);
    const line = projectedTrajectory(contributions, benchmark, targetTrajectory);
    const gap = projectionGap(line, targetTrajectory);
    assert.equal(gap?.year, 2040);
    assert.equal(gap?.targetTco2e, 50);
    assert.equal(gap?.projectedTco2e, 900);
    assert.equal(gap?.shortfallTco2e, 850);
    assert.equal(gap?.state, "short");
  });

  it("says the plan meets the target when it does", () => {
    const { contributions } = splitProjectionInputs([
      strategy("a", { targetDate: "2026-01-01", estimate: estimate({ tco2ePerYear: 960 }) }),
    ]);
    const line = projectedTrajectory(contributions, benchmark, targetTrajectory);
    const gap = projectionGap(line, targetTrajectory);
    assert.equal(gap?.state, "meets");
    assert.equal(gap?.shortfallTco2e, 0);
  });
});

describe("over-claim is raised, never capped", () => {
  it("warns when a scope's reductions exceed that scope's footprint", () => {
    const contributions: ProjectionContribution[] = splitProjectionInputs([
      strategy("a", { estimate: estimate({ scope: "1", tco2ePerYear: 150 }) }),
      strategy("b", { estimate: estimate({ scope: "1", tco2ePerYear: 120 }) }),
    ]).contributions;
    const claims = projectionOverClaims(contributions, benchmark);
    const scopeClaim = claims.find((claim) => claim.scope === "1");
    assert.ok(scopeClaim, "scope 1 is over-claimed: 270 against a 200 baseline");
    assert.equal(scopeClaim.projectedTco2e, 270);
    assert.equal(scopeClaim.baselineTco2e, 200);
    assert.deepEqual(scopeClaim.strategyIds, ["a", "b"], "and names who to look at");
    assert.match(scopeClaim.message, /cannot fall below zero/);
  });

  it("does not silently cap the line — the floor shows as a warning beside it", () => {
    // The line is floored at zero so it stays drawable, but the over-claim is raised, so a
    // plan that "exactly reaches zero" is never mistaken for an arithmetic error.
    const { contributions } = splitProjectionInputs([
      strategy("a", { targetDate: "2026-01-01", estimate: estimate({ tco2ePerYear: 5000 }) }),
    ]);
    const line = projectedTrajectory(contributions, benchmark, targetTrajectory);
    assert.equal(line[1]!.tco2e, 0, "floored, not negative");
    assert.ok(projectionOverClaims(contributions, benchmark).length > 0, "and said so");
  });

  it("stays quiet when the plan is within the footprint", () => {
    const { contributions } = splitProjectionInputs([strategy("a", { estimate: estimate({ scope: "1", tco2ePerYear: 100 }) })]);
    assert.deepEqual(projectionOverClaims(contributions, benchmark), []);
  });
});
