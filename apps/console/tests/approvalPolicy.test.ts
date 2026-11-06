import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { approvalPolicyStatement } from "../app/admin/organisation/approvalPolicyText";
import { INDEPENDENT_APPROVAL_OFF_TEXT, IndependentApprovalMarker } from "../app/lib/IndependentApprovalMarker";

/**
 * 0215 (BRIEF-independent-approval-toggle): the in-app switch for NZC-022's separation of duties. The console half — the
 * Organisation card says plainly which state the organisation is in, the report studio never hides that independent approval
 * is off, the policy read answers "required" when it cannot read, and only admin.settings reaches the write.
 */
(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../app/${path}`, import.meta.url), "utf8");

describe("the organisation card states the policy", () => {
  it("required reads as required, whether default or set; off reads as off, and names whose work it frees", () => {
    assert.match(approvalPolicyStatement({ required: true, source: "server" }), /required \(the default\)/);
    assert.match(approvalPolicyStatement({ required: true, source: "organisation" }), /is required:/);
    assert.match(approvalPolicyStatement({ required: false, source: "organisation" }), /is off:.*own work.*recorded/);
    assert.match(approvalPolicyStatement({ required: false, source: "server" }), /server setting.*overrides it/);
  });
});

describe("the report studio's marker", () => {
  const html = (policy: Parameters<typeof IndependentApprovalMarker>[0]["policy"]) => renderToStaticMarkup(createElement(IndependentApprovalMarker, { policy }));
  it("is drawn when independent approval is off, with the honest wording", () => {
    const out = html({ required: false, source: "organisation" });
    assert.ok(out.includes("data-independent-approval-off"));
    assert.ok(out.includes(INDEPENDENT_APPROVAL_OFF_TEXT.replace("'", "&#x27;")) || out.includes("Independent approval is off for this organisation"));
  });
  it("says nothing when it is on, unknown or unreadable — it never claims 'off' it did not read", () => {
    for (const policy of [{ required: true, source: "server" as const }, { required: true, source: "unreadable" as const }, null, undefined]) assert.equal(html(policy), "");
  });
  it("is mounted in the studio, next to the controls that release a report", () => {
    const studio = read("jobs/[jobId]/report/ReportStudio.tsx");
    assert.match(studio, /useApprovalPolicy\(kind !== "published"\)/);
    assert.match(studio, /<IndependentApprovalMarker policy=\{approvalPolicy\} \/>/);
  });
});

describe("the routes", () => {
  const route = read("api/isolated/organisation/approval-policy/route.ts");
  it("write is the governed command (admin.settings, a reason); read is report.view and fails safe", () => {
    assert.match(route, /requireCommandPrincipal\(request, "organisation\.approvalPolicy\.set"\)/);
    assert.match(route, /requireCapability\(principal, "report\.view"\)/);
    assert.match(route, /readApprovalPolicySafely/);
    assert.ok(!/export async function (POST|PATCH|DELETE)/.test(route), "PUT and GET only");
  });
  it("the job's release controls read the organisation's policy, not just the server variable", () => {
    const snapshots = read("api/isolated/jobs/[jobId]/reviewed-snapshots/route.ts");
    assert.match(snapshots, /readApprovalPolicySafely\(db,organisationId\)\)\.required/);
    assert.ok(!/independentApprovalRequired\(\)/.test(snapshots), "no direct read of the env flag");
  });
  it("the Organisation page reads the policy without a fallback: an unreadable policy shows the page's error, never a toggle", () => {
    const page = read("admin/organisation/page.tsx");
    assert.match(page, /policy: await readApprovalPolicy\(db, access\.organisationId\)/);
  });
});
