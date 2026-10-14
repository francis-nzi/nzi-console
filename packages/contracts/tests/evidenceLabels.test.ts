import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { provenanceLabelsFromSnapshot, resolveClientEmissionsEvidence, type ReviewedCrpSnapshotReadModel, type SnapshotProvenanceStamp } from "../src/index";

// Ruled 13 Oct 2026 (REVIEW-report-srcline-and-B1-rulings): the evidence drawer names a figure's factor sets by dataset id,
// display only. Synthetic stamp shaped like a re-ingested job's: dataset name and version are the upload file name.
const stamp: SnapshotProvenanceStamp = {
  resolver: "crp.snapshot.issue@2",
  reportingPeriod: { from: "2025-01-01", to: "2025-12-31" },
  factorSets: [
    { source: "dataset", id: "uk-ghg-gb-2026", name: "tmpupload1.csv", version: "tmpupload1.csv" },
    { source: "dataset", id: "uk-ghg-gb-2025", name: "Conversion Factors 2019-2025.xlsx", version: "Conversion Factors 2019-2025.xlsx" },
    { source: "client", id: "cf-9", name: "Client factor · Recycled steel", version: "v3" },
  ],
  boundary: { siteIds: [], excludedRowIds: [] },
};
const snapshot = (provenance: SnapshotProvenanceStamp | undefined): ReviewedCrpSnapshotReadModel => ({
  id: "snap-1", jobId: "job-1", jobNumber: "J000001", client: "Synthetic Client", reportingYear: 2025, version: 1, jobVersion: 1,
  createdAt: "2026-05-02T09:30:00.000Z", createdBy: "reviewer", dataHash: "sha256:abc",
  target: null, intensityTarget: null, annualComparison: [], sections: [], gapResolutions: [], provenance,
  measurements: [{ rowId: "r1", rowVersion: 1, scope: "1", sourceLabel: "Gas", tco2e: 10, factorSet: "Gas · tmpupload1.csv", qualityTier: "measured", reviewedBy: "reviewer" }],
});

describe("the evidence drawer's factor-set labels (display only)", () => {
  it("names each dataset by its id — the edition is the id — and a client factor by its stamped name and version", () => {
    assert.deepEqual(provenanceLabelsFromSnapshot(snapshot(stamp)), {
      factorSet: "Client factor · Recycled steel · DESNZ GB 2025 · DESNZ GB 2026",
      factorSetVersion: "Client factor · Recycled steel v3 · DESNZ GB 2025 (uk-ghg-gb-2025) · DESNZ GB 2026 (uk-ghg-gb-2026)",
    });
  });

  it("every resolved figure carries them; no upload file name in them", () => {
    const evidence = resolveClientEmissionsEvidence({ current: snapshot(stamp), prior: null });
    for (const figure of [evidence.latest, ...evidence.scopes]) {
      assert.ok(figure.provenanceLabels, `${figure.unit}: labels`);
      assert.doesNotMatch(JSON.stringify(figure.provenanceLabels), /\.csv|\.xlsx/);
    }
  });

  it("the signature itself is untouched — the stamp's own names, as before; nothing is recomputed into it", () => {
    const { latest } = resolveClientEmissionsEvidence({ current: snapshot(stamp), prior: null });
    assert.equal(latest.provenance?.factorSet, "Client factor · Recycled steel · Conversion Factors 2019-2025.xlsx · tmpupload1.csv");
    assert.equal(latest.provenance?.dataHash, "sha256:abc");
    assert.deepEqual(Object.keys(latest.provenance!).sort(), ["asAtDate", "dataHash", "factorSet", "factorSetVersion", "resolver", "source", "sourceRef"]);
  });

  it("without a signature there are no labels — the drawer says provenance is unavailable, as it did", () => {
    assert.equal(provenanceLabelsFromSnapshot(snapshot(undefined)), null);
    const { latest } = resolveClientEmissionsEvidence({ current: snapshot(undefined), prior: null });
    assert.equal(latest.provenance, null);
    assert.equal("provenanceLabels" in latest, false);
  });
});
