import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandDefinitions, commandGrantForRole, isV7ReportedTotalReason, v7QualityTier, V7_REINGEST_ACTOR, V7_REPORTED_TOTAL_REASONS,
  v7ReingestPlanIssues, v7CarriedFieldMisses, v7ReingestPostconditionMisses, validateCommand, withinV7Tolerance, type CommandContext, type V7ReingestJobInput,
} from "../src/index";

/** The v7 re-ingest's pure rules (DESIGN-v7-reingest-commit-phase, ruled): the actor, the plan's shape, the reason set, D7. */
/** The carried fields, all absent (v7 named none of them). */
const F = { siteId: null as string | null, dataConfidence: null as string | null, columnText: null as string | null, months: null as Array<number | null> | null };

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
    const v7Rows = [{ rowId: "a", scope: "1", v7Tco2e: 10, ...F }, { rowId: "b", scope: "2", v7Tco2e: 5, ...F }, { rowId: "c", scope: "3.6", v7Tco2e: 1, ...F }];
    const live = (over: Partial<Record<string, number | null>> = {}) => v7Rows.map((row, i) => ({ rowId: `l${i}`, reingestedFrom: row.rowId, scope: row.scope, tco2e: row.rowId in over ? over[row.rowId]! : row.v7Tco2e, enabled: true, ...F }));
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live(), enabledMigratedAfter: 0 }), []);
    // Scope 1 two tonnes light and scope 2 two tonnes heavy: the total still matches. Per scope, it does not.
    const offset = v7ReingestPostconditionMisses({ v7Rows, liveRows: live({ a: 8, b: 7 }), enabledMigratedAfter: 0 });
    assert.ok(!offset.some((miss) => miss.startsWith("total")), "the grand total alone would pass");
    assert.ok(offset.some((miss) => miss.startsWith("scope 1")) && offset.some((miss) => miss.startsWith("scope 2")), "but each scope is checked");
    // Two rows of one scope with their figures swapped: the total and the scope still match. Only each row's own check sees it.
    const pair = [{ rowId: "x", scope: "3.1", v7Tco2e: 3, ...F }, { rowId: "y", scope: "3.1", v7Tco2e: 7, ...F }];
    const swapped = v7ReingestPostconditionMisses({ v7Rows: pair, liveRows: [
      { rowId: "lx", reingestedFrom: "x", scope: "3.1", tco2e: 7, enabled: true, ...F }, { rowId: "ly", reingestedFrom: "y", scope: "3.1", tco2e: 3, enabled: true, ...F }], enabledMigratedAfter: 0 });
    assert.deepEqual(swapped.map((miss) => miss.split(":")[0]), ["row lx", "row ly"], "each row reproduces its own v7 row, not merely the sum");
    assert.ok(v7ReingestPostconditionMisses({ v7Rows, liveRows: live().slice(1), enabledMigratedAfter: 0 }).some((miss) => miss.includes("v7 row a: 0 live rows")));
    assert.ok(v7ReingestPostconditionMisses({ v7Rows, liveRows: [...live(), { ...live()[0]!, rowId: "dup" }], enabledMigratedAfter: 0 }).some((miss) => miss.includes("2 live rows")));
    assert.ok(v7ReingestPostconditionMisses({ v7Rows, liveRows: live(), enabledMigratedAfter: 1 }).some((miss) => miss.includes("still enabled")));
    assert.ok(v7ReingestPostconditionMisses({ v7Rows, liveRows: live({ c: null }), enabledMigratedAfter: 0 }).some((miss) => miss.includes("no figure")));
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live().map((row) => row.reingestedFrom === "a" ? { ...row, enabled: false } : row), enabledMigratedAfter: 0 }).length > 0, true, "a switched-off live row is not counted");
  });

  it("RULING-v7-reingest-full-record: D7 per site, Unallocated its own bucket — the dropped-site case fails", () => {
    const v7 = [
      { rowId: "gas", scope: "1", v7Tco2e: 43.4, ...F, siteId: "uk" }, { rowId: "car-pl", scope: "1", v7Tco2e: 0, ...F, siteId: "pl" },
      { rowId: "travel", scope: "3.6", v7Tco2e: 2, ...F },
    ];
    const live = v7.map((row) => ({ rowId: `l-${row.rowId}`, reingestedFrom: row.rowId, scope: row.scope, tco2e: row.v7Tco2e, enabled: true, ...F, siteId: row.siteId }));
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows: v7, liveRows: live, enabledMigratedAfter: 0 }), [], "the site-less v7 row reconciles as Unallocated");
    // J000663's bug: every row brought in Unallocated. The total, each scope and each figure still match; the site does not.
    const dropped = v7ReingestPostconditionMisses({ v7Rows: v7, liveRows: live.map((row) => ({ ...row, siteId: null })), enabledMigratedAfter: 0 });
    assert.ok(!dropped.some((miss) => miss.startsWith("total") || miss.startsWith("scope")));
    assert.ok(dropped.some((miss) => miss.startsWith("site uk:")) && dropped.some((miss) => miss.startsWith("site unallocated:")), JSON.stringify(dropped));
    assert.ok(dropped.some((miss) => miss.includes(`site none ≠ v7's "uk"`)), "and each row names its own dropped site");
  });

  it("per row, each carried field must equal its v7 source — what catches two rows swapping sites with equal figures", () => {
    const v7 = [{ rowId: "a", scope: "1", v7Tco2e: 5, ...F, siteId: "uk" }, { rowId: "b", scope: "1", v7Tco2e: 5, ...F, siteId: "pl" }];
    const swapped = [{ rowId: "la", reingestedFrom: "a", scope: "1", tco2e: 5, enabled: true, ...F, siteId: "pl" }, { rowId: "lb", reingestedFrom: "b", scope: "1", tco2e: 5, enabled: true, ...F, siteId: "uk" }];
    const misses = v7ReingestPostconditionMisses({ v7Rows: v7, liveRows: swapped, enabledMigratedAfter: 0 });
    assert.ok(!misses.some((miss) => miss.startsWith("site ")), "the per-site totals match");
    assert.deepEqual(misses, [`row la: site "pl" ≠ v7's "uk"`, `row lb: site "uk" ≠ v7's "pl"`]);
    const v7Fields = { siteId: "uk", dataConfidence: "H", columnText: "Diesel (average biofuel blend)", months: [1, null, 2] };
    assert.deepEqual(v7CarriedFieldMisses(v7Fields, { ...v7Fields }), []);
    assert.deepEqual(v7CarriedFieldMisses(v7Fields, { ...v7Fields, dataConfidence: null }), [`data confidence none ≠ v7's "H"`]);
    assert.deepEqual(v7CarriedFieldMisses(v7Fields, { ...v7Fields, columnText: null }).length, 1);
    assert.deepEqual(v7CarriedFieldMisses(v7Fields, { ...v7Fields, months: null }).length, 1, "months dropped");
    assert.deepEqual(v7CarriedFieldMisses(v7Fields, { ...v7Fields, months: [1, 0, 2] }).length, 1, "a blank month is not a zero month");
    assert.deepEqual(v7CarriedFieldMisses(v7Fields, { ...v7Fields, months: [2, null, 1] }).length, 1, "months in the wrong place");
    assert.deepEqual(v7CarriedFieldMisses({ ...F }, { ...F }), [], "nothing in v7, nothing on the row");
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
