import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UNASSIGNED_SITE_ID, type ScopeRowReadModel } from "@nzi/contracts";
import type { JobEmissions } from "@nzi/isolated-backend";

/**
 * Four fixes confirmed live before the presentation: the Clients list opens with nothing selected (#1); the CRM's category
 * list honours the site tab (#2); an "Unassigned" site tab (#3); and the report's Whole client / By site control on a
 * validated version — by design, frozen at validate (#4). The reads behind #2/#3 are proved in `jw10ScopeSectionsReal`.
 */
(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("#1 the Clients list opens with no row selected and no drawer", () => {
  const board = read("apps/console/app/clients/ClientsBoard.tsx");
  it("starts with nothing selected and the panel closed", () => {
    assert.match(board, /useState<string \| null>\(null\)/, "no selected id at rest");
    assert.match(board, /const \[panelOpen, setPanelOpen\] = useState\(false\);/, "the panel is closed at rest");
    assert.doesNotMatch(board, /page\.rows\[0\]/, "never falls back to the first row");
  });
  it("still opens a row's drawer when one is chosen", () => {
    assert.match(board, /const setSelectedId = \(id: string\) => \{ setSelectedIdRaw\(id\); setPanelOpen\(true\); \};/);
    assert.match(board, /const drawer = selected && panelOpen \?/);
    assert.match(board, /onSelect=\{\(c\) => setSelectedId\(c\.id\)\}/);
  });
});

describe("#2 the category list honours the selected site", () => {
  it("the accordion reads its categories narrowed to the site tab, and re-reads when the tab changes", () => {
    const accordion = read("apps/console/app/jobs/CrpDataEntryAccordion.tsx");
    assert.match(accordion, /const site = siteId \? `\?siteId=\$\{encodeURIComponent\(siteId\)\}` : "";/);
    assert.match(accordion, /applicable-categories\$\{site\}`/);
    assert.match(accordion, /\}, \[jobId, given, siteId\]\);/, "a tab change re-reads");
    assert.match(accordion, /if \(request !== latest\.current\) return;/, "only the latest tab's read lands");
  });
  it("the workspace hands the accordion the site tab in force", () => {
    const workspace = read("apps/console/app/jobs/CrpScopeWorkspace.tsx");
    assert.match(workspace, /rows=\{filterRowsBySite\(rows, siteId\)\}/);
    assert.match(workspace, /siteId=\{siteId \?\? ""\}/);
  });
  it("the route passes the site through to the read; \"all\" is unnarrowed", () => {
    const route = read("apps/console/app/api/isolated/jobs/[jobId]/applicable-categories/route.ts");
    assert.match(route, /listJobApplicableCategories\(db, jobId, "crm", siteId === "all" \? null : siteId\)/);
  });
});

describe("#3 an Unassigned site tab, with its count", () => {
  const emissions: JobEmissions = {
    jobId: "j", siteId: null, headline: { tco2e: 0, marketTco2e: 0, entries: 0, marketEntries: 0 }, byScope: [], byCategory: [],
    bySite: [{ siteId: "s-a", tco2e: 3, marketTco2e: 0, entries: 2, marketEntries: 0 }, { siteId: null, tco2e: 8, marketTco2e: 0, entries: 3, marketEntries: 0 }],
  };
  const sites = [{ id: "s-a", name: "Bristol bakery" }];
  const tabs = async (props: { selected: string | null; unassigned?: boolean; bySite?: JobEmissions["bySite"] }) => {
    const { JobSiteTabs } = await import("../app/jobs/JobSiteTabs");
    return renderToStaticMarkup(createElement(JobSiteTabs, { sites, emissions: { ...emissions, bySite: props.bySite ?? emissions.bySite }, selected: props.selected, onSelect: () => undefined, unassigned: props.unassigned }));
  };

  it("the CRM shows Unassigned after the sites, with the no-site count, under All sites too", async () => {
    const html = await tabs({ selected: null, unassigned: true });
    assert.match(html, />Bristol bakery<\/span>.*>Unassigned<\/span><span class="nz-site-tab-count tnum" aria-label="3 entries">3</);
    assert.match(html, /aria-selected="true" class="nz-site-tab on"><span class="nz-site-tab-name">All sites</, "All sites stays the one selected");
  });
  it("selecting it marks it, not All sites", async () => {
    const html = await tabs({ selected: UNASSIGNED_SITE_ID, unassigned: true });
    assert.match(html, /aria-selected="true" class="nz-site-tab on"><span class="nz-site-tab-name">Unassigned</);
    assert.match(html, /aria-selected="false" class="nz-site-tab"><span class="nz-site-tab-name">All sites</);
  });
  it("it is offered with 0 when every row has a site — somewhere to enter, like an empty site", async () => {
    const html = await tabs({ selected: null, unassigned: true, bySite: [{ siteId: "s-a", tco2e: 3, marketTco2e: 0, entries: 2, marketEntries: 0 }] });
    assert.match(html, />Unassigned<\/span><span class="nz-site-tab-count tnum" aria-label="0 entries">0</);
  });
  it("the portal, which does not opt in, keeps its older tab", async () => {
    assert.doesNotMatch(await tabs({ selected: null }), /Unassigned/);
    assert.match(await tabs({ selected: "s-a" }), />Unassigned</);
  });
  it("the rows, the label and a new entry under Unassigned are the rows with no site", async () => {
    const { filterRowsBySite } = await import("../app/jobs/scopeRegister");
    const { siteLabelFor } = await import("../app/jobs/JobSiteTabs");
    const rows = [{ id: "a", siteId: "s-a" }, { id: "b", siteId: null }] as unknown as ScopeRowReadModel[];
    assert.deepEqual(filterRowsBySite(rows, UNASSIGNED_SITE_ID).map((row) => row.id), ["b"]);
    assert.deepEqual(filterRowsBySite(rows, null).map((row) => row.id), ["a", "b"]);
    assert.deepEqual(filterRowsBySite(rows, "s-a").map((row) => row.id), ["a"]);
    assert.equal(siteLabelFor(sites, UNASSIGNED_SITE_ID), "Unassigned");
    const workspace = read("apps/console/app/jobs/CrpScopeWorkspace.tsx");
    assert.match(workspace, /const site = siteId === null \|\| siteId === UNASSIGNED_SITE_ID \? \{ id: null, label: null \} : \{ id: siteId, label: siteLabel \};/, "a quick-add under Unassigned has no site");
    assert.match(workspace, /onSelect=\{setSiteId\}\n\s+unassigned\n/, "the CRM opts in");
  });
});

describe("#4 Whole client / By site on a validated version is fixed at validate (by design)", () => {
  const studio = read("apps/console/app/jobs/[jobId]/report/ReportStudio.tsx");
  it("only a draft has the live selector; a validated or published version shows its frozen scope, read only", () => {
    assert.match(studio, /kind === "draft" && draft\s*\? <div className="nzs-ctl nzs-scope-live"><ReportScopeSelector/);
    assert.match(studio, /<div className="nzs-seg" aria-disabled="true" title="The sites are fixed when the version is validated">/);
    assert.match(studio, /if \(kind !== "draft" \|\| pending\) return;/, "changeScope refuses anything but a draft");
  });
  it("the choice is sent with validate, which freezes it onto the version", () => {
    assert.match(studio, /reviewedSnapshotId: draft\.snapshotId, manifestVersion: crpProfessionalManifest\.version, scope,/);
  });
  it("the studio opens an open version over the draft, so re-scoping needs a new draft", async () => {
    const { pickStudioVersion } = await import("../app/jobs/[jobId]/report/studio");
    const row = { jobId: "j", reportVersionId: "v1", status: "validated", createdAt: "2026-11-01T00:00:00Z", publishedAt: null, scopeLabel: "Whole client", version: 1, manifestVersion: "m", snapshotId: "s" };
    assert.equal(pickStudioVersion([row] as never, "j")?.reportVersionId, "v1");
  });
});
