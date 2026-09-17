// The financial year end drives each reporting year's period and the 300–400 day
// eligibility rule (NZC-067 / NZC-070).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandGrantForRole, isEligibleReportingYear, reportingPeriodDays, reportingPeriodForYear } from "@nzi/contracts";
import { createJob, reportingYearSnapshots } from "../src/index";
import { withAccess } from "./support/access";

type Call = { sql: string; values?: readonly unknown[] };
const context = { organisationId: "org-a", actorId: "consultant-a", principal: "staff" as const, idempotencyKey: "fye-job", correlationId: "corr-fye-job", grant: commandGrantForRole("consultant", "org-a", "consultant-a") };

function jobPool(calls: Call[], financialYearEndMonth: number | null) {
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("allocate_job_sequence")) return { rows: [{ sequence: 900 }] };
      if (sql.includes("INSERT INTO nzi_console.jobs")) return { rows: [{ job_number: "J000900" }] };
      if (sql.includes("SELECT financial_year_end_month FROM nzi_console.clients")) return { rows: [{ financial_year_end_month: financialYearEndMonth }] };
      return { rows: [] };
    },
    release() {},
  };
  return withAccess({ connect: async () => client } as never);
}

/**
 * NZC-070 asked that a reporting window be the client's financial year rather than 1 Jan–31 Dec.
 * It met that by reconstructing the window from the labelled year plus the client's
 * `financial_year_end_month`. Since NZC-092 the consultant enters the period itself, so the window
 * is **read, not inferred** — the same guarantee, reached without a guess.
 *
 * The two assertions below moved with the behaviour, deliberately. What they now pin is stronger:
 * the stored window is exactly what was entered, and the client's year-end month is not consulted
 * at all — so a job reporting on something other than the client's statutory year is expressible,
 * which the reconstruction could not do at any price.
 */
describe("the reporting window is the period the consultant entered", () => {
  it("stores a September-year-end client's own financial year, because that is what was entered", async () => {
    const calls: Call[] = [];
    await createJob(jobPool(calls, 9), { clientId: "client-a", family: "crp", title: "FY24 CRP", workflowStage: "Setup", owner: "Consultant A", startDate: "2025-10-01", dueDate: "2026-01-31", reportingPeriodStart: "2024-10-01", reportingPeriodEnd: "2025-09-30" }, context);
    const config = calls.find((call) => call.sql.includes("INSERT INTO nzi_console.job_emissions_config"))!;
    assert.deepEqual(config.values?.slice(2, 4), ["2024-10-01", "2025-09-30"]);
    assert.equal(isEligibleReportingYear("2024-10-01", "2025-09-30"), true);
  });

  it("no longer asks the client for a year-end month", async () => {
    // The reconstruction is gone rather than bypassed. If this query comes back, the window is
    // being guessed again and a non-statutory period would be silently overwritten.
    const calls: Call[] = [];
    await createJob(jobPool(calls, 9), { clientId: "client-a", family: "crp", title: "FY24 CRP", workflowStage: "Setup", owner: "Consultant A", startDate: "2025-10-01", dueDate: "2026-01-31", reportingPeriodStart: "2024-10-01", reportingPeriodEnd: "2025-09-30" }, { ...context, idempotencyKey: "fye-noquery" });
    assert.equal(calls.some((call) => call.sql.includes("SELECT financial_year_end_month")), false);
  });

  it("records a period that is not the client's financial year, rather than correcting it", async () => {
    // A part-year first engagement, or a transition period after a year-end change. The old
    // reconstruction could only ever produce the statutory year, so this case had no way to exist.
    const calls: Call[] = [];
    await createJob(jobPool(calls, 9), { clientId: "client-a", family: "crp", title: "Part-year", workflowStage: "Setup", owner: "Consultant A", startDate: "2025-01-05", dueDate: "2025-06-30", reportingPeriodStart: "2024-10-01", reportingPeriodEnd: "2025-03-31" }, { ...context, idempotencyKey: "fye-partial" });
    assert.deepEqual(calls.find((call) => call.sql.includes("INSERT INTO nzi_console.job_emissions_config"))!.values?.slice(2, 4), ["2024-10-01", "2025-03-31"]);
  });

  it("derives the reporting year from the period end, and never takes one from the caller", async () => {
    const calls: Call[] = [];
    await createJob(jobPool(calls, 3), { clientId: "client-a", family: "crp", title: "FY24 CRP", workflowStage: "Setup", owner: "Consultant A", startDate: "2024-04-01", dueDate: "2025-06-30", reportingPeriodStart: "2024-04-01", reportingPeriodEnd: "2025-03-31" }, { ...context, idempotencyKey: "fye-derived" });
    const insert = calls.find((call) => call.sql.includes("INSERT INTO nzi_console.jobs"))!;
    // A March year end: the start-year rule would have called this 2024, the end-year rule calls
    // it 2025. New jobs take the second; existing rows keep whatever they were stored with.
    assert.ok(insert.values?.includes(2025), `expected reporting_year 2025 in ${JSON.stringify(insert.values)}`);
    assert.equal(insert.values?.includes(2024), false, "the start-year label must not be written");
  });

  it("gives every year end an eligible (300–400 day) reporting year, leap years included", () => {
    for (const month of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) for (const year of [2023, 2024]) {
      const period = reportingPeriodForYear(year, month);
      assert.ok([365, 366].includes(reportingPeriodDays(period.from, period.to)), `${year}/${month}`);
      assert.equal(isEligibleReportingYear(period.from, period.to), true);
    }
  });
});

describe("reporting-year eligibility on the client workspace (NZC-067)", () => {
  const snapshot = (jobId: string, year: number, from: string | null, to: string | null, version = 1) => ({ job_id: jobId, snapshot_version: version, payload_json: { reportingYear: year }, reporting_from: from, reporting_to: to });

  it("lets only a 300–400 day job stand for a year, and never a stub or a multi-year job", () => {
    const rows = [
      snapshot("job-stub", 2025, "2025-04-01", "2025-05-15"),
      snapshot("job-fy24", 2024, "2024-04-01", "2025-03-31"),
      snapshot("job-multi", 2023, "2022-04-01", "2024-03-31"),
      snapshot("job-unknown", 2022, null, null),
    ];
    assert.deepEqual(reportingYearSnapshots(rows).map((row) => row.job_id), ["job-fy24"]);
  });

  it("prefers the latest period end, then the latest snapshot of that job", () => {
    const rows = [
      snapshot("job-a", 2024, "2024-01-01", "2024-12-31", 3),
      snapshot("job-b", 2024, "2024-04-01", "2025-03-31", 1),
      snapshot("job-b", 2024, "2024-04-01", "2025-03-31", 2),
      snapshot("job-c", 2023, "2023-04-01", "2024-03-31", 1),
    ];
    assert.deepEqual(reportingYearSnapshots(rows).map((row) => [row.job_id, row.snapshot_version]), [["job-b", 2], ["job-c", 1]]);
  });
});
