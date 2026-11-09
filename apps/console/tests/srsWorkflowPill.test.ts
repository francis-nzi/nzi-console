import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowPill } from "../app/jobs/WorkflowPill";
import { srsWorkflowHref } from "../app/lib/workflowDocs";

(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const docUrl = new URL("../public/workflows/WF-srs.html", import.meta.url);

// BRIEF-srs-wf-pill: one doc for SRS Readiness and Reduction Strategies, so its pill takes a constant href, like Reporting's. Display only.
describe("the SRS WF pill", () => {
  it("the href is the one constant, and the doc it names is hosted", () => {
    assert.equal(srsWorkflowHref(), "/workflows/WF-srs.html");
    assert.ok(existsSync(new URL(`.${srsWorkflowHref().replace("/workflows", "")}`, new URL("../public/workflows/", import.meta.url))));
  });

  it("renders as a new-tab link to the doc", () => {
    const html = renderToStaticMarkup(createElement(WorkflowPill, { href: srsWorkflowHref(), label: "SRS workflow" }));
    assert.match(html, /^<a class="nz-wf" href="\/workflows\/WF-srs\.html" target="_blank" rel="noopener"[^>]*>WF<\/a>$/);
  });

  it("sits in the SRS area header, beside the section (i) and the Walk-through", () => {
    const area = read("app/clients/[clientId]/SrsArea.tsx");
    assert.match(area, /import \{ srsWorkflowHref \} from "\.\.\/\.\.\/lib\/workflowDocs";/);
    assert.match(area, /onClick=\{\(\) => setTouring\(true\)\}>Walk-through<\/button>\r?\n\s*<WorkflowPill href=\{srsWorkflowHref\(\)\} label="SRS workflow" \/>/);
  });
});

describe("the hosted SRS doc is a generic process doc", () => {
  const html = readFileSync(docUrl, "utf8");
  it("is the draft for agreement, with no script, external link, hash or engineering/flag detail", () => {
    assert.match(html, /<b>Draft v0\.2<\/b>/);
    assert.match(html, /for agreement before anything is locked in/);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /https?:/i);
    assert.doesNotMatch(html, /sha256/i);
    assert.doesNotMatch(html, /portal-report-review|feature flag/i);
  });
  it("holds no client data: no email, no J-number, no client id", () => {
    assert.doesNotMatch(html, /[\w.+-]+@[\w-]+\.[\w.]+/);
    assert.doesNotMatch(html, /\bJ0\d{5}\b/);
    assert.doesNotMatch(html, /client_id|organisation_id/);
  });
  it("carries the real NZI logo, byte for byte", () => {
    const embedded = /src="data:image\/png;base64,([^"]+)"/.exec(html)?.[1] ?? "";
    assert.ok(Buffer.from(embedded, "base64").equals(readFileSync(new URL("../public/brand/netzero-logo.png", import.meta.url))));
  });
});
