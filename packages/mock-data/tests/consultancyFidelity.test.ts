import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  consultancyBudgetState,
  consultancyCompletionBlockers,
  consultancyOverdueDeliverables,
  isAllowedDeliverableTransition,
} from "@nzi/contracts";
import {
  fixedScopeDeliverables,
  fixedScopeDetail,
  retainerOverBudgetDetail,
  retainerOverBudgetView,
} from "../src/consultancyFidelity";

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("Consultancy model fidelity", () => {
  it("survives a JSON round-trip as the contract types", () => {
    assert.deepEqual(roundTrip(fixedScopeDetail), fixedScopeDetail);
    assert.deepEqual(roundTrip(fixedScopeDeliverables), fixedScopeDeliverables);
    assert.deepEqual(roundTrip(retainerOverBudgetView), retainerOverBudgetView);
  });

  it("fixture 1 — a retainer can run past its hours budget", () => {
    const state = consultancyBudgetState(retainerOverBudgetDetail);
    assert.equal(state.overBudget, true);
    assert.equal(state.remainingHours, -16.5);
    assert.ok(state.usedPct! > 100);
  });

  it("fixture 2 — a delivered deliverable past its due date is flagged overdue and blocks completion", () => {
    const overdue = consultancyOverdueDeliverables(fixedScopeDeliverables, "2026-09-01");
    const ids = overdue.map((d) => d.id).sort();
    assert.deepEqual(ids, ["dlv-boardpack", "dlv-roadmap"]);
    const boardpack = fixedScopeDeliverables.find((d) => d.id === "dlv-boardpack")!;
    assert.equal(boardpack.status, "delivered");
    assert.equal(boardpack.acceptedAt, null);
  });

  it("fixture 3 — fixed scope: 2 accepted, 1 rejected in rework, completion blocked", () => {
    const byStatus = (s: string) => fixedScopeDeliverables.filter((d) => d.status === s).length;
    assert.equal(byStatus("accepted"), 2);
    assert.equal(byStatus("rejected"), 1);
    const rejected = fixedScopeDeliverables.find((d) => d.status === "rejected")!;
    assert.ok(rejected.reworkNote && rejected.reworkNote.length > 0, "rejected requires a rework note");

    const blockers = consultancyCompletionBlockers(fixedScopeDeliverables);
    assert.equal(blockers.length, 3); // delivered + rejected + planned
  });

  it("only legal deliverable transitions are permitted", () => {
    assert.ok(isAllowedDeliverableTransition("planned", "in_progress"));
    assert.ok(isAllowedDeliverableTransition("delivered", "accepted"));
    assert.ok(isAllowedDeliverableTransition("delivered", "rejected"));
    assert.ok(isAllowedDeliverableTransition("rejected", "in_progress"));
    assert.ok(!isAllowedDeliverableTransition("accepted", "rejected"));
    assert.ok(!isAllowedDeliverableTransition("planned", "accepted"));
  });

  it("an unbudgeted engagement never reads as over budget", () => {
    const state = consultancyBudgetState({ hoursBudget: null, hoursUsed: 40 });
    assert.deepEqual(state, { overBudget: false, remainingHours: null, usedPct: null });
  });
});
