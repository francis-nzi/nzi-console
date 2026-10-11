import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/** Track A (RULING-reporting-trackA): the job's report link, the shared picker, the self-explaining empty states, A5's copy. */
describe("Track A: report navigation", () => {
  it("A1: the job page carries one state-driven report link, in both header variants, through the shared rule", () => {
    const workspace = read("apps/console/app/jobs/CrpScopeWorkspace.tsx");
    assert.equal(workspace.split("<JobReportLink jobId={job.header.id} />").length - 1, 2, "the job shell header and the legacy header");
    const link = read("apps/console/app/jobs/JobReportLink.tsx");
    assert.match(link, /reportLinkFor\(row\)/);
    assert.match(link, /const row = useJobReportRow\(jobId\);/);
    assert.match(read("apps/console/app/lib/useJobReportRow.ts"), /report-status\?jobId=\$\{encodeURIComponent\(jobId\)\}/, "the job's own row of the register");
    assert.match(link, /if \(!row\) return null;/, "an unread state offers nothing rather than a guess");
    assert.match(link, /if \(link\.kind === "add-evidence"\) return <span className="nz-job-report-link nz-job-report-state">No report yet — add evidence to begin<\/span>;/, "on its own page, no link to itself");
    assert.doesNotMatch(link, /openLegacyReport|legacy_report_versions|payload_sealed|\/v7-report/, "Q1 (b): nothing opens the sealed v7 report");
  });

  it("addendum #1: preparing or opening the report is the job header's primary action, as on the register row", () => {
    const link = read("apps/console/app/jobs/JobReportLink.tsx");
    assert.match(link, /if \(link\.kind === "prepare" \|\| link\.kind === "published"\) return <Link className="nz-btn pri nz-job-report-link" href=\{link\.href\}>/);
  });

  it("addendum #2: every report-preparation state sits in the console chrome, with the Reports rail item current", () => {
    const frame = read("apps/console/app/report-preview/PrepareFrame.tsx");
    assert.match(frame, /<AppShell rail=\{<WorkspaceRail sections=\{NAV\} activeId="reports" user=\{USER\} \/>\}>/);
    assert.match(frame, /<TopBar crumbs=\{crumbTrail\(crumbs\)\} \/>/);
    assert.match(frame, /<div className="nz-preview-canvas">\{children\}<\/div>/, "the canvas is the inner container, not the page");
    const page = read("apps/console/app/report-preview/page.tsx");
    assert.match(page, /<PrepareFrame crumbs=\{prepareReportCrumbs\(\)\}><section className="nz-preview-picker">/, "the picker");
    assert.match(page, /<JobPrepareFrame jobId=\{jobId\}><LiveSnapshotPreview snapshot=\{data\.snapshots\[0\]\} \/><\/JobPrepareFrame>/, "the snapshot preview");
    assert.match(page, /<ScreenState result=\{result\} chrome=\{PREPARE_CHROME\}>/, "loading and a failed read");
    assert.match(page, /const PREPARE_CHROME = \{ activeId: "reports", label: "Reports", href: "\/reports" \};/);
    assert.match(read("apps/console/app/report-preview/JobPrepareFrame.tsx"), /<PrepareFrame crumbs=\{prepareReportCrumbs\(row \?/);
    assert.match(read("apps/console/app/report-preview/PreviewEmpty.tsx"), /<PrepareFrame crumbs=\{prepareReportCrumbs\(row \?/, "the empty states");
    for (const file of ["page.tsx", "PreviewEmpty.tsx"]) {
      assert.doesNotMatch(read(`apps/console/app/report-preview/${file}`), /<main className="nz-preview-canvas"/, `${file}: no standalone page`);
    }
  });

  it("A2/A3: the picker is the shared register, not a flat list of every job", () => {
    const page = read("apps/console/app/report-preview/page.tsx");
    assert.match(page, /<ReportRegisterView mode="picker"\/>/);
    assert.doesNotMatch(page, /loadScreen<\{jobs:JobScreenReadModel\[\]\}>\("jobs"/, "off listAllJobs: every family, cancelled jobs, a subquery per job");
    assert.doesNotMatch(page, /Select a live CRP job/);
  });

  it("A4: no snapshot is the preview's own case — the generic empty state no longer swallows it", () => {
    const page = read("apps/console/app/report-preview/page.tsx");
    assert.match(page, /if \(result\.state === "empty"\) return <PreviewEmpty jobId=\{jobId\} \/>;/);
    const empty = read("apps/console/app/report-preview/PreviewEmpty.tsx");
    assert.match(empty, /This period's record of account is its NZ Insights Pro v7 report — there is no console snapshot to compose yet\./);
    assert.match(empty, /Ready for first record/);
    assert.match(empty, /Add evidence/);
    assert.match(empty, /could not be read/, "an unread state says so rather than guessing which case it is");
    const view = read("apps/console/app/reports/ReportRegisterView.tsx");
    assert.match(view, /No jobs match these filters/, "a filter that matched nothing is a different message from no jobs");
    assert.match(view, /No live CRP jobs/);
  });

  it("A4: while it reads the job, the empty state says it is checking — never the bare 'Nothing here yet'", async () => {
    (globalThis as { React?: unknown }).React = React;
    const { PreviewEmpty } = await import("../app/report-preview/PreviewEmpty");
    const html = renderToStaticMarkup(createElement(PreviewEmpty, { jobId: "j-1" }));
    assert.match(html, /Checking this job/);
    assert.doesNotMatch(html, /Nothing here yet/);
    // Addendum #2: in the shell, Reports current; until the job is read, the trail is Reports / Prepare.
    assert.match(html, /class="nz-main"/);
    assert.match(html, /<a href="\/reports" class="active" aria-current="page">/, "the rail's Reports item is current");
    assert.match(html, /<a class="nz-crumb" href="\/reports">Reports<\/a>/);
    assert.match(html, /<a class="nz-crumb current" aria-current="page" href="\/report-preview">Prepare<\/a>/);
    assert.match(html, /<div class="nz-preview-canvas"><section class="nz-preview-empty">/);
  });

  it("A5 / Q1 (b): the false 'historical report view' copy is gone; imported history is the v7 record of account, awaiting re-compose", () => {
    assert.doesNotMatch(read("apps/console/app/jobs/CrpReleaseControl.tsx"), /historical report view/);
    assert.doesNotMatch(read("packages/isolated-backend/src/postgresCommands.ts"), /historical report view/);
    assert.match(read("apps/console/app/jobs/CrpReleaseControl.tsx"), /kept sealed as issued, so no console snapshot is made — it is awaiting re-compose/);
    const view = read("apps/console/app/reports/ReportRegisterView.tsx");
    assert.match(view, /reportEligibilityLabels\[eligibility\]/, "every row is badged by eligibility");
    assert.match(view, /v7RecordLine\(job\.v7Report\)/, "the record of account from its unsealed metadata");
  });
});
