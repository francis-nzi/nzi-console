import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jobDateIssues, plausibleYearRange, reportingYearForPeriod, validateCommand, commandGrantForRole } from "../src/index";

/**
 * The four dates a job carries (Part 1, Task E) and the year derived from two of them.
 *
 * The bug this closes is on record: a job on live starts in the year 98655, because a native date
 * input accepts whatever year its user types and nothing downstream disagreed. So the checks live
 * in one exported function that the browser calls for courtesy and the command calls for real.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ok = {
  startDate: "2026-01-05", dueDate: "2026-11-30",
  reportingPeriodStart: "2025-04-01", reportingPeriodEnd: "2026-03-31",
};
const fields = (issues: { field: string }[]) => issues.map((issue) => issue.field).sort();
const codes = (issues: { code: string }[]) => issues.map((issue) => issue.code);

describe("a job's dates must be plausible, complete and ordered", () => {
  it("accepts a sensible set", () => {
    assert.deepEqual(jobDateIssues(ok, new Date("2026-06-01T00:00:00Z")), []);
  });

  it("requires all four, naming each one", () => {
    assert.deepEqual(fields(jobDateIssues({}, new Date("2026-06-01T00:00:00Z"))),
      ["dueDate", "reportingPeriodEnd", "reportingPeriodStart", "startDate"]);
  });

  it("refuses the year that got through on live", () => {
    // 98655-11-22 parses as a real date. It is the five digits that give it away.
    const issues = jobDateIssues({ ...ok, startDate: "98655-11-22" }, new Date("2026-06-01T00:00:00Z"));
    assert.deepEqual(fields(issues), ["startDate"]);
    assert.deepEqual(codes(issues), ["INVALID"]);
  });

  it("floors at 2000 and ceilings five years ahead of today", () => {
    const today = new Date("2026-06-01T00:00:00Z");
    assert.deepEqual(plausibleYearRange(today), { min: 2000, max: 2031 });
    assert.deepEqual(codes(jobDateIssues({ ...ok, startDate: "1999-12-31" }, today)), ["IMPLAUSIBLE_YEAR"]);
    assert.deepEqual(jobDateIssues({ ...ok, startDate: "2000-01-01", dueDate: "2000-06-01" }, today), []);
    assert.deepEqual(codes(jobDateIssues({ ...ok, dueDate: "2032-01-01" }, today)), ["IMPLAUSIBLE_YEAR"]);
  });

  it("computes the ceiling from today rather than carrying a written-down year", () => {
    // A hardcoded bound is correct until the January it silently starts refusing next year's work.
    assert.equal(plausibleYearRange(new Date("2031-02-02T00:00:00Z")).max, 2036);
    assert.notEqual(plausibleYearRange(new Date("2031-02-02T00:00:00Z")).max,
      plausibleYearRange(new Date("2026-02-02T00:00:00Z")).max);
    const source = readFileSync(join(ROOT, "packages/contracts/src/jobDates.ts"), "utf8");
    assert.ok(source.includes("getUTCFullYear() + PLAUSIBLE_YEARS_AHEAD"), "the ceiling is computed");
  });

  it("refuses a job and a period that end before they start, and an instant one", () => {
    const today = new Date("2026-06-01T00:00:00Z");
    assert.deepEqual(fields(jobDateIssues({ ...ok, dueDate: "2026-01-04" }, today)), ["dueDate"]);
    assert.deepEqual(fields(jobDateIssues({ ...ok, reportingPeriodEnd: "2025-03-31" }, today)), ["reportingPeriodEnd"]);
    assert.deepEqual(codes(jobDateIssues({ ...ok, dueDate: ok.startDate }, today)), ["INVALID_RANGE"]);
  });

  it("does not complain twice about one mistake", () => {
    // An unparseable end date is one problem. Reporting that it is also out of order would be the
    // form inventing a second fault from the same keystroke.
    const issues = jobDateIssues({ ...ok, dueDate: "not-a-date" }, new Date("2026-06-01T00:00:00Z"));
    assert.deepEqual(codes(issues), ["INVALID"]);
  });

  it("speaks dd/mm/yyyy, because that is the format on screen (NZC-040)", () => {
    const issues = jobDateIssues({ ...ok, startDate: "5/1/2026" }, new Date("2026-06-01T00:00:00Z"));
    assert.ok(issues[0]!.message.includes("dd/mm/yyyy"));
    assert.ok(!issues[0]!.message.includes("yyyy-mm-dd"), "the wire format is not the consultant's problem");
  });
});

describe("the reporting year is the year the period ends", () => {
  it("labels by the end date, both ways round", () => {
    assert.equal(reportingYearForPeriod("2024-12-31"), 2024);
    assert.equal(reportingYearForPeriod("2025-03-31"), 2025);
  });

  it("is a different rule from reportingPeriodForYear, which it must never be used to invert", () => {
    // reportingPeriodForYear(2024, 3) is 01/04/2024–31/03/2025 and is labelled FY2024. Feeding its
    // end back through this yields 2025. Both are correct under their own rule; that is the point,
    // and why only new jobs use this one. The full statement of the gap lives in #210.
    assert.equal(reportingYearForPeriod("2025-03-31"), 2025);
    assert.notEqual(reportingYearForPeriod("2025-03-31"), 2024);
  });
});

describe("the command is the guard, not the form", () => {
  const context = { organisationId: "org-a", actorId: "a", grant: commandGrantForRole("consultant", "org-a", "a") };
  const base = { clientId: "c1", family: "crp" as const, title: "T", workflowStage: "Setup", owner: "A" };

  it("runs the same checks the browser ran", () => {
    const issues = validateCommand("job.create", { ...base, ...ok, startDate: "98655-11-22" }, context as never);
    assert.ok(issues.some((issue) => issue.field === "startDate" && issue.code === "INVALID"));
  });

  it("keeps no second copy of the date rules beside the shared one", () => {
    // Task E asks that every path editing these dates validate them. Today createJob is the only
    // writer — there is no job edit command — so the guarantee is made by there being one
    // implementation: if a bespoke isoDate check on these fields reappears, two rules exist and
    // one of them will drift.
    //
    // Scoped to job.create's own definition, because `dueDate` is not exclusively a job's word:
    // srs.assessment.item.set carries one too, for when a client action is due, and it is right
    // that an SRS action is not held to a job's reporting window.
    const source = readFileSync(join(ROOT, "packages/contracts/src/commands.ts"), "utf8");
    const definition = source.split("\n").find((line) => line.includes(`"job.create": { key: "job.create"`));
    assert.ok(definition, "job.create's definition was not found — this test is checking nothing");
    for (const field of ["startDate", "dueDate", "reportingPeriodStart", "reportingPeriodEnd"]) {
      assert.ok(!definition.includes(`isoDate(input.${field})`),
        `${field} must be validated by jobDateIssues, not by a second bespoke check`);
    }
    assert.ok(definition.includes("jobDateIssues(input)"), "job.create delegates to the shared rules");
  });
});
