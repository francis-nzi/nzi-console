import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandDefinitions, commandGrantForRole, hoursFromMinutes, isTimeEntryMinutes, minutesFromHours, todayInLondon, utcDay, validateCommand, type CommandContext } from "../src/index";

const context: CommandContext = { organisationId: "org-nzi", actorId: "user-1", principal: "staff", idempotencyKey: "idem-1", correlationId: "corr-1", grant: commandGrantForRole("viewer", "org-nzi", "user-1") };
const fields = (issues: Array<{ field: string }>) => issues.map((issue) => issue.field).sort();
const entry = { jobId: "j1", workDate: "2026-03-10", minutes: 90, activityValueId: "activity_types:fieldwork" };

/** TIME PR A (rulings ⚑1, ⚑9, T-Q3, T-Q5, T-Q6 and the billable-default Addendum). */
describe("time contracts", () => {
  it("stores whole minutes, more than none and at most a day (⚑1, ⚑9); the screen's quarter-hours land exactly", () => {
    assert.deepEqual([1, 1440].map(isTimeEntryMinutes), [true, true]);
    assert.deepEqual([0, -15, 1441, 90.5, Number.NaN].map(isTimeEntryMinutes), [false, false, false, false, false]);
    assert.deepEqual([0.25, 1.5, 7.75, 24].map(minutesFromHours), [15, 90, 465, 1440]);
    assert.deepEqual([15, 90, 60].map(hoursFromMinutes), ["0.25", "1.5", "1"]);
  });

  it("validates a log before transport: a real day, minutes in range, an activity, a short note", () => {
    assert.deepEqual(validateCommand("time.entry.log", entry, context), []);
    assert.deepEqual(fields(validateCommand("time.entry.log", { ...entry, workDate: "2026-02-30", minutes: 0, activityValueId: "", note: "x".repeat(2001) }, context)),
      ["activityValueId", "minutes", "note", "workDate"]);
    assert.deepEqual(fields(validateCommand("time.entry.edit", { ...entry, entryId: "e1", expectedVersion: 0, billable: "yes" as unknown as boolean }, context)), ["billable", "expectedVersion"]);
  });

  it("caps the work date at today, as the London day (ruled on review)", () => {
    const today = todayInLondon();
    const tomorrow = new Date(`${today}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    assert.deepEqual(validateCommand("time.entry.log", { ...entry, workDate: today }, context), []);
    const future = validateCommand("time.entry.log", { ...entry, workDate: utcDay(tomorrow) }, context);
    assert.deepEqual(future.map((issue) => [issue.field, issue.code]), [["workDate", "FUTURE"]]);
    assert.deepEqual(validateCommand("time.entry.edit", { ...entry, entryId: "e1", expectedVersion: 1, billable: true, workDate: utcDay(tomorrow) }, context).map((issue) => issue.code), ["FUTURE"]);
  });

  it("logs, edits and voids under time.log — billing (and unbilling) under finance.manage, with an invoice reference or none", () => {
    assert.deepEqual(["time.entry.log", "time.entry.edit", "time.entry.void", "time.entry.bill"].map((key) => commandDefinitions[key as keyof typeof commandDefinitions].permission),
      ["time.log", "time.log", "time.log", "finance.manage"]);
    assert.deepEqual(validateCommand("time.entry.bill", { entryId: "e1", expectedVersion: 2, billedRef: null }, context), []);
    assert.deepEqual(fields(validateCommand("time.entry.bill", { entryId: "e1", expectedVersion: 2, billedRef: "  " }, context)), ["billedRef"]);
  });

  it("requires an activity's billable default when it is added, and refuses one on any other lookup (Addendum)", () => {
    assert.deepEqual(fields(validateCommand("reference.value.create", { categoryKey: "activity_types", label: "Training" }, context)), ["billableDefault"]);
    assert.deepEqual(validateCommand("reference.value.create", { categoryKey: "activity_types", label: "Training", billableDefault: false }, context), []);
    assert.deepEqual(fields(validateCommand("reference.value.create", { categoryKey: "industries", label: "Mining", billableDefault: true }, context)), ["billableDefault"]);
    assert.deepEqual(validateCommand("reference.value.update", { categoryKey: "activity_types", valueId: "v", label: "Travel", sortOrder: 50, expectedVersion: 1 }, context), []);
  });
});
