import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { crpChartSamples, crpProfessionalManifest, reviewedCrpSnapshotSample } from "@nzi/charts";
import { defaultReportSectionPlan, type PortalAssuredDashboard } from "@nzi/contracts";
import { dashboardVisibility, dashboardVisibilityOf } from "../app/portal/dashboardPlan";
import {
  DASHBOARD_SECTIONS, dashboardTasks, isPortalLiveBroadcastList, portalDashboardManifest, reportingYearOptions, sourceLine, surroundingsFrom, versusBaseline, yearOnYear,
  type PortalJobSummary,
} from "../app/portal/dashboardView";
import { PortalDashboardView, type DashboardSurroundings, type ReadyState } from "../app/portal/jobs/[jobId]/PortalDashboard";
import { organisationCopy } from "../app/lib/organisationName";

/**
 * BUILD-client-portal-dashboard: the client's Dashboard laid out as MOCKUP-client-portal.html, on the same data and the same gates.
 * Every section present for a full report; each tile and chart a left-out section speaks to withheld, and named; tasks only from
 * flows that already know them, routed to the report; no money anywhere (NZC-120). The plan's own rules stay pinned in
 * `portalDashboardHonoursReport`.
 */
(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const leaveOut = (...keys: string[]) => defaultReportSectionPlan.map((entry) => keys.includes(entry.key) ? { ...entry, included: false } : entry);
const formatDate = (iso: string) => iso.slice(0, 10);

const DASHBOARD: Extract<PortalAssuredDashboard, { published: true }> = {
  published: true, reportVersionId: "rv-2026", publishedAt: "2026-08-24T10:00:00Z", dataHash: "sha256:abcdef0123456789abcdef",
  reportingYear: 2026, total: 13157, byScope: { "1": 76, "2": 77, "3": 13004 },
  byCategory: [{ scopeCode: "3.1", label: "Purchased goods and services", tco2e: 12000 }, { scopeCode: "1", label: "Company vehicles", tco2e: 76 }],
  bySite: [{ siteId: "s1", label: "Head Office", tco2e: 9000 }, { siteId: "s2", label: "Depot", tco2e: 4157 }],
  intensity: 126.6, intensityUnit: "tCO₂e per employee",
  target: { baselineYear: 2022, baselineTco2e: 14000, interimYear: 2035, interimReductionPercent: 50, netZeroYear: 2050 },
  trend: [
    { year: 2022, kind: "baseline", total: 14000, byScope: { "1": 90, "2": 110, "3": 13800 } },
    { year: 2025, kind: "prior", total: 13000, byScope: { "1": 80, "2": 80, "3": 12840 } },
    { year: 2026, kind: "current", total: 13157, byScope: { "1": 76, "2": 77, "3": 13004 } },
  ],
};
const JOB: PortalJobSummary = { id: "job-2026", number: "J000663", reportingYear: 2026, hasPublishedReport: true, approved: false, hasUnreadNziResponse: false };
const ready = (visibility = dashboardVisibility(defaultReportSectionPlan)): ReadyState => ({
  kind: "ready", dashboard: DASHBOARD, charts: crpChartSamples, snapshotId: reviewedCrpSnapshotSample.id, visibility,
  identity: { client: "EFF Group", jobNumber: "J000663", asAt: "2026-08-24T09:00:00Z", sources: "CEDA 2025 v1.0 · DEFRA 2024 v1.2", comparison: [] },
});
const SURROUNDINGS: DashboardSurroundings = {
  years: { kind: "ready", value: [{ year: 2026, jobId: "job-2026" }, { year: 2025, jobId: "job-2025" }] },
  tasks: { kind: "ready", value: dashboardTasks({ jobId: "job-2026", job: JOB, reportingYear: 2026, formatDate,
    dataEntry: { access: { state: "open", startsAt: "2026-09-01", expiresAt: "2026-11-12T23:59:00Z" }, buckets: [{ bucketGrantId: "b-travel", sourceLabel: "business travel" }, { bucketGrantId: "b-gas", sourceLabel: "gas" }], submittedBucketIds: new Set(["b-gas"]) } }) },
  broadcasts: { kind: "ready", value: [{ broadcastId: "bc1", title: "SECR guidance update — FY2026", body: "New reporting guidance affects how travel emissions are disclosed.", style: "info" as never, link: null, startsAt: "2026-10-01T00:00:00Z", endsAt: null }] },
};
const org = organisationCopy({ displayName: "Net Zero International", shortName: "NZI" });
const render = (state = ready(), surroundings = SURROUNDINGS) =>
  renderToStaticMarkup(createElement(PortalDashboardView, { jobId: "job-2026", state, surroundings, org }));

describe("the client portal Dashboard view (BUILD-client-portal-dashboard)", () => {
  describe("what the view derives", () => {
    it("the dashboard manifest is the report's, regrouped into the mockup's two sections — same specs, same requirements", () => {
      const manifest = portalDashboardManifest(crpProfessionalManifest);
      assert.deepEqual(manifest.sections.map((section) => [section.title, section.chartIds, section.layout]), [
        ["Carbon emissions", ["emissions_scope_donut", "reduction_pathway"], "two-column"],
        ["Emissions performance", ["scope_year_on_year_bar", "emissions_by_activity"], "two-column"],
      ]);
      for (const chart of manifest.charts) assert.deepEqual(chart, crpProfessionalManifest.charts.find((entry) => entry.id === chart.id), `${chart.id}: unchanged`);
      assert.equal(manifest.charts.length, DASHBOARD_SECTIONS.flatMap((section) => section.chartIds).length);
    });

    it("year on year and against the baseline: direction and size only, and nothing when there is nothing to compare", () => {
      assert.deepEqual(yearOnYear(DASHBOARD), { direction: "up", percent: 1.2, year: 2025 });
      assert.deepEqual(versusBaseline(DASHBOARD), { direction: "down", percent: 6, year: 2022 });
      assert.equal(yearOnYear({ ...DASHBOARD, trend: DASHBOARD.trend.filter((entry) => entry.kind !== "prior") }), null, "no prior year: no delta");
      const noPrior = { ...DASHBOARD, trend: DASHBOARD.trend.filter((entry) => entry.kind !== "prior") };
      assert.deepEqual(yearOnYear(noPrior, [{ year: 2025, values: [{ value: 100 }, { value: 13057 }] }]), { direction: "flat", percent: 0, year: 2025 },
        "no chain snapshot for the prior year: the year the report itself compares against");
      assert.deepEqual(yearOnYear(DASHBOARD, [{ year: 2025, values: [{ value: 1 }] }]), { direction: "up", percent: 1.2, year: 2025 }, "the chain snapshot first");
      assert.equal(yearOnYear(noPrior, [{ year: 2024, values: [{ value: 1 }] }]), null, "only the year before counts");
      assert.equal(versusBaseline({ ...DASHBOARD, target: null, trend: DASHBOARD.trend.filter((entry) => entry.kind !== "baseline") }), null, "no baseline: none");
      assert.deepEqual(versusBaseline({ ...DASHBOARD, target: null }), { direction: "down", percent: 6, year: 2022 }, "the trend's baseline when no target");
    });

    it("the source line names each factor set once, in order; the year selector lists published years, newest first", () => {
      assert.equal(sourceLine([{ factorSet: "DEFRA 2024 v1.2" }, { factorSet: "CEDA 2025 v1.0" }, { factorSet: "DEFRA 2024 v1.2" }, { factorSet: null }]), "CEDA 2025 v1.0 · DEFRA 2024 v1.2");
      assert.deepEqual(reportingYearOptions([JOB, { ...JOB, id: "job-2024", reportingYear: 2024 }, { ...JOB, id: "job-draft", reportingYear: 2025, hasPublishedReport: false }, { ...JOB, id: "job-2025", reportingYear: 2025 }]),
        [{ year: 2026, jobId: "job-2026" }, { year: 2025, jobId: "job-2025" }, { year: 2024, jobId: "job-2024" }]);
    });

    it("tasks come only from flows that know them: an open window's unsubmitted categories, the unapproved report, an unread reply", () => {
      const open = { access: { state: "open" as const, startsAt: "2026-09-01", expiresAt: "2026-11-12T00:00:00Z" }, buckets: [{ bucketGrantId: "b1", sourceLabel: "business travel" }, { bucketGrantId: "b2", sourceLabel: "gas" }], submittedBucketIds: new Set(["b2"]) };
      const tasks = dashboardTasks({ jobId: "job-2026", job: { ...JOB, hasUnreadNziResponse: true }, reportingYear: 2026, dataEntry: open, formatDate });
      assert.deepEqual(tasks.map((task) => [task.kind, task.title, task.detail, task.href]), [
        ["submit-data", "Submit business travel data", "Due 2026-11-12 · FY2026", "/portal/jobs/job-2026"],
        ["approve-report", "Approve the J000663 report", "Awaiting your sign-off", "/portal/jobs/job-2026"],
        ["read-reply", "Read your adviser's reply", "On J000663", "/portal/jobs/job-2026"],
      ]);
      assert.deepEqual(dashboardTasks({ jobId: "job-2026", job: { ...JOB, approved: true }, reportingYear: 2026, dataEntry: { ...open, access: { ...open.access, state: "scheduled" } }, formatDate }), [],
        "a window not yet open, and an approved report: nothing to do");
      assert.ok(!tasks.some((task) => /upload/i.test(task.title)), "no upload task: the portal has no source for one yet");
    });

    it("the broadcast list is verified before it is drawn", () => {
      assert.ok(isPortalLiveBroadcastList({ broadcasts: SURROUNDINGS.broadcasts.kind === "ready" ? SURROUNDINGS.broadcasts.value : [] }));
      assert.ok(!isPortalLiveBroadcastList({ broadcasts: [{ broadcastId: 1 }] }));
      assert.ok(!isPortalLiveBroadcastList({}));
    });

    it("the surroundings are read as the routes answer — { jobs }, { access, buckets }, { records }, { broadcasts } — and a source that does not verify is failed, never empty", () => {
      // The shapes the routes return (api/portal/jobs, …/data-entry-access, …/data-entry-records, api/portal/broadcasts). The first
      // rendered check caught the loader reading the job list as a bare array: the year selector and tasks fell to "failed".
      const routeJob = { id: "job-2026", number: "J000663", title: "2026 Carbon Reduction Plan", reportingYear: 2026, hasPublishedReport: true, approved: false, approvedAt: null, hasUnreadNziResponse: false };
      const answers = {
        jobs: { ok: true as const, body: { jobs: [routeJob, { ...routeJob, id: "job-2025", number: "J000600", reportingYear: 2025, approved: true, approvedAt: "2025-09-01T00:00:00Z" }] } },
        access: { ok: true as const, body: { access: { jobId: "job-2026", state: "open", startsAt: "2026-09-01T00:00:00Z", expiresAt: "2026-11-12T23:59:00Z", reportingMonths: [] },
          buckets: [{ bucketGrantId: "b-travel", sourceLabel: "business travel", scope: "3.6" }, { bucketGrantId: "b-gas", sourceLabel: "gas", scope: "1" }] } },
        records: { ok: true as const, body: { records: [{ recordId: "r1", bucketGrantId: "b-gas", status: "submitted" }, { recordId: "r2", bucketGrantId: "b-travel", status: "draft" }] } },
        broadcasts: { ok: true as const, body: { broadcasts: SURROUNDINGS.broadcasts.kind === "ready" ? SURROUNDINGS.broadcasts.value : [] } },
      };
      const read = surroundingsFrom({ jobId: "job-2026", reportingYear: 2026, formatDate, ...answers });
      assert.deepEqual(read.years, { kind: "ready", value: [{ year: 2026, jobId: "job-2026" }, { year: 2025, jobId: "job-2025" }] });
      assert.deepEqual(read.tasks.kind === "ready" ? read.tasks.value.map((task) => task.title) : read.tasks, ["Submit business travel data", "Approve the J000663 report"]);
      assert.equal(read.broadcasts.kind, "ready");
      assert.deepEqual(surroundingsFrom({ jobId: "job-2026", reportingYear: 2026, formatDate, ...answers, access: { ok: true, body: { access: null, buckets: [] } } }).tasks,
        { kind: "ready", value: [{ id: "approve-job-2026", kind: "approve-report", title: "Approve the J000663 report", detail: "Awaiting your sign-off", href: "/portal/jobs/job-2026", action: "Review" }] },
        "no data-entry window: only the approval");
      for (const [label, broken] of [
        ["the job list as a bare array", { jobs: { ok: true as const, body: [routeJob] } }],
        ["the jobs route failing", { jobs: { ok: false as const } }],
        ["the records unreadable", { records: { ok: false as const } }],
        ["the access route failing", { access: { ok: false as const } }],
      ] as const) {
        assert.deepEqual(surroundingsFrom({ jobId: "job-2026", reportingYear: 2026, formatDate, ...answers, ...broken }).tasks, { kind: "failed" }, label);
      }
      assert.deepEqual(surroundingsFrom({ jobId: "job-2026", reportingYear: 2026, formatDate, ...answers, broadcasts: { ok: true, body: { broadcasts: [{}] } } }).broadcasts, { kind: "failed" });
    });
  });

  describe("the view", () => {
    it("a full report draws every section of the mockup", () => {
      const html = render();
      for (const expected of [
        "Carbon account", "<h1 class=\"nz-pd-client\">EFF Group</h1>", "Reporting year 2026 · Reviewed snapshot · as at",
        "Current emissions (2026)", "13,157", "1.2% vs 2025", "Vs baseline", "Against your 2022 baseline", "Intensity", "126.6", "Net zero target", "2050", "24 years to go",
        "Reviewed snapshot</b> · evidence state <b>Assured", "J000663 · CEDA 2025 v1.0 · DEFRA 2024 v1.2", "Publication gate passed",
        "What NZI needs from you", "Submit business travel data", "Due 2026-11-12 · FY2026", "Approve the J000663 report",
        "Carbon emissions", "Emissions performance", "View chart evidence",
        "Latest from NZI", "SECR guidance update — FY2026", "Every figure as a table", "Emissions by site",
      ]) assert.ok(html.includes(expected), `missing: ${expected}`);
      assert.doesNotMatch(html, /publication blocked/i, "the regrouped manifest validates against the report's charts");
      assert.ok(!html.includes("Submit gas data"), "a category already submitted is not asked for again");
      assert.match(html, /<option value="2025">2025<\/option>/, "the year selector lists the published years");
      assert.match(html, /href="\/portal\/jobs\/job-2026"[^>]*>Review</, "the approval card routes to the report's review");
    });

    it("each tile and chart a left-out section speaks to is withheld, and the omission is named", () => {
      const targets = render(ready(dashboardVisibility(leaveOut("targets"))));
      assert.match(targets, /Net zero target<\/span><b class="v">—<\/b><span class="s">Left out of your report/);
      assert.ok(!targets.includes("Emissions reduction pathway to net zero"), "the pathway chart is not drawn");
      assert.match(targets, /Left out of your report at your NZI adviser.s choice, so not shown here either: Targets &amp; reduction pathway/);
      assert.doesNotMatch(targets, /publication blocked/i);

      const intensity = render(ready(dashboardVisibility(leaveOut("intensity"))));
      assert.match(intensity, /Intensity<\/span><b class="v">—<\/b><span class="s">Left out of your report/);
      assert.ok(!intensity.includes("126.6"), "the intensity figure is not shown");

      const sites = render(ready(dashboardVisibility(leaveOut("sites"))));
      assert.ok(!sites.includes("Emissions by site"), "the site table is withheld");
      assert.ok(!sites.includes("Head Office"));
    });

    it("an unreadable plan withholds every section-dependent piece and says so; a report issued before compositions shows everything", () => {
      const unverified = render(ready(dashboardVisibilityOf({ state: "failed" })));
      assert.match(unverified, /could not be checked just now/);
      assert.ok(!unverified.includes("2050") && !unverified.includes("126.6") && !unverified.includes("Emissions by site"));
      const preComposition = render(ready(dashboardVisibilityOf({ state: "pre-composition" })));
      for (const expected of ["2050", "126.6", "Emissions by site", "Emissions reduction pathway to net zero"]) assert.ok(preComposition.includes(expected), expected);
    });

    it("a source that cannot be read is said, never shown as nothing to do", () => {
      const html = render(ready(), { years: { kind: "failed" }, tasks: { kind: "failed" }, broadcasts: { kind: "failed" } });
      assert.match(html, /Your outstanding tasks could not be checked just now. Nothing has been assumed done./);
      assert.match(html, /The latest updates could not be loaded just now./);
      assert.ok(!html.includes("<select"), "no year selector without the portfolio");
      assert.match(render(ready(), { ...SURROUNDINGS, tasks: { kind: "ready", value: [] } }), /Nothing is waiting on you right now./);
    });

    it("changes are said by direction, in words — never by a good/bad colour", () => {
      const html = render();
      assert.match(html, /aria-label="Up 1.2% vs 2025"/);
      assert.doesNotMatch(read("apps/console/app/portal/jobs/[jobId]/PortalDashboard.tsx"), /className=\{?["'`][^"'`]*\b(good|bad|warn|danger|up|down)\b/, "no judgement class on a change");
    });

    it("no money anywhere (NZC-120), and the client's copy of the report only", () => {
      const html = render();
      assert.doesNotMatch(html, /£|\$|€|turnover|revenue/i);
      // A client whose intensity metric is per unit of turnover sees the report's own unit (as the report and its intensity chart
      // already print it) — a ratio, never the turnover figure or any other amount of money.
      const perTurnover = render({ ...ready(), dashboard: { ...DASHBOARD, intensity: 1174.6, intensityUnit: "tCO₂e / £m" } });
      assert.match(perTurnover, /tCO₂e \/ £m/);
      assert.doesNotMatch(perTurnover, /[£$€]\s?\d|\d\s?[£$€]|turnover|revenue/i, "no amount of money");
      const source = read("apps/console/app/portal/jobs/[jobId]/PortalDashboard.tsx");
      assert.ok(!/\/api\/isolated/.test(source), "never a staff route");
      assert.match(source, /fetch\(`\$\{surface\.api\}\/jobs\/\$\{jobId\}\/published-report`/, "the client's copy (clientFacingPublishedReport, applied at the route)");
      assert.match(read("apps/console/app/portal/portalSurface.tsx"), /CLIENT_PORTAL_SURFACE: PortalSurface = \{ api: "\/api\/portal"/, "the client's routes, unless the staff preview says otherwise");
      assert.ok(!/method:\s*"(POST|PATCH|PUT|DELETE)"/.test(source), "no write path: the view only reads");
    });
  });
});
