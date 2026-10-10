import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultReportSectionPlan, type ReportComposition, type ReportSectionPlan } from "@nzi/contracts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/**
 * F-1 (RULING-reporting-F Q1, Q3, Q5, Q6; R-D1): the composed report draws the plan frozen into its composition — its order
 * and numbering, a left-out section stated on the Methodology page, the client's issuer line on the cover, and no narrative
 * in composed@1. Every report issued before F-1 still draws byte-for-byte (`reportComposedRenderer`).
 */
describe("the composed report draws its frozen section plan (F-1)", () => {
  const render = async (composition: ReportComposition) => {
    (globalThis as { React?: unknown }).React = React;
    const { ReportComposedView } = await import("../app/reports/[versionId]/ReportComposedView");
    return renderToStaticMarkup(createElement(ReportComposedView, { composition }));
  };
  const base = () => JSON.parse(fixture("composition-pre-f-whole.json")) as ReportComposition;
  const headings = (html: string) => [...html.matchAll(/<span class="n">(\d+)<\/span><div><div class="eyebrow">[^<]*<\/div><h2>([^<]+)<\/h2>/g)].map((match) => `${match[1]} ${match[2]}`);
  const reordered = (): ReportSectionPlan => {
    const plan = defaultReportSectionPlan.filter((entry) => entry.key !== "plan");
    const at = plan.findIndex((entry) => entry.key === "executive-summary") + 1;
    return [...plan.slice(0, at), { key: "plan", included: true }, ...plan.slice(at)];
  };

  it("a composition carrying the default plan draws exactly as the pin", async () => {
    assert.equal(await render({ ...base(), renderer: "composed@1", sectionPlan: defaultReportSectionPlan }), fixture("composition-pre-f-whole.html"));
  });

  it("draws its sections in the frozen order, numbered from it", async () => {
    assert.deepEqual(headings(await render({ ...base(), sectionPlan: reordered() })), [
      "01 Executive summary", "02 Decarbonisation actions", "03 Emissions by scope", "04 Sites &amp; reporting boundary",
      "05 Emissions intensity", "06 Targets &amp; reduction pathway", "07 UK SRS readiness statement", "08 Methodology &amp; provenance",
    ]);
  });

  it("states a section left out on the Methodology page (the machinery F-4 switches on), never dropping it silently", async () => {
    const plan = defaultReportSectionPlan.map((entry) => entry.key === "srs" || entry.key === "targets" ? { ...entry, included: false } : entry);
    const html = await render({ ...base(), sectionPlan: plan });
    assert.doesNotMatch(html, /<h2>(UK SRS readiness statement|Targets &amp; reduction pathway)<\/h2>/, "neither section is drawn");
    assert.match(html, /Omitted from this report at the issuer’s choice: Targets &amp; reduction pathway, UK SRS readiness statement\./);
    assert.deepEqual(headings(html).map((heading) => heading.slice(0, 2)), ["01", "02", "03", "04", "05", "06"], "no hole in the numbering");
    assert.doesNotMatch(await render(base()), /Omitted from this report/, "nothing is said when nothing is left out");
  });

  it("puts the client's issuer line on the cover, and nothing when there is none", async () => {
    assert.match(await render({ ...base(), issuerLine: "Prepared for the Board of Serial Co" }), /<div class="nzr-cover-issuer">Prepared for the Board of Serial Co<\/div>/);
    assert.doesNotMatch(await render(base()), /nzr-cover-issuer/);
  });

  it("never draws a narrative section in composed@1, even if a plan included one (Q6: it renders with a later layout)", async () => {
    const plan = defaultReportSectionPlan.map((entry) => entry.key.startsWith("narrative:") ? { ...entry, included: true } : entry);
    const html = await render({ ...base(), sectionPlan: plan });
    assert.equal(html, await render(base()), "identical to the report without them: numbering untouched");
  });
});
