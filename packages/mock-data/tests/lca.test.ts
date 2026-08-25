import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessmentReadiness, lcaAssessments } from "../src/lca";

describe("LCA assessment readiness", () => {
  it("derives readiness from mapping states and transport coverage", () => {
    const readiness = assessmentReadiness(lcaAssessments[0]!);
    assert.deepEqual(readiness, { mappedLines: 3, reviewLines: 1, unmappedLines: 1, inventoryPct: 80, transportPct: 88 });
  });

  it("keeps official job numbers and family standards", () => {
    assert.deepEqual(lcaAssessments.map((assessment) => assessment.jobNumber), ["J000714", "J000715"]);
    assert.equal(lcaAssessments[1]!.standard, "ISO 14067");
  });
});
