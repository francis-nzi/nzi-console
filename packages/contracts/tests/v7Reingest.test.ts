import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandDefinitions, commandGrantForRole, isV7ReportedTotalReason, v7QualityTier, V7_REINGEST_ACTOR, V7_REPORTED_TOTAL_REASONS,
  v7ReingestPlanIssues, v7ReingestPostconditionMisses, validateCommand, withinV7Tolerance, type CommandContext, type V7ReingestJobInput,
} from "../src/index";

/** The v7 re-ingest's pure rules (DESIGN-v7-reingest-commit-phase, ruled): the actor, the plan's shape, the reason set, D7. */
describe("the v7 re-ingest's rules", () => {
  const RUN = "v7-reingest-0f8fad5b-d9cb-469f-a165-70867728950e";
  const base: V7ReingestJobInput = {
    jobId: "j", runId: RUN, crosswalkVersion: "v1", crosswalkSha256: "a".repeat(64), vintageDatasetIds: ["d"],
    rows: [{ v7RowId: "r1", disposition: "RE-INGEST", categoryCode: "1.natural-gas", scope: "1", sourceLabel: "Gas", quantity: 1, unit: "kWh", datasetId: "d", factorId: "f", qualityTier: "measured", v7Tco2e: 0.2, rule: "S1-GAS" }],
  };
  const context = (actorId: string, principal: "staff" | "system"): CommandContext => ({ organisationId: "o", actorId, principal, idempotencyKey: "k", correlationId: "c", reason: "r", grant: commandGrantForRole("admin", "o", actorId) });

  it("both commands are the re-ingest's own system principal's, with a reason (condition 3)", () => {
    assert.deepEqual(validateCommand("v7.reingest.job", base, context(V7_REINGEST_ACTOR, "system")), []);
    for (const [actor, principal] of [["staff-1", "staff"], [V7_REINGEST_ACTOR, "staff"], ["policy:net-zero-minimum", "system"]] as const) {
      assert.ok(validateCommand("v7.reingest.job", base, context(actor, principal)).some((issue) => issue.code === "REINGEST_ACTOR_ONLY"), `${actor}/${principal}`);
      assert.ok(validateCommand("v7.reingest.revert", { jobId: "j", runId: RUN }, context(actor, principal)).some((issue) => issue.code === "REINGEST_ACTOR_ONLY"));
    }
    assert.equal(commandDefinitions["v7.reingest.job"].reasonRequired, true);
    assert.equal(commandDefinitions["v7.reingest.revert"].reasonRequired, true);
  });

  it("a plan row is RE-INGEST, CARRY-V7-FACTOR or REPORTED-TOTAL, each in its own shape; anything open is for Francis, not the re-ingest", () => {
    const row = base.rows[0]!;
    const issues = (over: object) => v7ReingestPlanIssues({ ...base, rows: [{ ...row, ...over } as never] }).map((issue) => issue.code);
    assert.deepEqual(issues({}), []);
    assert.deepEqual(issues({ disposition: "FOR-FRANCIS" }), ["INVALID"]);
    assert.deepEqual(issues({ categoryCode: "" }), ["REQUIRED"], "a row without a category is Francis's");
    assert.deepEqual(issues({ factorId: null }), ["REINGEST_SHAPE"]);
    assert.deepEqual(issues({ disposition: "REPORTED-TOTAL", quantity: null, unit: null, datasetId: null, factorId: null }), []);
    assert.deepEqual(issues({ disposition: "REPORTED-TOTAL" }), ["REPORTED_TOTAL_SHAPE"], "a reported total carries no quantity, unit or factor");
    assert.deepEqual(issues({ disposition: "CARRY-V7-FACTOR", datasetId: null, factorId: null, carriedFactor: { label: "v7", unit: "GBP", kgco2ePerUnit: 0.5, vintageYear: 2025 } }), []);
    assert.deepEqual(issues({ disposition: "CARRY-V7-FACTOR", datasetId: null, factorId: null, carriedFactor: null }), ["CARRY_SHAPE"]);
    assert.deepEqual(v7ReingestPlanIssues({ ...base, rows: [row, row] }).map((issue) => issue.code), ["DUPLICATE"]);
    assert.deepEqual(v7ReingestPlanIssues({ ...base, runId: "run-1" }).map((issue) => issue.code), ["INVALID"]);
  });

  it("the reported-total reason is a closed set of one", () => {
    assert.equal(V7_REPORTED_TOTAL_REASONS.length, 1);
    assert.ok(isV7ReportedTotalReason(V7_REPORTED_TOTAL_REASONS[0]));
    for (const reason of ["v7 reported total", "Manual override", "", null, undefined]) assert.ok(!isV7ReportedTotalReason(reason), String(reason));
  });

  it("D7: the total, each scope (condition 4), each row, one live row per v7 row, and no v7 row left on", () => {
    const v7Rows = [{ rowId: "a", scope: "1", v7Tco2e: 10 }, { rowId: "b", scope: "2", v7Tco2e: 5 }, { rowId: "c", scope: "3.6", v7Tco2e: 1 }];
    const live = (over: Partial<Record<string, number | null>> = {}) => v7Rows.map((row, i) => ({ rowId: `l${i}`, reingestedFrom: row.rowId, scope: row.scope, tco2e: row.rowId in over ? over[row.rowId]! : row.v7Tco2e, enabled: true }));
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live(), enabledMigratedAfter: 0 }), []);
    // Scope 1 two tonnes light and scope 2 two tonnes heavy: the total still matches. Per scope, it does not.
    const offset = v7ReingestPostconditionMisses({ v7Rows, liveRows: live({ a: 8, b: 7 }), enabledMigratedAfter: 0 });
    assert.ok(!offset.some((miss) => miss.startsWith("total")), "the grand total alone would pass");
    assert.ok(offset.some((miss) => miss.startsWith("scope 1")) && offset.some((miss) => miss.startsWith("scope 2")), "but each scope is checked");
    // Two rows of one scope with their figures swapped: the total and the scope still match. Only each row's own check sees it.
    const pair = [{ rowId: "x", scope: "3.1", v7Tco2e: 3 }, { rowId: "y", scope: "3.1", v7Tco2e: 7 }];
    const swapped = v7ReingestPostconditionMisses({ v7Rows: pair, liveRows: [
      { rowId: "lx", reingestedFrom: "x", scope: "3.1", tco2e: 7, enabled: true }, { rowId: "ly", reingestedFrom: "y", scope: "3.1", tco2e: 3, enabled: true }], enabledMigratedAfter: 0 });
    assert.deepEqual(swapped.map((miss) => miss.split(":")[0]), ["row lx", "row ly"], "each row reproduces its own v7 row, not merely the sum");
    assert.ok(v7ReingestPostconditionMisses({ v7Rows, liveRows: live().slice(1), enabledMigratedAfter: 0 }).some((miss) => miss.includes("v7 row a: 0 live rows")));
    assert.ok(v7ReingestPostconditionMisses({ v7Rows, liveRows: [...live(), { ...live()[0]!, rowId: "dup" }], enabledMigratedAfter: 0 }).some((miss) => miss.includes("2 live rows")));
    assert.ok(v7ReingestPostconditionMisses({ v7Rows, liveRows: live(), enabledMigratedAfter: 1 }).some((miss) => miss.includes("still enabled")));
    assert.ok(v7ReingestPostconditionMisses({ v7Rows, liveRows: live({ c: null }), enabledMigratedAfter: 0 }).some((miss) => miss.includes("no figure")));
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live().map((row) => row.reingestedFrom === "a" ? { ...row, enabled: false } : row), enabledMigratedAfter: 0 }).length > 0, true, "a switched-off live row is not counted");
  });

  it("the ruled tolerance: 0.1% relative or 0.001 t absolute", () => {
    assert.ok(withinV7Tolerance(100.09, 100));
    assert.ok(!withinV7Tolerance(100.2, 100));
    assert.ok(withinV7Tolerance(0.0009, 0));
    assert.ok(!withinV7Tolerance(0.002, 0));
  });

  it("the quality tier from v7's data source (condition 5); a reported total is never 'measured'", () => {
    assert.equal(v7QualityTier("Company Data", "kWh", false), "measured");
    assert.equal(v7QualityTier("Spend Data", "GBP", false), "spend-based");
    assert.equal(v7QualityTier("Company Data", "GBP", false), "spend-based");
    assert.equal(v7QualityTier("Employee Commuting (Consolidated)", "km", false), "survey");
    assert.equal(v7QualityTier("Previous Year", "kWh", false), "estimated");
    assert.equal(v7QualityTier("Company Data", null, true), "estimated");
  });
});
