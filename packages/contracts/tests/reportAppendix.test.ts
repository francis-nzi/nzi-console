import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReportAuditRows, buildReportSiteBreakdown, type ReportAuditMeasurement } from "../src/index";

const measurements: ReportAuditMeasurement[] = [
  { rowId: "row-1", scope: "1", scopeCode: "1", sourceLabel: "Fleet diesel", siteLabel: "Manchester", sourceQuantity: 6200, sourceUnit: "litres", tco2e: 16.6, factorSet: "Diesel · 2026.1", qualityTier: "measured" },
  { rowId: "row-2", scope: "2", scopeCode: "2", sourceLabel: "Grid electricity", siteLabel: "Manchester", sourceQuantity: 312000, sourceUnit: "kWh", tco2e: 58.2, factorSet: "UK grid · 2026.1", qualityTier: "measured" },
  { rowId: "row-3", scope: "3", scopeCode: "3.7", sourceLabel: "Commuting survey", siteLabel: null, sourceQuantity: 4000, sourceUnit: "passenger.km", tco2e: 0.8, factorSet: "Car — petrol · 2026.1", qualityTier: "estimated" },
  { rowId: "row-4", scope: "3", scopeCode: "3.1", sourceLabel: "Packaging", siteLabel: "Manchester", sourceQuantity: null, sourceUnit: null, tco2e: 12.4, factorSet: "", qualityTier: "spend-based" },
];

describe("buildReportAuditRows (R5a / NZC-051 — Appendix 1)", () => {
  it("sorts by scope then category then source, and carries a display-ready quantity + fallback factor/site", () => {
    const rows = buildReportAuditRows(measurements);
    assert.deepEqual(rows.map((row) => row.rowId), ["row-1", "row-2", "row-4", "row-3"]);
    assert.equal(rows[0]!.category, "Direct emissions");
    assert.equal(rows[0]!.quantityLabel, "6,200 litres");
    assert.equal(rows.find((row) => row.rowId === "row-4")!.factorSet, "—");
    assert.equal(rows.find((row) => row.rowId === "row-3")!.siteLabel, "Unallocated");
    assert.equal(rows.find((row) => row.rowId === "row-4")!.quantityLabel, "—");
  });

  it("is a pure re-shape — the same tCO2e total survives", () => {
    const rows = buildReportAuditRows(measurements);
    const total = rows.reduce((sum, row) => sum + row.tco2e, 0);
    assert.equal(total, measurements.reduce((sum, m) => sum + m.tco2e, 0));
  });
});

describe("buildReportSiteBreakdown (R5a / NZC-051 — Appendix 2)", () => {
  it("groups by site, then scope, then category — unallocated is a real site, not dropped", () => {
    const sites = buildReportSiteBreakdown(measurements);
    assert.deepEqual(sites.map((site) => site.siteLabel), ["Manchester", "Unallocated"]);

    const manchester = sites.find((site) => site.siteLabel === "Manchester")!;
    assert.equal(manchester.total, 16.6 + 58.2 + 12.4);
    assert.deepEqual(manchester.byScope.map((scope) => scope.scope), ["1", "2", "3"]);
    assert.equal(manchester.byScope.find((scope) => scope.scope === "3")!.categories[0]!.category, "Purchased goods and services");

    const unallocated = sites.find((site) => site.siteLabel === "Unallocated")!;
    assert.equal(unallocated.total, 0.8);
  });

  it("never invents a scope with no categories", () => {
    const sites = buildReportSiteBreakdown(measurements);
    for (const site of sites) for (const scope of site.byScope) assert.ok(scope.categories.length > 0);
  });

  it("empty input is an empty breakdown, not an error", () => {
    assert.deepEqual(buildReportSiteBreakdown([]), []);
  });
});
