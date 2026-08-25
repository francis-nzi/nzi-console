import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contractFor, hasData, type ScreenKey, type ScreenResult } from "../src/index";

describe("screen contracts", () => {
  it("registers and validates Sales V2 payloads", () => {
    const contract = contractFor("sales");
    assert.equal(contract.validate({ opportunities: [], prospects: [], runs: [] }), true);
    assert.equal(contract.validate({ opportunities: [] }), false);
  });
  it("does not treat failed as empty", () => {
    const failed: ScreenResult<never> = { state: "failed", meta: { contract: "jobs", receivedAt: "now", source: "api", requestId: "r1" }, error: { code: "UPSTREAM", message: "Unavailable", retryable: true } };
    assert.equal(hasData(failed), false);
    assert.notEqual(failed.state, "empty");
  });
  it("has a valid registered shape for every navigable screen", () => {
    const valid: Record<string, unknown> = {
      control: {}, clients: { clients: [] }, jobs: { jobs: [] }, job: { job: {} }, charts: {},
      datasets: { datasets: [], issues: [] }, reports: { reports: [] }, report: { report: {} },
      lca: { assessments: [] }, portal: {}, sales: { opportunities: [], prospects: [], runs: [] },
      platform: { services: [], events: [], roles: [] },
    };
    for (const [key, payload] of Object.entries(valid)) assert.equal(contractFor(key as ScreenKey).validate(payload), true, key);
  });
});
