import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReportComposition } from "@nzi/contracts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const composition = () => JSON.parse(fixture("composition-composed3-whole.json")) as ReportComposition;
(globalThis as { React?: unknown }).React = React;

/**
 * B2-1 (RULING-report-studio-B2): the Report Studio's Report Printing — the section rail beside the composed document. Display
 * only: the document is the pinned composed renderer, drawn unchanged; the studio reads and never writes.
 */
describe("Report Studio: which version it opens", async () => {
  const { pickStudioVersion, studioHasReport } = await import("../app/jobs/[jobId]/report/studio");
  const row = (id: string, jobId: string, status: "draft" | "validated" | "published" | "superseded", createdAt: string) =>
    ({ reportVersionId: id, jobId, status, createdAt, publishedAt: status === "published" ? createdAt : null, scopeLabel: "Whole client", version: 1 });
  const register = [
    row("v-old", "j1", "published", "2026-10-01T09:00:00Z"), row("v-new", "j1", "validated", "2026-10-10T09:00:00Z"),
    row("v-gone", "j1", "superseded", "2026-10-12T09:00:00Z"), row("v-draft", "j1", "draft", "2026-10-13T09:00:00Z"),
    row("v-other", "j2", "published", "2026-10-14T09:00:00Z"),
  ];

  it("opens the job's newest validated or published version — never a superseded or draft one, never another job's", () => {
    assert.equal(pickStudioVersion(register, "j1")?.reportVersionId, "v-new");
    assert.equal(pickStudioVersion(register, "j1")?.status, "validated");
    assert.equal(pickStudioVersion(register, "j3"), null, "nothing to print yet");
  });

  it("a version asked for by id opens when it is this job's and open — otherwise the job's newest", () => {
    assert.equal(pickStudioVersion(register, "j1", "v-old")?.reportVersionId, "v-old");
    assert.equal(pickStudioVersion(register, "j1", "v-other")?.reportVersionId, "v-new", "another job's version is never opened here");
    assert.equal(pickStudioVersion(register, "j1", "v-gone")?.reportVersionId, "v-new", "a superseded version is not the report");
  });

  it("the job header offers the studio once there is an approved snapshot to draft from (B2-2), or a version to draw", () => {
    assert.deepEqual(["in-preparation", "awaiting-review", "ready-to-validate", "ready-to-publish", "awaiting-client", "changes-requested", "client-approved", "v7-record"]
      .map((stage) => studioHasReport(stage as never)), [false, false, true, true, true, true, true, false]);
  });
});

describe("Report Studio: the rail and the document", async () => {
  const { studioRail } = await import("../app/jobs/[jobId]/report/studio");
  const { ReportComposedView } = await import("../app/reports/[versionId]/ReportComposedView");

  it("numbers every section exactly as the composed document does, in the plan's order", () => {
    const issued = composition();
    const rail = studioRail(issued);
    const html = renderToStaticMarkup(createElement(ReportComposedView, { composition: issued }));
    const drawn = rail.filter((row) => row.drawn && row.number);
    assert.ok(drawn.length >= 5);
    for (const row of drawn) assert.match(html, new RegExp(`<span class="n">${row.number}</span><div><div class="eyebrow">[^<]*</div><h2>${row.title.replace(/&/g, "&amp;")}</h2>`), `${row.number} ${row.title}`);
    assert.equal(rail[0]!.key, "cover");
    assert.equal(rail[0]!.number, null, "the cover is not numbered");
  });

  it("a section the plan leaves out is an off row, unnumbered, saying so", () => {
    const issued = composition();
    const plan = (issued.sectionPlan ?? []).map((entry) => entry.key === "srs" ? { ...entry, included: false } : entry);
    const row = studioRail({ ...issued, sectionPlan: plan }).find((entry) => entry.key === "srs")!;
    assert.deepEqual([row.included, row.drawn, row.number, row.note], [false, false, null, "Left out of this report"]);
  });

  it("a whole-client report with no site breakdown draws no Sites page — and the rail says why", () => {
    const issued = composition();
    if ("state" in issued.emissions) throw new Error("expected composed emissions");
    const row = studioRail({ ...issued, emissions: { ...issued.emissions, sites: [] } }).find((entry) => entry.key === "sites")!;
    assert.deepEqual([row.included, row.drawn, row.number], [true, false, null]);
    assert.match(row.note ?? "", /no site breakdown/);
  });

  it("the studio draws the composed document unchanged — the same markup the composed renderer gives, byte for byte", async () => {
    const { ReportStudioPrinting } = await import("../app/jobs/[jobId]/report/ReportStudio");
    const issued = composition();
    const version = { reportVersionId: "v1", status: "published" as const, createdAt: "2026-10-10T09:00:00Z", publishedAt: "2026-10-10T09:00:00Z", scopeLabel: "Whole client", version: 1 };
    const studio = renderToStaticMarkup(createElement(ReportStudioPrinting, { jobId: "j1", version, composition: issued }));
    const document = renderToStaticMarkup(createElement(ReportComposedView, { composition: issued, preview: false }));
    assert.ok(studio.includes(document), "the composed document appears whole and unaltered inside the studio");
    assert.match(studio, /data-studio-status="published"/);
    assert.doesNotMatch(studio, /data-report-preview="not-issued"/, "a published version carries no preview band");
    const preview = renderToStaticMarkup(createElement(ReportStudioPrinting, { jobId: "j1", version: { ...version, status: "validated" as const, publishedAt: null }, composition: issued }));
    assert.ok(preview.includes(renderToStaticMarkup(createElement(ReportComposedView, { composition: issued, preview: true }))), "a validated version: the preview drawing");
    assert.match(preview, /data-report-preview="not-issued"/);
    assert.match(preview, /Validated — preview, not issued/);
  });
});

describe("Report Studio: what it may write", () => {
  const readOnly = ["apps/console/app/jobs/[jobId]/report/studio.ts", "apps/console/app/jobs/[jobId]/report/printing/page.tsx", "apps/console/app/jobs/JobReportStudioLink.tsx"];

  it("its reads and links write nothing: no POST, no command client", () => {
    for (const file of readOnly) assert.doesNotMatch(read(file), /postBrowserCommand|method:\s*"POST"/, file);
  });

  it("B2-2: the rail writes only through the two governed commands — validate and the section-plan update — never publish or a section edit", () => {
    const studio = read("apps/console/app/jobs/[jobId]/report/ReportStudio.tsx");
    assert.deepEqual([...studio.matchAll(/postBrowserCommand<[^>]*>\("([^"]+)"/g)].map((match) => match[1]).sort(), ["/api/isolated/reports/section-plan", "/api/isolated/reports/validate"]);
    assert.doesNotMatch(studio, /reports\/(publish|sections\/)/, "publishing and narrative editing are later slices");
    assert.doesNotMatch(studio, /method:\s*"POST"|fetch\(/, "no write outside the command client");
    assert.match(studio, /expectedVersion: version\.version, sectionPlan: plan/, "the plan update pins the version the studio opened");
  });

  it("reads only the register, the version's composition (frozen, or its read-only preview), and with no version the job's draft", () => {
    const page = read("apps/console/app/jobs/[jobId]/report/printing/page.tsx");
    assert.deepEqual([...page.matchAll(/loadScreen<[^>]+>\("([a-zA-Z]+)"/g)].map((match) => match[1]), ["reports", "reportDraft", "reportComposition", "reportCompositionPreview"]);
    assert.match(page, /if \(!reportFeatureEnabled\("report-sections"\)\) notFound\(\);/, "behind the composed report's own flag");
  });

  it("the draft route is a GET in a READ ONLY transaction, and nothing else", () => {
    const route = read("apps/console/app/api/isolated/jobs/[jobId]/report-draft/route.ts");
    assert.match(route, /export async function GET\(/);
    assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
    assert.match(route, /withTenantRead\(pool, organisationId, \(db\) => draftReportComposition\(db,/, "composed inside the READ ONLY tenant read");
  });

  it("the composed renderer is not touched: its file has no studio code", () => {
    const view = read("apps/console/app/reports/[versionId]/ReportComposedView.tsx");
    assert.doesNotMatch(view, /nzs-/, "no studio class in the document");
    assert.doesNotMatch(view, /from "[^"]*report\/(studio|ReportStudio)"/, "the document does not depend on the studio");
  });
});
