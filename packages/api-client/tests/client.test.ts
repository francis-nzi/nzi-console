import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadFixtureScreen, requestScreen, resolveDataMode } from "../src/index";

describe("typed screen client", () => {
  it("rejects malformed fixture responses", () => assert.equal(loadFixtureScreen("platform", { services: [] }).state, "failed"));
  it("preserves degraded data with its warning", () => assert.equal(loadFixtureScreen("sales", { opportunities: [{}], prospects: [], runs: [] }, { warning: { code: "STALE", message: "Cached", retryable: true } }).state, "degraded"));
  it("maps transport failures to failed, never empty", async () => {
    const result = await requestScreen("clients", async () => { throw new Error("offline"); });
    assert.equal(result.state, "failed");
  });
  it("requires an explicit isolated URL and refuses production API mode", () => { assert.throws(() => resolveDataMode("isolated-api", "staging")); assert.throws(() => resolveDataMode("isolated-api", "production", "https://isolated.invalid")); assert.deepEqual(resolveDataMode("fixture", "staging"), { mode: "fixture" }); });
});
