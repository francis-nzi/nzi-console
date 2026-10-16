import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultReportSectionPlan, moveReportSection, type ReportComposition, type ReportSectionPlan } from "@nzi/contracts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const composition = () => JSON.parse(fixture("composition-composed3-whole.json")) as ReportComposition;
(globalThis as { React?: unknown }).React = React;

/**
 * B2-2 (REVIEW-B2-1-and-B2-rulings): the Report Studio's rail edits the plan — only through the governed commands, and only
 * where the plan rules allow: the cover and methodology never move, a mandatory section is never left out, a published report
 * is fixed. The draft (no version yet) is the read-only composition of the job's latest approved snapshot.
 */
describe("the rail's rights over each section", async () => {
  const { studioRail, studioDraftQuery, samePlan } = await import("../app/jobs/[jobId]/report/studio");

  it("the cover and methodology never move; a mandatory section is never left out; the rest may be moved and left out", () => {
    const rail = studioRail(composition());
    const rights = Object.fromEntries(rail.map((row) => [row.key, [row.movable, row.optional]]));
    assert.deepEqual(rights.cover, [false, false]);
    assert.deepEqual(rights.methodology, [false, false]);
    assert.deepEqual(rights["executive-summary"], [true, false]);
    assert.deepEqual(rights.emissions, [true, false]);
    for (const key of ["sites", "intensity", "targets", "plan", "srs"]) assert.deepEqual(rights[key], [true, true], key);
  });

  it("an edited plan is numbered as it would draw — the rail shows the change before it is saved", () => {
    const issued = composition();
    const moved = moveReportSection(issued.sectionPlan ?? defaultReportSectionPlan, "srs", "earlier");
    const before = studioRail(issued).filter((row) => row.number).map((row) => row.key);
    const after = studioRail(issued, moved).filter((row) => row.number).map((row) => row.key);
    assert.notDeepEqual(after, before);
    assert.equal(after.indexOf("srs"), before.indexOf("srs") - 1);
  });

  it("the draft query carries a chosen plan and a site scope; an unchanged plan and the whole client are left out", () => {
    assert.equal(studioDraftQuery({}), "");
    assert.equal(studioDraftQuery({ scope: { kind: "whole" } }), "");
    assert.match(studioDraftQuery({ plan: defaultReportSectionPlan }), /^\?plan=cover%3A1%2C/);
    assert.equal(studioDraftQuery({ scope: { kind: "sites", siteIds: ["s-a", "s-b"] } }), "?scope=sites%3As-a%2Cs-b");
    assert.equal(samePlan(defaultReportSectionPlan, [...defaultReportSectionPlan]), true);
  });
});

describe("what each state lets the rail touch", async () => {
  const { ReportStudioPrinting } = await import("../app/jobs/[jobId]/report/ReportStudio");
  const { ReportComposedView } = await import("../app/reports/[versionId]/ReportComposedView");
  const version = { reportVersionId: "v1", status: "published" as const, createdAt: "2026-10-10T09:00:00Z", publishedAt: "2026-10-10T09:00:00Z", scopeLabel: "Whole client", version: 3, manifestVersion: 1, snapshotId: "snap-1" };
  const switches = (html: string) => [...html.matchAll(/<button type="button" class="nzs-switch[^"]*" role="switch" aria-checked="(true|false)"( disabled="")?[^>]*aria-label="([^:]+):/g)]
    .map((match) => [match[3], match[2] ? "fixed" : "operable"]);

  it("published: nothing operable — the issued report is fixed", () => {
    const html = renderToStaticMarkup(createElement(ReportStudioPrinting, { jobId: "j1", version, composition: composition() }));
    assert.ok(switches(html).length >= 8 && switches(html).every(([, state]) => state === "fixed"));
    assert.doesNotMatch(html, /<button type="button" aria-label="Move [^"]+"(?! disabled)/, "no move arrow is live");
    assert.doesNotMatch(html, /data-studio-validate|data-studio-save/);
  });

  it("validated: optional sections' switches and the arrows are live; mandatory ones are fixed", () => {
    const html = renderToStaticMarkup(createElement(ReportStudioPrinting, { jobId: "j1", version: { ...version, status: "validated" as const, publishedAt: null }, composition: composition() }));
    const state = Object.fromEntries(switches(html));
    assert.equal(state["Carbon Reduction Plan"], "fixed");
    assert.equal(state["Executive summary"], "fixed");
    assert.equal(state["Methodology & provenance"] ?? state["Methodology &amp; provenance"], "fixed");
    assert.equal(state["UK SRS readiness statement"], "operable");
    assert.match(html, /aria-label="Move UK SRS readiness statement earlier">/, "a movable section's arrow is live");
    assert.doesNotMatch(html, /data-studio-validate/, "a validated version is not validated again");
  });

  it("draft: the draft band names it not validated, the blockers are listed, and Validate waits for them", () => {
    const issued = composition();
    const draft = {
      draftedAt: "2026-10-15T09:00:00Z", snapshotId: "snap-1", snapshotVersion: 2, sectionPlan: issued.sectionPlan ?? defaultReportSectionPlan as ReportSectionPlan,
      planOrigin: "default" as const, scope: { kind: "whole" as const }, scopeChoices: { sites: [], unallocatedTco2e: 39, totalTco2e: 39 },
      blockers: [{ field: "intensity_pathway", code: "MISSING_REQUIRED_CHART", message: "Leave the \"intensity\" section out of this report." }],
    };
    const html = renderToStaticMarkup(createElement(ReportStudioPrinting, { jobId: "j1", version: null, composition: issued, draft }));
    assert.match(html, /data-report-draft="not-validated"/);
    assert.match(html, /Draft — not validated, not issued/);
    assert.match(html, /data-studio-blockers/);
    assert.match(html, /<button type="button" class="nz-btn pri" data-studio-validate="[^"]*" disabled=""/, "validate waits on the blockers");
    assert.doesNotMatch(html, /data-report-preview="not-issued"/, "a draft is not a validated preview");
    assert.ok(html.includes(renderToStaticMarkup(createElement(ReportComposedView, { composition: issued, preview: true }))), "the document is drawn unchanged");
    const clear = renderToStaticMarkup(createElement(ReportStudioPrinting, { jobId: "j1", version: null, composition: issued, draft: { ...draft, blockers: [] } }));
    assert.match(clear, /<button type="button" class="nz-btn pri" data-studio-validate="[^"]*"(?! disabled)/, "with nothing blocking, Validate is live");
  });
});
