import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditEvents, platformServices, platformSummary, staffRoles, tenantIsolationPass } from "../src/platform";

describe("Platform governance", () => {
  it("keeps degraded and unconfigured services distinct from failure", () => assert.deepEqual(platformSummary(platformServices), { healthy: 4, degraded: 1, failed: 0, unconfigured: 1 }));
  it("requires tenant and correlation evidence on every audit event", () => assert.equal(tenantIsolationPass(auditEvents), true));
  it("keeps read-only staff mutation-free", () => assert.ok(staffRoles.find((role) => role.id === "readonly")!.restricted.includes("All mutations")));
});
