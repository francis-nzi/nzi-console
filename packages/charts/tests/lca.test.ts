import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  LcaHotspotsBar, LcaModuleDonut, ManifestChartSet, chartAssetKey, lcaProfessionalManifest,
  pcfProfessionalManifest, resolveLcaCharts, validateManifest, verifyLcaChartsAgainstSnapshot,
  type ReviewedLcaSnapshot,
} from "../src/index";
import { lcaChartSamples, reviewedLcaSnapshotSample } from "../src/sample";

test("one reviewed LCA snapshot resolves a publishable chart set", () => {
  const result = validateManifest(lcaProfessionalManifest, lcaChartSamples, reviewedLcaSnapshotSample.id);
  assert.equal(result.valid, true);
  assert.equal(lcaChartSamples[0]!.provenance.dataHash, lcaChartSamples[1]!.provenance.dataHash);
  assert.equal(lcaChartSamples[0]!.spec.family, "lca");
});

test("a PCF snapshot resolves against the PCF manifest and keeps the Product Carbon Footprint label", () => {
  const pcf: ReviewedLcaSnapshot = { ...reviewedLcaSnapshotSample, id: "reviewed-pcf-1", isPcf: true };
  const charts = resolveLcaCharts(pcf);
  assert.equal(charts[0].spec.family, "pcf");
  assert.match(charts[0].spec.title, /Product Carbon Footprint/);
  assert.equal(validateManifest(pcfProfessionalManifest, charts, pcf.id).valid, true);
  // The LCA manifest must reject a PCF-family chart set.
  assert.equal(validateManifest(lcaProfessionalManifest, charts, pcf.id).valid, false);
});

test("an empty module breakdown degrades to a blocked manifest, not a silent zero", () => {
  const bare: ReviewedLcaSnapshot = { ...reviewedLcaSnapshotSample, id: "reviewed-lca-empty", moduleBreakdown: [], totalTco2e: 0 };
  const charts = resolveLcaCharts(bare);
  assert.equal(charts[0].state, "empty");
  assert.equal(validateManifest(lcaProfessionalManifest, charts, bare.id).valid, false);
});

test("every chart figure reconciles to the reviewed snapshot", () => {
  const check = verifyLcaChartsAgainstSnapshot(reviewedLcaSnapshotSample, lcaChartSamples);
  assert.equal(check.ok, true, JSON.stringify(check.checks.filter((c) => !c.ok)));
});

test("a module segment that drifts from the snapshot fails verification", () => {
  const drifted = structuredClone(lcaChartSamples);
  (drifted[0] as { modules: Array<{ value: number }> }).modules[0]!.value += 5;
  assert.equal(verifyLcaChartsAgainstSnapshot(reviewedLcaSnapshotSample, drifted).ok, false);
});

test("both LCA charts render to deterministic static SVG (no request-time canvas)", () => {
  const donut = renderToStaticMarkup(createElement(LcaModuleDonut, { data: lcaChartSamples[0] as never }));
  const bar = renderToStaticMarkup(createElement(LcaHotspotsBar, { data: lcaChartSamples[1] as never }));
  for (const html of [donut, bar]) {
    assert.match(html, /<svg/);
    assert.doesNotMatch(html, /<canvas/i);
  }
  // The same data + target must produce the same asset key twice.
  assert.equal(chartAssetKey(lcaChartSamples[0]!, "print"), chartAssetKey(lcaChartSamples[0]!, "print"));
});

test("ManifestChartSet renders the LCA section from one reviewed identity", () => {
  const html = renderToStaticMarkup(createElement(ManifestChartSet, {
    manifest: lcaProfessionalManifest, charts: lcaChartSamples, reviewedSnapshotId: reviewedLcaSnapshotSample.id, printSafe: true,
  }));
  assert.match(html, /Life-cycle assessment footprint/);
  assert.match(html, new RegExp(reviewedLcaSnapshotSample.dataHash));
});
