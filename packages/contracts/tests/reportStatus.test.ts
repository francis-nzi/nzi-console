import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countReportStages, CRM_TURN_STAGES, crmQueue, crmTurn, deriveReportStatus, REPORT_STAGES, reportStageLabels, type PublishedScopeFacts, type ReportStatusFacts } from "../src/reportStatus";

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
  it("in_client_review awaits the client, or reads client-responded when the client spoke last", () => {
    assert.equal(loop(round("in_client_review", 0, null)), "awaiting-client");
    assert.equal(loop(round("in_client_review", 0, "staff")), "awaiting-client");
    assert.equal(loop(round("in_client_review", 0, "portal")), "client-responded");
  });
  it("client_approved is client-approved whatever the thread says; an open round is never read as approved by a stray approval count", () => {
    assert.equal(loop(round("client_approved", 1, "portal")), "awaiting-final-approval");
    assert.equal(loop(round("client_approved", 0, null)), "awaiting-final-approval");
    assert.equal(loop(round("in_client_review", 3, null)), "awaiting-client", "the stored status outranks the approval records");
  });
  it("a reopened round is the scope's stage; the published version it will replace is still live but is not where the work is", () => {
    assert.equal(loop(round("published", 1, null), round("in_client_review", 0, null)), "awaiting-client");
    assert.equal(loop(round("published", 0, "portal"), round("client_approved", 1, null)), "awaiting-final-approval");
    const status = deriveReportStatus(facts({ hasSnapshot: true, published: [round("published", 1, null), round("in_client_review", 0, null), round("published", 1, null, "Works")] }));
    assert.deepEqual(status.scopes, [{ scopeLabel: "Whole client", stage: "awaiting-client" }, { scopeLabel: "Works", stage: "client-approved" }], "one entry per scope; another scope is unaffected");
  });
  it("a status-less entry is the direct-publish path, derived as before (S6 leaves it alone: changes-requested still reads off the thread)", () => {
    assert.equal(loop({ scopeLabel: "Whole client", approvalCount: 0, lastCommentFrom: "portal" }), "changes-requested");
    assert.equal(loop({ scopeLabel: "Whole client", approvalCount: 1, lastCommentFrom: null }), "client-approved");
    assert.equal(loop({ scopeLabel: "Whole client", approvalCount: 0, lastCommentFrom: null }), "awaiting-client");
  });
});

// Client-review loop S6: whose turn a round open for review is - the client's latest act against the team's. Exhaustive on the orderings.
describe("whose turn it is on a round open for review (S6)", () => {
  const T = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 9, minutes)).toISOString();
  const open = (lastClientActionAt: string | null, lastStaffActionAt: string | null, lastCommentFrom: "portal" | "staff" | null = null): PublishedScopeFacts =>
    ({ scopeLabel: "Whole client", approvalCount: 0, lastCommentFrom, status: "in_client_review", scopeKey: "whole", lastClientActionAt, lastStaffActionAt });
  const read = (round: PublishedScopeFacts) => deriveReportStatus({ hasSnapshot: true, latestSnapshotApproved: true, hasValidatedVersion: false, published: [round], v7Record: false }).stage;

  it("the client acting after the team is the CRM's turn: responded, review needed", () => {
    assert.equal(read(open(T(30), T(10))), "client-responded", "a client edit or message after the round was sent / the last reply");
    assert.equal(read(open(T(30), null)), "client-responded", "the team has never acted");
    assert.equal(reportStageLabels["client-responded"], "Client responded — review needed");
  });
  it("the team acting last, or at the same instant, leaves it with the client", () => {
    assert.equal(read(open(T(10), T(30))), "awaiting-client", "the team replied after the client");
    assert.equal(read(open(T(30), T(30))), "awaiting-client", "a tie is the team's - it spoke last");
    assert.equal(read(open(null, T(30))), "awaiting-client", "the client has done nothing");
    assert.equal(read(open(null, null)), "awaiting-client", "nobody has acted");
  });
  it("it turns over each time: client, then team, then client again", () => {
    assert.deepEqual([read(open(T(5), T(1))), read(open(T(5), T(9))), read(open(T(20), T(9)))], ["client-responded", "awaiting-client", "client-responded"]);
  });
  it("when the times are not given, the thread's last author decides, as before", () => {
    assert.equal(read({ scopeLabel: "Whole client", approvalCount: 0, lastCommentFrom: "portal", status: "in_client_review", scopeKey: "whole" }), "client-responded");
    assert.equal(read({ scopeLabel: "Whole client", approvalCount: 0, lastCommentFrom: "staff", status: "in_client_review", scopeKey: "whole" }), "awaiting-client");
  });
  it("an unreadable time is never read as the client acting", () => {
    assert.equal(read(open("not a time", T(10))), "awaiting-client");
  });
  it("client_approved reads awaiting final approval whatever the times say; a published report is judged as before", () => {
    assert.equal(read({ ...open(T(30), T(10)), status: "client_approved" }), "awaiting-final-approval");
    assert.equal(read({ ...open(T(10), T(30)), status: "client_approved" }), "awaiting-final-approval");
    assert.equal(read({ scopeLabel: "Whole client", approvalCount: 1, lastCommentFrom: "portal", status: "published", scopeKey: "whole", lastClientActionAt: T(30), lastStaffActionAt: T(10) }), "client-approved");
  });
  it("across scopes the job shows what needs the team first, and the queue counts each scope that does - not one awaiting the client", () => {
    const status = deriveReportStatus({ hasSnapshot: true, latestSnapshotApproved: true, hasValidatedVersion: false, v7Record: false,
      published: [open(T(30), T(10)), { ...open(T(1), T(2)), scopeLabel: "Works", scopeKey: "works" }, { ...open(T(1), T(2)), scopeLabel: "Depot", scopeKey: "depot", status: "client_approved" }] });
    assert.equal(status.stage, "client-responded");
    assert.deepEqual(crmQueue([status]), { total: 2, byStage: { "client-responded": 1, "changes-requested": 0, "awaiting-final-approval": 1 } });
  });
  it("the queue is the CRM's turn only: responded, changes requested and awaiting final approval - never awaiting the client or approved", () => {
    const rows = (["awaiting-client", "client-approved", "client-responded", "changes-requested", "awaiting-final-approval", "in-preparation", "ready-to-publish"] as const).map((stage) => ({ stage }));
    assert.deepEqual(crmQueue(rows), { total: 3, byStage: { "client-responded": 1, "changes-requested": 1, "awaiting-final-approval": 1 } });
    assert.deepEqual(crmQueue([]), { total: 0, byStage: { "client-responded": 0, "changes-requested": 0, "awaiting-final-approval": 0 } });
    assert.deepEqual(CRM_TURN_STAGES.map(crmTurn), [true, true, true]);
    assert.equal(crmTurn("awaiting-client"), false);
  });
});
