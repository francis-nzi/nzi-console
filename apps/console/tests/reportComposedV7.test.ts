import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMMUTING_UPLIFT_METHOD_LINE, crpReportSectionCatalogue, reportNarrativeDrawnKeys, reportSectionPlanOf, type ReportCommutingUplift, type ReportComposition } from "@nzi/contracts";
(globalThis as { React?: unknown }).React = React;
/* eslint-disable @typescript-eslint/no-require-imports */
const { ReportComposedView } = require("../app/reports/[versionId]/ReportComposedView") as typeof import("../app/reports/[versionId]/ReportComposedView");

/**
 * composed@7 (BRIEF-commuting-uplift-methodology-line): composed@6 that also states, on its Methodology page, that employee commuting
 * at some sites is extrapolated from a sample — the snapshot's own method line, then each uplifted site's responses and factor —
 * from the composition's frozen `commutingUplift` only. A composition without the block draws exactly as composed@6 does (pinned
 * against the committed composed@6 golden); the earlier renderers never draw it, whatever a composition holds.
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const render = (composition: ReportComposition) => renderToStaticMarkup(createElement(ReportComposedView, { composition }));
const decode = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const six = (): ReportComposition => JSON.parse(fixture("composition-composed6-whole.json")) as ReportComposition;
const UPLIFT: ReportCommutingUplift = {
  method: COMMUTING_UPLIFT_METHOD_LINE,
  sites: [
    { siteId: "s-a", siteLabel: "Leeds", employees: 100, companyCarUsers: 10, respondents: 54, eligible: 90, responseRate: 0.6, headcount: 36, factor: 90 / 54, agreedBy: "ada", agreedAt: "2026-11-01T09:00:00.000Z" },
    { siteId: "s-b", siteLabel: null, employees: 40, companyCarUsers: 0, respondents: 40, eligible: 40, responseRate: 1, headcount: 0, factor: 1, agreedBy: null, agreedAt: null },
  ],
};
const seven = (composition: ReportComposition, uplift?: ReportCommutingUplift): ReportComposition => ({ ...composition, renderer: "composed@7", ...(uplift ? { commutingUplift: uplift } : {}) });
const statementOf = (html: string) => [...html.matchAll(/<div data-commuting-uplift="[^"]*">([\s\S]*?)<\/div>/g)].map((match) => decode(match[1]!));

describe("composed@7: the extrapolated-commuting statement on Methodology", () => {
  it("the fixture is the committed composed@6 render (the regression baseline is real)", () => {
    assert.equal(render(six()), fixture("composition-composed6-whole.html"));
  });

  it("prints the snapshot's method line and, per uplifted site, who responded and the factor — the figures are the provenance's", () => {
    const html = render(seven(six(), UPLIFT));
    const [statement] = statementOf(html);
    assert.ok(statement, "the statement is drawn");
    assert.ok(statement.startsWith(COMMUTING_UPLIFT_METHOD_LINE), "the representativeness caveat leads");
    assert.match(statement, /Leeds: 54 of 90 eligible staff responded \(60%\), scaled ×1\.67\./);
    assert.match(statement, /Site: 40 of 40 eligible staff responded \(100%\), scaled ×1\.00\./, "a site with no label reads Site, never a guess");
    // It is on the Methodology page, inside the basis box.
    const methodology = html.slice(html.indexOf("Standards, Methodology"));
    assert.ok(methodology.includes("data-commuting-uplift"), "drawn on the Methodology page");
  });

  it("a composition WITHOUT the block draws exactly as composed@6 does — only the renderer marker differs (regression pin)", () => {
    const [before, after] = [render(six()), render(seven(six()))];
    assert.equal(after.includes("data-commuting-uplift"), false);
    assert.equal(after.replace('data-renderer="composed@7"', 'data-renderer="composed@6"'), before);
  });

  it("is deterministic and reads the frozen composition only: the same composition renders the same, and the line is the block's own words", () => {
    const [one, two] = [render(seven(six(), UPLIFT)), render(seven(six(), UPLIFT))];
    assert.equal(one, two);
    const custom = render(seven(six(), { ...UPLIFT, method: "A frozen sentence the snapshot carried." }));
    assert.ok(statementOf(custom)[0]!.startsWith("A frozen sentence the snapshot carried."), "not the live constant");
    assert.equal(statementOf(custom)[0]!.includes(COMMUTING_UPLIFT_METHOD_LINE), false);
  });

  it("an earlier renderer never draws it, whatever a composition holds — an issued composed@6 keeps its rendered output", () => {
    const stray = { ...six(), commutingUplift: UPLIFT } as ReportComposition;
    assert.equal(render(stray), fixture("composition-composed6-whole.html"));
  });

  it("composed@7 draws the frozen narrative as composed@6 does", () => {
    const composition = six();
    assert.ok(composition.narrative && composition.narrative.length > 0, "the baseline carries a narrative");
    const drawn = new Set(reportNarrativeDrawnKeys(reportSectionPlanOf(composition)));
    assert.ok(crpReportSectionCatalogue.some((section) => drawn.has(section.key)));
    const [a, b] = [render(seven(composition, UPLIFT)), render(composition)];
    const strip = (html: string) => html.replace(/<div data-commuting-uplift="[^"]*">[\s\S]*?<\/div>/, "").replace('data-renderer="composed@7"', 'data-renderer="composed@6"');
    assert.equal(strip(a), b, "the only difference is the statement");
  });
});
