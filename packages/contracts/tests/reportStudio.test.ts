import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeStudioPlan, decodeStudioScope, defaultReportSectionPlan, encodeStudioPlan, encodeStudioScope, setReportSectionIncluded } from "../src/index";

// B2-2: the Report Studio's draft carries the rail's plan and scope in its URL — one encoding, shared by the studio and the route.
describe("the studio's plan and scope in a URL", () => {
  it("a plan round-trips exactly — every entry, in order, in or out", () => {
    const plan = setReportSectionIncluded(defaultReportSectionPlan, "srs", false, { allowExclusion: true });
    assert.deepEqual(decodeStudioPlan(encodeStudioPlan(plan)), plan.map(({ key, included }) => ({ key, included })));
    assert.deepEqual(decodeStudioPlan(encodeStudioPlan(defaultReportSectionPlan)), defaultReportSectionPlan.map(({ key, included }) => ({ key, included })));
  });

  it("a malformed or unknown plan reads as nothing asked — never a guessed plan", () => {
    for (const bad of ["", "cover:1,nonsense:1", "cover:2", "cover", "cover:1,,emissions:1", "narrative:unknown:1"]) assert.equal(decodeStudioPlan(bad), null, bad);
    assert.equal(decodeStudioPlan(null), null);
  });

  it("a scope round-trips; anything else reads as nothing asked", () => {
    assert.deepEqual(decodeStudioScope(encodeStudioScope({ kind: "whole" })), { kind: "whole" });
    assert.deepEqual(decodeStudioScope(encodeStudioScope({ kind: "sites", siteIds: ["s-a", "s-b"] })), { kind: "sites", siteIds: ["s-a", "s-b"] });
    assert.deepEqual(decodeStudioScope("sites:"), { kind: "sites", siteIds: [] }, "an empty site scope is kept, so validate's own refusal applies");
    assert.equal(decodeStudioScope("everything"), null);
    assert.equal(decodeStudioScope(undefined), null);
  });
});
