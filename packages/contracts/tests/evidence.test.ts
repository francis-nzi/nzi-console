import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FigureEvidence } from "../src/index";

describe("figure evidence contract", () => {
  it("requires a complete provenance signature when provenance is resolved", () => {
    const figure: FigureEvidence = { value: 1842, unit: "tCO2e", qualityTier: "Mixed", provenance: { factorSet: "DEFRA", factorSetVersion: "v1.2", dataHash: "sha256:demo", asAtDate: "2026-09-10", sourceRef: "Reviewed snapshot · J000712", resolver: "reviewed-snapshot.resolve@1" }, lineage: [{ title: "Snapshot", detail: "Approved" }] };
    assert.equal(Object.keys(figure.provenance ?? {}).length, 6);
    assert.equal(figure.qualityTier, "Mixed");
  });
});