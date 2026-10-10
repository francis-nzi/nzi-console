import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { crpChartSamples, crpProfessionalManifest, ManifestChartSet, reviewedCrpSnapshotSample } from "@nzi/charts";
import { defaultReportSectionPlan, type ReportComposition } from "@nzi/contracts";
import { chartsHonouringPlan, dashboardVisibility, dashboardVisibilityOf, manifestHonouringPlan } from "../app/portal/dashboardPlan";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const leaveOut = (...keys: string[]) => defaultReportSectionPlan.map((entry) => keys.includes(entry.key) ? { ...entry, included: false } : entry);

/**
 * F-4c (RULING-reporting-F4b-flip-and-dashboard, decision 2; GATE 1 for the exclusion flip): the client's emissions dashboard
 * honours the report it is drawn from. A section that report leaves out — targets, intensity, sites — has its tiles, charts and
 * table withheld here too, by the same plan; the omission is said; an unreadable plan withholds them (fail closed) and says so.
 */
describe("the portal dashboard honours the report it is drawn from (F-4c)", () => {
  it("a report that leaves nothing out shows everything — today's dashboard, unchanged", () => {
    assert.deepEqual(dashboardVisibility(defaultReportSectionPlan), { targets: true, intensity: true, sites: true, omitted: [] });
    assert.equal(manifestHonouringPlan(crpProfessionalManifest, dashboardVisibility(defaultReportSectionPlan)), crpProfessionalManifest, "the manifest itself, untouched");
  });

  it("a left-out section is withheld, and named", () => {
    const visibility = dashboardVisibility(leaveOut("targets", "sites"));
    assert.deepEqual([visibility.targets, visibility.intensity, visibility.sites], [false, true, false]);
    assert.deepEqual(visibility.omitted, ["Sites & reporting boundary", "Targets & reduction pathway"]);
  });

  it("the plan comes from the report's frozen composition; a version issued before compositions shows everything; an unreadable plan fails closed", () => {
    const composition = { sectionPlan: leaveOut("intensity") } as unknown as ReportComposition;
    assert.equal(dashboardVisibilityOf({ state: "composed", composition }).intensity, false);
    assert.deepEqual(dashboardVisibilityOf({ state: "pre-composition" }), { targets: true, intensity: true, sites: true, omitted: [] });
    assert.deepEqual(dashboardVisibilityOf({ state: "failed" }), { targets: false, intensity: false, sites: false, omitted: [], unverified: true });
  });

  it("the chart set still draws without the withheld charts — the manifest view drops them from its requirements, not just the page", () => {
    (globalThis as { React?: unknown }).React = React;
    const visibility = dashboardVisibility(leaveOut("targets", "intensity", "sites"));
    const view = manifestHonouringPlan(crpProfessionalManifest, visibility);
    assert.deepEqual(view.charts.map((chart) => chart.id), ["emissions_scope_donut", "scope_year_on_year_bar", "emissions_by_activity", "purchased_goods_breakdown"]);
    assert.ok(!view.sections.some((section) => section.chartIds.length === 0), "no empty section is left behind");
    const html = renderToStaticMarkup(createElement(ManifestChartSet, { manifest: view, charts: chartsHonouringPlan(crpChartSamples, visibility), reviewedSnapshotId: reviewedCrpSnapshotSample.id }));
    assert.doesNotMatch(html, /publication blocked/i, "withholding a required chart does not block the set");
    assert.ok(!html.includes("Emissions reduction pathway to net zero"), "the targets section's chart is not drawn");
    assert.match(html, /carbon emissions by scope/, "the emissions charts stand");
    // Control: withholding the chart from the full manifest is what would block it — why the view exists.
    const blocked = renderToStaticMarkup(createElement(ManifestChartSet, { manifest: crpProfessionalManifest, charts: chartsHonouringPlan(crpChartSamples, visibility), reviewedSnapshotId: reviewedCrpSnapshotSample.id }));
    assert.match(blocked, /publication blocked/i);
  });

  it("the dashboard reads the plan of the very report it shows, and gates each piece on it", () => {
    const dashboard = read("apps/console/app/portal/jobs/[jobId]/PortalDashboard.tsx");
    assert.match(dashboard, /published-report\/composition\?reportVersionId=\$\{encodeURIComponent\(reportVersionId\)\}/);
    assert.match(dashboard, /dashboardVisibilityOf\(await planSourceFor\(jobId, dashboard\.reportVersionId\)\)/, "the dashboard's own report version");
    assert.match(dashboard, /\{dashboard\.target && visibility\.targets \?/, "the target-progress tile");
    assert.match(dashboard, /\{dashboard\.bySite\.length > 1 && visibility\.sites \?/, "the site table");
    assert.match(dashboard, /<ManifestChartSet manifest=\{manifest\} charts=\{charts\}/, "the charts, through the manifest view");
    assert.match(dashboard, /const charts = chartsHonouringPlan\(state\.charts, visibility\);/);
    assert.match(dashboard, /Left out of your report at/, "the omission is said");
    assert.match(dashboard, /visibility\.unverified \?/, "an unreadable plan is said too");
  });
});
