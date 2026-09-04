import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computePageBreakIndices, REPORT_A4_CONTENT_HEIGHT_PX } from "../app/reports/[versionId]/reportPageBreaks";
import { buildReportPagedCss, escapeCssContent, REPORT_PAGED_MEDIA_RULES } from "../app/reports/[versionId]/reportPrintRules";

describe("computePageBreakIndices (R5b / NZC-051) — Continuous view's advisory markers", () => {
  it("breaks only when the next block would overflow the current page", () => {
    const page = REPORT_A4_CONTENT_HEIGHT_PX;
    // Three blocks, each a third of a page: never overflows, no breaks.
    assert.deepEqual(computePageBreakIndices([page / 3, page / 3, page / 3]), []);
    // A block that pushes the running total over the page starts a new one.
    assert.deepEqual(computePageBreakIndices([page * 0.6, page * 0.6]), [1]);
  });

  it("a single block taller than a page is never split around — it just overflows on its own", () => {
    const page = REPORT_A4_CONTENT_HEIGHT_PX;
    assert.deepEqual(computePageBreakIndices([page * 3]), []);
    // A too-tall block followed by another: the next block still starts a
    // fresh page (it cannot share the overflowing one).
    assert.deepEqual(computePageBreakIndices([page * 3, page / 4]), [1]);
  });

  it("empty input is zero breaks, not an error", () => {
    assert.deepEqual(computePageBreakIndices([]), []);
  });

  it("accepts a custom content height (for a non-default page size)", () => {
    assert.deepEqual(computePageBreakIndices([60, 60], 100), [1]);
    assert.deepEqual(computePageBreakIndices([60, 60], 200), []);
  });
});

describe("escapeCssContent (R5b) — safe to embed in an @page content string", () => {
  it("escapes double quotes and backslashes", () => {
    assert.equal(escapeCssContent('Client "A" Ltd'), 'Client \\"A\\" Ltd');
    assert.equal(escapeCssContent("C:\\path"), "C:\\\\path");
  });

  it("leaves an ordinary client name untouched", () => {
    assert.equal(escapeCssContent("First Event"), "First Event");
  });
});

describe("buildReportPagedCss (R5b) — the Paged.js stylesheet", () => {
  const css = buildReportPagedCss({ client: "First Event", jobNumber: "J000566", reportingYear: 2026 });

  it("sets A4 size/margin and a running header/footer with page numbers", () => {
    assert.match(css, /@page\{size:A4;margin:14mm 12mm\}/);
    assert.match(css, /@top-center\{content:"First Event · Carbon Reduction Plan · 2026"/);
    assert.match(css, /@bottom-right\{content:"J000566 · Page " counter\(page\) " of " counter\(pages\)/);
  });

  it("suppresses the running header/footer on the cover page only", () => {
    assert.match(css, /@page :first\{@top-center\{content:none\}@bottom-left\{content:none\}@bottom-right\{content:none\}\}/);
  });

  it("CSS-escapes client and job number before embedding them", () => {
    const withQuote = buildReportPagedCss({ client: 'Client "A"', jobNumber: "J1", reportingYear: 2026 });
    assert.match(withQuote, /Client \\"A\\"/);
  });

  it("carries the same paged-media rules the real print path uses — one fragmentation contract, not two", () => {
    assert.ok(css.includes(REPORT_PAGED_MEDIA_RULES));
    assert.match(css, /\.report-audit-table thead\{display:table-header-group\}/);
    assert.match(css, /\.report-appendix\{break-before:page\}/);
  });
});
