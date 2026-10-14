import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { resolveCrpCoreCharts, crpProfessionalManifest, type ReviewedCrpSnapshotCore } from "../src/crp";
import { manifestChartAbsence, snapshotHasPurchasedGoods, validateManifest } from "../src/manifest";
import { ManifestChartSet } from "../src/index";

/**
 * RULING-report-studio-consolidation R7: the purchased-goods breakdown is drawn from Scope 3.1 rows, so a snapshot with none
 * has no breakdown to show — the chart is absent, not a blocker. With 3.1 rows it is required as before, and with the fact
 * unknown (no context) the manifest is as strict as it always was.
 */
const snapshot = (rows: ReviewedCrpSnapshotCore["measurements"]): ReviewedCrpSnapshotCore => ({
  id: "snap-r7", jobId: "j", jobNumber: "J000001", client: "Synthetic Client", reportingYear: 2025, generatedAt: "2026-10-14T00:00:00Z", dataHash: "sha256:r7",
  annualComparison: [{ year: 2025, values: [{ scope: "1", value: 10 }] }], measurements: rows,
});
const gas = { rowId: "a", scope: "1" as const, scopeCode: "1", sourceLabel: "Gas", siteId: "uk", siteLabel: "UK Office", tco2e: 10, factorSet: "f" };
const goods = { rowId: "g", scope: "3" as const, scopeCode: "3.1", sourceLabel: "Goods", siteId: "uk", siteLabel: "UK Office", tco2e: 5, factorSet: "f", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" };
const travel = { rowId: "t", scope: "3" as const, scopeCode: "3.6", sourceLabel: "Flights", siteId: "uk", siteLabel: "UK Office", tco2e: 7, factorSet: "f" };
const noGoods = snapshot([gas, travel]), withGoods = snapshot([gas, travel, goods]);
const firstYearOut = { reportingYears: 1, excludedSections: ["intensity", "targets"] };
const missing = (validation: ReturnType<typeof validateManifest>) => validation.issues.filter((issue) => issue.code === "missing_required_chart").map((issue) => issue.chartId).sort();

test("whether a snapshot has Scope 3.1 rows is read from its rows' scope codes — 3.6 or 3.10 is not 3.1", () => {
  assert.equal(snapshotHasPurchasedGoods(noGoods.measurements), false);
  assert.equal(snapshotHasPurchasedGoods(withGoods.measurements), true);
  assert.equal(snapshotHasPurchasedGoods([{ scopeCode: "3.10" }, { scopeCode: null }, {}]), false);
});

test("no 3.1 rows: the breakdown is absent, not a blocker — a report without purchased goods validates", () => {
  const charts = resolveCrpCoreCharts(noGoods);
  assert.ok(!charts.some((chart) => chart.spec.type === "purchased_goods_breakdown"), "the resolver draws none");
  const validation = validateManifest(crpProfessionalManifest, charts, "snap-r7", { ...firstYearOut, purchasedGoods: false });
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.deepEqual(validation.absent.find((absence) => absence.chartId === "purchased_goods_breakdown"), { chartId: "purchased_goods_breakdown", reason: "no-3.1" });
});

test("unknown (no fact given) stays as strict as before: the missing breakdown blocks", () => {
  assert.deepEqual(missing(validateManifest(crpProfessionalManifest, resolveCrpCoreCharts(noGoods), "snap-r7", firstYearOut)), ["purchased_goods_breakdown"]);
});

test("with 3.1 rows the breakdown is required, resolves, and is held to every check — never excused", () => {
  const charts = resolveCrpCoreCharts(withGoods);
  const validation = validateManifest(crpProfessionalManifest, charts, "snap-r7", { ...firstYearOut, purchasedGoods: true });
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.ok(!validation.absent.some((absence) => absence.chartId === "purchased_goods_breakdown"));
  const requirement = crpProfessionalManifest.charts.find((chart) => chart.id === "purchased_goods_breakdown")!;
  assert.equal(manifestChartAbsence(requirement, { purchasedGoods: true }), null);
  // A 3.1 breakdown that was expected and is missing still blocks.
  assert.deepEqual(missing(validateManifest(crpProfessionalManifest, charts.filter((chart) => chart.spec.type !== "purchased_goods_breakdown"), "snap-r7", { ...firstYearOut, purchasedGoods: true })), ["purchased_goods_breakdown"]);
});

test("the purchased-goods fact excuses only that chart", () => {
  const validation = validateManifest(crpProfessionalManifest, resolveCrpCoreCharts(noGoods), "snap-r7", { reportingYears: 1, purchasedGoods: false });
  assert.deepEqual(missing(validation), ["intensity_pathway", "reduction_pathway"]);
});

test("the evidence says why it is absent — in its own words, not as a left-out section", () => {
  const html = renderToStaticMarkup(createElement(ManifestChartSet, { manifest: crpProfessionalManifest, charts: resolveCrpCoreCharts(noGoods), reviewedSnapshotId: "snap-r7", context: { ...firstYearOut, purchasedGoods: false } }));
  assert.match(html, /data-chart-absent="purchased_goods_breakdown"[^>]*>Purchased goods and services appears when this snapshot has Scope 3\.1 emissions; it has none\./);
  assert.doesNotMatch(html, /the undefined section|Graphics unavailable/);
});
