import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { crpReportSectionCatalogue, reportNarrativeBodyIssues, reportNarrativeDrawnKeys, reportSectionPlanOf, type ReportComposition, type ReportNarrativeElement } from "@nzi/contracts";
(globalThis as { React?: unknown }).React = React;
/* eslint-disable @typescript-eslint/no-require-imports */
const { ReportComposedView } = require("../app/reports/[versionId]/ReportComposedView") as typeof import("../app/reports/[versionId]/ReportComposedView");
const { drawNarrativeBody, narrativeForEditing, resolveComposedToken, unresolvedNarrativeTokens } = require("../app/reports/[versionId]/composedNarrative") as typeof import("../app/reports/[versionId]/composedNarrative");

/**
 * B2-4 (`composed@6`; RULING-report-studio-B2-4): composed@5 drawing a frozen narrative. The catalogue's defaults are composed@5's own
 * wording, so drawn under composed@6 they read word for word as composed@5's template — in every case composed@5 words differently
 * (a baseline or none, sites or none, one measure or several, one action or several, an interim target or none, a net zero target
 * or none). An edited body draws its own words, its figures resolved from the frozen composition. Its render is pinned byte for
 * byte; composed@1–5 keep theirs (their own suites, unchanged).
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const base = () => JSON.parse(fixture("composition-composed5-whole.json")) as ReportComposition;
const render = (composition: ReportComposition) => renderToStaticMarkup(createElement(ReportComposedView, { composition }));
const decode = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const proseOf = (html: string) => [...html.matchAll(/<div class="r5-prose">([\s\S]*?)<\/div><\/div>/g)].map((match) => decode(match[1]!));

/** The narrative validate would freeze for this composition's plan, every section at its catalogue default. */
const defaults = (composition: ReportComposition): ReportNarrativeElement[] => {
  const drawn = reportNarrativeDrawnKeys(reportSectionPlanOf(composition));
  return crpReportSectionCatalogue.filter((section) => drawn.has(section.key)).map((section) => ({ key: section.key, bodyHtml: section.defaultBodyHtml, contentSource: "default", sectionVersion: 0 }));
};
const as6 = (composition: ReportComposition, narrative = defaults(composition)): ReportComposition => ({ ...composition, renderer: "composed@6", narrative });

type Mutate = (composition: ReportComposition) => void;
const targetsOf = (c: ReportComposition) => c.targets as Extract<ReportComposition["targets"], { trajectory: unknown }>;
const VARIANTS: Record<string, Mutate> = {
  "as issued (a baseline, three sites, two measures, four actions, interim and net zero)": () => {},
  "no baseline": (c) => { targetsOf(c).benchmark = null as never; },
  "no sites": (c) => { (c.emissions as { sites?: unknown[] }).sites = []; },
  "one intensity measure": (c) => { const intensity = c.intensity as { metrics: unknown[] }; intensity.metrics = intensity.metrics.slice(0, 1); },
  "one action": (c) => { const plan = c.plan as { groups: Array<{ strategies: unknown[] }> }; plan.groups = [{ ...plan.groups[0]!, strategies: plan.groups[0]!.strategies.slice(0, 1) }]; },
  "no interim target": (c) => { const t = targetsOf(c); t.trajectory = t.trajectory.filter((point) => point.kind !== "near-term"); },
  "no net zero target": (c) => { const t = targetsOf(c); t.trajectory = t.trajectory.filter((point) => point.kind !== "net-zero"); },
};

describe("composed@6: the frozen narrative", () => {
  for (const [name, mutate] of Object.entries(VARIANTS)) {
    it(`draws the catalogue default word for word as composed@5's template — ${name}`, () => {
      const five = base(); mutate(five);
      const six = as6(JSON.parse(JSON.stringify(five)) as ReportComposition);
      const [fiveProse, sixProse] = [proseOf(render(five)), proseOf(render(six))];
      assert.ok(fiveProse.length >= 4, "the template's blocks are found");
      assert.deepEqual(sixProse, fiveProse);
    });
  }

  it("draws an edited body as written, its figures resolved from the frozen composition; the default pill becomes the source", () => {
    const composition = base();
    const edited: ReportNarrativeElement = { key: "executive-summary", contentSource: "client-edited", sectionVersion: 3,
      bodyHtml: "<p>In <span data-token=\"reportingYear\"></span> the footprint was <span data-token=\"total\"></span>, Scope 3 being <span data-token=\"scope3Pct\"></span>.</p>" };
    const html = render(as6(composition, [edited, ...defaults(composition).filter((element) => element.key !== "executive-summary")]));
    const total = (composition.emissions as { totalTco2e: number }).totalTco2e.toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    assert.match(html, new RegExp(`<div class="r5-editblock r5-src-client-edited" data-narrative="executive-summary"><span class="r5-spill r5-spill-client-edited">Edited by client</span><div class="r5-prose"><p>In <span class="r5-tok">2025–2026</span> the footprint was <span class="r5-tok">${total.replace(/[.]/g, "\\.")} tCO₂e</span>`));
    assert.match(html, /<span class="r5-spill r5-spill-default">Default template<\/span>/, "the untouched sections say so");
    assert.match(html, /<main class="nzr5 r5-mode-page" data-renderer="composed@6">/);
  });

  it("marks a figure the composition cannot hold — never fills it; drops a paragraph a clause leaves empty", () => {
    const composition = base();
    const t = targetsOf(composition); t.trajectory = t.trajectory.filter((point) => point.kind !== "net-zero");
    assert.match(drawNarrativeBody("<p>Net zero by <span data-token=\"netZeroYear\"></span>.</p>", composition), /<span class="r5-tok r5-tok-missing" title="Net zero year: No net zero target was set[^"]*">—<\/span>/);
    assert.equal(drawNarrativeBody("<p>Kept.</p><p><span data-token=\"progressReview\"></span></p>", composition), "<p>Kept.</p>");
    assert.deepEqual(unresolvedNarrativeTokens("<p><span data-token=\"netZeroYear\"></span> <span data-token=\"total\"></span></p>", composition).map((token) => token.key), ["netZeroYear"]);
  });

  it("the editor shows figures as locked chips and phrases as locked words — saving collapses them back to the bare keys", async () => {
    const { serializeReportSectionBody } = await import("@nzi/contracts");
    const composition = base();
    for (const section of crpReportSectionCatalogue) {
      const editing = narrativeForEditing(section.defaultBodyHtml, composition);
      assert.doesNotMatch(editing, /<span class="r5-tok">/, "every chip in the editor keeps its key");
      assert.equal(serializeReportSectionBody(editing), section.defaultBodyHtml, `${section.key}: round trip`);
      assert.deepEqual(reportNarrativeBodyIssues(serializeReportSectionBody(editing)), []);
    }
  });

  it("a composed@6 composition without its narrative draws the template — it cannot draw a body it does not hold", () => {
    const composition = { ...base(), renderer: "composed@6" } as ReportComposition;
    assert.deepEqual(proseOf(render(composition)), proseOf(render(base())));
  });

  it("resolves every catalogue token from the frozen composition as composed@5 prints it", () => {
    const composition = base();
    assert.deepEqual(resolveComposedToken("client", composition), { ok: true, kind: "figure", html: `<span class="r5-tok">${composition.client}</span>`, text: composition.client, label: "Client name" });
    assert.equal((resolveComposedToken("netZeroYear", composition) as { text: string }).text, "2050");
    assert.equal((resolveComposedToken("reportingYear", composition) as { text: string }).text, "2025–2026");
    assert.equal((resolveComposedToken("baselineAnchor", composition) as { text: string }).text, " anchored to the client's 2022–2023 baseline set in its targets");
    for (const section of crpReportSectionCatalogue) {
      for (const match of section.defaultBodyHtml.matchAll(/data-token="([^"]+)"/g)) assert.ok(resolveComposedToken(match[1]!, composition).ok, `${section.key}: ${match[1]}`);
    }
  });

  it("no amount of money and no file name on the page (NZC-120); the narrative names no currency at all", () => {
    const html = render(as6(base()));
    // An intensity is per £m of turnover (a unit, as composed@5 draws it); an amount — a currency beside a figure — never appears.
    assert.doesNotMatch(html, /[£$€]\s?\d|\b(GBP|USD|EUR)\s?\d|\d\s?(GBP|USD|EUR)\b/);
    assert.doesNotMatch(html, /\.(xlsx|csv|pdf)\b/i);
    for (const prose of proseOf(html)) assert.doesNotMatch(prose, /[£$€]|\b(GBP|USD|EUR)\b/, prose);
  });

  it("draws a composed@6 report byte-for-byte as pinned (a default narrative and one client edit, tokens resolved)", () => {
    const composition = base();
    const edited: ReportNarrativeElement = { key: "executive-summary", contentSource: "client-edited", sectionVersion: 2,
      bodyHtml: "<p><span data-token=\"client\"></span> measured <span data-token=\"total\"></span> in the <span data-token=\"reportingYear\"></span> year: <span data-token=\"scope1\"></span> from Scope 1, <span data-token=\"scope2\"></span> from Scope 2 and <span data-token=\"scope3\"></span> from Scope 3.</p><p>Scope 3 is <span data-token=\"scope3Pct\"></span> of the total.</p>" };
    const pinned = as6(composition, [edited, ...defaults(composition).filter((element) => element.key !== "executive-summary")]);
    // The composition is frozen alongside its render: the pin is over both.
    const frozen = JSON.parse(fixture("composition-composed6-whole.json")) as ReportComposition;
    assert.deepEqual(frozen, pinned, "the pinned composition is the one this test builds");
    assert.equal(frozen.renderer, "composed@6");
    assert.equal(render(frozen), fixture("composition-composed6-whole.html"));
  });
});
