import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateAssuranceYear,
  buildReportingChain,
  computeAssuranceGaps,
  percentVsBaseline,
  percentVsBaselineTone,
  type AssuranceCurrentRow,
  type AssuranceTrend,
} from "../src/index";

const snap = (year: number) => ({ year, snapshotId: `s-${year}`, dataHash: `sha256:${year}` });

describe("buildReportingChain (DA1 / NZC-059)", () => {
  it("orders baseline + three most recent priors + current, ascending", () => {
    const chain = buildReportingChain({
      jobId: "j", clientId: "c", currentYear: 2026, baselineYear: 2020,
      priorSnapshots: [snap(2020), snap(2021), snap(2022), snap(2023), snap(2024), snap(2025)],
      currentSnapshot: null,
    });
    assert.deepEqual(chain.entries.map((e) => [e.year, e.kind]), [
      [2020, "baseline"], [2023, "prior"], [2024, "prior"], [2025, "prior"], [2026, "current"],
    ]);
    assert.equal(chain.entries[0]!.source, "reviewed-snapshot");
    assert.equal(chain.entries.at(-1)!.source, "live");
  });

  it("marks the current year reviewed-snapshot when the job has one", () => {
    const chain = buildReportingChain({
      jobId: "j", clientId: "c", currentYear: 2026, baselineYear: 2024,
      priorSnapshots: [snap(2024), snap(2025)],
      currentSnapshot: { snapshotId: "s-current", dataHash: "sha256:cur" },
    });
    const current = chain.entries.at(-1)!;
    assert.equal(current.kind, "current");
    assert.equal(current.source, "reviewed-snapshot");
    assert.equal(current.snapshotId, "s-current");
  });

  it("keeps the baseline entry with source none when no snapshot exists for that year", () => {
    const chain = buildReportingChain({
      jobId: "j", clientId: "c", currentYear: 2026, baselineYear: 2019,
      priorSnapshots: [snap(2024), snap(2025)],
      currentSnapshot: null,
    });
    assert.equal(chain.entries[0]!.year, 2019);
    assert.equal(chain.entries[0]!.kind, "baseline");
    assert.equal(chain.entries[0]!.source, "none");
    assert.equal(chain.entries[0]!.snapshotId, null);
  });

  it("has no baseline entry when no target is set", () => {
    const chain = buildReportingChain({
      jobId: "j", clientId: "c", currentYear: 2026, baselineYear: null,
      priorSnapshots: [snap(2023), snap(2024), snap(2025)],
      currentSnapshot: null,
    });
    assert.equal(chain.baselineYear, null);
    assert.ok(!chain.entries.some((e) => e.kind === "baseline"));
    assert.deepEqual(chain.entries.map((e) => e.year), [2023, 2024, 2025, 2026]);
  });

  it("never double-counts the baseline year as a prior", () => {
    const chain = buildReportingChain({
      jobId: "j", clientId: "c", currentYear: 2026, baselineYear: 2024,
      priorSnapshots: [snap(2024), snap(2025)],
      currentSnapshot: null,
    });
    assert.equal(chain.entries.filter((e) => e.year === 2024).length, 1);
    assert.equal(chain.entries.find((e) => e.year === 2024)!.kind, "baseline");
  });

  it("tolerates gaps in the prior-year sequence", () => {
    const chain = buildReportingChain({
      jobId: "j", clientId: "c", currentYear: 2026, baselineYear: 2020,
      priorSnapshots: [snap(2020), snap(2022), snap(2025)], // 2021, 2023, 2024 missing
      currentSnapshot: null,
    });
    assert.deepEqual(chain.entries.map((e) => e.year), [2020, 2022, 2025, 2026]);
  });
});

describe("aggregateAssuranceYear (DA1b)", () => {
  const measurements = [
    { scope: "1" as const, scopeCode: "1", siteId: "hq", siteLabel: "HQ", tco2e: 100 },
    { scope: "2" as const, scopeCode: "2", siteId: "hq", siteLabel: "HQ", tco2e: 40 },
    { scope: "3" as const, scopeCode: "3.7", siteId: null, siteLabel: null, tco2e: 300 },
    { scope: "3" as const, scopeCode: "3.7", siteId: "warehouse", siteLabel: "Warehouse", tco2e: 60 },
  ];

  it("totals by scope, category and site", () => {
    const year = aggregateAssuranceYear({ year: 2026, kind: "current", source: "live", measurements, intensity: { reportingDenominator: 10, denominatorUnit: "FTE" } });
    assert.equal(year.total, 500);
    assert.deepEqual(year.byScope, { "1": 100, "2": 40, "3": 360 });
    assert.equal(year.byCategory.find((c) => c.scopeCode === "3.7")!.tco2e, 360);
    assert.equal(year.byCategory[0]!.label, "Employee commuting");
    assert.equal(year.bySite.find((s) => s.siteId === null)!.label, "Unallocated");
    assert.equal(year.intensity, 50);
    assert.equal(year.intensityUnit, "tCO₂e / FTE");
  });

  it("a source:none year carries null total and empty aggregates", () => {
    const year = aggregateAssuranceYear({ year: 2019, kind: "baseline", source: "none", measurements: [] });
    assert.equal(year.total, null);
    assert.deepEqual(year.byScope, { "1": 0, "2": 0, "3": 0 });
    assert.equal(year.byCategory.length, 0);
  });
});

describe("percentVsBaseline / tone (DA1c / NZC-060)", () => {
  const near = (value: number | null, expected: number) => assert.ok(value != null && Math.abs(value - expected) < 1e-9, `${value} ≈ ${expected}`);
  it("computes current ÷ baseline − 1, guarding a missing side", () => {
    near(percentVsBaseline(80, 100), -0.2);
    near(percentVsBaseline(120, 100), 0.2);
    assert.equal(percentVsBaseline(80, null), null);
    assert.equal(percentVsBaseline(80, 0), null);
  });

  it("a reduction driven by an unresolved completeness gap reads neutral", () => {
    const gaps = [
      { key: "completeness:category:3.7", flag: "completeness" as const, scopeRowId: null, scopeCode: "3.7", siteId: null, label: "Employee commuting", detail: "", resolved: false, resolution: null },
    ];
    assert.equal(percentVsBaselineTone({ scopeCode: "3.7", percent: -1, gaps }), "neutral");
    // once resolved it takes its normal tone
    assert.equal(percentVsBaselineTone({ scopeCode: "3.7", percent: -1, gaps: [{ ...gaps[0]!, resolved: true }] }), "reduction");
    // a YoY-movement gap does not neutralise the %
    assert.equal(percentVsBaselineTone({ scopeCode: "3.7", percent: -1, gaps: [{ ...gaps[0]!, flag: "yoy_movement" }] }), "reduction");
    // an increase is always shown
    assert.equal(percentVsBaselineTone({ scopeCode: "3.7", percent: 0.5, gaps }), "increase");
  });
});

describe("computeAssuranceGaps (DA1c / NZC-060) — all four flag types", () => {
  const priorYear = aggregateAssuranceYear({
    year: 2025, kind: "prior", source: "reviewed-snapshot",
    measurements: [
      { scope: "1" as const, scopeCode: "1.natural-gas", tco2e: 50 },
      { scope: "2" as const, scopeCode: "2", tco2e: 40 },
      { scope: "3" as const, scopeCode: "3.7", tco2e: 100 },
    ],
  });
  const currentYear = aggregateAssuranceYear({
    year: 2026, kind: "current", source: "live",
    measurements: [
      { scope: "2" as const, scopeCode: "2", tco2e: 40 },
      { scope: "3" as const, scopeCode: "3.7", tco2e: 300 }, // 3× → YoY flag
    ],
  });
  const trend: AssuranceTrend = { jobId: "j", clientId: "c", currentYear: 2026, baselineYear: 2020, years: [priorYear, currentYear] };

  const rows: AssuranceCurrentRow[] = [
    { rowId: "r-gas", scope: "1", scopeCode: "1.natural-gas", sourceLabel: "Natural gas", siteId: null, quantity: 0, hasFactor: true, tco2e: 0, enabled: true, hasMonthlyActivity: false }, // zero_blank
    { rowId: "r-nofactor", scope: "3", scopeCode: "3.1", sourceLabel: "Supplier X", siteId: null, quantity: 12, hasFactor: false, tco2e: null, enabled: true, hasMonthlyActivity: false }, // unmapped
    { rowId: "r-commute", scope: "3", scopeCode: "3.7", sourceLabel: "Commuting survey", siteId: null, quantity: 5000, hasFactor: true, tco2e: 300, enabled: true, hasMonthlyActivity: false },
    { rowId: "r-disabled", scope: "1", scopeCode: "1.natural-gas", sourceLabel: "Old row", siteId: null, quantity: null, hasFactor: false, tco2e: null, enabled: false, hasMonthlyActivity: false }, // ignored (disabled)
  ];

  it("flags YoY, completeness, zero/blank and unmapped", () => {
    const result = computeAssuranceGaps({ trend, currentRows: rows, resolutions: [] });
    const byFlag = (flag: string) => result.gaps.filter((g) => g.flag === flag);
    assert.equal(byFlag("yoy_movement").length, 1);
    assert.equal(byFlag("yoy_movement")[0]!.scopeCode, "3.7");
    assert.ok(byFlag("completeness").some((g) => g.scopeCode === "1.natural-gas")); // gas present 2025, absent 2026 aggregate
    assert.equal(byFlag("zero_blank").length, 1);
    assert.equal(byFlag("zero_blank")[0]!.scopeRowId, "r-gas");
    assert.equal(byFlag("unmapped").length, 1);
    assert.equal(byFlag("unmapped")[0]!.scopeRowId, "r-nofactor");
    assert.equal(result.openCount, result.gaps.length);
  });

  it("a resolution clears a gap's open state but keeps it visible with its reason", () => {
    const key = "unmapped:r-nofactor";
    const result = computeAssuranceGaps({
      trend, currentRows: rows,
      resolutions: [{ gapKey: key, reason: "Immaterial supplier, mapped next cycle.", resolvedBy: "rev", resolvedAt: "2026-09-04T00:00:00Z" }],
    });
    const gap = result.gaps.find((g) => g.key === key)!;
    assert.equal(gap.resolved, true);
    assert.equal(gap.resolution!.reason, "Immaterial supplier, mapped next cycle.");
    assert.equal(result.openCount, result.gaps.length - 1);
  });

  it("no prior year with data ⇒ no YoY or completeness flags", () => {
    const bareTrend: AssuranceTrend = { ...trend, years: [{ ...priorYear, source: "none", total: null }, currentYear] };
    const result = computeAssuranceGaps({ trend: bareTrend, currentRows: rows, resolutions: [] });
    assert.equal(result.gaps.filter((g) => g.flag === "yoy_movement" || g.flag === "completeness").length, 0);
    // row-level flags still fire
    assert.ok(result.gaps.some((g) => g.flag === "zero_blank"));
  });
});
