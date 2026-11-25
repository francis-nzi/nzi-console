import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { v7BehindLine, v7DriftOf, v7DriftPublishIssue, v7FiguresJobTotalsIssue, V7_FIGURES_CONTRACT } from "../src/v7ImportDrift";

/** The drift guard's rules (BRIEF-v7-import-j000663 Part C; CONTRACT-v7-import-figures v1; ruled 25 Nov). */
const REPLY = {
  contract: V7_FIGURES_CONTRACT, job_id: 663, job_number: "J000663", computed_at: "2026-11-25T14:02:11Z", period: { from: "2025-04-01", to: "2026-03-31" },
  scope_totals: { scope_1: 93.83, scope_2: 2121.17, scope_3: 21839.06, total: 24054.11 }, counted_rows: 180, rows_updated_at: "2026-11-24T16:40:02Z",
};

describe("the contract check on V7's job totals: exactly v1, or refused", () => {
  it("accepts the contract's own example", () => assert.equal(v7FiguresJobTotalsIssue(REPLY, "J000663"), null));
  it("refuses an extra field, a missing one, another job, another version and a non-number total — naming the field", () => {
    assert.equal(v7FiguresJobTotalsIssue({ ...REPLY, client_name: "x" }, "J000663"), "fields");
    const { counted_rows: _gone, ...missing } = REPLY;
    assert.equal(v7FiguresJobTotalsIssue(missing, "J000663"), "fields");
    assert.equal(v7FiguresJobTotalsIssue(REPLY, "J000664"), "job_number");
    assert.equal(v7FiguresJobTotalsIssue({ ...REPLY, contract: "v7-import-figures/2" }, "J000663"), "contract");
    assert.equal(v7FiguresJobTotalsIssue({ ...REPLY, scope_totals: { ...REPLY.scope_totals, scope_2: "2121.17" } }, "J000663"), "scope_totals");
    assert.equal(v7FiguresJobTotalsIssue({ ...REPLY, scope_totals: { ...REPLY.scope_totals, scope_4: 1 } }, "J000663"), "scope_totals");
    assert.equal(v7FiguresJobTotalsIssue(null, "J000663"), "fields");
    assert.equal(v7FiguresJobTotalsIssue([REPLY], "J000663"), "fields");
  });
});

describe("the drift rule: more than 0.1 t apart in any scope is behind", () => {
  it("J000663 as the brief found it: behind on every scope, Scope 3 the furthest", () => {
    const drift = v7DriftOf({ "1": 80.3, "2": 77.1, "3": 13003.8 }, { "1": 93.83, "2": 2121.17, "3": 21839.06 });
    assert.deepEqual([drift.outcome, drift.behind, drift.maxDifference], ["behind", ["1", "2", "3"], 8835.26]);
    assert.equal(drift.scopes[1]!.difference, -2044.07, "console − V7");
  });
  it("0.1 t exactly is level; just over is behind", () => {
    assert.equal(v7DriftOf({ "1": 10.1, "2": 0, "3": 0 }, { "1": 10, "2": 0, "3": 0 }).outcome, "level");
    assert.deepEqual(v7DriftOf({ "1": 10.1001, "2": 0, "3": 0 }, { "1": 10, "2": 0, "3": 0 }).behind, ["1"]);
  });
  it("the banner's line, in the brief's words — only the scopes behind", () => {
    const drift = v7DriftOf({ "1": 93.8, "2": 77.1, "3": 21839.06 }, { "1": 93.83, "2": 2121.17, "3": 21839.06 });
    assert.equal(v7BehindLine(drift.scopes), "Behind the previous system: Scope 2 77.1 here, 2,121.2 in the previous system");
  });
});

describe("the publish gate (ruled 25 Nov)", () => {
  const at = "2026-11-25T14:02:11Z";
  const behind = { outcome: "behind" as const, scopes: v7DriftOf({ "1": 0, "2": 77.1, "3": 0 }, { "1": 0, "2": 2121.17, "3": 0 }).scopes, checkedAt: at };
  const level = { outcome: "level" as const, scopes: v7DriftOf({ "1": 1, "2": 1, "3": 1 }, { "1": 1, "2": 1, "3": 1 }).scopes, checkedAt: at };
  const unknown = { outcome: "unknown" as const, scopes: null, checkedAt: at };
  it("a job behind is refused, named by scope", () => {
    const issue = v7DriftPublishIssue({ imported: true, spansTwoYears: false }, behind);
    assert.equal(issue?.code, "BEHIND_PREVIOUS_SYSTEM");
    assert.match(issue!.message, /Scope 2 77\.1 here, 2,121\.2 in the previous system/);
  });
  it("a one-year job: unknown and never checked are allowed (with the banner); level is allowed", () => {
    for (const latest of [unknown, null, level]) assert.equal(v7DriftPublishIssue({ imported: true, spansTwoYears: false }, latest), null);
  });
  it("a two-dataset-year job: refused unless the latest check says level", () => {
    for (const latest of [unknown, null]) assert.equal(v7DriftPublishIssue({ imported: true, spansTwoYears: true }, latest)?.code, "NOT_CHECKED_AGAINST_PREVIOUS_SYSTEM");
    assert.equal(v7DriftPublishIssue({ imported: true, spansTwoYears: true }, behind)?.code, "BEHIND_PREVIOUS_SYSTEM");
    assert.equal(v7DriftPublishIssue({ imported: true, spansTwoYears: true }, level), null);
  });
  it("a job not imported from the previous system is never gated", () => {
    for (const latest of [behind, unknown, null]) assert.equal(v7DriftPublishIssue({ imported: false, spansTwoYears: true }, latest), null);
  });
});
