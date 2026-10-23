import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { derivePortalBaseline, type PortalTrendYear, type ReviewedCrpSnapshotReadModel } from "@nzi/contracts";
import { MetricBars, MetricRing, MetricTrend, tokens } from "@nzi/charts";
import { ALL_SITES, METRIC_FORMS, metricFigures, metricFormOr, metricSites, metricTrend, type MetricMeasurement } from "../app/portal/metrics/metricsView";

/**
 * BUILD-portal-shell-lookandfeel R8 — the portal Metrics view: the forms each chart may take (never a misleading one), figures
 * identical to the dashboard's, the filters, and the re-formattable marks on @nzi/charts.
 */
(globalThis as { React?: unknown }).React = React;
const rows: MetricMeasurement[] = [
  { scope: "1", scopeCode: "1", siteId: "s-a", siteLabel: "Bristol bakery", tco2e: 33.4 },
  { scope: "2", scopeCode: "2", siteId: "s-b", siteLabel: "Avonmouth depot", tco2e: 21.7 },
  { scope: "1", scopeCode: "1", siteId: "s-b", siteLabel: "Avonmouth depot", tco2e: 6.6 },
  { scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, tco2e: 148.2 },
];
const all = { scope: "all" as const, site: ALL_SITES };

describe("the portal Metrics view", () => {
  describe("formats: only those true to each chart's job", () => {
    it("part-to-whole over the three scopes: donut, pie or bar; many-part magnitude: bars; a trend: line or bar — every chart a table", () => {
      assert.deepEqual(METRIC_FORMS.scope, ["donut", "pie", "bar", "table"]);
      assert.deepEqual(METRIC_FORMS.category, ["bar", "table"]);
      assert.deepEqual(METRIC_FORMS.site, ["bar", "table"]);
      assert.deepEqual(METRIC_FORMS.trend, ["line", "bar", "table"]);
      assert.ok(!METRIC_FORMS.trend.includes("pie") && !METRIC_FORMS.trend.includes("donut"), "never a pie of a trend");
      assert.ok(!METRIC_FORMS.site.includes("donut") && !METRIC_FORMS.category.includes("pie"), "never a ring of many parts");
    });

    it("a form asked for is honoured only where the chart allows it", () => {
      assert.equal(metricFormOr("scope", "pie"), "pie");
      assert.equal(metricFormOr("trend", "pie"), "line");
      assert.equal(metricFormOr("site", "donut"), "bar");
      assert.equal(metricFormOr("category", null), "bar");
    });
  });

  describe("the figures are the dashboard's", () => {
    it("unfiltered, every total equals the dashboard's derivation of the same published snapshot", () => {
      const snapshot = { reportingYear: 2025, target: null, intensityTarget: null, measurements: rows.map((row, index) => ({ ...row, rowId: `r${index}`, sourceLabel: "x", qualityTier: "measured", factorSet: "f" })) } as unknown as ReviewedCrpSnapshotReadModel;
      const dashboard = derivePortalBaseline(snapshot);
      const figures = metricFigures(rows, all);
      assert.equal(figures.total, dashboard.total);
      assert.deepEqual(figures.byScope, dashboard.byScope);
      assert.deepEqual(figures.byCategory.map((row) => [row.key, row.tco2e]), dashboard.byCategory.map((row) => [row.scopeCode, row.tco2e]));
      assert.deepEqual(figures.bySite.map((row) => [row.label, row.tco2e]), dashboard.bySite.map((row) => [row.label, row.tco2e]));
    });

    it("filters by scope and site; the chosen site is emphasised among the others, not left alone", () => {
      const scope1 = metricFigures(rows, { scope: "1", site: ALL_SITES });
      const tenth = (value: number) => Math.round(value * 10) / 10;
      assert.equal(tenth(scope1.total), 40);
      assert.equal(tenth(scope1.reportTotal), 209.9);
      assert.deepEqual(scope1.byCategory.map((row) => row.scope), ["1"]);
      const site = metricFigures(rows, { scope: "all", site: "s-b" });
      assert.equal(tenth(site.total), 28.3);
      assert.deepEqual(site.bySite.filter((row) => row.selected).map((row) => row.label), ["Avonmouth depot"]);
      assert.equal(site.bySite.length, 3, "every site stays as context");
      assert.deepEqual(metricSites(rows).map((entry) => entry.label), ["Unallocated", "Bristol bakery", "Avonmouth depot"]);
    });

    it("the trend is the dashboard's, scope-filtered; a year with no published report is a gap, never zero", () => {
      const trend: PortalTrendYear[] = [
        { year: 2025, kind: "current", total: 210, byScope: { "1": 40, "2": 21.7, "3": 148.2 } },
        { year: 2023, kind: "baseline", total: 260, byScope: { "1": 50, "2": 30, "3": 180 } },
        { year: 2024, kind: "prior", total: null, byScope: { "1": 0, "2": 0, "3": 0 } },
      ];
      const scoped = metricTrend(trend, "2");
      assert.deepEqual(scoped.years, [2023, 2024, 2025]);
      assert.deepEqual(scoped.series, [{ scope: "2", values: [30, null, 21.7] }]);
      assert.equal(metricTrend(trend, "all").series.length, 3);
    });
  });

  describe("the marks (@nzi/charts)", () => {
    const slices = [
      { key: "1", label: "Scope 1", value: 40, color: tokens.scope["1"]! },
      { key: "2", label: "Scope 2", value: 20, color: tokens.scope["2"]! },
      { key: "3", label: "Scope 3", value: 140, color: tokens.scope["3"]! },
    ];
    it("ring and pie: one fill per part with a 2px surface gap, every part direct-labelled with value and share, a title on each mark", () => {
      const donut = renderToStaticMarkup(createElement(MetricRing, { slices, unit: "tCO₂e", title: "By scope" }));
      assert.equal((donut.match(/<path /g) ?? []).length, 3);
      assert.match(donut, /stroke="#FFFFFF" stroke-width="2"/);
      for (const needle of ["Scope 1", "40", "20%", "<title>Scope 3: 140 tCO₂e (70%)</title>", ">200<"]) assert.ok(donut.includes(needle), needle);
      const pie = renderToStaticMarkup(createElement(MetricRing, { slices, pie: true, unit: "tCO₂e", title: "By scope" }));
      assert.doesNotMatch(pie, />200</, "a pie has no hole to carry the total");
    });

    it("bars: text in the ink tokens, never the series colour; a muted bar recedes", () => {
      const html = renderToStaticMarkup(createElement(MetricBars, { rows: [{ ...slices[0]!, muted: true }, slices[2]!], unit: "tCO₂e", title: "By site" }));
      assert.ok(html.includes(`fill="${tokens.line}"`), "the muted bar is the line token");
      assert.doesNotMatch(html, new RegExp(`color:\\s*${tokens.scope["3"]}`, "i"), "no text in a series colour");
    });

    it("trend: one y-axis; a gap year breaks the line rather than being drawn through", () => {
      const line = renderToStaticMarkup(createElement(MetricTrend, { years: [2023, 2024, 2025], series: [{ key: "1", label: "Scope 1", color: tokens.scope["1"]!, values: [50, null, 40] }], form: "line", unit: "tCO₂e", title: "Over time" }));
      assert.equal((line.match(/<polyline /g) ?? []).length, 2, "two runs, not one line across the missing year");
      assert.equal((line.match(/<circle /g) ?? []).length, 2);
      const bar = renderToStaticMarkup(createElement(MetricTrend, { years: [2023, 2024, 2025], series: [{ key: "1", label: "Scope 1", color: tokens.scope["1"]!, values: [50, null, 40] }], form: "bar", unit: "tCO₂e", title: "Over time" }));
      assert.equal((bar.match(/<rect /g) ?? []).length, 2, "no bar for the missing year");
    });
  });
});
