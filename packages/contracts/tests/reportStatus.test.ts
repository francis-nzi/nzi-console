import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countReportStages, deriveReportStatus, REPORT_STAGES, type PublishedScopeFacts, type ReportStatusFacts } from "../src/reportStatus";

// R-ST1 (ruled): a job's report status is derived from records the platform already keeps — never stored, never set.
const facts = (over: Partial<ReportStatusFacts> = {}): ReportStatusFacts => ({
  hasSnapshot: false, latestSnapshotApproved: false, hasValidatedVersion: false, published: [], v7Record: false, ...over });
const stage = (over: Partial<ReportStatusFacts>) => deriveReportStatus(facts(over)).stage;
const scope = (approvalCount: number, lastCommentFrom: "portal" | "staff" | null, scopeLabel = "Whole client"): PublishedScopeFacts => ({ scopeLabel, approvalCount, lastCommentFrom });

describe("a CRP job's derived report status (R-ST1)", () => {
  it("moves through preparation, review, validation and publication as the records say", () => {
    assert.equal(stage({}), "in-preparation");
    assert.equal(stage({ hasSnapshot: true }), "awaiting-review");
    assert.equal(stage({ hasSnapshot: true, latestSnapshotApproved: true }), "ready-to-validate");
    assert.equal(stage({ hasSnapshot: true, latestSnapshotApproved: true, hasValidatedVersion: true }), "ready-to-publish");
    assert.equal(stage({ hasSnapshot: true, latestSnapshotApproved: true, published: [scope(0, null)] }), "awaiting-client");
  });

  it("derives 'changes requested' from the thread: the client spoke last and has not approved", () => {
    const published = (approvalCount: number, lastCommentFrom: "portal" | "staff" | null) => stage({ hasSnapshot: true, published: [scope(approvalCount, lastCommentFrom)] });
    assert.equal(published(0, "portal"), "changes-requested");
    assert.equal(published(0, "staff"), "awaiting-client", "we answered last: waiting on the client again");
    assert.equal(published(1, "portal"), "client-approved", "an approval outranks an open thread");
  });

  it("keeps the client's stage while a re-issue waits, and flags the re-issue", () => {
    assert.deepEqual(deriveReportStatus(facts({ hasSnapshot: true, hasValidatedVersion: true, published: [scope(1, null)] })),
      { stage: "client-approved", reissueReady: true });
  });

  it("with several published scopes (S-1), shows the one that most needs attention, and each scope's own stage", () => {
    const status = deriveReportStatus(facts({ hasSnapshot: true, published: [scope(1, null, "Whole client"), scope(0, "portal", "Works")] }));
    assert.equal(status.stage, "changes-requested", "an approval elsewhere never hides a change request");
    assert.deepEqual(status.scopes, [{ scopeLabel: "Whole client", stage: "client-approved" }, { scopeLabel: "Works", stage: "changes-requested" }]);
    assert.equal(stage({ hasSnapshot: true, published: [scope(1, null), scope(0, null, "Works")] }), "awaiting-client", "one scope still to approve");
    assert.equal(stage({ hasSnapshot: true, published: [scope(1, null), scope(2, "portal", "Works")] }), "client-approved", "every scope approved");
    assert.equal(deriveReportStatus(facts({ published: [scope(0, null)] })).scopes, undefined, "one scope needs no breakdown");
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

// Client-review loop S1 (Risk #3): the STORED status is read first, so the register and the version cannot disagree.
describe("a round in the client-review loop is judged by its stored status (S1)", () => {
  const round = (status: "published" | "in_client_review" | "client_approved", approvalCount: number, lastCommentFrom: "portal" | "staff" | null, scopeLabel = "Whole client"): PublishedScopeFacts =>
    ({ scopeLabel, approvalCount, lastCommentFrom, status, scopeKey: scopeLabel });
  const loop = (...published: PublishedScopeFacts[]) => stage({ hasSnapshot: true, published });
  it("in_client_review awaits the client, or has changes requested when the client spoke last", () => {
    assert.equal(loop(round("in_client_review", 0, null)), "awaiting-client");
    assert.equal(loop(round("in_client_review", 0, "staff")), "awaiting-client");
    assert.equal(loop(round("in_client_review", 0, "portal")), "changes-requested");
  });
  it("client_approved is client-approved whatever the thread says; an open round is never read as approved by a stray approval count", () => {
    assert.equal(loop(round("client_approved", 1, "portal")), "client-approved");
    assert.equal(loop(round("client_approved", 0, null)), "client-approved");
    assert.equal(loop(round("in_client_review", 3, null)), "awaiting-client", "the stored status outranks the approval records");
  });
  it("a reopened round is the scope's stage; the published version it will replace is still live but is not where the work is", () => {
    assert.equal(loop(round("published", 1, null), round("in_client_review", 0, null)), "awaiting-client");
    assert.equal(loop(round("published", 0, "portal"), round("client_approved", 1, null)), "client-approved");
    const status = deriveReportStatus(facts({ hasSnapshot: true, published: [round("published", 1, null), round("in_client_review", 0, null), round("published", 1, null, "Works")] }));
    assert.deepEqual(status.scopes, [{ scopeLabel: "Whole client", stage: "awaiting-client" }, { scopeLabel: "Works", stage: "client-approved" }], "one entry per scope; another scope is unaffected");
  });
  it("a status-less entry is the direct-publish path, derived as before", () => {
    assert.equal(loop({ scopeLabel: "Whole client", approvalCount: 1, lastCommentFrom: null }), "client-approved");
    assert.equal(loop({ scopeLabel: "Whole client", approvalCount: 0, lastCommentFrom: null }), "awaiting-client");
  });
});
