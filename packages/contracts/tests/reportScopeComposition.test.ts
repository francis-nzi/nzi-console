import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeScopedComparison, composeScopedEmissions, SITE_ACTIVITY_LIMIT, UNALLOCATED_LABEL } from "../src/reportScopeComposition";
import { reportScopeChoices, reportScopeSummary } from "../src/reportScope";
import { reportHeadline, reportScopeFlag, type ReportEmissionsSection } from "../src/reportComposition";

// Reporting S-2 (ruled): a report's emissions recomposed for its scope — a pure filter of frozen rows; organisation-level
// emissions never apportioned; history columns that follow the periods that exist.
const rows = [
  { scope: "1", tco2e: 10, siteId: "works", siteLabel: "Works", sourceLabel: "Gas" },
  { scope: "2", tco2e: 5, siteId: "works", siteLabel: "Works", sourceLabel: "Electricity" },
  { scope: "2", tco2e: 4, siteId: "annex", siteLabel: "Annex", sourceLabel: "Electricity" },
  { scope: "3", tco2e: 20, siteId: null, siteLabel: null, sourceLabel: "Purchased goods" },
];

describe("a report's emissions for its scope (S-2)", () => {
  it("whole client: every row, and the organisation-level line inside the total", () => {
    const whole = composeScopedEmissions(rows, { kind: "whole" });
    assert.equal(whole.totalTco2e, 39);
    assert.deepEqual(whole.sites.map((site) => [site.siteId, site.label, site.totalTco2e]), [["works", "Works", 15], ["annex", "Annex", 4], [null, UNALLOCATED_LABEL, 20]]);
    assert.equal(whole.unallocated, undefined, "at whole-client scope unallocated is a line, not an exclusion");
  });

  it("a site scope: only its sites' rows; organisation-level excluded and stated, never apportioned", () => {
    const works = composeScopedEmissions(rows, { kind: "sites", siteIds: ["works"] });
    assert.equal(works.totalTco2e, 15, "20 t organisation-level is not split across sites");
    assert.deepEqual(works.byScope, [{ scope: "1", tco2e: 10 }, { scope: "2", tco2e: 5 }]);
    assert.equal(works.unallocated?.tco2e, 20);
    assert.match(works.unallocated!.statement, /20 tCO₂e, not attributable to a site\) are reported at whole-client level only/);
    const every = composeScopedEmissions(rows, { kind: "sites", siteIds: ["annex", "works"] });
    assert.equal(every.totalTco2e, 19, "every site still excludes organisation-level: 19, not the whole client's 39");
  });

  it("lists a selected boundary site with no rows as a read zero, named from the fallback", () => {
    const depot = composeScopedEmissions(rows, { kind: "sites", siteIds: ["depot"] }, new Map([["depot", "Depot"]]));
    assert.deepEqual(depot.sites.map((site) => [site.label, site.totalTco2e, site.activities.length]), [["Depot", 0, 0]]);
    assert.deepEqual(depot.siteLabels, ["Depot"]);
  });

  it("groups a site's activities and folds the tail into one line", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ scope: "1", tco2e: 12 - index, siteId: "works", sourceLabel: `Activity ${index}` }));
    const activities = composeScopedEmissions(many, { kind: "sites", siteIds: ["works"] }).sites[0]!.activities;
    assert.equal(activities.length, SITE_ACTIVITY_LIMIT);
    assert.equal(activities.at(-1)!.label, "Other activities (5)");
    assert.equal(activities.reduce((total, activity) => total + activity.tco2e, 0), 78, "nothing lost in the fold");
  });
});

describe("year-on-year for a scope (S-2, sub-ruling 4)", () => {
  const period = (year: number, sitesKnown = true) => ({ year, sitesKnown, rows: [{ siteId: sitesKnown ? "works" : null, scope: "1", tco2e: year - 2000 }, { siteId: null, scope: "3", tco2e: 1 }] });
  it("follows the periods that exist: current only; baseline + current; baseline + previous + current", () => {
    const columns = (history: ReturnType<typeof period>[], baselineYear: number | null) =>
      composeScopedComparison({ scope: { kind: "whole" }, currentYear: 2025, current: rows, history, baselineYear }).columns.map((column) => column.key);
    assert.deepEqual(columns([], null), ["current"]);
    assert.deepEqual(columns([period(2022)], 2022), ["baseline", "current"]);
    assert.deepEqual(columns([period(2022), period(2024)], 2022), ["baseline", "previous", "current"]);
    assert.deepEqual(columns([period(2024)], 2022), ["previous", "current"], "a baseline year with no assured period is not invented");
  });

  it("filters each period by the scope's sites, and says when a period cannot be attributed", () => {
    const whole = composeScopedComparison({ scope: { kind: "whole" }, currentYear: 2025, current: rows, history: [period(2024)], baselineYear: null });
    assert.deepEqual(whole.totals, [25, 39]);
    const works = composeScopedComparison({ scope: { kind: "sites", siteIds: ["works"] }, currentYear: 2025, current: rows, history: [period(2024)], baselineYear: null });
    assert.deepEqual(works.totals, [24, 15], "organisation-level excluded in every period");
    const legacy = composeScopedComparison({ scope: { kind: "sites", siteIds: ["works"] }, currentYear: 2025, current: rows, history: [period(2024, false)], baselineYear: null });
    assert.deepEqual(legacy.totals, [null, 15], "never a zero for a period it cannot attribute");
    assert.match(legacy.notes[0]!, /FY2024 was frozen before its rows carried a site/);
  });

  it("states the change against the baseline when both are known", () => {
    const comparison = composeScopedComparison({ scope: { kind: "whole" }, currentYear: 2025, current: rows, history: [period(2022)], baselineYear: 2022 });
    assert.equal(Math.round(comparison.changeVsBaselinePct! * 10) / 10, 69.6, "(39 - 23) / 23");
  });
});

describe("the scope choice and its flags (S-2)", () => {
  it("offers the snapshot's sites with their frozen totals, and says what a site view excludes", () => {
    const choices = reportScopeChoices({ provenance: { boundary: { siteIds: ["works", "annex", "depot"] } }, measurements: rows });
    assert.deepEqual(choices.sites.map((site) => [site.siteId, site.tco2e]), [["annex", 4], ["depot", 0], ["works", 15]]);
    assert.equal(reportScopeSummary(choices, { kind: "sites", siteIds: ["works"] }), "Covers 1 of 3 sites · 15 tCO₂e attributable · 20 tCO₂e organisation-level, excluded");
    assert.match(reportScopeSummary(choices, { kind: "whole" }), /^Whole client · 3 sites · 39 tCO₂e, including 20 tCO₂e organisation-level$/);
  });

  it("flags site sections with their sites, client sections as client-level, and nothing at whole-client scope", () => {
    const scope = { kind: "sites" as const, siteIds: ["works"], siteLabels: ["Works"] };
    assert.equal(reportScopeFlag(scope, "site"), "Recomposed for: Works");
    assert.equal(reportScopeFlag(scope, "client"), "Client-level — shown for the whole client regardless of site scope");
    assert.equal(reportScopeFlag({ kind: "whole" }, "site"), null);
    assert.equal(reportScopeFlag(undefined, "client"), null, "a composition from before S-2 carries no flag");
  });
});

describe("the headline of a site view (S-2)", () => {
  const scope = { kind: "sites" as const, siteIds: ["works"], siteLabels: ["Works"] };
  const section = (totals: Array<number | null>, years: number[]): ReportEmissionsSection => ({
    totalTco2e: 15, byScope: [], priorYear: null, provenance: { factorSets: [], dataHash: "h", asAt: "2026-01-01", qualityTiers: [] },
    comparison: { columns: years.map((year, index) => ({ key: index === years.length - 1 ? "current" : "previous", year, label: `${year}` })), rows: [], totals, changeVsBaselinePct: null, notes: [] },
  });
  it("names its sites and moves against its own earlier period — never the whole client's prior year", () => {
    assert.equal(reportHeadline(section([20, 15], [2024, 2025]), 2025, scope), "FY2025 assured emissions for Works: 15 tCO₂e, down 25.0% against FY2024.");
    assert.equal(reportHeadline(section([15], [2025]), 2025, scope), "FY2025 assured emissions for Works: 15 tCO₂e. This is the first assured period, so there is no earlier period to compare against.");
    assert.equal(reportHeadline(section([null, 15], [2024, 2025]), 2025, scope), "FY2025 assured emissions for Works: 15 tCO₂e. FY2024 cannot be attributed to these sites, so no movement is stated.");
  });
  it("leaves a whole-client headline exactly as it was", () => {
    assert.match(reportHeadline({ ...section([20, 15], [2024, 2025]), priorYear: { year: 2024, totalTco2e: 20 } }, 2025, { kind: "whole" }), /^FY2025 assured emissions: 15 tCO₂e, down 25\.0% against FY2024\.$/);
  });
});
