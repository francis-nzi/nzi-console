import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clientFacingComposition, clientFacingPublishedReport, composeReportChartBasis, isCurrencyIntensityTarget, reportingIntensityOf,
  withoutCurrencyDenominator, type ChartBasisSnapshot, type PublishedCrpReportReadModel, type ReportComposition,
} from "../src/index";

/**
 * RULING-report-denominator (NZC-120): no currency denominator — the client's turnover — crosses either client boundary (a
 * composition's chart basis; the client's copy of a published report). The year's intensity goes in its place, by one helper,
 * as the pathway's own division. Floor area and employees keep their denominators at both.
 */
const rows = [{ tco2e: 10 }, { tco2e: 5 }, { tco2e: 20 }];
const target = (metric: "turnover" | "employee" | "floor-area", reportingDenominator: number | null) => ({
  jobId: "j", metric, denominatorUnit: metric === "turnover" ? "£m" : metric === "employee" ? "employee" : "m²", reportingDenominator,
  baselineYear: 2024, baselineIntensity: 3, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "staff",
});
const snapshot = (intensityTarget: ReturnType<typeof target>): ChartBasisSnapshot => ({
  id: "s", jobId: "j", jobNumber: "J1", client: "Co", reportingYear: 2025, dataHash: "sha256:a", createdAt: "2026-01-01T00:00:00.000Z", intensityTarget,
  measurements: rows.map((row, index) => ({ rowId: `r${index}`, scope: "1", scopeCode: "1", sourceLabel: "Gas", siteId: null, siteLabel: null, tco2e: row.tco2e, factorSet: "demo" })),
});
const published = (intensityTarget: ReturnType<typeof target>): PublishedCrpReportReadModel => ({
  reportVersionId: "rv", manifestVersion: 1, publishedAt: "2026-02-01T00:00:00.000Z", dataHash: "sha256:a",
  snapshot: { ...snapshot(intensityTarget), version: 1, jobVersion: 1, createdBy: "p", approvedBy: "a", target: null, annualComparison: [], sections: [], gapResolutions: [],
    measurements: rows.map((row, index) => ({ rowId: `r${index}`, rowVersion: 1, scope: "1", sourceLabel: "Gas", tco2e: row.tco2e, factorSet: "demo", qualityTier: "measured", reviewedBy: "x" })) },
} as unknown as PublishedCrpReportReadModel);
const TURNOVER = /reportingDenominator|12\.5\b|12500000/;

describe("no currency denominator crosses to the client (RULING-report-denominator)", () => {
  it("the currency measure is turnover — the one a CRP reports in money", () => {
    assert.equal(isCurrencyIntensityTarget({ metric: "turnover" }), true);
    assert.equal(isCurrencyIntensityTarget({ metric: "employee" }), false);
    assert.equal(isCurrencyIntensityTarget({ metric: "floor-area" }), false);
  });

  it("the composition's chart basis: the turnover is replaced by the year's intensity", () => {
    const basis = composeReportChartBasis({ snapshot: snapshot(target("turnover", 12.5)), scope: { kind: "whole" } });
    assert.doesNotMatch(JSON.stringify(basis.intensityTarget), TURNOVER);
    assert.equal((basis.intensityTarget as { reportingIntensity: number }).reportingIntensity, 35 / 12.5);
    assert.equal((basis.intensityTarget as { denominatorUnit: string }).denominatorUnit, "£m", "the unit stays");
  });

  it("the client's copy of a published report: the turnover is replaced by the year's intensity; the staff copy keeps it", () => {
    const full = published(target("turnover", 12.5));
    const client = clientFacingPublishedReport(full);
    assert.doesNotMatch(JSON.stringify(client), TURNOVER);
    assert.equal(client.snapshot.intensityTarget?.reportingIntensity, 35 / 12.5);
    assert.equal(full.snapshot.intensityTarget?.reportingDenominator, 12.5, "the staff-side snapshot is untouched");
  });

  it("a non-currency denominator survives both boundaries, as it was", () => {
    for (const metric of ["employee", "floor-area"] as const) {
      const basis = composeReportChartBasis({ snapshot: snapshot(target(metric, 431)), scope: { kind: "whole" } });
      assert.equal((basis.intensityTarget as { reportingDenominator: number }).reportingDenominator, 431, metric);
      assert.ok(!("reportingIntensity" in basis.intensityTarget!), metric);
      const client = clientFacingPublishedReport(published(target(metric, 431)));
      assert.equal(client.snapshot.intensityTarget?.reportingDenominator, 431, metric);
      assert.ok(!("reportingIntensity" in client.snapshot.intensityTarget!), metric);
    }
  });

  it("a composition frozen before the ruling still sends the client no turnover — the issued record itself untouched", () => {
    const frozen = { assurance: { reviewedBy: "r" }, plan: { state: "unavailable", reason: "x" },
      chartBasis: { measurements: rows, intensityTarget: { metric: "turnover", denominatorUnit: "£m", reportingDenominator: 12.5 } } } as unknown as ReportComposition;
    const client = clientFacingComposition(frozen);
    assert.doesNotMatch(JSON.stringify(client.chartBasis), TURNOVER);
    assert.equal((client.chartBasis!.intensityTarget as { reportingIntensity: number }).reportingIntensity, 35 / 12.5);
    assert.equal((frozen.chartBasis!.intensityTarget as { reportingDenominator: number }).reportingDenominator, 12.5, "the frozen composition is not changed");
  });

  it("no denominator, no intensity — never a guessed one; and applying it twice changes nothing", () => {
    assert.equal(reportingIntensityOf(rows, null), null);
    assert.equal(reportingIntensityOf(rows, 0), null);
    const once = withoutCurrencyDenominator(target("turnover", null), rows);
    assert.ok(!("reportingDenominator" in once), "a null turnover is not sent either");
    assert.equal((once as { reportingIntensity: number | null }).reportingIntensity, null);
    const stripped = withoutCurrencyDenominator(target("turnover", 12.5), rows);
    assert.deepEqual(withoutCurrencyDenominator(stripped, []), stripped, "idempotent: the intensity is kept, not recomputed from other rows");
  });

  it("is the pathway's own division, unrounded — the rows summed in order, over the denominator", () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let index = 0; index < 500; index++) {
      const sample = Array.from({ length: 1 + Math.floor(random() * 6) }, () => ({ tco2e: Math.round(random() * 1e6) / 100 }));
      const denominator = Math.round(random() * 1e8) / [1, 1e3, 1e6][index % 3]! + 0.01;
      assert.equal(reportingIntensityOf(sample, denominator), sample.reduce((sum, row) => sum + row.tco2e, 0) / denominator);
    }
  });
});
