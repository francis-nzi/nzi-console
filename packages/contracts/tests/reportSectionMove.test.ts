import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultReportSectionPlan, isMovableReportSection, moveReportSection, reportSectionPlanIssues, type ReportSectionPlan } from "../src/reportComposition";

/** F-1b: what the editors' up/down buttons do to a plan — always to another valid plan. */
const order = (plan: ReportSectionPlan) => plan.filter((entry) => !entry.key.startsWith("narrative:")).map((entry) => entry.key);

describe("moving a section in a plan (F-1b)", () => {
  it("swaps a data section with its neighbouring movable data section, leaving the narrative where it is", () => {
    const moved = moveReportSection(defaultReportSectionPlan, "targets", "earlier");
    assert.deepEqual(order(moved), ["cover", "executive-summary", "emissions", "sites", "targets", "intensity", "plan", "srs", "methodology"]);
    const narrative = (plan: ReportSectionPlan) => plan.map((entry, index) => entry.key.startsWith("narrative:") ? `${index}:${entry.key}` : null).filter(Boolean);
    assert.deepEqual(narrative(moved), narrative(defaultReportSectionPlan), "every narrative entry keeps its index");
    assert.deepEqual(reportSectionPlanIssues(moved), [], "the result is a valid plan");
  });

  it("moves across a narrative entry to the next data section", () => {
    // In the default, narrative entries sit between executive-summary and emissions.
    assert.deepEqual(order(moveReportSection(defaultReportSectionPlan, "emissions", "earlier")).slice(0, 3), ["cover", "emissions", "executive-summary"]);
  });

  it("never moves the cover or the methodology, nor anything past them, nor past either end", () => {
    assert.equal(isMovableReportSection("cover"), false);
    assert.equal(isMovableReportSection("methodology"), false);
    assert.equal(isMovableReportSection("narrative:background"), false);
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
