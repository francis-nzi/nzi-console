import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveClientEmissionsEvidence, type ReviewedCrpSnapshotReadModel, type SnapshotProvenanceStamp } from "../src/index";

type Measurement = ReviewedCrpSnapshotReadModel["measurements"][number];
const row = (rowId: string, scope: "1" | "2" | "3", tco2e: number, qualityTier: Measurement["qualityTier"]): Measurement =>
  ({ rowId, rowVersion: 1, scope, sourceLabel: rowId, tco2e, factorSet: "Synthetic factor · 2025", qualityTier, reviewedBy: "reviewer" });

const stamp: SnapshotProvenanceStamp = {
  resolver: "crp.snapshot.issue@2",
  reportingPeriod: { from: "2024-04-01", to: "2025-03-31" },
  factorSets: [{ source: "dataset", id: "ds-1", name: "Synthetic GB factors", version: "2025.1" }, { source: "client", id: "cf-9", name: "Client factor · Recycled steel", version: "v3" }],
  boundary: { siteIds: ["hq"], excludedRowIds: ["r-old-depot"] },
};

const snapshot = (overrides: Partial<ReviewedCrpSnapshotReadModel> = {}): ReviewedCrpSnapshotReadModel => ({
  id: "snap-2", jobId: "job-24", jobNumber: "J000724", client: "Synthetic Client", reportingYear: 2024, version: 2, jobVersion: 7,
  createdAt: "2026-05-02T09:30:00.000Z", createdBy: "reviewer", dataHash: "sha256:abc",
  target: null, intensityTarget: null, annualComparison: [], sections: [], gapResolutions: [],
  provenance: stamp,
  measurements: [row("r1", "1", 100, "measured"), row("r2", "2", 50, "measured"), row("r3", "3", 30, "spend-based"), row("r4", "3", 20, "estimated")],
  ...overrides,
});

describe("client figure evidence (NZC-005)", () => {
  it("resolves the total, per-scope values and a genuinely mixed Scope 3 from the snapshot's own rows", () => {
    const evidence = resolveClientEmissionsEvidence({ current: snapshot(), prior: null });
    assert.equal(evidence.state, "resolved");
    assert.equal(evidence.latest.value, 200);
    assert.deepEqual(evidence.scopes.map((scope) => [scope.scope, scope.value, scope.qualityTier]), [["1", 100, "Measured"], ["2", 50, "Measured"], ["3", 50, "Mixed"]]);
    assert.deepEqual(evidence.scopes[2]!.tiers, [{ tier: "Spend-based", tco2e: 30 }, { tier: "Estimated", tco2e: 20 }]);
    assert.equal(evidence.latest.source?.jobId, "job-24");
  });

  it("reads the signature from the issue-time stamp — never a literal", () => {
    const { latest } = resolveClientEmissionsEvidence({ current: snapshot(), prior: null });
    assert.deepEqual(latest.provenance, {
      factorSet: "Client factor · Recycled steel · Synthetic GB factors",
      factorSetVersion: "Client factor · Recycled steel v3 · Synthetic GB factors 2025.1",
      dataHash: "sha256:abc", asAtDate: "2026-05-02", sourceRef: "J000724 · reviewed snapshot v2", resolver: "crp.snapshot.issue@2",
    });
    assert.ok(latest.lineage.some((step) => step.detail.includes("1 out-of-boundary row excluded")));
  });

  it("returns null provenance (so the UI says 'unavailable') for a snapshot issued before stamping", () => {
    const { latest, scopes } = resolveClientEmissionsEvidence({ current: snapshot({ provenance: undefined }), prior: null });
    assert.equal(latest.provenance, null);
    assert.equal(latest.value, 200);
    assert.match(latest.note ?? "", /Provenance unavailable/);
    assert.equal(scopes[0]!.provenance, null);
  });

  it("does not call an empty scope Mixed", () => {
    const { scopes } = resolveClientEmissionsEvidence({ current: snapshot({ measurements: [row("r1", "1", 10, "measured")] }), prior: null });
    assert.equal(scopes[1]!.qualityTier, null);
    assert.match(scopes[1]!.note ?? "", /No Scope 2 rows/);
  });

  it("makes a missing intensity unavailable — never zero with a full signature", () => {
    const { intensity } = resolveClientEmissionsEvidence({ current: snapshot(), prior: null });
    assert.equal(intensity.state, "unavailable");
    assert.equal(intensity.value, null);
    assert.equal(intensity.provenance, null);
  });

  it("divides by a site floor-area denominator and says it cannot when one is missing (NZC-071)", () => {
    const target = { jobId: "job-24", metric: "floor-area" as const, denominatorUnit: "m²", baselineYear: 2023, baselineIntensity: 0.2, interimYear: 2030, interimReductionPercent: 40, netZeroYear: 2045, version: 1, updatedAt: "2026-01-01", updatedBy: "consultant" };
    const resolved = resolveClientEmissionsEvidence({ current: snapshot({ intensityTarget: { ...target, reportingDenominator: 1000, denominatorBasis: { kind: "site-floor-area", state: "resolved", reason: null, sites: [{ siteId: "hq", name: "HQ", floorAreaM2: 1000 }] } } }), prior: null }).intensity;
    assert.equal(resolved.value, 0.2);
    assert.ok(resolved.lineage.some((step) => step.title === "Denominator" && step.detail.includes("HQ")));
    const missing = resolveClientEmissionsEvidence({ current: snapshot({ intensityTarget: { ...target, reportingDenominator: null, denominatorBasis: { kind: "site-floor-area", state: "unavailable", reason: "No floor area is recorded for Yard.", sites: [] } } }), prior: null }).intensity;
    assert.equal(missing.state, "unavailable");
    assert.match(missing.note ?? "", /Yard/);
  });

  it("derives year-on-year from the prior reviewed snapshot, and is unavailable without one", () => {
    const prior = snapshot({ id: "snap-1", jobId: "job-23", jobNumber: "J000611", reportingYear: 2023, measurements: [row("p1", "1", 250, "measured")] });
    const { yoy } = resolveClientEmissionsEvidence({ current: snapshot(), prior });
    assert.ok(Math.abs((yoy.value ?? 0) + 20) < 1e-9, String(yoy.value));
    assert.ok(yoy.lineage.some((step) => step.detail.includes("J000611")));
    assert.equal(resolveClientEmissionsEvidence({ current: snapshot(), prior: null }).yoy.state, "unavailable");
  });

  it("shows no figure at all — not a stand-in total — for a client with no reviewed snapshot", () => {
    const evidence = resolveClientEmissionsEvidence({ current: null, prior: null });
    assert.equal(evidence.state, "empty");
    assert.equal(evidence.latest.value, null);
    assert.ok(evidence.scopes.every((scope) => scope.value === null && scope.provenance === null));
  });
});
