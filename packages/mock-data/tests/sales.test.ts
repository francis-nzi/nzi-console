import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canCreateJob, salesOpportunities, weightedPipeline } from "../src/sales";

describe("Sales V2 lifecycle", () => {
  it("separates open stage from terminal status", () => {
    assert.deepEqual([...new Set(salesOpportunities.filter((item) => item.status === "OPEN").map((item) => item.stage))].sort(), ["discovery", "negotiation", "proposal"]);
  });
  it("weights only open pipeline", () => assert.equal(weightedPipeline(salesOpportunities), 33700));
  it("allows job handoff only after a confirmed win with a quote", () => {
    assert.equal(canCreateJob(salesOpportunities[0]!), false);
    assert.equal(canCreateJob(salesOpportunities[3]!), true);
  });
});
