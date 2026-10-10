import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReportComposition } from "@nzi/contracts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/**
 * F-2 (chart parity; RULING-reporting-F4 D2): `composed@2` is `composed@1` plus the manifest's charts, drawn from the frozen
 * chart basis. Its first render is pinned byte-for-byte — the bump rule now holds for it too — and each chart sits in the
 * section it speaks to. `composed@1` draws none of them (its own pins, in `reportComposedRenderer`, are unchanged).
 * Parity with the portal's charts is proven against a real database in `reportChartParityReal`.
 */
describe("composed@2: the composed report with the portal's charts (F-2)", () => {
  const render = async (composition: ReportComposition) => {
    (globalThis as { React?: unknown }).React = React;
    const { ReportComposedView } = await import("../app/reports/[versionId]/ReportComposedView");
    return renderToStaticMarkup(createElement(ReportComposedView, { composition }));
  };
  const composition = () => JSON.parse(fixture("composition-composed2-whole.json")) as ReportComposition;
  const pageWith = (html: string, heading: string) => html.split('<section class="nzr-page">').find((page) => page.includes(`<h2>${heading}</h2>`)) ?? "";
  const titles = {
    pathway: "Emissions reduction pathway to net zero", yearOnYear: "Annual emissions comparison by scope",
    intensity: "Intensity reduction pathway", purchased: "Purchased Goods &amp; Services emissions breakdown",
  };

  it("draws a composed@2 report byte-for-byte as pinned", async () => {
    assert.equal(composition().renderer, "composed@2");
    assert.equal(await render(composition()), fixture("composition-composed2-whole.html"));
  });

  it("puts each chart in the section it speaks to", async () => {
    const html = await render(composition());
    const emissions = pageWith(html, "Emissions by scope");
    assert.match(emissions, /<div class="nzr-charts">/);
    assert.ok(emissions.includes(titles.yearOnYear) && emissions.includes(titles.purchased), "year-on-year and purchased goods with the emissions");
    assert.ok(pageWith(html, "Targets &amp; reduction pathway").includes(titles.pathway), "the reduction pathway with the targets");
    assert.ok(pageWith(html, "Emissions intensity").includes(titles.intensity), "the intensity pathway with the intensity");
  });

  it("composed@1 draws none of them — the same composition, issued under the earlier layout, is the earlier document", async () => {
    const { chartBasis: _basis, ...rest } = composition();
    const html = await render({ ...rest, renderer: "composed@1" });
    for (const title of Object.values(titles)) assert.ok(!html.includes(title), title);
    assert.doesNotMatch(html, /nzr-charts|nzr-chart wide/);
  });

  it("draws the reduction pathway from the report's own Targets section — the client model, net zero at its residual", async () => {
    const { reportPathway } = await import("../app/reports/[versionId]/scopeCharts");
    const issued = composition();
    if (!issued.targets || "state" in issued.targets || "state" in issued.emissions) throw new Error("expected composed targets and emissions");
    const pathway = reportPathway(issued, issued.targets)!;
    const last = pathway.target[pathway.target.length - 1]!;
    assert.equal(Math.round(last.value * 1000) / 1000, 6.4, "net zero at the client model's 6.4 t residual — never a flat zero");
    assert.deepEqual(pathway.target.map((point) => point.year), issued.targets.trajectory.map((point) => point.year), "the table's own points");
    assert.deepEqual(pathway.milestones.map((milestone) => milestone.kind), ["baseline", "interim", "netzero"]);
    assert.deepEqual(pathway.actual, [{ year: 2024, value: 64 }, { year: issued.reportingYear, value: issued.emissions.totalTco2e }], "the benchmark and this report's assured total");
    assert.equal(reportPathway({ ...issued, scope: { kind: "sites", siteIds: ["s-a"], siteLabels: ["Works"] } }, issued.targets), null, "a site report draws no client-level pathway");
  });

  it("never draws an intensity pathway beside an Intensity section that states it has no measures (found by the render)", async () => {
    const html = await render({ ...composition(), intensity: { state: "unavailable", reason: "No intensity measures were set up for this client when the report was issued." } });
    assert.ok(pageWith(html, "Emissions intensity").includes("No intensity measures were set up"));
    assert.ok(!html.includes(titles.intensity), "no pathway contradicting the stated gap");
  });

  describe("the first assured period beside a chart of earlier reviewed years (F-2 finding 3, ruled (a))", () => {
    const firstAssured = (issued: ReportComposition): ReportComposition => {
      if ("state" in issued.emissions) throw new Error("expected composed emissions");
      const { comparison } = issued.emissions;
      if (!comparison) throw new Error("expected a comparison");
      return { ...issued, emissions: { ...issued.emissions, comparison: { ...comparison, columns: comparison.columns.slice(1), totals: comparison.totals.slice(1), rows: comparison.rows.map((row) => ({ ...row, values: row.values.slice(1) })) } } };
    };
    const reworded = "This is the first assured period, so there is no earlier assured period to compare against. The chart below includes earlier reviewed years.";
    const issuedText = "This is the first assured period, so there is no earlier period to compare against.";

    it("says which is which when the chart draws earlier reviewed years — never denying the chart beneath it", async () => {
      const html = await render(firstAssured(composition()));
      assert.ok(html.includes(titles.yearOnYear), "the chart draws the earlier reviewed year");
      assert.ok(html.includes(reworded));
      assert.ok(!html.includes(issuedText));
    });

    it("keeps the plain sentence when the chart has no earlier year to show", async () => {
      const issued = firstAssured(composition());
      const basis = issued.chartBasis!;
      const current = basis.annualComparison.find((entry) => entry.year === issued.reportingYear)!;
      // A chart is still drawn (two years), but its other year is later, not earlier: nothing earlier to own up to.
      const html = await render({ ...issued, chartBasis: { ...basis, annualComparison: [current, { ...current, year: issued.reportingYear + 1 }] } });
      assert.ok(html.includes(titles.yearOnYear), "a chart is drawn");
      assert.ok(html.includes(issuedText));
      assert.ok(!html.includes("earlier reviewed years"));
    });

    it("composed@1 keeps its issued text exactly — the reword is composed@2's alone", async () => {
      const { chartBasis: _basis, ...rest } = firstAssured(composition());
      const html = await render({ ...rest, renderer: "composed@1" });
      assert.ok(html.includes(issuedText));
      assert.ok(!html.includes("earlier reviewed years"));
    });
  });

  it("a composed@2 report without a basis draws none of the basis's charts rather than guessing them", async () => {
    const { chartBasis: _basis, ...rest } = composition();
    const html = await render(rest);
    for (const title of [titles.yearOnYear, titles.intensity, titles.purchased]) assert.ok(!html.includes(title), title);
    // The pathway is the report's own Targets section, not the basis — it stands either way.
    assert.ok(html.includes(titles.pathway));
  });
});
