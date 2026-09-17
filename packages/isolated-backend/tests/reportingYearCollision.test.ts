import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reportingYearSnapshots, resolveYearDenominators } from "../src/readModels";
import type { IntensityMetricDefinition, IntensityMetricValue } from "@nzi/contracts";

/**
 * Two jobs, one label: the collision that forward-only derivation does not close (NZC-096).
 *
 * NZC-092 kept every job's own `reporting_year` stable — an existing job keeps what it was stored
 * with, a new one derives from its period end. That is necessary and it is not sufficient, because
 * the two conventions disagree by a year for any non-December financial year end, and nothing stops
 * the disagreement putting **two different periods under one label on the same client**:
 *
 * ```
 * legacy job   01/10/2025 → 30/09/2026   reporting_year 2025   (labelled by the year it starts)
 * new job      01/10/2024 → 30/09/2025   reporting_year 2025   (labelled by the year it ends)
 * ```
 *
 * Adjacent, non-overlapping, and indistinguishable to anything keyed by the year. A part-year
 * period ending in the same calendar year as a full one does the same thing without any legacy
 * row involved, so this outlives the migration that made it reachable.
 *
 * **These tests fail before the re-key and pass after.** Each pairs the collision with a
 * regular-client invariant, so a fix that separates the colliding pair by breaking the ordinary
 * case fails just as loudly.
 */


/** A client with a September year end: the legacy label and the new one differ by a year. */
const legacy = {
  job_id: "job-legacy", snapshot_version: 1,
  payload_json: { reportingYear: 2025 },      // start-year convention: FY2025 starts 01/10/2025
  reporting_from: "2025-10-01", reporting_to: "2026-09-30",
};
const current = {
  job_id: "job-new", snapshot_version: 1,
  payload_json: { reportingYear: 2025 },      // end-year convention: this period ends in 2025
  reporting_from: "2024-10-01", reporting_to: "2025-09-30",
};

describe("two periods under one label — client history", () => {
  it("keeps both periods, rather than letting one silently replace the other", () => {
    // On main this returns one row: `byYear` is keyed by the year, so the second job overwrites
    // the first and a whole year of reviewed emissions disappears from the client's history with
    // nothing reporting that it did.
    const kept = reportingYearSnapshots([legacy, current]);
    assert.equal(kept.length, 2, "both jobs report a real period and both must survive");
    assert.deepEqual(kept.map((row) => row.job_id).sort(), ["job-legacy", "job-new"]);
  });

  it("still collapses genuine duplicates of one period", () => {
    // The invariant the fix must not break: two snapshots of the *same* period are still one
    // entry, and the later snapshot version wins.
    const kept = reportingYearSnapshots([
      { ...current, snapshot_version: 1 },
      { ...current, snapshot_version: 3 },
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.snapshot_version, 3, "the latest snapshot of a period stands for it");
  });

  it("is unchanged for a client whose periods never collide", () => {
    // A December year end: both conventions agree, and this must return exactly what it always did.
    const twenty24 = { job_id: "j24", snapshot_version: 1, payload_json: { reportingYear: 2024 },
      reporting_from: "2024-01-01", reporting_to: "2024-12-31" };
    const twenty25 = { job_id: "j25", snapshot_version: 1, payload_json: { reportingYear: 2025 },
      reporting_from: "2025-01-01", reporting_to: "2025-12-31" };
    const kept = reportingYearSnapshots([twenty24, twenty25]);
    assert.deepEqual(kept.map((row) => row.job_id), ["j25", "j24"], "newest period first, both present");
  });

  it("still drops a stub and a multi-year job, which are not reporting years at all", () => {
    // NZC-067's 300–400 day rule is untouched by any of this.
    const stub = { job_id: "stub", snapshot_version: 1, payload_json: { reportingYear: 2025 },
      reporting_from: "2025-04-01", reporting_to: "2025-05-15" };
    const multi = { job_id: "multi", snapshot_version: 1, payload_json: { reportingYear: 2023 },
      reporting_from: "2022-04-01", reporting_to: "2024-03-31" };
    assert.deepEqual(reportingYearSnapshots([stub, multi]).map((row) => row.job_id), []);
  });
});

describe("two periods under one label — the intensity denominator", () => {
  const definitions: IntensityMetricDefinition[] = [{
    key: "turnover", version: 1, label: "Turnover", unitWording: "£m", divider: 1_000_000,
    iconKey: "coins", isStandard: true, valueSource: "entered", active: true, ordering: 1,
  }];
  const value = (reportingYear: number, from: string, to: string, amount: number): IntensityMetricValue => ({
    metricKey: "turnover", reportingYear, periodKey: "year", value: amount,
    overridesResolved: false, note: "", version: 1,
    period: { from, to },
  });

  it("takes the denominator recorded against the period being resolved", () => {
    // On main `resolveYearDenominators` matches on `value.reportingYear === input.reportingYear`
    // with `.find()`, so with two jobs sharing 2025 the first row in the list wins whichever
    // period is being resolved — a turnover from a different year, divided into this year's
    // emissions, reported as an intensity figure with no sign that anything is wrong.
    const values = [
      value(2025, "2025-10-01", "2026-09-30", 9_000_000),  // the legacy job's turnover
      value(2025, "2024-10-01", "2025-09-30", 4_000_000),  // the new job's turnover
    ];
    const resolved = resolveYearDenominators({
      definitions, values, reportingYear: 2025, sites: [],
      period: { from: "2024-10-01", to: "2025-09-30" },
    });
    assert.equal(resolved.turnover!.value, 4_000_000, "the denominator belongs to the period asked for");
  });

  it("resolves the other period of the same label to its own denominator", () => {
    const values = [
      value(2025, "2025-10-01", "2026-09-30", 9_000_000),
      value(2025, "2024-10-01", "2025-09-30", 4_000_000),
    ];
    const resolved = resolveYearDenominators({
      definitions, values, reportingYear: 2025, sites: [],
      period: { from: "2025-10-01", to: "2026-09-30" },
    });
    assert.equal(resolved.turnover!.value, 9_000_000, "the same label, the other period, its own number");
  });

  it("is unchanged for a client with one job per year", () => {
    // The regular-client invariant: one value for the year, and it is still found.
    const values = [value(2024, "2024-01-01", "2024-12-31", 5_000_000)];
    const resolved = resolveYearDenominators({
      definitions, values, reportingYear: 2024, sites: [],
      period: { from: "2024-01-01", to: "2024-12-31" },
    });
    assert.equal(resolved.turnover!.value, 5_000_000);
  });

  it("still reports an absent denominator as absent, not as zero", () => {
    // Truth before apparent availability: no recorded turnover is not a turnover of nothing.
    const resolved = resolveYearDenominators({
      definitions, values: [], reportingYear: 2024, sites: [],
      period: { from: "2024-01-01", to: "2024-12-31" },
    });
    assert.equal(resolved.turnover!.value, null);
  });
});

describe("adjacent periods are two; overlapping periods are one", () => {
  /**
   * The distinction keying by period has to get right, and the one the year key used to make by
   * accident. Both cases put two periods under one label; only one of them is two reporting years.
   */
  const snapshot = (jobId: string, year: number, from: string, to: string, version = 1) =>
    ({ job_id: jobId, snapshot_version: version, payload_json: { reportingYear: year }, reporting_from: from, reporting_to: to });

  it("keeps adjacent periods that share a label — they are different years", () => {
    const kept = reportingYearSnapshots([
      snapshot("later", 2025, "2025-10-01", "2026-09-30"),
      snapshot("earlier", 2025, "2024-10-01", "2025-09-30"),
    ]);
    assert.deepEqual(kept.map((row) => row.job_id), ["later", "earlier"], "newest period first, both present");
  });

  it("keeps one of two overlapping periods — they describe the same time", () => {
    // A client that changed its financial year end: 01/01/2024–31/12/2024 and
    // 01/04/2024–31/03/2025 share nine months. Showing both would describe those months twice.
    const kept = reportingYearSnapshots([
      snapshot("calendar", 2024, "2024-01-01", "2024-12-31"),
      snapshot("april", 2024, "2024-04-01", "2025-03-31"),
    ]);
    assert.deepEqual(kept.map((row) => row.job_id), ["april"], "the latest period end wins, as NZC-067 preferred");
  });

  it("applies the overlap rule across labels too, not only within one", () => {
    // The old year key could only ever compare rows sharing a label, so two overlapping periods
    // with different labels both stood. The rule is about the time covered, not the number on it.
    const kept = reportingYearSnapshots([
      snapshot("labelled-2023", 2023, "2024-01-01", "2024-12-31"),
      snapshot("labelled-2024", 2024, "2024-04-01", "2025-03-31"),
    ]);
    assert.deepEqual(kept.map((row) => row.job_id), ["labelled-2024"]);
  });

  it("treats touching-but-not-overlapping periods as distinct", () => {
    // 30/09 then 01/10: the boundary case the comparison has to get exactly right.
    const kept = reportingYearSnapshots([
      snapshot("first", 2024, "2023-10-01", "2024-09-30"),
      snapshot("second", 2025, "2024-10-01", "2025-09-30"),
    ]);
    assert.equal(kept.length, 2, "a period starting the day after another ends does not overlap it");
  });
});
