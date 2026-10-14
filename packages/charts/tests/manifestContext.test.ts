import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { resolveCrpCoreCharts, crpProfessionalManifest } from "../src/crp";
import { manifestChartAbsence, validateManifest } from "../src/manifest";
import { ManifestChartSet } from "../src/index";

/**
 * RULING-report-studio-consolidation R4/R5: the manifest is judged against the report's own plan and years. A chart drawn in a
 * section the plan leaves out is absent, not a blocker; an annual comparison is absent for a single-year client. Nothing else
 * changes: with no context the manifest is exactly as strict as before.
 */
const firstYear = resolveCrpCoreCharts({
  id: "snap-first", jobId: "663", jobNumber: "J000663", client: "EFF", reportingYear: 2025, generatedAt: "2026-10-12T00:00:00Z", dataHash: "sha256:first",
  annualComparison: [{ year: 2025, values: [{ scope: "1", value: 43.4 }] }] as never,
  measurements: [
    { rowId: "a", scope: "1", scopeCode: "1", sourceLabel: "Gas", siteId: "uk", siteLabel: "UK Office", tco2e: 43.4, factorSet: "DEFRA 2025 v1.2" },
    { rowId: "b", scope: "3", scopeCode: "3.1", sourceLabel: "Goods", siteId: "uk", siteLabel: "UK Office", tco2e: 20, factorSet: "CEDA 2025 v1.0", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" },
  ],
});
const missing = (validation: ReturnType<typeof validateManifest>) => validation.issues.filter((issue) => issue.code === "missing_required_chart").map((issue) => issue.chartId).sort();

test("with no context the manifest is as strict as before: every unresolved required chart blocks", () => {
  assert.deepEqual(missing(validateManifest(crpProfessionalManifest, firstYear, "snap-first")), ["intensity_pathway", "reduction_pathway", "scope_year_on_year_bar"]);
});

test("R5: one reporting year — the annual comparison is absent, not a blocker; two years — it is required again", () => {
  const one = validateManifest(crpProfessionalManifest, firstYear, "snap-first", { reportingYears: 1 });
  assert.deepEqual(missing(one), ["intensity_pathway", "reduction_pathway"]);
  assert.deepEqual(one.absent, [{ chartId: "scope_year_on_year_bar", reason: "single-year" }]);
  assert.deepEqual(missing(validateManifest(crpProfessionalManifest, firstYear, "snap-first", { reportingYears: 2 })), ["intensity_pathway", "reduction_pathway", "scope_year_on_year_bar"]);
});

test("R4: Intensity and Targets left out — their charts are absent; J000663's first-year report validates", () => {
  const validation = validateManifest(crpProfessionalManifest, firstYear, "snap-first", { reportingYears: 1, excludedSections: ["intensity", "targets"] });
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.deepEqual(validation.absent.map((absence) => [absence.chartId, absence.reason]).sort(),
    [["intensity_pathway", "excluded-section"], ["reduction_pathway", "excluded-section"], ["scope_year_on_year_bar", "single-year"]]);
});

test("only the section a chart belongs to excuses it: leaving out Sites does not excuse a missing target", () => {
  const validation = validateManifest(crpProfessionalManifest, firstYear, "snap-first", { reportingYears: 1, excludedSections: ["sites", "intensity"] });
  assert.deepEqual(missing(validation), ["reduction_pathway"]);
  assert.match(validation.issues[0]!.message, /Leave the "targets" section out of this report/);
});

test("a chart that resolved is held to every check even when its section is out", () => {
  const tampered = firstYear.map((chart) => chart.spec.id === "emissions_site_donut" ? { ...chart, provenance: { ...chart.provenance, reviewedSnapshotId: "another" } } : chart);
  const validation = validateManifest(crpProfessionalManifest, tampered, "snap-first", { reportingYears: 1, excludedSections: ["intensity", "targets", "sites"] });
  assert.deepEqual(validation.issues.map((issue) => [issue.code, issue.chartId]), [["snapshot_mismatch", "emissions_site_donut"]]);
});

test("manifestChartAbsence names the reason; a chart with no section and no year rule is never absent", () => {
  const chart = (id: string) => crpProfessionalManifest.charts.find((entry) => entry.id === id)!;
  assert.deepEqual(manifestChartAbsence(chart("reduction_pathway"), { excludedSections: ["targets"] }), { chartId: "reduction_pathway", reason: "excluded-section", reportSection: "targets" });
  assert.equal(manifestChartAbsence(chart("emissions_scope_donut"), { excludedSections: ["emissions", "targets"], reportingYears: 1 }), null);
  assert.equal(manifestChartAbsence(chart("scope_year_on_year_bar"), {}), null, "years unknown: not assumed single");
});

test("ManifestChartSet draws what resolved, says what is absent, and does not fail on a chart the report leaves out", () => {
  const html = renderToStaticMarkup(createElement(ManifestChartSet, { manifest: crpProfessionalManifest, charts: firstYear, reviewedSnapshotId: "snap-first",
    context: { reportingYears: 1, excludedSections: ["intensity", "targets"] } }));
  assert.doesNotMatch(html, /publication blocked/);
  assert.match(html, /data-chart-absent="scope_year_on_year_bar"/);
  assert.match(html, /Annual comparison appears once this client has reviewed snapshots for at least two reporting years/);
  assert.match(html, /data-chart-absent="reduction_pathway"[^>]*>Not in this report: the targets section is left out/);
});
