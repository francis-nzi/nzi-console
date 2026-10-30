import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandDefinitions, commandGrantForRole, isV7ReportedTotalReason, monthsFitQuantity, sameV7CarriedQuantity, sameV7Quantity, v7ApplyPct, v7EmissionDelta, v7EmissionDeltaReport, v7QualityTier,
  V7_REINGEST_ACTOR, V7_REPORTED_TOTAL_REASONS, v7ReingestPlanIssues, v7CarriedFieldMisses, v7ReingestPostconditionMisses, validateCommand, withinV7Tolerance,
  type CommandContext, type V7ReingestJobInput,
} from "../src/index";

/** The v7 re-ingest's pure rules (DESIGN-v7-reingest-commit-phase, ruled; RULING-v7-book-runner): the actor, the plan's shape, the reason set, D7, the delta report. */
/** The carried fields, all absent (v7 named none of them). */
const F = { siteId: null as string | null, dataConfidence: null as string | null, columnText: null as string | null, months: null as Array<number | null> | null };
/** The carried input of an input-bearing row. */
const I = { quantity: 1 as number | null, unit: "kWh" as string | null, applyPct: 100 };

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

  it("D7 (RULING-v7-book-runner R2): each row carries v7's input exactly; one live row per v7 row; no v7 row left on", () => {
    const v7Rows = [
      { rowId: "a", scope: "1", v7Tco2e: 10, reportedTotal: false, ...I, quantity: 500, ...F }, { rowId: "b", scope: "2", v7Tco2e: 5, reportedTotal: false, ...I, quantity: 200, ...F },
      { rowId: "c", scope: "3.6", v7Tco2e: 1, reportedTotal: false, ...I, quantity: 12.5, unit: "passenger.km", ...F },
    ];
    const live = (over: Partial<Record<string, object>> = {}) => v7Rows.map((row, i) => ({ rowId: `l${i}`, reingestedFrom: row.rowId, scope: row.scope, tco2e: row.v7Tco2e, enabled: true,
      quantity: row.quantity, unit: row.unit, applyPct: row.applyPct, ...F, ...(over[row.rowId] ?? {}) }));
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live(), enabledMigratedAfter: 0 }), []);
    // The emission is the calculation, not a gate: scope 1 two tonnes light and scope 2 two tonnes heavy is a delta to report.
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live({ a: { tco2e: 8 }, b: { tco2e: 7 } }), enabledMigratedAfter: 0 }), [], "no emission check refuses");
    // The input is the gate: a moved quantity, another unit, or another apportionment refuses — whatever the figure.
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live({ a: { quantity: 500.5 } }), enabledMigratedAfter: 0 }), ["row l0: quantity 500.5 ≠ v7's 500"]);
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live({ b: { unit: "MWh" } }), enabledMigratedAfter: 0 }), ["row l1: unit MWh ≠ v7's kWh"]);
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live({ c: { applyPct: 50 } }), enabledMigratedAfter: 0 }), ["row l2: apportionment 50% ≠ v7's 100%"]);
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live({ a: { quantity: null } }), enabledMigratedAfter: 0 }), ["row l0: quantity none ≠ v7's 500"]);
    // Floating-point noise is the same quantity; a unit the caller reads as the same (the factor's spelling) passes.
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live({ a: { quantity: 500 + 1e-10 } }), enabledMigratedAfter: 0 }), []);
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live({ b: { unit: "kWh (Gross CV)" } }), enabledMigratedAfter: 0 }, (x, y) => x.startsWith(y) || y.startsWith(x)), []);
    // Two rows of one scope with their quantities swapped: each row carries its own v7 row's input, not merely the sum.
    const pair = [{ rowId: "x", scope: "3.1", v7Tco2e: 3, reportedTotal: false, ...I, quantity: 3, ...F }, { rowId: "y", scope: "3.1", v7Tco2e: 7, reportedTotal: false, ...I, quantity: 7, ...F }];
    const swapped = v7ReingestPostconditionMisses({ v7Rows: pair, liveRows: [
      { rowId: "lx", reingestedFrom: "x", scope: "3.1", tco2e: 7, enabled: true, ...I, quantity: 7, ...F }, { rowId: "ly", reingestedFrom: "y", scope: "3.1", tco2e: 3, enabled: true, ...I, quantity: 3, ...F }], enabledMigratedAfter: 0 });
    assert.deepEqual(swapped.map((miss) => miss.split(":")[0]), ["row lx", "row ly"]);
    assert.ok(v7ReingestPostconditionMisses({ v7Rows, liveRows: live().slice(1), enabledMigratedAfter: 0 }).some((miss) => miss.includes("v7 row a: 0 live rows")));
    assert.ok(v7ReingestPostconditionMisses({ v7Rows, liveRows: [...live(), { ...live()[0]!, rowId: "dup" }], enabledMigratedAfter: 0 }).some((miss) => miss.includes("2 live rows")));
    assert.ok(v7ReingestPostconditionMisses({ v7Rows, liveRows: live(), enabledMigratedAfter: 1 }).some((miss) => miss.includes("still enabled")));
    assert.ok(v7ReingestPostconditionMisses({ v7Rows, liveRows: live({ c: { tco2e: null } }), enabledMigratedAfter: 0 }).some((miss) => miss.includes("no figure")));
    assert.ok(v7ReingestPostconditionMisses({ v7Rows, liveRows: live().map((row) => row.reingestedFrom === "a" ? { ...row, enabled: false } : row), enabledMigratedAfter: 0 }).some((miss) => miss.includes("v7 row a: 0 live rows")), "a switched-off live row is not counted");
  });

  it("R4: a reported total has no input to carry — it carries v7's figure, and is held to it", () => {
    const v7Rows = [{ rowId: "t", scope: "1", v7Tco2e: 2.19, reportedTotal: true, quantity: null, unit: null, applyPct: 100, ...F }];
    const live = (tco2e: number) => [{ rowId: "lt", reingestedFrom: "t", scope: "1", tco2e, enabled: true, quantity: null, unit: null, applyPct: 100, ...F }];
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live(2.19), enabledMigratedAfter: 0 }), []);
    assert.deepEqual(v7ReingestPostconditionMisses({ v7Rows, liveRows: live(2.5), enabledMigratedAfter: 0 }), ["row lt: reported total 2.5 t ≠ v7 2.19 t"]);
  });

  it("R3: the emission delta report — per row, scope, site and job; > 5% material; 0 → non-zero zero-base; within tolerance never flagged", () => {
    const report = v7EmissionDeltaReport([
      { v7RowId: "r3", liveRowId: "l3", scope: "3.6", siteId: null, v7Tco2e: 0, calcTco2e: 0.4 },            // zero-base
      { v7RowId: "r1", liveRowId: "l1", scope: "1", siteId: "uk", v7Tco2e: 100, calcTco2e: 100.05 },       // within the ruled tolerance
      { v7RowId: "r2", liveRowId: "l2", scope: "2", siteId: "uk", v7Tco2e: 10, calcTco2e: 11 },            // +10%: material (a mis-map, or v7's drift)
      { v7RowId: "r4", liveRowId: "l4", scope: "2", siteId: "uk", v7Tco2e: 10, calcTco2e: 10.4 },          // +4%: reported, not flagged
      { v7RowId: "r5", liveRowId: "l5", scope: "1", siteId: "pl", v7Tco2e: 0, calcTco2e: 0 },              // 0 = 0
    ]);
    assert.deepEqual(report.rows.map((row) => [row.v7RowId, row.flag]), [["r1", null], ["r2", "material"], ["r3", "zero-base"], ["r4", null], ["r5", null]]);
    assert.equal(report.rows[1]!.relative!.toFixed(2), "0.10");
    assert.equal(report.rows[2]!.relative, null, "no relative delta against a zero base");
    assert.deepEqual(report.flagged, ["r2", "r3"], "the job's own total (+1.5%) is within 5%, so only the rows are flagged");
    assert.equal(report.job.flag, null);
    assert.deepEqual(Object.keys(report.byScope), ["1", "2", "3"]);
    assert.deepEqual(Object.keys(report.bySite), ["pl", "uk", "unallocated"]);
    assert.equal(report.byScope["3"]!.flag, "zero-base");
    // A job whose own total moves > 5% is flagged as a job, ahead of its rows.
    const moved = v7EmissionDeltaReport([{ v7RowId: "a", liveRowId: "la", scope: "1", siteId: null, v7Tco2e: 10, calcTco2e: 12 }]);
    assert.deepEqual(moved.flagged, ["job", "a"]);
    assert.deepEqual(v7EmissionDelta(-10, -10.6).flag, "material", "the threshold is on the magnitude");
  });

  it("v7's apportionment: none or 0 is the whole quantity, as the plan carries it", () => {
    assert.equal(v7ApplyPct(null), 100);
    assert.equal(v7ApplyPct(undefined), 100);
    assert.equal(v7ApplyPct(0), 100);
    assert.equal(v7ApplyPct(40), 40);
    assert.ok(sameV7Quantity(0.1 + 0.2, 0.3));
    assert.ok(!sameV7Quantity(1000, 1000.001));
    // RULING 29 Oct: months fit the quantity to rounding (relative), never to a different number.
    assert.ok(monthsFitQuantity(10, 9.9996) && monthsFitQuantity(17133.8, 17133.81) && monthsFitQuantity(100, 100));
    assert.ok(!monthsFitQuantity(23421, 1186404) && !monthsFitQuantity(100, 999) && !monthsFitQuantity(0, 525) && !monthsFitQuantity(1, 1.001));
    assert.ok(sameV7CarriedQuantity(10, 9.9996, true), "a row carrying months may differ from v7's quantity by rounding");
    assert.ok(!sameV7CarriedQuantity(10, 9.9996, false), "a row without months carries v7's number exactly");
  });

  it("per row, each carried field must equal its v7 source — what catches two rows swapping sites with equal figures, or a dropped site", () => {
    const v7 = [{ rowId: "a", scope: "1", v7Tco2e: 5, reportedTotal: false, ...I, ...F, siteId: "uk" }, { rowId: "b", scope: "1", v7Tco2e: 5, reportedTotal: false, ...I, ...F, siteId: "pl" }];
    const swapped = [{ rowId: "la", reingestedFrom: "a", scope: "1", tco2e: 5, enabled: true, ...I, ...F, siteId: "pl" }, { rowId: "lb", reingestedFrom: "b", scope: "1", tco2e: 5, enabled: true, ...I, ...F, siteId: "uk" }];
    const misses = v7ReingestPostconditionMisses({ v7Rows: v7, liveRows: swapped, enabledMigratedAfter: 0 });
    assert.deepEqual(misses, [`row la: site "pl" ≠ v7's "uk"`, `row lb: site "uk" ≠ v7's "pl"`]);
    // J000663's bug: every row brought in Unallocated — each row names its own dropped site.
    const dropped = v7ReingestPostconditionMisses({ v7Rows: v7, liveRows: swapped.map((row) => ({ ...row, siteId: null })), enabledMigratedAfter: 0 });
    assert.deepEqual(dropped, [`row la: site none ≠ v7's "uk"`, `row lb: site none ≠ v7's "pl"`]);
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
