import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMovableReportSection, legacyReportSectionPlanV3 as defaultReportSectionPlan, moveReportSection, normaliseReportPlanKeys, reportSectionPlanIssues, type ReportSectionPlan } from "../src/reportComposition";

/** F-1b: what the editors' up/down buttons do to a plan — always to another valid plan. The fixture is the frozen v3 legacy plan
 * (B2-3): the move rules are unchanged, and the order this file was written against is that one. */
const order = (plan: ReportSectionPlan) => plan.filter((entry) => !entry.key.startsWith("narrative:")).map((entry) => entry.key);

describe("moving a section in a plan (F-1b)", () => {
  it("swaps a data section with its neighbouring movable data section, leaving the narrative where it is", () => {
    const moved = moveReportSection(defaultReportSectionPlan, "targets", "earlier");
    assert.deepEqual(order(moved), ["cover", "executive-summary", "emissions", "sites", "targets", "intensity", "plan", "srs", "methodology"]);
    const narrative = (plan: ReportSectionPlan) => plan.map((entry, index) => entry.key.startsWith("narrative:") ? `${index}:${entry.key}` : null).filter(Boolean);
    assert.deepEqual(narrative(moved), narrative(defaultReportSectionPlan), "every narrative entry keeps its index");
    assert.deepEqual(reportSectionPlanIssues(normaliseReportPlanKeys(moved)), [], "the result is a valid plan, once read complete (B2-3)");
  });

  it("moves across an embedded narrative entry to the next movable section", () => {
    // In the legacy plan the category narrative sits between emissions and sites: sites moves past it, it stays put.
    const moved = moveReportSection(defaultReportSectionPlan, "sites", "earlier");
    assert.deepEqual(order(moved).slice(0, 4), ["cover", "executive-summary", "sites", "emissions"]);
    assert.equal(moved.findIndex((entry) => entry.key === "narrative:category-analysis"), defaultReportSectionPlan.findIndex((entry) => entry.key === "narrative:category-analysis"));
  });

  it("moves the two standalone narrative sections like any section (ACCEPT-composed5-checkpoint2, decision 3) — the embedded four never", () => {
    assert.equal(isMovableReportSection("narrative:background"), true);
    assert.equal(isMovableReportSection("narrative:net-zero-commitment"), true);
    for (const key of ["narrative:executive-summary", "narrative:intensity-analysis", "narrative:category-analysis", "narrative:reduction-actions"] as const) assert.equal(isMovableReportSection(key), false, key);
    // Emissions moving earlier now swaps with Background, the movable section before it.
    const keys = moveReportSection(defaultReportSectionPlan, "emissions", "earlier").map((entry) => entry.key);
    assert.ok(keys.indexOf("emissions") < keys.indexOf("narrative:background"));
  });

  it("never moves the cover or the methodology, nor anything past them, nor past either end", () => {
    assert.equal(isMovableReportSection("cover"), false);
    assert.equal(isMovableReportSection("methodology"), false);
    assert.equal(isMovableReportSection("narrative:executive-summary"), false, "an embedded narrative rides with its host");
    assert.equal(moveReportSection(defaultReportSectionPlan, "cover", "later"), defaultReportSectionPlan);
    assert.equal(moveReportSection(defaultReportSectionPlan, "methodology", "earlier"), defaultReportSectionPlan);
    assert.equal(moveReportSection(defaultReportSectionPlan, "executive-summary", "earlier"), defaultReportSectionPlan, "first movable: nothing earlier but the cover");
    assert.equal(moveReportSection(defaultReportSectionPlan, "srs", "later"), defaultReportSectionPlan, "last movable: nothing later but the methodology");
  });

  it("leaves the input untouched", () => {
    const before = JSON.stringify(defaultReportSectionPlan);
    moveReportSection(defaultReportSectionPlan, "plan", "earlier");
    assert.equal(JSON.stringify(defaultReportSectionPlan), before);
  });
});
