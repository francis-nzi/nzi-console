import assert from "node:assert/strict";
import test from "node:test";
import { resolveCrpCharts,resolveCrpCoreCharts, crpProfessionalManifest, type ReviewedCrpSnapshot } from "../src/crp";
import { chartAssetKey } from "../src/identity";
import { validateManifest } from "../src/manifest";
import { crpChartSamples, reviewedCrpSnapshotSample } from "../src/sample";

test("one reviewed CRP snapshot resolves a publishable chart set", () => {
  const charts = crpChartSamples;
  const result = validateManifest(crpProfessionalManifest, charts, reviewedCrpSnapshotSample.id);
  assert.equal(result.valid, true);
  assert.equal(charts[0].provenance.dataHash, charts[1].provenance.dataHash);
  assert.equal(charts[0].provenance.reviewedSnapshotId, reviewedCrpSnapshotSample.id);
});

test("a missing required chart blocks publication", () => {
  const charts = resolveCrpCharts(reviewedCrpSnapshotSample);
  const result = validateManifest(crpProfessionalManifest, [charts[0]], reviewedCrpSnapshotSample.id);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "missing_required_chart");
});

test("an included unreviewed measurement degrades charts and blocks publication", () => {
  const snapshot: ReviewedCrpSnapshot = {
    ...reviewedCrpSnapshotSample,
    id: "reviewed-crp-J000712-v2",
    measurements: [...reviewedCrpSnapshotSample.measurements, {
      scope: "3", tco2e: 10, factorSet: "DEFRA 2024 v1.2", reviewed: false, included: true,
    }],
  };
  const charts = resolveCrpCharts(snapshot);
  const result = validateManifest(crpProfessionalManifest, charts, snapshot.id);
  assert.equal(charts[0].state, "degraded");
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "chart_not_successful"));
});

test("render targets have distinct content-addressed derivative keys", () => {
  const [chart] = resolveCrpCharts(reviewedCrpSnapshotSample);
  assert.notEqual(chartAssetKey(chart, "screen"), chartAssetKey(chart, "print"));
  assert.match(chartAssetKey(chart, "portal"), /tokens-1:renderer-1:portal$/);
});

test("the professional CRP manifest requires every catalogue chart", () => {
  const required = crpProfessionalManifest.charts.filter((chart) => chart.required).map((chart) => chart.id);
  assert.deepEqual(required, crpChartSamples.map((chart) => chart.spec.id));
  assert.equal(validateManifest(crpProfessionalManifest, crpChartSamples, reviewedCrpSnapshotSample.id).valid, true);
});

test("database core snapshots resolve supported charts but cannot bypass the full manifest",()=>{const charts=resolveCrpCoreCharts({id:"snapshot-core",jobId:"717",jobNumber:"J000717",client:"Synthetic Client",reportingYear:2026,generatedAt:"2026-08-25T00:00:00Z",dataHash:"sha256:core",measurements:[{rowId:"row-a",scope:"1",sourceLabel:"Synthetic fuel",tco2e:2.5,factorSet:"Demo v1"}]});assert.deepEqual(charts.map(chart=>chart.spec.id),["emissions_scope_donut","emissions_by_activity"]);const validation=validateManifest(crpProfessionalManifest,charts,"snapshot-core");assert.equal(validation.valid,false);assert.deepEqual(validation.issues.filter(issue=>issue.code==="missing_required_chart").map(issue=>issue.chartId),["reduction_pathway","scope_year_on_year_bar","emissions_site_donut","intensity_pathway","purchased_goods_breakdown"]);});
