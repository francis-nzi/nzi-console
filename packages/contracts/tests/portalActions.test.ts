import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPortalActionTracker, portalActionLevers } from "../src/index";

describe("portal A2-lite Spheres of Influence", () => {
  it("preserves the live 3 / 9 / 24 taxonomy in stable order", () => {
    assert.equal(portalActionLevers.length, 24);
    assert.deepEqual([...new Set(portalActionLevers.map((lever) => lever.sphereCode))], ["A", "B", "C"]);
    assert.equal(new Set(portalActionLevers.map((lever) => lever.subSphereCode)).size, 9);
    assert.equal(new Set(portalActionLevers.map((lever) => lever.code)).size, 24);
    assert.equal(portalActionLevers[0]?.code, "A1.1");
    assert.equal(portalActionLevers[23]?.code, "C3.2");
  });

  it("has no emissions or projection fields and validates the tracker envelope", () => {
    const fields = new Set(portalActionLevers.flatMap((lever) => Object.keys(lever)));
    for (const forbidden of ["tco2e", "factor", "projected", "reductionPercent", "impact"]) assert.equal(fields.has(forbidden), false, forbidden);
    assert.equal(isPortalActionTracker({ levers: portalActionLevers, actions: [] }), true);
    assert.equal(isPortalActionTracker({ levers: portalActionLevers.slice(1), actions: [] }), false);
  });
});
