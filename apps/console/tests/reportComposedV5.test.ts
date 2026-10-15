import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { clientFacingComposition, setReportSectionIncluded, type ReportComposition } from "@nzi/contracts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/**
 * composed@5 (BUILD-report-studio-composed5; ACCEPT-composed5-full-document): the mockup, rendered, bound to the frozen
 * composition. Its first render is pinned byte for byte; composed@1/2/3/4 keep theirs (their own suites, unchanged). The fixture
 * is the real-stack render's frozen composition — synthetic, EFF-shaped (three sites, the mockup's magnitudes), money-free.
 */
describe("composed@5: the mockup's document", () => {
  const render = async (composition: ReportComposition, options: { preview?: boolean; mode?: "page" | "flow" } = {}) => {
    (globalThis as { React?: unknown }).React = React;
    const { ReportComposedView } = await import("../app/reports/[versionId]/ReportComposedView");
    return renderToStaticMarkup(createElement(ReportComposedView, { composition, ...options }));
  };
  const composition = () => JSON.parse(fixture("composition-composed5-whole.json")) as ReportComposition;
  const sections = (html: string) => [...html.matchAll(/data-section="([^"]+)"/g)].map((match) => match[1]);
  const heads = (html: string) => [...html.matchAll(/<div class="r5-kicker">([^<]*)<\/div><h2 class="r5-h2">([^<]*)/g)].map((match) => `${match[1]} | ${match[2]!.trim()}`);

  it("draws a composed@5 report byte-for-byte as pinned", async () => {
    assert.equal(composition().renderer, "composed@5");
    assert.equal(await render(composition()), fixture("composition-composed5-whole.html"));
  });

  it("the cover and fifteen sections, in the mockup's order, by its titles and kickers", async () => {
    const html = await render(composition());
    assert.deepEqual(sections(html), ["executive-summary", "narrative:net-zero-commitment", "narrative:background", "sites", "emissions", "intensity", "targets",
      "scope-analysis", "category-analysis", "plan", "srs", "methodology", "glossary", "audit", "appendix-sites"]);
    assert.deepEqual(heads(html), [
      "01 · Overview | Executive Summary", "02 · Commitment | Net Zero Commitment", "03 · Background | Background &amp; Organisation",
      "04 · Boundary | Sites &amp; Reporting Boundary", "05 · Overview | Carbon Emissions Overview", "06 · Performance | Intensity Metric Analysis",
      "07 · Trajectory | Targets &amp; Reduction Pathway", "08 · Analysis | Analysis by Scope", "09 · Analysis | Emissions by Scope &amp; Category",
      "10 · Plan | Carbon Reduction Actions", "11 · Disclosure | UK SRS Readiness Statement", "12 · Assurance | Standards, Methodology &amp; Sign-off",
      "Reference | Glossary", "Appendix 1 | Full Emissions Audit", "Appendix 2 | Emissions by Site, Scope &amp; Category"]);
    assert.match(html, /Page 16 of 16/);
  });

  it("every figure in the narrative is a locked token holding the composition's own number", async () => {
    const issued = composition(), html = await render(issued);
    if ("state" in issued.emissions) throw new Error("expected emissions");
    const total = issued.emissions.totalTco2e.toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    assert.match(html, new RegExp(`<span class="r5-tok">${total} tCO₂e</span>`));
    const executive = html.split('data-section="executive-summary"')[1]!.split('data-section=')[0]!;
    assert.equal([...executive.matchAll(/class="r5-tok"/g)].length, 6);
  });

  it("NZC-120: no money amount anywhere in the document — the turnover ratio and unit, never the turnover", async () => {
    const html = await render(composition());
    assert.doesNotMatch(html, /[£$€]\s?\d|\b(GBP|USD|EUR)\b|\.csv|\.xlsx|reportingDenominator/);
    assert.match(html, /tCO₂e \/ £m/, "the ratio's unit stays");
  });

  it("RULING-intensity-badge: no pill on an intensity row — neither \"Standard\" nor \"Reported in the CRP\"", async () => {
    const intensity = (await render(composition())).split('data-section="intensity"')[1]!.split('data-section=')[0]!;
    assert.doesNotMatch(intensity, /Reported in the CRP|>Standard</);
  });

  it("the year-aware tables: real earlier periods, and \"—\" where a site or category has none (never modelled)", async () => {
    const html = await render(composition());
    const overview = html.split('data-section="emissions"')[1]!.split('data-section=')[0]!;
    assert.match(overview, /Baseline period<\/th><th class="r5-num">Previous period<\/th><th class="r5-num">Current period<\/th><th class="r5-num">% difference/);
    assert.match(overview, /Regional Depot<\/td><td class="r5-num"><span class="r5-nr">—<\/span><\/td>/);
    const category = html.split('data-section="category-analysis"')[1]!.split('data-section=')[0]!;
    assert.match(category, /Waste generated in operations<\/td><td class="r5-num"><span class="r5-nr">—<\/span>/);
  });

  it("the data-quality mix sums the frozen audit rows' own tiers, by tCO₂e — nothing new frozen", async () => {
    const issued = composition(), html = await render(issued);
    const rows = issued.audit!.rows, total = rows.reduce((sum, row) => sum + row.tco2e, 0);
    const measured = Math.round((rows.filter((row) => row.qualityTier === "measured").reduce((sum, row) => sum + row.tco2e, 0) / total) * 1000) / 10;
    assert.match(html, new RegExp(`Measured ${measured}%`));
    assert.match(html, /Scope 1 &amp; 2 measured · Scope 3 estimated &amp; spend-based/);
  });

  it("a field the composition does not hold is said to be missing, never invented", async () => {
    const { organisation: _organisation, clientLogoAssetId: _logo, reportingPeriod: _period, ...bare } = composition();
    const html = await render(bare as ReportComposition);
    assert.match(html, /Industry<\/span><b><span class="r5-nr">Not recorded<\/span>/);
    assert.doesNotMatch(html, /Reporting Period<\/span>/, "an unstamped period leaves the cover row out");
    assert.doesNotMatch(html, /r5-clframe/, "no client logo, no stand-in");
    assert.match(html, /Client approval<\/div><div class="r5-sl">Name &amp; position/, "no signee named: a blank line");
    const signed = await render({ ...composition(), signee: { name: "Sam Taylor", jobTitle: "Head of Sustainability" } });
    assert.match(signed, /Client approval<\/div><div class="r5-sl">Sam Taylor, Head of Sustainability/);
  });

  it("a section left out is absent, numbered past, and named on Methodology (F-1) — the standalone narrative sections included", async () => {
    const issued = composition();
    const plan = setReportSectionIncluded(setReportSectionIncluded(issued.sectionPlan!, "narrative:background", false), "glossary", false);
    const html = await render({ ...issued, sectionPlan: plan });
    assert.ok(!sections(html).includes("narrative:background") && !sections(html).includes("glossary"));
    assert.match(html, /<div class="r5-kicker">03 · Boundary<\/div><h2 class="r5-h2">Sites/, "numbered past: Sites moves up to 03");
    assert.match(html, /Omitted from this report at the issuer’s choice: Background &amp; Organisation, Glossary\./);
  });

  it("the client's copy draws the same document, without a reviewer and without a strategy owner (F-4b)", async () => {
    const html = await render(clientFacingComposition(composition()));
    assert.ok(sections(html).length === 15);
    assert.doesNotMatch(html, /approver-other|prep-other/);
  });

  it("the continuous view: no running head or foot sheets, a marker at each page break", async () => {
    const flow = await render(composition(), { mode: "flow" });
    assert.match(flow, /class="nzr5 r5-mode-flow"/);
    assert.equal([...flow.matchAll(/class="r5-pb-num">Page \d+ break</g)].length, 15);
  });

  it("a preview says it is not issued", async () => {
    assert.match(await render(composition(), { preview: true }), /Report Generated<\/span><b>Not issued — preview/);
  });

  it("the studio's rail numbers and names composed@5's rows exactly as its pages", async () => {
    const { studioRail } = await import("../app/jobs/[jobId]/report/studio");
    const issued = composition(), html = await render(issued);
    const rail = studioRail(issued).filter((row) => row.number).map((row) => `${row.number} ${row.title}`);
    const pages = [...html.matchAll(/<div class="r5-kicker">(\d\d) · [^<]*<\/div><h2 class="r5-h2">([^<]*)/g)].map((match) => `${match[1]} ${match[2]!.trim().replace(/&amp;/g, "&")}`);
    assert.deepEqual(rail.slice(0, pages.length), pages);
  });

  it("the fork is the difference: composed@4 draws the same composition as it always has — none of composed@5", async () => {
    const html = await render({ ...composition(), renderer: "composed@4" });
    assert.doesNotMatch(html, /class="nzr5|r5-page/);
  });
});
