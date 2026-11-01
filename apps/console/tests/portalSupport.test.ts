import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PortalAssuredDashboard } from "@nzi/contracts";
import { insightsFrom } from "../app/portal/insights/insightsView";

/**
 * BUILD-portal-shell-lookandfeel, increment 5: Insights & Help (insights from the job's assured figures, never new metrics) and
 * Files (R4: the mockup's layout as a labelled design preview — no file store, nothing presented as real, nothing actionable).
 */
(globalThis as { React?: unknown }).React = React;
type Published = Extract<PortalAssuredDashboard, { published: true }>;
const dashboard = (over: Partial<Published> = {}): Published => ({
  published: true, reportVersionId: "rv", publishedAt: "2026-10-01T00:00:00Z", dataHash: "h", trend: [],
  reportingYear: 2025, total: 200, byScope: { "1": 30, "2": 20, "3": 150 },
  byCategory: [{ scopeCode: "3.1", label: "Purchased goods and services", tco2e: 150 }, { scopeCode: "1", label: "Direct emissions", tco2e: 30 }],
  bySite: [{ siteId: "s-a", label: "Bristol bakery", tco2e: 120 }, { siteId: "s-b", label: "Avonmouth depot", tco2e: 80 }],
  intensity: null, intensityUnit: null,
  target: { baselineYear: 2024, baselineTco2e: 250, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
  ...over,
});

describe("Insights & Help, and the Files preview", () => {
  it("insights are read off the assured figures: the largest category and scope, against baseline, the largest site", () => {
    const insights = insightsFrom(dashboard());
    assert.deepEqual(insights.map((insight) => insight.id), ["largest-category", "largest-scope", "against-baseline", "largest-site"]);
    assert.match(insights[0]!.detail, /^Purchased goods and services is 75% of your emissions \(150\.0 tCO₂e\)/);
    assert.match(insights[1]!.detail, /^Scope 3 \(value chain\) makes up 75% of your 200\.0 tCO₂e\./);
    assert.match(insights[2]!.detail, /^Down 20% on your 2024 baseline — your interim target is −50% by 2030\./);
    assert.match(insights[3]!.detail, /^Bristol bakery accounts for 60%/);
  });

  it("says nothing it cannot support: no target, no baseline line; one site, no site line; no emissions, nothing", () => {
    assert.ok(!insightsFrom(dashboard({ target: null })).some((insight) => insight.id === "against-baseline"));
    assert.ok(!insightsFrom(dashboard({ bySite: [{ siteId: "s-a", label: "Only site", tco2e: 200 }] })).some((insight) => insight.id === "largest-site"));
    assert.deepEqual(insightsFrom(dashboard({ total: 0, byScope: { "1": 0, "2": 0, "3": 0 }, byCategory: [], bySite: [], target: null })), []);
  });

  it("Files is a labelled preview: coming soon, every row an example, nothing enabled, nothing fetched", async () => {
    const { FilesPreview } = await import("../app/portal/files/FilesPreview");
    const html = renderToStaticMarkup(createElement(FilesPreview));
    assert.match(html, /Preview — coming soon/);
    assert.match(html, /No files are stored here yet, and nothing below is yours/);
    assert.equal((html.match(/>Example</g) ?? []).length, 4, "every row is marked as an example");
    assert.match(html, /<button type="button" class="nz-btn pri" disabled="">Choose files<\/button>/);
    assert.doesNotMatch(html, /<input|<form|href=/, "nothing to submit, nothing to open");
  });
});
