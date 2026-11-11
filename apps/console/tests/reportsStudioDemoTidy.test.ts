import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  defaultReportRegisterQuery, filterReportRegister, reportEligibilityLabels, reportEligibilityOf, reportStageLabels,
  type ReportRegisterRow,
} from "@nzi/contracts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/** The /reports Publication Studio tidy for the demo (11 Nov 2026): UI and copy only — every predicate is unchanged. */
describe("Publication Studio demo tidy", () => {
  const page = read("apps/console/app/reports/page.tsx");
  const view = read("apps/console/app/reports/ReportRegisterView.tsx");

  it("1: the hero box is gone", () => {
    assert.doesNotMatch(page, /nz-report-hero|nz-report-flow|One governed publishing system|board-ready report/);
    assert.match(page, /<h1>Publication studio<\/h1>/, "the page head stays");
  });

  it("2: the 'Derived from the records themselves…' line is gone, the section heading stays", () => {
    assert.doesNotMatch(page, /Derived from the records themselves/);
    assert.match(page, /<h2>Every CRP job, at its stage<\/h2><\/div><\/div>/);
  });

  it("3: the Client filter is the shared SmartSearch typeahead, with 'All clients' to undo a choice", () => {
    assert.match(view, /import \{ DataListPager, SmartSearch, type SmartSearchOption \} from "@nzi\/ui";/);
    assert.match(view, /<label htmlFor="report-register-client"><span>Client<\/span><SmartSearch id="report-register-client" label="Client" options=\{options\.clients\} value=\{query\.clientId \?\? ""\}/);
    assert.match(view, /onChange=\{\(id\) => update\(\{ clientId: id \|\| null \}\)\}/, "'All clients' (id \"\") clears the filter");
    assert.match(view, /const ALL_CLIENTS: SmartSearchOption = \{ id: "", label: "All clients" \};/);
    assert.doesNotMatch(view, /<select value=\{query\.clientId/, "no long dropdown");
    assert.match(read("packages/ui/src/styles.css"), /\.nz-reportreg-filters \.nz-smart-chosen\{display:none\}/, "no 'Selected' echo under a filter");
  });

  it("4: 'Lead consultant' reads 'CRM' — still filtering on the lead consultant", () => {
    assert.doesNotMatch(view, /<span>Lead consultant<\/span>|<th>Lead consultant<\/th>/);
    assert.match(view, /<label><span>CRM<\/span><select value=\{query\.leadConsultant \?\? ""\} onChange=\{\(event\) => update\(\{ leadConsultant:/);
    assert.match(view, /<th>CRM<\/th>/);
    const rows = [row({ jobId: "a", leadConsultant: "Maya Osei" }), row({ jobId: "b", leadConsultant: "Sam Lee" })];
    const shown = filterReportRegister(rows, { ...defaultReportRegisterQuery, whose: "all", leadConsultant: "Maya Osei" }, null);
    assert.deepEqual(shown.map((r) => r.jobId), ["a"]);
  });

  it("5: the job list pages with the Clients list's rows-per-page and page nav, back to page 1 on a filter change", () => {
    assert.match(view, /\{shown\.map\(\(job\) => <ReportRegisterRow key=\{job\.jobId\} job=\{job\} \/>\)\}/);
    assert.match(view, /const shown = visible\.slice\(\(current - 1\) \* pageSize, current \* pageSize\);/);
    assert.match(view, /<DataListPager label="CRP jobs" paging=\{\{ page: current, pageCount, pageSize, pageSizes: PAGE_SIZES, total: visible\.length \}\}/);
    assert.match(view, /const update = \(patch: Partial<ReportRegisterQuery>\) => \{ setPage\(1\);/);
    // The same pager the Clients list draws, now one component.
    assert.match(read("packages/ui/src/DataList.tsx"), /<DataListPager label=\{label\} paging=\{paging\} onPage=\{onPage\} onPageSize=\{onPageSize\} \/>/);
  });

  it("5: the pager renders rows-per-page and Prev / Page n of m / Next", async () => {
    (globalThis as { React?: unknown }).React = React;
    const { DataListPager } = await import("@nzi/ui");
    const html = renderToStaticMarkup(createElement(DataListPager, {
      label: "CRP jobs", paging: { page: 2, pageCount: 3, pageSize: 25, pageSizes: [25, 50, 100, 200], total: 60 }, onPage: () => {}, onPageSize: () => {},
    }));
    assert.match(html, /<nav class="nz-datalist-pager" aria-label="CRP jobs pages">/);
    assert.match(html, /Rows per page/);
    assert.match(html, /Page 2 of 3/);
    assert.doesNotMatch(html, /disabled=""/, "page 2 of 3: both Prev and Next are live");
  });

  it("6: the Report filter options read 'Ready to compose' and 'Imported' — predicates unchanged", () => {
    assert.equal(reportEligibilityLabels["compose-eligible"], "Ready to compose");
    assert.equal(reportEligibilityLabels["v7-awaiting"], "Imported");
    assert.equal(reportEligibilityLabels["no-evidence"], "No evidence yet");
    assert.equal(reportEligibilityOf(row({ hasSnapshot: true })), "compose-eligible");
    assert.equal(reportEligibilityOf(row({ publishedVersionId: "rv-1" })), "compose-eligible");
    assert.equal(reportEligibilityOf(row({ v7Record: true })), "v7-awaiting");
    assert.equal(reportEligibilityOf(row({})), "no-evidence");
  });

  it("7: an imported job shows one 'Imported' badge, under the job — its last column is empty, no record-of-account copy", () => {
    assert.match(view, /<span className=\{`nz-register-eligibility \$\{eligibility\}`\}>\{reportEligibilityLabels\[eligibility\]\}<\/span>/, "the one badge");
    assert.doesNotMatch(view, />Imported</, "no second, hard-coded 'Imported' badge");
    assert.match(view, /\n\s+: null\}<\/td>/, "no action for an imported job");
    assert.doesNotMatch(view, /<details className="nz-v7-record">|v7RecordLine|record of account|re-ingested/i);
  });

  it("the report-version page says nothing about the console either", () => {
    for (const file of ["page.tsx", "ReportComposedView.tsx"]) {
      const source = read(`apps/console/app/reports/[versionId]/${file}`);
      assert.doesNotMatch(source, /this console|Connect this console/i, file);
    }
  });

  it("no user-facing 'console' on the studio: the stage label and the filter labels", () => {
    assert.equal(reportStageLabels["v7-record"], "Previously issued");
    for (const label of [...Object.values(reportStageLabels), ...Object.values(reportEligibilityLabels)]) assert.doesNotMatch(label, /console/i, label);
    for (const text of [...page.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]!)) assert.doesNotMatch(text, /console/i, text);
  });
});

function row(patch: Partial<ReportRegisterRow>): ReportRegisterRow {
  return {
    jobId: "j", publishedVersionId: null, hasSnapshot: false, v7Record: false, jobNumber: "J000001", legacyJobNumber: null,
    clientId: "c", client: "Client", title: "", ownerUserId: null, leadConsultant: null, reportingYear: 2025, stage: "in-preparation", ...patch,
  };
}
