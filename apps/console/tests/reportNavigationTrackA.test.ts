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
    assert.match(link, /report-status\?jobId=\$\{encodeURIComponent\(jobId\)\}/, "the job's own row of the register");
    assert.match(link, /if \(!row\) return null;/, "an unread state offers nothing rather than a guess");
    assert.match(link, /if \(link\.kind === "add-evidence"\) return <span className="nz-job-report-link nz-job-report-state">No report yet — add evidence to begin<\/span>;/, "on its own page, no link to itself");
    assert.doesNotMatch(link, /openLegacyReport|legacy_report_versions|payload_sealed|\/v7-report/, "Q1 (b): nothing opens the sealed v7 report");
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
