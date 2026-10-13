import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveCrpCoreCharts, type ReviewedCrpSnapshotCore } from "../src/crp";
import { EmissionsByActivity, EmissionsScopeDonut, EmissionsSiteDonut, ManifestChartSet, ReductionPathway, ScopeYearOnYearBar, crpProfessionalManifest, withSourceSummary, type AnyChartData } from "../src/index";

// R3/R6 (RULING-report-studio-consolidation): a surface holding the snapshot's stamp names one source line under each chart;
// without it a chart draws exactly as before — the composed@1/2 renderers never set it and stay byte-identical (F-0).
const PER_ROW = ["Air travel · upload-a.csv", "Diesel · upload-b.xlsx", "Grid electricity · upload-b.xlsx"];
const snapshot: ReviewedCrpSnapshotCore = {
  id: "snap-src-1", jobId: "job-src", jobNumber: "J000001", client: "Synthetic Client", reportingYear: 2025, generatedAt: "2026-03-01T09:00:00.000Z", dataHash: "sha256:src",
  target: { baselineYear: 2024, baselineTco2e: 200, interimYear: 2030, interimReductionPercent: 42, netZeroYear: 2050 },
  annualComparison: [{ year: 2024, values: [{ scope: "1", value: 90 }, { scope: "2", value: 40 }, { scope: "3", value: 70 }] }, { year: 2025, values: [{ scope: "1", value: 80 }, { scope: "2", value: 30 }, { scope: "3", value: 60 }] }],
  measurements: [
    { rowId: "r1", scope: "1", sourceLabel: "Diesel", tco2e: 80, factorSet: PER_ROW[1]!, siteId: "s1", siteLabel: "Works" },
    { rowId: "r2", scope: "2", sourceLabel: "Grid electricity", tco2e: 30, factorSet: PER_ROW[2]!, siteId: "s1", siteLabel: "Works" },
    { rowId: "r3", scope: "3", sourceLabel: "Air travel", tco2e: 60, factorSet: PER_ROW[0]!, siteId: "s2", siteLabel: "Office" },
  ],
};
const SUMMARY = "Reviewed snapshot J000001 · DESNZ GB 2025";
const charts = resolveCrpCoreCharts(snapshot);
const chart = <T,>(set: AnyChartData[], type: string) => set.find((c) => c.spec.type === type) as T;
const footers: Array<[string, FunctionComponent<{ data: never }>]> = [
  ["emissions_scope_donut", EmissionsScopeDonut as never], ["reduction_pathway", ReductionPathway as never], ["emissions_by_activity", EmissionsByActivity as never],
  ["emissions_site_donut", EmissionsSiteDonut as never], ["scope_year_on_year_bar", ScopeYearOnYearBar as never],
];
const draw = (component: FunctionComponent<{ data: never }>, data: unknown) => renderToStaticMarkup(createElement(component, { data: data as never }));

test("without a summary, each chart is the very same object and names its factor sets as before", () => {
  assert.equal(withSourceSummary(charts, null), charts);
  assert.equal(withSourceSummary(charts, undefined), charts);
  assert.equal(withSourceSummary(charts, ""), charts);
  for (const [type, component] of footers) {
    const html = draw(component, chart(charts, type));
    assert.ok(PER_ROW.every((set) => html.includes(set)), `${type}: per-row factor sets, as always`);
    assert.doesNotMatch(html, /derived, not captured/, `${type}: no summary tail`);
  }
});

test("with a summary, every CRP chart's source line names it once — none of the per-row factor strings, no upload names", () => {
  const summarised = withSourceSummary(charts, SUMMARY);
  assert.equal(summarised.length, charts.length);
  for (const [type, component] of footers) {
    const html = draw(component, chart(summarised, type));
    assert.equal(html.split(SUMMARY).length - 1, 1, `${type}: the summary, once`);
    assert.match(html, /as at .*— derived, not captured/, `${type}: the as-at date, then the closing words`);
    assert.ok(PER_ROW.every((set) => !html.includes(set)), `${type}: no per-row factor string`);
    assert.doesNotMatch(html, /\.csv|\.xlsx/);
  }
});

test("the summary is display only: the data, its identity and the manifest validation are unchanged", () => {
  const summarised = withSourceSummary(charts, SUMMARY);
  summarised.forEach((c, i) => {
    assert.deepEqual(c.provenance.factorSets, charts[i]!.provenance.factorSets, "the factor sets themselves are kept");
    assert.equal(c.provenance.dataHash, charts[i]!.provenance.dataHash);
    assert.deepEqual({ ...c, provenance: { ...c.provenance, sourceSummary: undefined } }, { ...charts[i]!, provenance: { ...charts[i]!.provenance, sourceSummary: undefined } });
  });
  assert.equal(charts.every((c) => c.provenance.sourceSummary === undefined), true, "the resolved charts are not mutated");
});

test("the manifest's chart evidence names the summary as the factor sources when set, the factor sets when not", () => {
  // The manifest cut to the charts this fixture resolves, so it validates and the evidence is drawn (no intensity target here).
  const present = new Set(charts.map((c) => c.spec.id));
  const manifest = { ...crpProfessionalManifest, charts: crpProfessionalManifest.charts.filter((c) => present.has(c.id)),
    sections: crpProfessionalManifest.sections.map((s) => ({ ...s, chartIds: s.chartIds.filter((id) => present.has(id)) })) };
  const props = { manifest, reviewedSnapshotId: snapshot.id };
  const plain = renderToStaticMarkup(createElement(ManifestChartSet, { ...props, charts }));
  const summarised = renderToStaticMarkup(createElement(ManifestChartSet, { ...props, charts: withSourceSummary(charts, SUMMARY) }));
  assert.match(plain, /View chart evidence/, "the set validated and drew its evidence");
  assert.ok(PER_ROW.every((set) => plain.includes(set)));
  assert.ok(PER_ROW.every((set) => !summarised.includes(set)), "no per-row factor string anywhere on the summarised set");
  assert.match(summarised, /Factor sources<b>Reviewed snapshot J000001 · DESNZ GB 2025<\/b>/);
});
