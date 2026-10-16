import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultReportRegisterQuery, filterReportRegister, filterReportRegisterExceptStage, parseReportRegisterQuery, REPORT_STAGES,
  reportEligibilityOf, reportLinkFor, reportRegisterQueryString, v7RecordLine, type ReportRegisterQuery, type ReportRegisterRow,
} from "../src/index";

/** Track A (RULING-reporting-trackA): the report link, eligibility and the register's filters — one rule for every surface. */
const row = (over: Partial<ReportRegisterRow> = {}): ReportRegisterRow => ({
  jobId: "j1", publishedVersionId: null, hasSnapshot: false, v7Record: false,
  jobNumber: "J000101", legacyJobNumber: null, clientId: "c1", client: "Acme Ltd", title: "Carbon Reduction Plan 2025",
  ownerUserId: "me", leadConsultant: "Jennie Davide", reportingYear: 2025, stage: "in-preparation", ...over,
});
const q = (over: Partial<ReportRegisterQuery> = {}): ReportRegisterQuery => ({ ...defaultReportRegisterQuery, ...over });
const STAGES = [...REPORT_STAGES, "v7-record"];

describe("A1: a job's report link follows its state — never an empty preview", () => {
  it("published → the composed report", () => {
    assert.deepEqual(reportLinkFor(row({ publishedVersionId: "rv 1", hasSnapshot: true })), { kind: "published", label: "View composed report", href: "/reports/rv%201" });
  });
  it("a reviewed snapshot → preparation", () => {
    assert.deepEqual(reportLinkFor(row({ hasSnapshot: true })), { kind: "prepare", label: "Prepare report", href: "/report-preview?jobId=j1" });
  });
  it("imported v7 → its record of account, with no link (the content is sealed, Q1 (b))", () => {
    assert.deepEqual(reportLinkFor(row({ v7Record: true })), { kind: "v7-record", label: "v7 record of account · awaiting re-compose", href: null });
  });
  it("nothing yet → add evidence on the job", () => {
    assert.deepEqual(reportLinkFor(row()), { kind: "add-evidence", label: "Add evidence", href: "/jobs/j1" });
  });
  it("re-composed history reads as its new state, not as v7 — the same control before and after", () => {
    assert.equal(reportLinkFor(row({ v7Record: true, hasSnapshot: true })).kind, "prepare");
    assert.equal(reportLinkFor(row({ v7Record: true, publishedVersionId: "rv" })).kind, "published");
  });
  it("the one path: where the studio is on, \"Prepare report\" opens the Report Studio — and nothing else moves", () => {
    const studio = { studio: true };
    assert.deepEqual(reportLinkFor(row({ jobId: "j 1", hasSnapshot: true }), studio), { kind: "prepare", label: "Prepare report", href: "/jobs/j%201/report/printing" });
    for (const over of [{ publishedVersionId: "rv 1", hasSnapshot: true }, { v7Record: true }, {}]) {
      assert.deepEqual(reportLinkFor(row(over), studio), reportLinkFor(row(over)), JSON.stringify(over));
    }
    assert.deepEqual(reportLinkFor(row({ hasSnapshot: true }), { studio: false }), reportLinkFor(row({ hasSnapshot: true })), "off: exactly as before");
  });
});

describe("A3/A5: eligibility and the filters", () => {
  it("names each job's eligibility", () => {
    assert.equal(reportEligibilityOf(row({ hasSnapshot: true })), "compose-eligible");
    assert.equal(reportEligibilityOf(row({ v7Record: true })), "v7-awaiting");
    assert.equal(reportEligibilityOf(row()), "no-evidence");
  });

  const rows = [
    row({ jobId: "mine-native", hasSnapshot: true }),
    row({ jobId: "mine-v7", v7Record: true, stage: "v7-record", legacyJobNumber: "J000663", reportingYear: 2024 }),
    row({ jobId: "theirs", ownerUserId: "someone", clientId: "c2", client: "Beta plc", leadConsultant: "Sam Kerr", stage: "awaiting-review" }),
  ];
  const ids = (query: ReportRegisterQuery, viewer: string | null = "me") => filterReportRegister(rows, query, viewer).map((r) => r.jobId);

  it("defaults to My clients (the client owner), and All shows the rest", () => {
    assert.equal(defaultReportRegisterQuery.whose, "mine");
    assert.deepEqual(ids(q()), ["mine-native", "mine-v7"]);
    assert.deepEqual(ids(q({ whose: "all" })), ["mine-native", "mine-v7", "theirs"]);
    assert.deepEqual(ids(q(), null), [], "My clients with no known viewer shows none — the view falls back to All and says so");
  });

  it("imported jobs are badged, never hidden — only an explicit eligibility filter narrows them", () => {
    assert.ok(ids(q({ whose: "all" })).includes("mine-v7"));
    assert.deepEqual(ids(q({ whose: "all", eligibility: "v7-awaiting" })), ["mine-v7"]);
    assert.deepEqual(ids(q({ whose: "all", eligibility: "compose-eligible" })), ["mine-native"]);
  });

  it("filters by client, lead consultant, stage and year", () => {
    assert.deepEqual(ids(q({ whose: "all", clientId: "c2" })), ["theirs"]);
    assert.deepEqual(ids(q({ whose: "all", leadConsultant: "Sam Kerr" })), ["theirs"]);
    assert.deepEqual(ids(q({ whose: "all", stage: "v7-record" })), ["mine-v7"]);
    assert.deepEqual(ids(q({ whose: "all", year: 2024 })), ["mine-v7"]);
  });

  it("searches job number, v7 number, client and plan title, case-insensitively", () => {
    assert.deepEqual(ids(q({ whose: "all", search: "j000663" })), ["mine-v7"], "the v7 number");
    assert.deepEqual(ids(q({ whose: "all", search: "beta" })), ["theirs"]);
    assert.equal(ids(q({ whose: "all", search: "reduction plan" })).length, 3);
  });

  it("the stage counters count over every other filter, not over everything", () => {
    const scoped = filterReportRegisterExceptStage(rows, q({ stage: "awaiting-review" }), "me");
    assert.deepEqual(scoped.map((r) => r.jobId), ["mine-native", "mine-v7"], "My clients still applies; the stage does not");
  });
});

describe("A3: the filter lives in the URL", () => {
  it("round-trips, and the default view has a clean address", () => {
    assert.equal(reportRegisterQueryString(defaultReportRegisterQuery), "");
    const query = q({ whose: "all", clientId: "c 2", leadConsultant: "Sam Kerr", stage: "awaiting-review", year: 2024, eligibility: "v7-awaiting", search: "acme" });
    assert.deepEqual(parseReportRegisterQuery(new URLSearchParams(reportRegisterQueryString(query).slice(1)), STAGES), query);
  });
  it("reads anything unrecognised as the default, never as an error", () => {
    assert.deepEqual(parseReportRegisterQuery(new URLSearchParams("stage=nonsense&year=abc&eligibility=x&whose=x"), STAGES), defaultReportRegisterQuery);
  });
});

describe("Q1 (b): the v7 record of account, from its unsealed metadata", () => {
  it("says what there is — version, status, finalised date — and never offers to open it", () => {
    assert.equal(v7RecordLine({ version: 2, status: "final", finalisedAt: "2025-03-31T10:00:00.000Z", dataHash: "abc" }), "Record of account: NZ Insights Pro v7 report, version 2 · final · finalised 2025-03-31.");
    assert.equal(v7RecordLine(null), "Record of account: imported from NZ Insights Pro v7 (no v7 report version was issued for it).");
    assert.doesNotMatch(v7RecordLine({ version: 1, status: "draft", finalisedAt: null, dataHash: null }), /open|view/i);
  });
});
