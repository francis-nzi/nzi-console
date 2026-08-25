import assert from "node:assert/strict";
import test from "node:test";
import { resolveCrpCharts, crpProfessionalManifest, type ReviewedCrpSnapshot } from "../src/crp";
import { chartAssetKey } from "../src/identity";
import { validateManifest } from "../src/manifest";
import { emissionsByActivitySample, reductionPathwaySample, reviewedCrpSnapshotSample, scopeDonutSample, scopeYearOnYearSample } from "../src/sample";

test("one reviewed CRP snapshot resolves a publishable chart set", () => {
  const charts = [scopeDonutSample, reductionPathwaySample, scopeYearOnYearSample, emissionsByActivitySample];
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
