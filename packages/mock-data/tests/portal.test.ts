import assert from "node:assert/strict";
import test from "node:test";
import { canAccessPortalJob, canEnterPortalData, portalAccessSample } from "../src/portal";

test("portal access is constrained to the granted client and jobs", () => {
  assert.equal(canAccessPortalJob(portalAccessSample, "bushy-tails", "712"), true);
  assert.equal(canAccessPortalJob(portalAccessSample, "bushy-tails", "713"), false);
  assert.equal(canAccessPortalJob(portalAccessSample, "another-client", "712"), false);
});

test("portal data entry is permissioned and expires", () => {
  assert.equal(canEnterPortalData(portalAccessSample, "2026-09-01T00:00:00Z"), true);
  assert.equal(canEnterPortalData(portalAccessSample, "2026-10-01T00:00:00Z"), false);
});
