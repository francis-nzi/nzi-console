import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NoCompositionNotice, wasIssued } from "../app/reports/[versionId]/NoCompositionNotice";
import { PRE_COMPOSITION_LABEL } from "../app/portal/portalReportView";

/**
 * FINDING-published-no-composition: a published version issued before compositions were frozen (pre-0077) has none, by design
 * (D1). The staff page must not call it "not issued" — only a version never issued reads that way.
 */
(globalThis as { React?: unknown }).React = React;
const html = (status?: string) => renderToStaticMarkup(createElement(NoCompositionNotice, { versionId: "v1", status }));
const page = readFileSync(new URL("../app/reports/[versionId]/page.tsx", import.meta.url), "utf8");

describe("staff report page, a version with no frozen composition", () => {
  it("a published version reads as issued before reports were frozen, with the portal's label", () => {
    const out = html("published");
    assert.ok(out.includes(PRE_COMPOSITION_LABEL));
    assert.ok(!/not been issued/i.test(out));
    assert.ok(!out.includes("/preview"), "no composed-preview offer for a version that was issued");
  });
  it("a superseded version was issued too", () => {
    assert.equal(wasIssued("superseded"), true);
    assert.ok(!/not been issued/i.test(html("superseded")));
  });
  it("a validated version still reads not issued, and offers the preview", () => {
    const out = html("validated");
    assert.match(out, /has not been issued/);
    assert.ok(out.includes("/reports/v1/preview"));
  });
  it("a draft, or a status that could not be read, keeps the not-issued wording", () => {
    for (const status of ["draft", undefined]) assert.match(html(status), /has not been issued/);
  });
  it("the page passes the version's status to the notice", () => {
    assert.match(page, /<NoCompositionNotice versionId=\{versionId\} status=\{/);
    assert.ok(!/This report version has not been issued/.test(page), "the wording lives in the notice only");
  });
});
