import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultReportSectionPlan, legacyReportSectionPlanV3, setReportSectionIncluded, type ReportComposition } from "@nzi/contracts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/**
 * B2-3 (RULING-report-B2-3): `composed@4` is the mockup's document — Analysis by Scope, Emissions by Scope & Category, the
 * reference block after Methodology (Glossary, the Full Emissions Audit as its own section, Appendix 2 by site & scope), the
 * mockup's titles, the cover's metacard and the sign-off. Its first render is pinned byte for byte; `composed@1/2/3` keep
 * theirs, untouched. The fixture (synthetic) is the composed@3 one re-issued under composed@4.
 */
describe("composed@4: the mockup's section set (B2-3)", () => {
  const render = async (composition: ReportComposition, preview = false) => {
    (globalThis as { React?: unknown }).React = React;
    const { ReportComposedView } = await import("../app/reports/[versionId]/ReportComposedView");
    return renderToStaticMarkup(createElement(ReportComposedView, { composition, preview }));
  };
  const composition = () => JSON.parse(fixture("composition-composed4-whole.json")) as ReportComposition;
  const heads = (html: string) => [...html.matchAll(/<span class="n">(\d\d)<\/span><div><div class="eyebrow">([^<]*)<\/div><h2>([^<]*)<\/h2>/g)].map((match) => `${match[1]} ${match[3]}`);
  const pageWith = (html: string, title: string) => html.split('<section class="nzr-page">').find((page) => page.includes(`<h2>${title}</h2>`)) ?? "";

  it("draws a composed@4 report byte-for-byte as pinned", async () => {
    assert.equal(composition().renderer, "composed@4");
    assert.equal(await render(composition()), fixture("composition-composed4-whole.html"));
  });

  it("draws the mockup's sections, in its order, by its titles — the main body ending at Methodology, then the reference block", async () => {
    assert.deepEqual(heads(await render(composition())), [
      "01 Executive Summary", "02 Sites &amp; Reporting Boundary", "03 Carbon Emissions Overview", "04 Intensity Metric Analysis",
      "05 Targets &amp; Reduction Pathway", "06 Analysis by Scope", "07 Emissions by Scope &amp; Category", "08 Carbon Reduction Actions",
      "09 UK SRS Readiness Statement", "10 Standards, Methodology &amp; Sign-off", "11 Glossary", "12 Full Emissions Audit", "13 Emissions by Site &amp; Scope",
    ]);
  });

  it("moves the year-on-year chart and comparison to Analysis by Scope, and purchased goods to Scope & Category", async () => {
    const html = await render(composition());
    const overview = pageWith(html, "Carbon Emissions Overview"), byScope = pageWith(html, "Analysis by Scope"), byCategory = pageWith(html, "Emissions by Scope &amp; Category");
    assert.doesNotMatch(overview, /Annual emissions comparison by scope|nzr-compare|Purchased Goods/);
    assert.match(byScope, /Annual emissions comparison by scope/);
    assert.match(byScope, /class="nzr-tbl nzr-compare"|first assured/);
    assert.match(byCategory, /Purchased Goods &amp; Services emissions breakdown/);
  });

  it("the category table and Appendix 2 sum the frozen audit rows — and reconcile to its total", async () => {
    const issued = composition(), html = await render(issued);
    const total = issued.audit!.totalTco2e.toLocaleString("en-GB", { maximumFractionDigits: 2 });
    const byCategory = pageWith(html, "Emissions by Scope &amp; Category");
    assert.match(byCategory, /<td>Scope 1[^<]*<\/td><td>Direct emissions<\/td><td class="r num">10<\/td>/, "the two Gas rows, 6 + 4");
    assert.match(byCategory, new RegExp(`<tfoot><tr><td colSpan="2">Total</td><td class="r num">${total}</td>|<tfoot><tr><td colspan="2">Total</td><td class="r num">${total}</td>`));
    const appendix = pageWith(html, "Emissions by Site &amp; Scope");
    assert.match(appendix, /<tr class="sub"><td><b>Works<\/b><\/td><td class="r num"><b>14<\/b><\/td><\/tr>/, "Works: 6 + 4 gas, 4 steel");
    assert.match(appendix, new RegExp(`<td>Total emissions</td><td class="r num">${total}</td>`));
  });

  it("the Full Emissions Audit is its own section; Methodology ends with the sign-off — the frozen issuer and the client signee", async () => {
    const html = await render(composition());
    const methodology = pageWith(html, "Standards, Methodology &amp; Sign-off");
    assert.doesNotMatch(methodology, /nzr-audit-tbl/, "the audit no longer closes Methodology");
    assert.match(pageWith(html, "Full Emissions Audit"), /nzr-audit-tbl/);
    assert.match(methodology, /Declaration &amp; sign-off/);
    assert.match(methodology, /Client approval<\/div><b>Sam Taylor<\/b><div class="nzr-note">Head of Sustainability<\/div><div class="nzr-signoff-line">Signature<\/div><div class="nzr-signoff-line">Date<\/div>/);
    const { signee: _signee, ...unsigned } = composition();
    assert.match(pageWith(await render(unsigned as ReportComposition), "Standards, Methodology &amp; Sign-off"), /Client approval<\/div><b><span class="muted">Name<\/span><\/b>/, "no signee: a blank line, never a guessed name");
  });

  it("the cover's metacard: client, title, the frozen period, the scope, when generated — a period not frozen is left out", async () => {
    const html = await render(composition());
    assert.match(html, /<dt>Reporting period<\/dt><dd>01\/01\/2025 – 31\/12\/2025<\/dd>/);
    assert.match(html, /<dt>Scope<\/dt><dd>Whole client<\/dd>/);
    const { reportingPeriod: _period, ...unstamped } = composition();
    assert.doesNotMatch(await render(unstamped as ReportComposition), /Reporting period/);
    assert.match(await render(composition(), true), /<dt>Report generated<\/dt><dd>Not issued — preview<\/dd>/);
  });

  it("a left-out section is absent, numbered past, and named on Methodology by its composed@4 title", async () => {
    const issued = composition();
    const html = await render({ ...issued, sectionPlan: setReportSectionIncluded(issued.sectionPlan!, "glossary", false, { allowExclusion: true }) });
    assert.ok(!heads(html).some((head) => head.endsWith("Glossary")));
    assert.match(html, /Omitted from this report at the issuer’s choice: Glossary\./);
  });

  it("no money amount and no file name anywhere in the document — a ratio unit (tCO₂e / £m) is not an amount", async () => {
    const html = await render(composition());
    assert.doesNotMatch(html, /[£$€]\s?\d|\b(GBP|USD|EUR)\b|\.csv|\.xlsx/);
    assert.match(html, /tCO₂e \/ £m/, "the intensity unit stays (F4)");
  });

  it("a currency measure's amount is never printed by composed@4, even one a composition carried — composed@3 draws what it froze", async () => {
    // Compose no longer freezes it (RULING-B2-3-two-decisions), so the fixture carries none; the renderer's guard is checked
    // against a composition that does, as one composed before the ruling would.
    const issued = composition();
    if ("state" in issued.intensity) throw new Error("expected a composed intensity section");
    assert.ok(issued.intensity.metrics.every((metric) => !/£/.test(metric.denominatorText ?? "")), "the fixture, as composed now, carries no amount");
    const carried = { ...issued, intensity: { ...issued.intensity, metrics: issued.intensity.metrics.map((metric) => metric.key === "turnover" ? { ...metric, denominatorText: "£12,500,000" } : metric) } };
    assert.ok(carried.intensity.metrics.some((metric) => metric.denominatorText === "£12,500,000"), "the turnover measure is in the fixture");
    assert.doesNotMatch(await render(carried), /12,500,000/);
    assert.match(await render({ ...carried, renderer: "composed@3" }), /£12,500,000/, "composed@3 unchanged");
  });

  it("the fork is the difference: the same composition under composed@3 draws as composed@3 — none of the new sections", async () => {
    const { reportingPeriod: _p, signee: _s, ...rest } = composition();
    const html = await render({ ...rest, renderer: "composed@3", sectionPlan: legacyReportSectionPlanV3 });
    assert.doesNotMatch(html, /Analysis by Scope|Glossary|Appendix 2|Declaration &amp; sign-off|nzr-metacard/);
    const asIssued = await render({ ...composition(), renderer: "composed@3" });
    assert.doesNotMatch(asIssued, /<h2>(Analysis by Scope|Glossary|Emissions by Site &amp; Scope|Full Emissions Audit)<\/h2>|nzr-metacard|nzr-signoff/, "composed@3 never draws composed@4's sections, whatever the plan holds");
    assert.ok(defaultReportSectionPlan.length > legacyReportSectionPlanV3.length);
  });
});
