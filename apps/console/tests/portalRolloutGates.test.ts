import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * The client portal's rollout gates (NZC-080).
 *
 * The plan and the readiness statement shipped without one, which left no way to withdraw
 * either short of a revert. These hold the retrofit: each surface renders when its token is
 * present and is absent when it is not.
 */

const original = process.env.NEXT_PUBLIC_FEATURE_PORTAL;
afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_FEATURE_PORTAL;
  else process.env.NEXT_PUBLIC_FEATURE_PORTAL = original;
});

/**
 * The module is cached after the first import, which does not matter: `portalFeatureEnabled`
 * re-reads `process.env` on every call rather than closing over it at import time. That is
 * what makes these tests exercise the real resolution rather than a snapshot of it.
 */
const flags = async () => import("../app/lib/portalFlags");

describe("each portal surface resolves on its own token", () => {
  it("is enabled when its token is present", async () => {
    process.env.NEXT_PUBLIC_FEATURE_PORTAL = "portal-analytics,portal-actions,portal-plan,portal-readiness";
    const { portalFeatureEnabled } = await flags();
    assert.equal(portalFeatureEnabled("portal-plan"), true);
    assert.equal(portalFeatureEnabled("portal-readiness"), true);
  });

  it("is hidden when its token is absent", async () => {
    // The state that was impossible before the retrofit: turning one off without a revert.
    process.env.NEXT_PUBLIC_FEATURE_PORTAL = "portal-analytics,portal-actions";
    const { portalFeatureEnabled } = await flags();
    assert.equal(portalFeatureEnabled("portal-plan"), false);
    assert.equal(portalFeatureEnabled("portal-readiness"), false);
  });

  it("turns one off without touching the other", async () => {
    // They are separate surfaces and separate tokens; withdrawing readiness must not take
    // the plan with it.
    process.env.NEXT_PUBLIC_FEATURE_PORTAL = "portal-plan";
    const { portalFeatureEnabled } = await flags();
    assert.equal(portalFeatureEnabled("portal-plan"), true);
    assert.equal(portalFeatureEnabled("portal-readiness"), false);
  });

  it("is off when the variable is unset entirely — off by default, as the convention requires", async () => {
    delete process.env.NEXT_PUBLIC_FEATURE_PORTAL;
    const { portalFeatureEnabled } = await flags();
    for (const token of ["portal-plan", "portal-readiness", "portal-analytics", "portal-actions"] as const) {
      assert.equal(portalFeatureEnabled(token), false, token);
    }
  });

  it("ignores spacing and case, as the existing tokens do", async () => {
    process.env.NEXT_PUBLIC_FEATURE_PORTAL = " Portal-Plan , portal-readiness ";
    const { portalFeatureEnabled } = await flags();
    assert.equal(portalFeatureEnabled("portal-plan"), true);
    assert.equal(portalFeatureEnabled("portal-readiness"), true);
  });
});

describe("the portal home gates both surfaces", () => {
  const home = read("apps/console/app/portal/PortalHome.tsx");

  it("wraps each component in its own token check", () => {
    assert.match(home, /portalFeatureEnabled\("portal-plan"\)\?<PortalReductionPlan\/>:null/);
    assert.match(home, /portalFeatureEnabled\("portal-readiness"\)\?<PortalReadiness\/>:null/);
  });

  it("leaves neither rendering unconditionally", () => {
    // The state this change exists to end.
    assert.doesNotMatch(home, /\n\s*<PortalReductionPlan\/>/);
    assert.doesNotMatch(home, /\n\s*<PortalReadiness\/>/);
  });

  it("declares both tokens in the type, so a typo is a compile error", () => {
    const flagsSource = read("apps/console/app/lib/portalFlags.ts");
    assert.match(flagsSource, /"portal-plan"/);
    assert.match(flagsSource, /"portal-readiness"/);
  });

  it("keeps render.yaml in step with the dashboard value", () => {
    // NZC-079: the file is documentation, but it must not be wrong about what is running.
    assert.match(read("render.yaml"), /value: portal-analytics,portal-actions,portal-plan,portal-readiness/);
  });
});
