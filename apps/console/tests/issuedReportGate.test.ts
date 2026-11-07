import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DOWNLOAD_PDF_LABEL, ISSUED_FINAL_NOTE, issuedFinalOf } from "../app/portal/jobs/[jobId]/issuedReportGate";
import { SIGNEE_EMPTY_HOW, SIGNEE_EMPTY_LEAD, signeeContactsHref } from "../app/lib/signeeHint";

// Client-review loop S8: the portal's issued-report gate (PDF-only once final-approved) and the report-signee pointer.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const HREF = "/portal/jobs/j1/print?report=rv1";

describe("the portal's issued-report gate (S8, piece A)", () => {
  it("a loop-completed report (final_approved_at) is the issued, locked view with a Download PDF; anything else is the view as it has always been", () => {
    assert.deepEqual(issuedFinalOf({ finalApproved: true }, HREF), { printHref: HREF });
    assert.equal(issuedFinalOf({ finalApproved: false }, HREF), null, "a directly-published report (final_approved_at null) keeps its current view - the J000663 guarantee");
    assert.equal(issuedFinalOf({}, HREF), null, "absent (an older response, the staff preview): unchanged");
    for (const odd of ["true", 1, null, "yes", {}]) assert.equal(issuedFinalOf({ finalApproved: odd }, HREF), null, `only a real true gates: ${String(odd)}`);
    assert.equal(DOWNLOAD_PDF_LABEL, "Download PDF");
    assert.match(ISSUED_FINAL_NOTE, /locked/);
  });
  it("the read route sends the marker from the version's final_approved_at, as a read, after the grant-checked selection", () => {
    const route = read("../app/api/portal/jobs/[jobId]/published-report/route.ts");
    assert.match(route, /finalApproved:await reportIsLoopFinal\(db,selected\.report\.reportVersionId\)/);
    assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
  });
  it("the page passes the gate to the workspace, which swaps the approval card for the issued card and drops the review thread - and nothing else keys on it", () => {
    const page = read("../app/portal/jobs/[jobId]/PortalReportPage.tsx");
    assert.match(page, /issuedFinal=\{issuedFinalOf\(body,/);
    const workspace = read("../app/portal-preview/PortalWorkspace.tsx");
    assert.match(workspace, /report&&clientMode&&issuedFinal\?<div id="issued-report" data-issued-final/);
    assert.match(workspace, /data-download-pdf href=\{issuedFinal\.printHref\}/, "the existing print path - no server-side PDF");
    assert.match(workspace, /\.\.\.\(issuedFinal\?\[\]:\[\{id:"messages" as const,label:"Review messages"\}\]\)/, "no review thread once issued");
    assert.equal((workspace.match(/issuedFinal/g) ?? []).length >= 6, true);
  });
});

describe("the report-signee pointer (S8, piece B)", () => {
  it("says what is missing and where to add it, and links to the client's Record tab (where the contact form's Report signee role is)", () => {
    assert.equal(signeeContactsHref("c 1"), "/clients/c%201?area=record");
    assert.match(SIGNEE_EMPTY_LEAD, /No contact is marked Report signee/);
    assert.match(SIGNEE_EMPTY_HOW, /Record tab/);
    assert.match(read("../app/clients/[clientId]/clientAreas.ts"), /id: "record", label: "Record"/, "the link's target tab exists");
    assert.match(read("../app/clients/[clientId]/ClientContacts.tsx"), /clientContactRoles\.map\(\(role\) => <label key=\{role\} className="nz-rolechk">/, "the form that offers the role");
  });
  it("the pointer shows only when the client genuinely has none - a pending or failed read says its own thing", () => {
    const studio = read("../app/jobs/[jobId]/report/ReportStudio.tsx");
    assert.match(studio, /Array\.isArray\(signees\) && signees\.length === 0 \? <SigneeEmptyHint/);
    const release = read("../app/jobs/CrpReleaseControl.tsx");
    assert.match(release, /Array\.isArray\(signees\)&&signees\.length===0\?<SigneeEmptyHint/);
    assert.match(studio, /"Signees could not be read"/);
  });
});
