import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReportComposition } from "@nzi/contracts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/**
 * Reporting S-2 (ruled): the composed report per scope, to the Report Studio mockup. The rule worth holding first: a
 * composition frozen **before** S-2 renders byte-for-byte as it did — the fixture is `main` @ d2c1bd22's own render of a real
 * pre-S-2 composition (from the RF suite's database), so S-2 cannot quietly move an issued document.
 */
describe("the composed report per scope (S-2)", () => {
  const render = async (composition: ReportComposition) => {
    (globalThis as { React?: unknown }).React = React;
    const { ReportComposedView } = await import("../app/reports/[versionId]/ReportComposedView");
    return renderToStaticMarkup(createElement(ReportComposedView, { composition }));
  };

  it("renders a composition frozen before S-2 byte-for-byte as main did", async () => {
    assert.equal(await render(JSON.parse(fixture("composition-pre-s2.json"))), fixture("composition-pre-s2.html"));
  });

  it("adds the Sites section, the flags and the unallocated statement for a site-scoped composition — figures only from it", async () => {
    const base = JSON.parse(fixture("composition-pre-s2.json")) as ReportComposition;
    const emissions = { ...(base.emissions as object), totalTco2e: 15, byScope: [{ scope: "1", tco2e: 10 }, { scope: "2", tco2e: 5 }], priorYear: null,
      sites: [
        { siteId: "s-a", label: "Works", totalTco2e: 10, byScope: [{ scope: "1", tco2e: 10 }], activities: [{ label: "Gas", scope: "1", tco2e: 10 }], floorAreaIntensity: { value: 0.01, unit: "tCO₂e / m²", floorAreaM2: 1000, reason: null } },
        { siteId: "s-b", label: "Annex", totalTco2e: 5, byScope: [{ scope: "2", tco2e: 5 }], activities: [{ label: "Electricity", scope: "2", tco2e: 5 }] }],
      unallocated: { tco2e: 20, statement: "Organisation-level emissions (20 tCO₂e, not attributable to a site) are reported at whole-client level only and are not included in this site view." },
      comparison: { columns: [{ key: "previous", year: 2024, label: "Previous (FY2024)" }, { key: "current", year: 2025, label: "Current (FY2025)" }], rows: [{ scope: "1", values: [null, 10] }, { scope: "2", values: [null, 5] }, { scope: "3", values: [null, 0] }], totals: [null, 15], changeVsBaselinePct: null, notes: ["FY2024 was frozen before its rows carried a site, so it cannot be attributed to these sites."] },
    };
    const html = await render({ ...base, emissions, scope: { kind: "sites", siteIds: ["s-a", "s-b"], siteLabels: ["Works", "Annex"] } } as ReportComposition);
    assert.match(html, /Sites &amp; reporting boundary/);
    assert.ok((html.match(/Recomposed for: Works, Annex/g) ?? []).length >= 3, "executive summary, emissions, sites and intensity are flagged");
    assert.ok((html.match(/Client-level — shown for the whole client regardless of site scope/g) ?? []).length >= 3, "targets, plan and SRS are client-level");
    assert.equal((html.match(/Organisation-level emissions are not in this view\./g) ?? []).length, 3,
      "stated under the executive summary's figures, under the emissions table and on the sites page — not only in a footnote");
    assert.match(html, /Not attributable/);
    assert.match(html, /FY2024 was frozen before its rows carried a site/);
    assert.match(html, /<h4>Works<\/h4>/);
    assert.match(html, /Floor-area intensity: <b class="num">0\.01<\/b>/);
    assert.doesNotMatch(html, /first assured year/, "a site view's history is its comparison, not the whole-client prior-year note");
  });

  it("sends the chosen scope on validate, offers the snapshot's own sites, and never hides the choice", () => {
    const action = read("apps/console/app/report-preview/ReportValidationAction.tsx");
    const selector = read("apps/console/app/report-preview/ReportScopeSelector.tsx");
    const page = read("apps/console/app/report-preview/page.tsx");
    assert.match(action, /\{reviewedSnapshotId:snapshotId,manifestVersion,scope\}/);
    assert.match(action, /disabled=\{!ready\|\|!scopeReady\|\|pending!==null\}/, "a site scope with no site cannot be validated");
    assert.match(page, /choices=\{reportScopeChoices\(snapshot\)\}/);
    assert.match(selector, /reportScopeSummary\(choices, scope\)/, "the summary says what a site view excludes");
    assert.match(selector, /aria-pressed=\{chosen\.has\(site\.siteId\)\}/);
  });

  it("publishes the version it validated, pinned — report.publish refuses one without an expected version", () => {
    // Found by the S-2 rendered check: the page never sent expectedVersion, so every publish from it failed validation.
    const action = read("apps/console/app/report-preview/ReportValidationAction.tsx");
    assert.match(action, /\{reportVersionId:validated\.reportVersionId,expectedStatus:"validated",expectedVersion:1,manifestVersion,reviewedSnapshotId:snapshotId\}/);
  });
});
