import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composeScopedComparison, defaultReportSectionPlan, drawsMockupSectionSet, isMovableReportSection, isOptionalReportSection,
  isReportStandaloneNarrativeSection, legacyReportSectionPlanV3, REPORT_RENDERER_LATEST, reportOmittedSections, reportSectionMetaFor,
  reportSectionMetaV4, reportSectionPlanIssues, reportSectionPlanOf, reportStandaloneNarrativeSections, setReportSectionIncluded,
  type ReportComposition, type ScopedHistoryPeriod,
} from "../src/index";

/**
 * BUILD-report-studio-composed5 and its rulings (ACCEPT-composed5-checkpoint2–5): the renderer, the two standalone narrative
 * sections, and the per-site and per-category comparison composed@5's year-aware tables draw.
 */
describe("composed@5: the renderer and its plan", () => {
  it("is the latest; it reads its plan complete and heads by the mockup's titles, as composed@4 does", () => {
    // B2-4: composed@6 (composed@5 drawing a frozen narrative) is now the latest; composed@5 reads and heads exactly as before.
    assert.equal(REPORT_RENDERER_LATEST, "composed@6");
    assert.equal(drawsMockupSectionSet({ renderer: "composed@6" }), true);
    assert.equal(drawsMockupSectionSet({ renderer: "composed@5" }), true);
    assert.equal(drawsMockupSectionSet({ renderer: "composed@4" }), true);
    for (const renderer of [undefined, "composed@1", "composed@2", "composed@3"]) assert.equal(drawsMockupSectionSet({ renderer }), false, String(renderer));
    assert.equal(reportSectionMetaFor({ renderer: "composed@5" }), reportSectionMetaV4);
    const partial = legacyReportSectionPlanV3;
    assert.ok(reportSectionPlanOf({ renderer: "composed@5", sectionPlan: partial } as unknown as ReportComposition).some((entry) => entry.key === "glossary"), "read complete");
    assert.equal(reportSectionPlanOf({ renderer: "composed@3", sectionPlan: partial } as unknown as ReportComposition), partial, "composed@1/2/3 untouched");
  });
});

describe("the standalone narrative sections (ACCEPT-composed5-checkpoint2, decision 3)", () => {
  it("are exactly Net Zero Commitment and Background — the four embedded narratives ride with their data sections", () => {
    assert.deepEqual([...reportStandaloneNarrativeSections], ["narrative:net-zero-commitment", "narrative:background"]);
    for (const key of ["narrative:executive-summary", "narrative:intensity-analysis", "narrative:category-analysis", "narrative:reduction-actions"]) {
      assert.equal(isReportStandaloneNarrativeSection(key), false, key);
    }
  });

  it("are optional and movable, on by default; the mandatory set is unchanged", () => {
    for (const key of reportStandaloneNarrativeSections) {
      assert.equal(isOptionalReportSection(key), true, key);
      assert.equal(isMovableReportSection(key), true, key);
      assert.equal(defaultReportSectionPlan.find((entry) => entry.key === key)!.included, true, key);
      const off = setReportSectionIncluded(defaultReportSectionPlan, key, false);
      assert.equal(off.find((entry) => entry.key === key)!.included, false);
      assert.deepEqual(reportSectionPlanIssues(off), [], "leaving one out is a valid plan");
    }
    for (const key of ["cover", "executive-summary", "emissions", "methodology"] as const) assert.equal(isOptionalReportSection(key), false, key);
  });

  it("the validator allows including them; the embedded narrative is still refused", () => {
    assert.deepEqual(reportSectionPlanIssues(defaultReportSectionPlan), []);
    const embedded = defaultReportSectionPlan.map((entry) => entry.key === "narrative:category-analysis" ? { ...entry, included: true } : entry);
    assert.deepEqual(reportSectionPlanIssues(embedded).map((issue) => issue.code), ["NARRATIVE_NOT_YET_DRAWN"]);
  });

  it("composed@1/2/3's omitted-sections line never names them — so every issued report says exactly what it said", () => {
    // A legacy plan holds both off (the only value the validator allowed before): they are not "left out" there.
    assert.deepEqual(reportOmittedSections(legacyReportSectionPlanV3), []);
    const off = setReportSectionIncluded(defaultReportSectionPlan, "narrative:background", false);
    assert.deepEqual(reportOmittedSections(off), [], "data sections only, as before");
  });
});

describe("the per-site and per-category comparison (ACCEPT-composed5-checkpoint3/4)", () => {
  const row = (siteId: string | null, scope: string, scopeCode: string, tco2e: number) => ({ siteId, scope, scopeCode, tco2e });
  const current = [row("a", "1", "1", 10), row("b", "1", "1", 5), row("a", "3", "3.1", 7), row("c", "3", "3.5", 2), row(null, "2", "2", 1)];
  const history: ScopedHistoryPeriod[] = [
    { year: 2022, sitesKnown: true, rows: [row("a", "1", "1", 12), row("b", "1", "1", 6), row("a", "3", "3.1", 8), row(null, "2", "2", 2)] },
    { year: 2024, sitesKnown: true, rows: [row("a", "1", "1", 11), row("b", "1", "1", 5.5), row("a", "3", "3.1", 7.5), row("c", "3", "3.5", 3), row(null, "2", "2", 1.5)] },
  ];
  const comparison = composeScopedComparison({ scope: { kind: "whole" }, currentYear: 2025, current, history, baselineYear: 2022 });

  it("carries each current site's own figure per column; a site with no row in a period is null, never modelled", () => {
    assert.deepEqual(comparison.columns.map((column) => column.key), ["baseline", "previous", "current"]);
    const site = (id: string | null) => comparison.sites!.find((entry) => entry.siteId === id)!.values;
    assert.deepEqual(site("a"), [20, 18.5, 17]);
    assert.deepEqual(site("c"), [null, 3, 2], "the site had no row in the baseline year");
    assert.deepEqual(site(null), [2, 1.5, 1], "the organisation-level line is a row of its own");
  });

  it("carries each current category's own figure per column, by code; absent in a period is null", () => {
    const category = (code: string) => comparison.categories!.find((entry) => entry.scopeCode === code)!;
    assert.deepEqual(comparison.categories!.map((entry) => entry.scopeCode), ["1", "2", "3.1", "3.5"], "in GHG code order");
    assert.deepEqual(category("3.1").values, [8, 7.5, 7]);
    assert.deepEqual(category("3.5").values, [null, 3, 2]);
    assert.equal(category("3.5").scope, "3");
  });

  it("reconciles: the site figures and the category figures each sum to the comparison's own totals where every one is known", () => {
    const sum = (values: Array<number | null>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
    for (const index of [0, 1, 2]) {
      assert.equal(sum(comparison.sites!.map((entry) => entry.values[index]!)), comparison.totals[index]);
      assert.equal(sum(comparison.categories!.map((entry) => entry.values[index]!)), comparison.totals[index]);
    }
  });

  it("a period frozen before rows carried a site, or before they carried a code, is null for every site or category", () => {
    const old: ScopedHistoryPeriod[] = [{ year: 2024, sitesKnown: false, rows: [{ siteId: null, scope: "1", tco2e: 15 }] }];
    const result = composeScopedComparison({ scope: { kind: "whole" }, currentYear: 2025, current, history: old, baselineYear: null });
    assert.deepEqual(result.sites!.map((entry) => entry.values[0]), result.sites!.map(() => null));
    assert.deepEqual(result.categories!.map((entry) => entry.values[0]), result.categories!.map(() => null));
  });

  it("under a site scope, only the selected sites", () => {
    const scoped = composeScopedComparison({ scope: { kind: "sites", siteIds: ["a"] }, currentYear: 2025, current, history, baselineYear: 2022 });
    assert.deepEqual(scoped.sites!.map((entry) => entry.siteId), ["a"]);
    assert.deepEqual(scoped.categories!.map((entry) => entry.scopeCode), ["1", "3.1"]);
  });
});
