// NZC-066 — an issued report and its PDF stay retrievable whatever the provenance
// stamp says. A snapshot issued before stamping (no stamp) and one whose stamp was
// backfilled (`migrated_unverified`) both come back in full; the stamp is context,
// never a gate. Only an evidence-hash mismatch — the report and its snapshot
// disagreeing about the figures — refuses, and that is unrelated to the stamp.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SnapshotProvenanceStamp } from "@nzi/contracts";
import { getCurrentPublishedCrpReport, getGrantedPublishedCrpReport, portalDeliverableRecords, portalPublicationEvidence, type Queryable } from "../src/index";

const stamp: SnapshotProvenanceStamp = {
  resolver: "crp.snapshot.issue@2",
  reportingPeriod: { from: "2025-04-01", to: "2026-03-31" },
  factorSets: [{ source: "dataset", id: "ds-1", name: "Synthetic GB factors", version: "2025.1" }],
  boundary: { siteIds: ["hq"], excludedRowIds: [] },
};

const payload = (provenance: SnapshotProvenanceStamp | undefined) => ({
  jobNumber: "J000712", client: "Synthetic Client", reportingYear: 2025, jobVersion: 4,
  target: null, intensityTarget: null, annualComparison: [], sections: [], gapResolutions: [],
  ...(provenance ? { provenance } : {}),
  measurements: [{ rowId: "row-a", rowVersion: 2, scope: "1", scopeCode: "1", sourceLabel: "Synthetic fuel", tco2e: 10, factorSet: "Synthetic GB factors 2025.1", qualityTier: "measured", reviewedBy: "reviewer-a" }],
});

const publishedRow = (provenance: SnapshotProvenanceStamp | undefined, dataHash = "sha256:published") => ({
  report_version_id: "report-a", manifest_version: 1, report_data_hash: dataHash, published_at: "2026-08-27T12:00:00.000Z",
  snapshot_id: "snapshot-a", job_id: "job-a", snapshot_version: 1, job_version: 4, data_hash: "sha256:published",
  created_by: "reviewer-a", created_at: "2026-08-27T11:00:00.000Z", payload_json: payload(provenance),
});

const pool = (row: ReturnType<typeof publishedRow>, granted = true): Queryable => ({
  async query(sql: string) {
    if (sql.includes("FROM nzi_console.portal_access_grants")) return { rows: granted ? [{ "?column?": 1 }] : [] } as never;
    return { rows: [row] } as never;
  },
});

const cases = [
  ["no stamp at all (issued before stamping)", undefined],
  ["a backfilled stamp", { ...stamp, source: "migrated_unverified" as const }],
  ["an issue-time stamp", stamp],
] as const;

describe("retrieving an issued report never depends on its provenance stamp (NZC-066)", () => {
  for (const [label, provenance] of cases) {
    it(`returns the published report with ${label}`, async () => {
      const report = await getCurrentPublishedCrpReport(pool(publishedRow(provenance)), "job-a");
      assert.ok(report, "the published report must come back");
      assert.equal(report.reportVersionId, "report-a");
      assert.equal(report.snapshot.measurements.length, 1);
      assert.equal(report.snapshot.provenance?.source ?? null, provenance?.source ?? null);
    });

    it(`serves the portal PDF evidence with ${label}`, async () => {
      const report = (await getGrantedPublishedCrpReport(pool(publishedRow(provenance)), { portalUserId: "portal-a", clientId: "client-a", jobId: "job-a" }))!;
      assert.ok(report, "a granted portal user must still get the report");
      const evidence = portalPublicationEvidence(report);
      assert.equal(evidence.evidenceHash, "sha256:published");
      assert.deepEqual(evidence.scopeTotals.find((total) => total.scope === "1"), { scope: "1", tco2e: 10 });
      // All three deliverables (report, certificate, methodology) are offered either way.
      assert.deepEqual(portalDeliverableRecords(report).map((record) => record.kind), ["report", "certificate", "methodology"]);
    });
  }

  it("still refuses when the report and its snapshot disagree about the figures — an evidence mismatch, not a stamp", async () => {
    await assert.rejects(() => getCurrentPublishedCrpReport(pool(publishedRow(stamp, "sha256:other")), "job-a"), /evidence hash does not match/i);
  });
});
