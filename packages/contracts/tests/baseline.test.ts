import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  baselineInForce,
  isEligibleReportingYear,
  isSamePeriod,
  reportingPeriodDays,
  resolveBaseline,
  selectReportingYearJob,
  yearsAfterBaseline,
  type ClientBaselineRecord,
} from "../src/index";

const figures = (total: number) => ({ scope1: total * 0.1, scope2: total * 0.1, scope3: total * 0.8, total });

const record = (over: Partial<ClientBaselineRecord> = {}): ClientBaselineRecord => ({
  baselineId: "b1", clientId: "c1",
  periodStart: "2019-01-01", periodEnd: "2019-12-31",
  baselineJobId: null, figures: figures(1000),
  kind: "initial", source: "declared", reason: null,
  setBy: "staff-a", setAt: "2026-01-01T00:00:00.000Z",
  effectiveFrom: "2019-01-01", supersededAt: null,
  ...over,
});

describe("reporting-year eligibility (NZC-067)", () => {
  it("counts an inclusive period in days", () => {
    assert.equal(reportingPeriodDays("2026-01-01", "2026-12-31"), 365);
    assert.equal(reportingPeriodDays("2024-01-01", "2024-12-31"), 366);
    assert.equal(reportingPeriodDays("2026-01-01", "2026-01-01"), 1);
  });

  it("admits annual-ish periods and excludes the stubs and multi-year jobs live found", () => {
    assert.equal(isEligibleReportingYear("2026-01-01", "2026-12-31"), true);   // 365
    assert.equal(isEligibleReportingYear("2026-04-01", "2027-03-31"), true);   // financial year
    assert.equal(isEligibleReportingYear("2026-01-01", "2026-02-01"), false);  // 32-day stub
    assert.equal(isEligibleReportingYear("2024-01-01", "2026-03-01"), false);  // 790-day multi-year
  });

  it("picks the latest-ending eligible job, then the highest id, and excludes ineligible ones", () => {
    const pick = selectReportingYearJob([
      { jobId: "j1", periodStart: "2026-01-01", periodEnd: "2026-12-31" },
      { jobId: "j9", periodStart: "2026-01-01", periodEnd: "2026-12-31" },
      { jobId: "j5", periodStart: "2026-02-01", periodEnd: "2027-01-31" },
    ]);
    assert.equal(pick?.jobId, "j5", "latest period end wins over a higher id");

    const tie = selectReportingYearJob([
      { jobId: "j1", periodStart: "2026-01-01", periodEnd: "2026-12-31" },
      { jobId: "j9", periodStart: "2026-01-01", periodEnd: "2026-12-31" },
    ]);
    assert.equal(tie?.jobId, "j9", "equal ends fall back to the highest id");
  });

  it("yields no job at all when every candidate is ineligible", () => {
    // A wrong point is worse than no point — a 790-day total must not plot as a year.
    assert.equal(selectReportingYearJob([{ jobId: "j1", periodStart: "2024-01-01", periodEnd: "2026-03-01" }]), null);
    assert.equal(selectReportingYearJob([]), null);
  });
});

describe("period comparison (NZC-067)", () => {
  it("tolerates the one-day drift live's exact string equality missed", () => {
    assert.equal(isSamePeriod("2026-01-01", "2026-12-31", "2026-01-01", "2026-12-31"), true);
    assert.equal(isSamePeriod("2026-01-01", "2026-12-31", "2026-01-02", "2026-12-30"), true);
  });

  it("still separates genuinely different years", () => {
    assert.equal(isSamePeriod("2026-01-01", "2026-12-31", "2025-01-01", "2025-12-31"), false);
    assert.equal(isSamePeriod("2026-01-01", "2026-12-31", "2026-02-01", "2027-01-31"), false);
  });
});

describe("baselineInForce (NZC-065)", () => {
  const initial = record({ baselineId: "b-2019", effectiveFrom: "2019-01-01", setAt: "2019-02-01T00:00:00.000Z" });
  const rebased = record({
    baselineId: "b-2024", periodStart: "2024-01-01", periodEnd: "2024-12-31",
    effectiveFrom: "2024-01-01", kind: "rebaseline", reason: "Acquired Northwind",
    setAt: "2024-06-01T00:00:00.000Z", figures: figures(1400),
  });

  it("returns the record that had taken effect when the period began", () => {
    assert.equal(baselineInForce([initial, rebased], "2022-01-01")?.baselineId, "b-2019");
    assert.equal(baselineInForce([initial, rebased], "2025-01-01")?.baselineId, "b-2024");
  });

  it("keeps a superseded record resolvable, so an old report can still reproduce itself", () => {
    const superseded = { ...initial, supersededAt: "2024-06-01T00:00:00.000Z" };
    assert.equal(baselineInForce([superseded, rebased], "2022-01-01")?.baselineId, "b-2019");
  });

  it("has no baseline before the first record takes effect", () => {
    assert.equal(baselineInForce([initial], "2018-01-01"), null);
    assert.equal(baselineInForce([], "2026-01-01"), null);
  });
});

describe("resolveBaseline (NZC-067)", () => {
  it("reports a job that is its own baseline, with nothing earlier to compare against", () => {
    // The J000699 failure: a client rebased to its own reporting year still showed
    // a baseline column and a prior-year column.
    const resolved = resolveBaseline({
      periodStart: "2026-01-01", periodEnd: "2026-12-31",
      records: [record({ periodStart: "2026-01-01", periodEnd: "2026-12-31", effectiveFrom: "2026-01-01" })],
    });
    assert.equal(resolved?.jobIsItsOwnBaseline, true);
  });

  it("resolves assured figures through the baseline job", () => {
    const resolved = resolveBaseline({
      periodStart: "2026-01-01", periodEnd: "2026-12-31",
      records: [record({ baselineJobId: "j-2019", figures: null, source: "assured" })],
      figuresForJob: (jobId) => (jobId === "j-2019" ? figures(900) : null),
    });
    assert.equal(resolved?.figures?.total, 900);
    assert.equal(resolved?.comparable, true);
    assert.equal(resolved?.jobIsItsOwnBaseline, false);
  });

  it("declines to compare against a migrated_unverified record", () => {
    // Present for context, never a denominator — a two-year total must not become a base year.
    const resolved = resolveBaseline({
      periodStart: "2026-01-01", periodEnd: "2026-12-31",
      records: [record({ source: "migrated_unverified" })],
    });
    assert.equal(resolved?.source, "migrated_unverified");
    assert.equal(resolved?.comparable, false, "an unverified record is not comparable");
  });

  it("is not comparable when a job-referenced baseline has no figures yet", () => {
    const resolved = resolveBaseline({
      periodStart: "2026-01-01", periodEnd: "2026-12-31",
      records: [record({ baselineJobId: "j-x", figures: null, source: "assured" })],
      figuresForJob: () => null,
    });
    assert.equal(resolved?.figures, null);
    assert.equal(resolved?.comparable, false);
  });

  it("returns null when no baseline governs the period", () => {
    assert.equal(resolveBaseline({ periodStart: "2018-01-01", periodEnd: "2018-12-31", records: [record()] }), null);
  });
});

describe("yearsAfterBaseline (NZC-067)", () => {
  it("never looks earlier than the baseline in force", () => {
    assert.deepEqual(yearsAfterBaseline([2021, 2022, 2023, 2024], "2022-12-31"), [2023, 2024]);
  });

  it("keeps every year when there is no baseline", () => {
    assert.deepEqual(yearsAfterBaseline([2021, 2022], null), [2021, 2022]);
  });

  it("excludes the baseline year itself — it is the start of the record, not a prior", () => {
    assert.deepEqual(yearsAfterBaseline([2024], "2024-12-31"), []);
  });
});
