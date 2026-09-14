import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  strategyLibrary, strategyPlanGroups, strategyPlanSummary, strategyProgressForStatus,
  strategyStatusForProgress, type LibraryStrategy, type ClientStrategy,
} from "../src/reductionStrategies";

const lever = (id: string, over: Partial<LibraryStrategy> = {}): LibraryStrategy => ({
  id, key: id, leverIds: [], title: id, description: "", scope: "2", category: "Energy",
  controlLevel: "direct_control", iconKey: "energy", active: true, version: 1, modelledImpact: null, ...over,
});

const action = (id: string, over: Partial<ClientStrategy> = {}): ClientStrategy => ({
  id, clientId: "client-a", leverIds: [], strategyId: null, title: id, scope: "2", category: "Energy",
  controlLevel: "direct_control", iconKey: "energy", status: "planned", owner: "", targetDate: null,
  progressPct: 0, notes: "", active: true, version: 1, ...over,
});

describe("the action-lever library", () => {
  describe("status and progress stay one fact", () => {
    it("puts a complete action at 100%", () => {
      // The database holds this as a CHECK. Keeping the rule here means a form cannot
      // offer a combination that will be refused on save.
      assert.equal(strategyProgressForStatus("complete", 60), 100);
    });

    it("steps a non-complete action back off 100 rather than rewriting its status", () => {
      // Someone who chose "in progress" meant it; silently marking it complete would be
      // the form deciding something the person didn't.
      assert.equal(strategyProgressForStatus("in_progress", 100), 99);
      assert.equal(strategyProgressForStatus("planned", 40), 40);
    });

    it("completes an action dragged to 100%", () => {
      assert.equal(strategyStatusForProgress(100, "in_progress"), "complete");
    });

    it("reopens a completed action as in-progress, never as planned", () => {
      // Work that was finished and then reopened was never "not started".
      assert.equal(strategyStatusForProgress(80, "complete"), "in_progress");
      assert.equal(strategyStatusForProgress(0, "complete"), "in_progress");
      // And an untouched planned action stays planned.
      assert.equal(strategyStatusForProgress(0, "planned"), "planned");
    });
  });

  describe("the plan summary", () => {
    it("counts each live action once", () => {
      const summary = strategyPlanSummary([
        action("a", { status: "in_progress", progressPct: 60 }),
        action("b", { status: "complete", progressPct: 100 }),
        action("c"),
        action("d", { active: false, status: "complete", progressPct: 100 }),
      ]);
      assert.equal(summary.total, 3, "a removed action is not on the plan");
      assert.equal(summary.planned + summary.inProgress + summary.complete, summary.total);
      assert.equal(summary.inProgress, 1);
      assert.equal(summary.complete, 1);
      assert.equal(summary.planned, 1);
      assert.equal(summary.progressPct, 53);
    });

    it("reads an empty plan as null progress, never as zero", () => {
      // 0% says "no progress"; the truth is "nothing planned yet", which is different.
      assert.equal(strategyPlanSummary([]).progressPct, null);
      assert.equal(strategyPlanSummary([action("a", { active: false })]).progressPct, null);
    });
  });

  describe("grouping", () => {
    it("groups by level of control in a fixed order and drops the empty ones", () => {
      const groups = strategyPlanGroups([
        action("a", { controlLevel: "influence" }),
        action("b", { controlLevel: "direct_control" }),
      ]);
      assert.deepEqual(groups.map((group) => group.controlLevel), ["direct_control", "influence"]);
      assert.equal(groups.length, 2, "supply_chain has nothing in it and is not shown");
    });

    it("orders within a group by the order of work, not the alphabet", () => {
      const groups = strategyPlanGroups([
        action("z-complete", { status: "complete", progressPct: 100 }),
        action("a-planned"),
        action("m-live", { status: "in_progress", progressPct: 50 }),
      ]);
      // What is live, then what is next, then what is behind you.
      assert.deepEqual(groups[0]!.actions.map((entry) => entry.title), ["m-live", "a-planned", "z-complete"]);
    });

    it("leaves a removed action out of the plan entirely", () => {
      assert.deepEqual(strategyPlanGroups([action("a", { active: false })]), []);
    });
  });

  describe("the library drawer", () => {
    it("marks what the client already holds instead of offering it twice", () => {
      const entries = strategyLibrary([lever("l1"), lever("l2")], [action("a", { strategyId: "l1" })]);
      assert.deepEqual(entries.map((entry) => [entry.strategy.id, entry.assigned]), [["l1", true], ["l2", false]]);
    });

    it("hides a withdrawn lever from everyone except the clients still holding it", () => {
      // A client's plan should not develop a hole because the catalogue moved on, but a
      // withdrawn lever is not offered to anyone new.
      const withdrawn = lever("old", { active: false });
      assert.deepEqual(strategyLibrary([withdrawn], []).map((entry) => entry.strategy.id), []);
      const held = strategyLibrary([withdrawn], [action("a", { strategyId: "old" })]);
      assert.deepEqual(held.map((entry) => [entry.strategy.id, entry.assigned]), [["old", true]]);
    });

    it("stops a removed assignment from marking a lever as still held", () => {
      const entries = strategyLibrary([lever("l1")], [action("a", { strategyId: "l1", active: false })]);
      assert.equal(entries[0]!.assigned, false, "a removed action frees its lever to be added again");
    });
  });

  describe("Stage 2 impact", () => {
    it("carries a modelled figure only together with its basis", () => {
      // The type makes the pairing impossible to break, which is the point: an unsourced
      // reduction number on a plan is what ends up quoted in a report.
      const quantified = lever("l1", { modelledImpact: { tco2ePerYear: 12.5, basis: "Supplier-provided" } });
      assert.equal(quantified.modelledImpact?.basis, "Supplier-provided");
      assert.equal(lever("l2").modelledImpact, null, "and it is null everywhere today");
    });
  });
});
