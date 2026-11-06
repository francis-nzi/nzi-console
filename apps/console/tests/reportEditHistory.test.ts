import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
void React;
import { renderToStaticMarkup } from "react-dom/server";
import { editHeadline, historyText } from "../app/jobs/[jobId]/report/editHistory";
import { ReportEditHistory } from "../app/jobs/[jobId]/report/ReportEditHistory";

// Client-review loop S3: the report studio's edit-history view.
describe("the studio's edit history (S3)", () => {
  it("shows narrative HTML as plain words, a figure token as its key in braces - the history holds no figure", () => {
    assert.equal(historyText(`<p>Our footprint was <span data-token="total"></span> in <span data-token="reportingYear"></span>.</p><p>Second &amp; last.</p>`), "Our footprint was {total} in {reportingYear}. Second & last.");
    assert.equal(historyText("<p>  spaced   out </p>"), "spaced out");
  });
  it("headlines who did what where, naming a client edit as the client's", () => {
    assert.equal(editHeadline({ actorName: "Ada Admin", actorId: "ada", principal: "staff", action: "amend", sectionKey: "background" }), "Ada Admin (staff) amended background");
    assert.equal(editHeadline({ actorName: null, actorId: "pu-1", principal: "portal", action: "edit", sectionKey: "background" }), "pu-1 (client) edited background");
    assert.equal(editHeadline({ actorName: "Ada", actorId: "ada", principal: "staff", action: "restore", sectionKey: "x" }), "Ada (staff) restored x");
  });
  it("renders collapsed with a loading line until it has read, so a failed or pending read is never drawn as an empty history", () => {
    const html = renderToStaticMarkup(createElement(ReportEditHistory, { reportVersionId: "rv-1" }));
    assert.match(html, /data-report-edit-history/);
    assert.match(html, /Loading the edit history/);
    assert.doesNotMatch(html, /No edits have been made/);
  });
  it("is mounted in the studio for a version (not a draft), and its route is staff-only and read-only", () => {
    const studio = readFileSync(new URL("../app/jobs/[jobId]/report/ReportStudio.tsx", import.meta.url), "utf8");
    assert.match(studio, /\{version && !draft \? <ReportEditHistory reportVersionId=\{version\.reportVersionId\} refresh=\{version\.version\} \/> : null\}/);
    const route = readFileSync(new URL("../app/api/isolated/report-versions/[versionId]/edits/route.ts", import.meta.url), "utf8");
    assert.match(route, /requireCapability\(principal, "report\.view"\)/);
    assert.match(route, /export async function GET/);
    assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
    assert.match(route, /withTenantRead/);
  });
});
