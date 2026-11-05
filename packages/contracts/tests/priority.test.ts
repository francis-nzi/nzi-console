import assert from "node:assert/strict";
import test from "node:test";
import { comparePriority, isPriority, PRIORITIES, priorityLabels, priorityRank, type Priority } from "../src/priority";
import { commandDefinitions } from "../src/commands";

/** The one priority vocabulary (RULING-srs-assessment-priority-vocabulary.md): three values, ordered, labelled. */

test("the vocabulary is exactly high, medium and low — highest first", () => {
  assert.deepEqual([...PRIORITIES], ["high", "medium", "low"]);
  assert.deepEqual(PRIORITIES.map((p) => priorityLabels[p]), ["High", "Medium", "Low"]);
});

test("isPriority accepts only the three values", () => {
  for (const ok of PRIORITIES) assert.ok(isPriority(ok));
  for (const bad of ["High", "urgent", "", null, undefined, 1]) assert.ok(!isPriority(bad), String(bad));
});

test("sorts high before medium before low before unset", () => {
  const mixed: Array<Priority | null> = [null, "low", "high", "medium", null, "high"];
  assert.deepEqual([...mixed].sort(comparePriority), ["high", "high", "medium", "low", null, null]);
  assert.ok(priorityRank("high") < priorityRank("medium") && priorityRank("medium") < priorityRank("low") && priorityRank("low") < priorityRank(null));
});

test("srs.assessment.item.set accepts a priority from the vocabulary and refuses any other", () => {
  const context = { organisationId: "o", actorId: "a", principal: "staff", idempotencyKey: "k", correlationId: "c" } as never;
  const validate = (priority: unknown) => (commandDefinitions["srs.assessment.item.set"].validate as (i: unknown, c: unknown) => Array<{ field: string }>)(
    { assessmentId: "a", requirementId: "r", maturity: 1, expectedVersion: 0, priority }, context);
  for (const ok of [...PRIORITIES, null, undefined]) assert.deepEqual(validate(ok).filter((i) => i.field === "priority"), [], String(ok));
  for (const bad of ["urgent", "High", ""]) assert.equal(validate(bad).filter((i) => i.field === "priority").length, 1, bad);
});
