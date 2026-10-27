import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * One name per area (27 Oct): the portal's Actions view holds two areas, and a client must not read "actions" twice. The
 * client's reduction plan is "Your reduction plan"; the job's qualitative tracker is "Spheres of influence". Labels only —
 * the flags (`portal-plan`, `portal-actions`) and the component names are unchanged.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const tracker = read("app/portal/jobs/[jobId]/PortalActionTracker.tsx");
const plan = read("app/portal/PortalReductionPlan.tsx");
const actionsPage = read("app/portal/jobs/[jobId]/actions/page.tsx");

describe("the two areas on the portal's Actions view have distinct names", () => {
  it("names the tracker \"Spheres of influence\" and the plan \"Your reduction plan\"", () => {
    assert.match(tracker, /<h2 id="action-tracker-title">Spheres of influence<\/h2>/);
    assert.match(plan, /<span className="nz-eyebrow">Your reduction plan<\/span>\s*<h2[^>]*>\{model\.total\} action\{[^}]*\} on your plan<\/h2>/);
  });

  it("never says \"action tracker\" to the client, and neither area's heading is \"Actions\"", () => {
    const visible = (source: string) => [...source.matchAll(/>([^<>{}]+)</g)].map((match) => match[1]!.trim()).filter(Boolean);
    for (const text of [...visible(tracker), ...visible(plan)]) {
      assert.doesNotMatch(text, /action tracker/i, `client copy: "${text}"`);
      assert.notEqual(text.toLowerCase(), "actions", `client copy: "${text}"`);
    }
    assert.doesNotMatch(tracker, /Spheres of Influence action tracker|Decarbonisation plan/);
    assert.doesNotMatch(plan, /Decarbonisation plan/);
  });

  it("keeps the flags and the component names", () => {
    assert.match(actionsPage, /portalFeatureEnabled\("portal-plan"\)/);
    assert.match(actionsPage, /portalFeatureEnabled\("portal-actions"\) \? <PortalActionTrackerPanel jobId=\{jobId\} \/>/);
    assert.match(actionsPage, /<PortalReductionPlan \/>/);
  });
});
