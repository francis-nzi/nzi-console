import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReportComposition } from "@nzi/contracts";
import { reportingWorkflowHref } from "../app/lib/workflowDocs";

(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const docUrl = new URL("../public/workflows/WF-reporting.html", import.meta.url);

// The reporting process has one doc, so its pill takes a constant href (not a category-keyed table entry). Display only.
describe("the Reporting WF pill", async () => {
  const { ReportStudioPrinting } = await import("../app/jobs/[jobId]/report/ReportStudio");

  it("the href is the one constant, and the doc it names is hosted", () => {
    assert.equal(reportingWorkflowHref(), "/workflows/WF-reporting.html");
    assert.ok(existsSync(new URL(`.${reportingWorkflowHref().replace("/workflows", "")}`, new URL("../public/workflows/", import.meta.url))));
  });

  it("sits in the Report Studio toolbar as a new-tab link, whatever the round's status", () => {
    const composition = JSON.parse(read("tests/fixtures/composition-composed5-whole.json")) as ReportComposition;
    for (const status of ["validated", "in_client_review", "client_approved", "published"] as const) {
      const html = renderToStaticMarkup(createElement(ReportStudioPrinting, { jobId: "712", version: { reportVersionId: "rv-9", createdAt: "2026-10-15T09:00:00Z", publishedAt: status === "published" ? "2026-10-15T09:00:00Z" : null, scopeLabel: "Whole client", version: 4, manifestVersion: 1, snapshotId: "snap-9", status } as never, composition }));
      assert.match(html, /<a class="nz-wf" href="\/workflows\/WF-reporting\.html" target="_blank" rel="noopener"[^>]*>WF<\/a>/, status);
    }
  });

  it("sits on the job's report-state card header, beside the Report label", () => {
    const card = read("app/jobs/CrpReportStageCard.tsx");
    assert.match(card, /import \{ reportingWorkflowHref \} from "\.\.\/lib\/workflowDocs";/);
    assert.match(card, /<span className="nz-eyebrow">Report<\/span> <WorkflowPill href=\{reportingWorkflowHref\(\)\} label="Reporting" \/>/);
  });

  it("the Studio imports the same helper and the same pill", () => {
    const studio = read("app/jobs/[jobId]/report/ReportStudio.tsx");
    assert.match(studio, /<WorkflowPill href=\{reportingWorkflowHref\(\)\} label="Reporting" \/>/);
  });
});

describe("the hosted Reporting doc is a generic process doc", () => {
  const html = readFileSync(docUrl, "utf8");
  it("carries the version stamp and no script, external link, hash or engineering/flag detail", () => {
    assert.match(html, />v1\.0</);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /https?:/i);
    assert.doesNotMatch(html, /sha256/i);
    assert.doesNotMatch(html, /\bBuilt\b|portal-report-review|feature flag/i, "the implementation-status badges and flag footer are not shipped");
  });
  it("holds no client data: no email, no J-number, no client id", () => {
    assert.doesNotMatch(html, /[\w.+-]+@[\w-]+\.[\w.]+/);
    assert.doesNotMatch(html, /\bJ0\d{5}\b/);
    assert.doesNotMatch(html, /client_id|organisation_id/);
  });
});
