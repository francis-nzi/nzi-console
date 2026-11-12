import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { v7ImportIngestIssues, v7ImportRehearsalRecordIssues, type V7ImportRehearsalRecord } from "../src/index";

/** The import workbench, Phase 3: what the console keeps of a rehearsal is closed, and an ingest names what the operator saw. */
const totals = { "1": { v7Tco2e: 0.34, liveTco2e: 0.34 }, "2": { v7Tco2e: 0, liveTco2e: 0 }, "3": { v7Tco2e: 0.0015, liveTco2e: 0.0015 } };
const WOULD: V7ImportRehearsalRecord = { sessionId: "v7-import-00000000-0000-0000-0000-000000000000", extractSha256: "e".repeat(64), decisionsSha256: "a".repeat(64),
  planSha256: "b".repeat(64), outcome: "would-commit", refusedStage: null, refusalCodes: [],
  counts: { resync: { unchanged: 1, superseded: 1, added: 1, withdrawn: 1 }, plan: { committed: 2, decided: 1 } }, scopeTotals: totals };
const REFUSED: V7ImportRehearsalRecord = { ...WOULD, outcome: "refused", refusedStage: "reingest", refusalCodes: ["PLAN_QUANTITY_MISMATCH"], scopeTotals: null };
const codes = (rehearsal: unknown) => v7ImportRehearsalRecordIssues({ jobId: "job-1", rehearsal: rehearsal as V7ImportRehearsalRecord }).map((issue) => issue.code);

describe("import.rehearsal.record — a rehearsal, closed", () => {
  it("accepts one that would commit with Σ per scope, and one refused by its step and codes", () => {
    assert.deepEqual(codes(WOULD), []);
    assert.deepEqual(codes(REFUSED), []);
  });
  it("refuses anything beyond the closed shape — named by key, never by value", () => {
    const issues = v7ImportRehearsalRecordIssues({ jobId: "job-1", rehearsal: { ...WOULD, message: "site Acme Depot is archived" } as never });
    assert.deepEqual(issues.map((issue) => issue.code), ["UNKNOWN_FIELD"]);
    assert.ok(!JSON.stringify(issues).includes("Acme"));
  });
  it("keeps a refusal to its codes, and its totals to an outcome that reconciled", () => {
    assert.deepEqual(codes({ ...REFUSED, refusalCodes: ["site Acme is archived"] }), ["INVALID"], "a code, never a message");
    assert.deepEqual(codes({ ...REFUSED, scopeTotals: totals }), ["INVALID"], "a refused rehearsal has no reconciliation");
    assert.deepEqual(codes({ ...WOULD, scopeTotals: null }), ["INVALID"]);
    assert.deepEqual(codes({ ...WOULD, refusedStage: "reingest" }), ["INVALID"]);
    assert.deepEqual(codes({ ...REFUSED, refusedStage: "somewhere" }), ["INVALID"]);
    assert.deepEqual(codes({ ...WOULD, counts: { ...WOULD.counts, resync: { ...WOULD.counts.resync!, superseded: -1 } } }), ["INVALID"]);
  });
});

describe("import.ingest — the input names the job, its summary, the extract and the decisions", () => {
  const input = { jobId: "job-1", sessionId: WOULD.sessionId, extractSha256: "e".repeat(64), decisionsSha256: "a".repeat(64) };
  it("accepts it, and refuses extra keys — the extract's rows never travel in the input", () => {
    assert.deepEqual(v7ImportIngestIssues(input), []);
    assert.deepEqual(v7ImportIngestIssues({ ...input, rows: [] } as never).map((issue) => issue.code), ["UNKNOWN_FIELD"]);
    assert.deepEqual(v7ImportIngestIssues({ ...input, extractSha256: "x" }).map((issue) => issue.code), ["BAD_EXTRACT_SHA256"]);
  });
});
