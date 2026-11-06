import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  carryNarrativeForward, clientMayEdit, isInFlight, isReportLocked, isReportVersionStatus, REPORT_VERSION_STATUSES, reportEditRefusal,
  staffMayEditNarrative, staffMayEditPlan,
} from "../src/reportLifecycle";

// Client-review loop S1 (RULING-reporting-client-review-state-model): editing is an ALLOW-LIST. A status that is not named — a value
// added later, or one that could not be read — is locked, so "may this be edited?" defaults to no.
describe("report version lifecycle: who may edit at each status (S1)", () => {
  it("the staff may amend the narrative while validated or in the open review round, and at no other status", () => {
    assert.deepEqual(REPORT_VERSION_STATUSES.filter(staffMayEditNarrative), ["validated", "in_client_review"]);
  });
  it("the client may edit only while the round is open — client_approved locks the client's side", () => {
    assert.deepEqual(REPORT_VERSION_STATUSES.filter(clientMayEdit), ["in_client_review"]);
    assert.equal(clientMayEdit("client_approved"), false);
  });
  it("the section order is set only while validated, before the version goes to the client", () => {
    assert.deepEqual(REPORT_VERSION_STATUSES.filter(staffMayEditPlan), ["validated"]);
  });
  it("a published report and a superseded one are locked in full", () => {
    for (const status of ["published", "superseded", "draft"]) assert.equal(isReportLocked(status), true, status);
    assert.equal(isReportLocked("client_approved"), true, "client-approved: the client's side is locked and the CRM's edit needs a reopen");
  });
  it("fail-safe: an unrecognised, unreadable or malformed status is locked, never editable", () => {
    for (const status of ["locked", "final", "IN_CLIENT_REVIEW", "validated ", "", null, undefined, 0, {}, ["validated"]]) {
      assert.equal(staffMayEditNarrative(status), false, String(status));
      assert.equal(clientMayEdit(status), false, String(status));
      assert.equal(staffMayEditPlan(status), false, String(status));
      assert.equal(isReportLocked(status), true, String(status));
      assert.equal(isReportVersionStatus(status), false, String(status));
    }
  });
  it("names the open statuses once, so an in-flight round is one definition everywhere", () => {
    assert.deepEqual(REPORT_VERSION_STATUSES.filter(isInFlight), ["in_client_review", "client_approved"]);
  });
  it("words the refusal for the status, and never offers an edit for an unknown one", () => {
    assert.match(reportEditRefusal("client_approved"), /Reopen it/);
    assert.match(reportEditRefusal("published"), /fixed as it was issued/);
    assert.match(reportEditRefusal("who-knows"), /locked/);
  });
});

describe("D7: carrying the narrative forward across a job-data unlock", () => {
  const element = (key: string, bodyHtml: string) => ({ key, bodyHtml, contentSource: "client-edited", sectionVersion: 1 });
  it("an in-flight round's words win, in the resolved (new plan's) order and membership", () => {
    const resolved = [element("executive-summary", "default"), element("background", "default"), element("reduction-actions", "default")];
    const inFlight = [element("reduction-actions", "settled"), element("executive-summary", "settled"), element("net-zero-commitment", "dropped from the plan")];
    const { narrative, carriedKeys } = carryNarrativeForward(resolved, inFlight);
    assert.deepEqual(narrative.map((e) => [e.key, e.bodyHtml]), [["executive-summary", "settled"], ["background", "default"], ["reduction-actions", "settled"]]);
    assert.deepEqual(carriedKeys, ["executive-summary", "reduction-actions"]);
  });
  it("a round with no frozen narrative carries nothing", () => {
    const resolved = [element("executive-summary", "default")];
    for (const none of [null, undefined, []]) assert.deepEqual(carryNarrativeForward(resolved, none), { narrative: resolved, carriedKeys: [] });
  });
});
