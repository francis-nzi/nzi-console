import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  v7FiguresRowKey, v7FiguresRowsIssue, v7FiguresScope, v7ImportPeriodIssue, v7MatchCandidate, v7SpanningReconcile, v7SpanningRefusal, V7_FIGURES_CONTRACT,
  V7_RECONCILE_ROWS_NAMED,
} from "../src/index";

/**
 * Datasets Part 2, increment 2: the previous system's own row figures (CONTRACT-v7-import-figures endpoint 2), and the rule a spanning
 * job is brought in by — within 0.1 t of them in every scope, or refused with the rows named.
 */
const ROW = { row_id: 9278, scope: "Scope 2", enabled: true, tco2e: 15.30668112, blended: true, custom_factor: false, spans: [
  { from: "2025-04", to: "2025-12", dataset_id: 1, dataset_year: 2025, factor: 0.177, ghg_unit: "kgCO2e", tco2e: 9.679068 },
  { from: "2026-01", to: "2026-03", dataset_id: 69, dataset_year: 2026, factor: 0.13096, ghg_unit: "kgCO2e", tco2e: 5.62761312 }] };
const REPLY = { contract: V7_FIGURES_CONTRACT, job_id: 256, computed_at: "2026-11-26T10:00:00Z", rows: [ROW] };
const ZERO = { "1": 0, "2": 0, "3": 0 };

describe("endpoint 2's contract check: exactly v1, for the job asked", () => {
  it("a v1 reply passes; a register source's id is `source:<id>`; a custom factor's span has no dataset", () => {
    assert.equal(v7FiguresRowsIssue(REPLY, 256), null);
    assert.equal(v7FiguresRowsIssue({ ...REPLY, rows: [{ ...ROW, row_id: "source:12", spans: [{ ...ROW.spans[0], dataset_id: null, from: null, to: null }] }] }, 256), null);
  });
  it("refused, by the field: another job, a missing or extra field, a mistyped value, a row with no span", () => {
    assert.equal(v7FiguresRowsIssue({ ...REPLY, job_id: 265 }, 256), "job_id");
    assert.equal(v7FiguresRowsIssue({ ...REPLY, contract: "v7-import-figures/2" }, 256), "contract");
    assert.equal(v7FiguresRowsIssue({ ...REPLY, job_number: "J000265" }, 256), "fields");
    assert.equal(v7FiguresRowsIssue({ ...REPLY, rows: [{ ...ROW, label: "UK electricity" }] }, 256), "rows.fields");
    assert.equal(v7FiguresRowsIssue({ ...REPLY, rows: [{ ...ROW, row_id: "9278" }] }, 256), "rows.row_id");
    assert.equal(v7FiguresRowsIssue({ ...REPLY, rows: [{ ...ROW, spans: [] }] }, 256), "rows.spans");
    assert.equal(v7FiguresRowsIssue({ ...REPLY, rows: [{ ...ROW, spans: [{ ...ROW.spans[0], from: "2025-13" }] }] }, 256), "rows.spans.value");
  });
  it("its keys and scopes, as the console reads them", () => {
    assert.deepEqual([v7FiguresRowKey(ROW), v7FiguresRowKey({ row_id: "source:12" })], ["9278", "source:12"]);
    assert.deepEqual(["Scope 1", "scope 3", "Unknown"].map(v7FiguresScope), ["1", "3", null]);
  });
});

describe("the reconcile: within 0.1 t of the previous system's own in every scope; the rows that differ named, with why", () => {
  it("level in every scope reconciles; a scope more than 0.1 t apart does not", () => {
    const level = v7SpanningReconcile([{ legacyDbId: "9278", scope: "2", console: 15.306681, previous: 15.30668112, reason: null }],
      { console: { ...ZERO, "2": 15.36 }, previous: { ...ZERO, "2": 15.30668112 } });
    assert.deepEqual([level.reconciles, level.rows], [true, []]);
    const off = v7SpanningReconcile([{ legacyDbId: "9278", scope: "2", console: 17.285112, previous: 15.30668112, reason: "dataset-not-on-job", detail: "DESNZ GB 2026" }],
      { console: { ...ZERO, "2": 17.285112 }, previous: { ...ZERO, "2": 15.30668112 } });
    assert.equal(off.reconciles, false);
    assert.deepEqual(off.rows.map((row) => [row.legacyDbId, row.reason]), [["9278", "dataset-not-on-job"]]);
  });
  it("the refusal: SPANS_TWO_DATASET_YEARS, the scopes apart, then each row with its reason — tCO₂e to 1 dp, ids, no label", () => {
    const off = v7SpanningReconcile([
      { legacyDbId: "9278", scope: "2", console: 17.285112, previous: 15.30668112, reason: "dataset-not-on-job", detail: "DESNZ GB 2026" },
      { legacyDbId: "9301", scope: "1", console: 1.8, previous: null, reason: null },
      { legacyDbId: "9302", scope: "1", console: null, previous: 1.8, reason: null }],
    { console: { ...ZERO, "2": 17.285112 }, previous: { ...ZERO, "2": 15.30668112 } });
    assert.deepEqual(v7SpanningRefusal(off).map((issue) => [issue.field, issue.code, issue.message]), [
      ["jobId", "SPANS_TWO_DATASET_YEARS", "This job spans two dataset years, and its figures don't match the previous system's own: Scope 2 17.3 here, 15.3 there. Nothing was written."],
      ["rows.9278", "SPANS_TWO_DATASET_YEARS", "Row 9278 (Scope 2): 17.3 here, 15.3 there — a dataset the previous system priced it from is not on the job (DESNZ GB 2026)."],
      ["rows.9301", "SPANS_TWO_DATASET_YEARS", "Row 9301 (Scope 1): 1.8 here, none in the previous system — the previous system's row changed since it was read."],
      ["rows.9302", "SPANS_TWO_DATASET_YEARS", "Row 9302 (Scope 1): not brought in, 1.8 there — the previous system's row changed since it was read."]]);
  });
  it("at most twenty rows are named; the rest are counted", () => {
    const many = Array.from({ length: 23 }, (_, at) => ({ legacyDbId: String(at), scope: "3" as const, console: 1, previous: 2, reason: null }));
    const refusal = v7SpanningRefusal(v7SpanningReconcile(many, { console: { ...ZERO, "3": 23 }, previous: { ...ZERO, "3": 46 } }));
    assert.equal(refusal.length, 1 + V7_RECONCILE_ROWS_NAMED + 1);
    assert.equal(refusal.at(-1)!.message, "…and 3 more rows.");
  });
  it("the period's own rule is unchanged: no period refused, two years flagged for the reconcile, one year clear", () => {
    assert.equal(v7ImportPeriodIssue({ from: null, to: null })?.code, "NO_REPORTING_PERIOD");
    assert.equal(v7ImportPeriodIssue({ from: "2025-04-01", to: "2026-03-31" })?.code, "SPANS_TWO_DATASET_YEARS");
    assert.equal(v7ImportPeriodIssue({ from: "2024-01-01", to: "2024-12-31" }), null);
  });
});

describe("the matcher, with a row priced by month", () => {
  it("the priced figure stands in for quantity × rate; a null one is no figure; absent, the single product as before", () => {
    const row = { scope: "2" as const, quantity: 97_656, applyPct: 100, previousTco2e: 15.30668112, categories: ["2.purchased-electricity"] };
    const factor = { rate: 0.177, scopes: ["2"], categories: ["2.purchased-electricity"], sameUnit: true };
    assert.deepEqual([v7MatchCandidate(row, { ...factor, priced: 15.306681 }, []).tco2e, v7MatchCandidate(row, { ...factor, priced: 15.306681 }, []).verdict], [15.306681, "reproduces"]);
    assert.equal(v7MatchCandidate(row, { ...factor, priced: null }, []).verdict, "no-figure");
    assert.deepEqual([v7MatchCandidate(row, factor, []).tco2e, v7MatchCandidate(row, factor, []).verdict], [17.285112, "differs"]);
  });
});
