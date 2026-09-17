import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reportingPeriodForYear } from "../src/siteBoundary";

/**
 * What the reporting year means **today**, pinned before Part 1 changes how a new job derives one.
 *
 * Part 1 adopts the end-year rule: a job's reporting year becomes the calendar year of its
 * reporting-period **end** date. The system today uses the opposite convention — a period is
 * labelled by the year it **starts** — and that convention is load-bearing in four places: the job
 * create command, the reviewed-snapshot read model, the portal intensity fallback, and the
 * baseline benchmark, whose comment states it explicitly ("FY23 is 01/04/2023–31/03/2024 for a
 * March year end, the same rule `reportingPeriodForYear` uses").
 *
 * This file changes no behaviour. It exists so that when the derivation moves, the diff says
 * exactly which outputs moved with it — the alternative being to change the rule and then reason
 * about which of hundreds of stored `reporting_year` values still mean what they used to.
 *
 * **The instruction it serves: forward-derive only.** Existing jobs keep the reporting year they
 * were stored with, and their period dates are back-filled to be consistent with it. Nothing below
 * may change when Part 1 lands; if something does, the change has reached backwards.
 */

/** Every financial-year end the system supports, against a spread of years. */
const MONTHS = [null, 1, 2, 3, 4, 6, 9, 12] as const;
const YEARS = [2019, 2020, 2023, 2024, 2025] as const;

describe("the reporting year labels the year a period starts", () => {
  it("holds for every financial-year end, not just December", () => {
    for (const year of YEARS) {
      for (const month of MONTHS) {
        const period = reportingPeriodForYear(year, month);
        assert.equal(Number(period.from.slice(0, 4)), year,
          `FY${year} with year end ${month ?? "unset"} must start in ${year}`);
      }
    }
  });

  it("pins the exact periods the four dependants resolve", () => {
    // Spelled out rather than computed, so a change to the derivation cannot quietly change the
    // expectation with it.
    assert.deepEqual(reportingPeriodForYear(2024, 12), { from: "2024-01-01", to: "2024-12-31" });
    assert.deepEqual(reportingPeriodForYear(2024, null), { from: "2024-01-01", to: "2024-12-31" });
    assert.deepEqual(reportingPeriodForYear(2024, 3), { from: "2024-04-01", to: "2025-03-31" });
    assert.deepEqual(reportingPeriodForYear(2024, 9), { from: "2024-10-01", to: "2025-09-30" });
    assert.deepEqual(reportingPeriodForYear(2023, 2), { from: "2023-03-01", to: "2024-02-29" });
  });

  it("ends on the real last day of the month, including a leap February", () => {
    assert.equal(reportingPeriodForYear(2023, 2).to, "2024-02-29");
    assert.equal(reportingPeriodForYear(2024, 2).to, "2025-02-28");
  });
});

describe("how far the end-year rule reaches", () => {
  /** Part 1's rule, written here only to measure the difference it makes. */
  const endYearRule = (period: { to: string }) => Number(period.to.slice(0, 4));

  it("agrees with today's rule for a December or unset year end", () => {
    // The common case, and the reason this can look harmless: for most clients the two rules are
    // the same number.
    for (const year of YEARS) {
      for (const month of [null, 12] as const) {
        assert.equal(endYearRule(reportingPeriodForYear(year, month)), year);
      }
    }
  });

  it("disagrees by exactly one year for every other year end", () => {
    // This is the blast radius, stated as a number rather than a worry: a client with a
    // non-December financial year end would have every stored reporting year re-interpreted one
    // year later. FY24 (Apr 2024 – Mar 2025) would start reading as 2025.
    for (const year of YEARS) {
      for (const month of [1, 2, 3, 4, 6, 9] as const) {
        const period = reportingPeriodForYear(year, month);
        assert.equal(endYearRule(period), year + 1,
          `a ${month}-month year end shifts FY${year} to ${year + 1} under the end-year rule`);
      }
    }
  });

  it("means the two rules cannot both label the same period", () => {
    // Which is why Part 1 derives forward only: a new job records the period the consultant
    // entered and the year derived from its end, and an existing job keeps the year it was stored
    // with. Re-deriving an old job's year from its period would move it.
    const march = reportingPeriodForYear(2024, 3);
    assert.equal(Number(march.from.slice(0, 4)), 2024, "stored today as FY2024");
    assert.equal(endYearRule(march), 2025, "and would read as FY2025 if re-derived");
    assert.notEqual(Number(march.from.slice(0, 4)), endYearRule(march));
  });
});
