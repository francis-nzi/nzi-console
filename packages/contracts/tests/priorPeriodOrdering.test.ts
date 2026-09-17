import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReportingChain } from "../src/index";

/**
 * "Earlier than this job" is a question about time, not about which number is smaller (NZC-098).
 *
 * The assurance chain selected prior years with `year < currentYear`. A reporting year is a label:
 * the start-year convention names a period by the year it begins and the end-year convention by
 * the year it ends, so for a client with any period irregularity the label and the calendar
 * disagree — and comparing labels then produces a chain that is wrong in the worst direction, by
 * showing a client a "prior year" that is not prior, or hiding one that is.
 *
 * Every case below pairs the irregular client with the regular one. A fix that orders the awkward
 * client correctly by disturbing the ordinary client is not a fix, and the paired assertion is what
 * says so.
 */

const snap = (year: number, from: string, to: string) => ({
  year, snapshotId: `snap-${year}-${from}`, dataHash: `sha256:${"a".repeat(64)}`,
  period: { from, to },
});
const chain = (over: Partial<Parameters<typeof buildReportingChain>[0]>) => buildReportingChain({
  jobId: "job-current", clientId: "client-a", currentYear: 2026, baselineYear: null,
  priorSnapshots: [], currentSnapshot: null, ...over,
});
const priors = (result: ReturnType<typeof buildReportingChain>) =>
  result.entries.filter((entry) => entry.kind === "prior").map((entry) => entry.year);

describe("a prior year is one whose period ended before this period started", () => {
  it("includes a genuinely earlier period that the label hid", () => {
    // Where the two conventions meet, on one September-year-end client.
    //
    //   current job (legacy, start-year label)  01/10/2025 – 30/09/2026   labelled 2025
    //   prior job   (new, end-year label)       01/10/2024 – 30/09/2025   labelled 2025
    //
    // Adjacent, non-overlapping, and plainly one after the other — but `2025 < 2025` is false, so
    // the old comparison dropped the immediately preceding year out of the assurance trend. The
    // client sees no prior year at all, and nothing reports that one was omitted.
    const result = chain({
      currentYear: 2025,
      currentPeriod: { from: "2025-10-01", to: "2026-09-30" },
      priorSnapshots: [snap(2025, "2024-10-01", "2025-09-30")],
    });
    assert.deepEqual(priors(result), [2025], "its period ended the day before this one started");
  });

  it("excludes a job whose label is smaller but whose period is not earlier", () => {
    // The same error in the other direction: a label of 2025 on a period that overlaps the current
    // one. Smaller number, not a prior year.
    const result = chain({
      currentYear: 2026,
      currentPeriod: { from: "2025-10-01", to: "2026-09-30" },
      priorSnapshots: [snap(2025, "2026-01-01", "2026-12-31")],
    });
    assert.deepEqual(priors(result), [], "an overlapping period is not a prior year, whatever it is called");
  });

  it("is unchanged for a client with one calendar year per job", () => {
    // The regular case, and the one that must not move: labels and periods agree, so both
    // comparisons select the same three years in the same order.
    const result = chain({
      currentYear: 2026,
      currentPeriod: { from: "2026-01-01", to: "2026-12-31" },
      priorSnapshots: [
        snap(2023, "2023-01-01", "2023-12-31"),
        snap(2024, "2024-01-01", "2024-12-31"),
        snap(2025, "2025-01-01", "2025-12-31"),
      ],
    });
    assert.deepEqual(priors(result), [2023, 2024, 2025], "oldest first, all three, exactly as before");
  });

  it("falls back to the label when a job records no period", () => {
    // Every job created before the period columns existed. The label is all such a job has, and
    // comparing it is what the chain always did.
    const result = chain({
      currentYear: 2026,
      currentPeriod: null,
      priorSnapshots: [
        { year: 2024, snapshotId: "s24", dataHash: "h", period: null },
        { year: 2027, snapshotId: "s27", dataHash: "h", period: null },
      ],
    });
    assert.deepEqual(priors(result), [2024], "2027 is not prior to 2026 by the only measure available");
  });

  it("orders priors oldest-first by period end, not by label", () => {
    // Display order. Two periods whose labels sort the opposite way to their dates.
    const result = chain({
      currentYear: 2027,
      currentPeriod: { from: "2026-10-01", to: "2027-09-30" },
      priorSnapshots: [
        snap(2026, "2025-10-01", "2026-09-30"),
        snap(2025, "2024-10-01", "2025-09-30"),
      ],
    });
    assert.deepEqual(priors(result), [2025, 2026], "oldest period first");
  });

  it("keeps at most the three most recent priors, chosen by period", () => {
    const result = chain({
      currentYear: 2027,
      currentPeriod: { from: "2026-10-01", to: "2027-09-30" },
      priorSnapshots: [
        snap(2023, "2022-10-01", "2023-09-30"),
        snap(2024, "2023-10-01", "2024-09-30"),
        snap(2025, "2024-10-01", "2025-09-30"),
        snap(2026, "2025-10-01", "2026-09-30"),
      ],
    });
    assert.deepEqual(priors(result), [2024, 2025, 2026], "the three most recent by period, oldest first");
  });
});

describe("the baseline is compared by period too", () => {
  it("keeps a period starting after the baseline even when its label does not", () => {
    // A March year end against a December baseline: 01/04/2023–31/03/2024 is labelled 2023, which
    // is not greater than a baseline year of 2023 — so the label excluded a period that starts
    // fifteen months after the baseline ended.
    const result = chain({
      currentYear: 2026,
      currentPeriod: { from: "2025-04-01", to: "2026-03-31" },
      baselineYear: 2023,
      baselinePeriodEnd: "2022-12-31",
      priorSnapshots: [snap(2023, "2023-04-01", "2024-03-31")],
    });
    assert.deepEqual(priors(result), [2023]);
  });

  it("still refuses a period that starts before the baseline ends", () => {
    const result = chain({
      currentYear: 2026,
      currentPeriod: { from: "2025-04-01", to: "2026-03-31" },
      baselineYear: 2023,
      baselinePeriodEnd: "2022-12-31",
      priorSnapshots: [snap(2023, "2022-04-01", "2023-03-31")],
    });
    assert.deepEqual(priors(result), []);
  });

  it("is unchanged for a calendar-year client with a calendar-year baseline", () => {
    const result = chain({
      currentYear: 2026,
      currentPeriod: { from: "2026-01-01", to: "2026-12-31" },
      baselineYear: 2023,
      baselinePeriodEnd: "2023-12-31",
      priorSnapshots: [
        snap(2023, "2023-01-01", "2023-12-31"),
        snap(2024, "2024-01-01", "2024-12-31"),
        snap(2025, "2025-01-01", "2025-12-31"),
      ],
    });
    assert.deepEqual(priors(result), [2024, 2025], "the baseline year itself is not a prior");
  });
});

describe("two periods under one label reach the chain intact", () => {
  it("does not collapse them into one entry", () => {
    // The chain builder keyed its own map by year. The query feeding it separates periods
    // (NZC-096), so a year-keyed map here would have put one straight back on top of the other —
    // undoing that fix one function downstream.
    const result = chain({
      currentYear: 2027,
      currentPeriod: { from: "2026-10-01", to: "2027-09-30" },
      priorSnapshots: [
        snap(2025, "2024-10-01", "2025-09-30"),
        snap(2025, "2025-10-01", "2026-09-30"),
      ],
    });
    assert.equal(priors(result).length, 2, "two periods, two entries, whatever they are labelled");
  });

  it("keeps each period distinct however many snapshots share the label", () => {
    // The tripwire proper. The query feeding this does DISTINCT ON (period) — it hands over one
    // snapshot per period, already separated. Anything here that groups by year silently rejoins
    // them, and the loss is invisible downstream because the chain simply has fewer entries than
    // the client has years. Three periods sharing two labels must come back as three.
    const result = chain({
      currentYear: 2028,
      currentPeriod: { from: "2027-10-01", to: "2028-09-30" },
      priorSnapshots: [
        snap(2025, "2024-10-01", "2025-09-30"),
        snap(2025, "2025-10-01", "2026-09-30"),
        snap(2026, "2026-10-01", "2027-09-30"),
      ],
      priorYearCount: 5,
    });
    assert.equal(priors(result).length, 3, "three periods in, three periods out");
    // Each keeps its own snapshot too: a year-keyed map would not only drop one, it would leave
    // the surviving entry carrying evidence belonging to a different period.
    const ids = result.entries.filter((entry) => entry.kind === "prior").map((entry) => entry.snapshotId);
    assert.equal(new Set(ids).size, 3, "three distinct snapshots, one per period");
  });

  it("still collapses two snapshots of the same period to one entry", () => {
    // The other half, so "keep everything" is not mistaken for the rule. One period is one entry
    // however many times it was snapshotted.
    const result = chain({
      currentYear: 2027,
      currentPeriod: { from: "2026-10-01", to: "2027-09-30" },
      priorSnapshots: [
        snap(2025, "2024-10-01", "2025-09-30"),
        snap(2025, "2024-10-01", "2025-09-30"),
      ],
    });
    assert.equal(priors(result).length, 1, "one period, one entry");
  });
});
