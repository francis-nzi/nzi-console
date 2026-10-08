import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countReportStages, deriveReportStatus, REPORT_STAGES, type ReportStatusFacts } from "../src/reportStatus";

// R-ST1 (ruled): a job's report status is derived from records the platform already keeps — never stored, never set.
const facts = (over: Partial<ReportStatusFacts> = {}): ReportStatusFacts => ({
  hasSnapshot: false, latestSnapshotApproved: false, hasValidatedVersion: false, published: null, v7Record: false, ...over });
const stage = (over: Partial<ReportStatusFacts>) => deriveReportStatus(facts(over)).stage;

describe("a CRP job's derived report status (R-ST1)", () => {
  it("moves through preparation, review, validation and publication as the records say", () => {
    assert.equal(stage({}), "in-preparation");
    assert.equal(stage({ hasSnapshot: true }), "awaiting-review");
    assert.equal(stage({ hasSnapshot: true, latestSnapshotApproved: true }), "ready-to-validate");
    assert.equal(stage({ hasSnapshot: true, latestSnapshotApproved: true, hasValidatedVersion: true }), "ready-to-publish");
    assert.equal(stage({ hasSnapshot: true, latestSnapshotApproved: true, published: { approvalCount: 0, lastCommentFrom: null } }), "awaiting-client");
  });

  it("derives 'changes requested' from the thread: the client spoke last and has not approved", () => {
    const published = (approvalCount: number, lastCommentFrom: "portal" | "staff" | null) => stage({ hasSnapshot: true, published: { approvalCount, lastCommentFrom } });
    assert.equal(published(0, "portal"), "changes-requested");
    assert.equal(published(0, "staff"), "awaiting-client", "we answered last: waiting on the client again");
    assert.equal(published(1, "portal"), "client-approved", "an approval outranks an open thread");
  });

  it("keeps the client's stage while a re-issue waits, and flags the re-issue", () => {
    assert.deepEqual(deriveReportStatus(facts({ hasSnapshot: true, hasValidatedVersion: true, published: { approvalCount: 1, lastCommentFrom: null } })),
      { stage: "client-approved", reissueReady: true });
  });

  it("never calls imported v7 history 'in preparation' — its record of account already exists", () => {
    assert.equal(stage({ v7Record: true }), "v7-record");
    assert.equal(stage({ v7Record: true, hasSnapshot: true }), "awaiting-review", "work begun in the console is the console's");
  });

  it("counts every stage, an empty one as a read zero", () => {
    const counts = countReportStages([{ stage: "awaiting-review" }, { stage: "awaiting-review" }, { stage: "client-approved" }]);
    assert.equal(counts["awaiting-review"], 2);
    assert.equal(counts["in-preparation"], 0);
    assert.deepEqual(Object.keys(counts).sort(), [...REPORT_STAGES, "v7-record"].sort());
  });
});
