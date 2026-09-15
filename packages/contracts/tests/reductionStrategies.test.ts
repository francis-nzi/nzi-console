import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  strategyLibrary, strategyPlanGroups, strategyPlanSummary, strategyProgressForStatus,
  strategyStatusForProgress, strategyDeadline, strategyDeadlineSignals, strategyDeadlineSummary,
  strategiesBySrsRequirement,
  type LibraryStrategy, type ClientStrategy,
} from "../src/reductionStrategies";

const lever = (id: string, over: Partial<LibraryStrategy> = {}): LibraryStrategy => ({
  id, key: id, leverIds: [], defaultSrsRequirementIds: ["req-1"], title: id, description: "", scope: "2", category: "Energy",
  controlLevel: "direct_control", iconKey: "energy", active: true, version: 1, modelledImpact: null, ...over,
});

const action = (id: string, over: Partial<ClientStrategy> = {}): ClientStrategy => ({
  id, clientId: "client-a", leverIds: [], srsRequirementIds: ["req-1"], includeInReport: true, strategyId: null, title: id, scope: "2", category: "Energy",
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

describe("what a target date means today", () => {
  const dated = (over: Partial<ClientStrategy>) => action("s", over);
  const TODAY = "2026-09-14";

  it("raises nothing for a strategy with no date", () => {
    // The brief's rule, and the one most easily broken by a default: an undated strategy is
    // not late, and a warning against a date nobody set is an invented fact.
    assert.deepEqual(strategyDeadline(dated({ targetDate: null }), TODAY), { state: "none" });
    assert.deepEqual(strategyDeadline(dated({ targetDate: "" }), TODAY), { state: "none" });
  });

  it("raises nothing for a finished strategy, whatever its date says", () => {
    // On a complete strategy the date is when it happened, not a deadline. Treating it as
    // one would flag finished work as late.
    assert.deepEqual(
      strategyDeadline(dated({ status: "complete", progressPct: 100, targetDate: "2026-01-01" }), TODAY),
      { state: "none" });
  });

  it("raises nothing for a strategy taken off the plan", () => {
    assert.deepEqual(strategyDeadline(dated({ active: false, targetDate: "2026-01-01" }), TODAY), { state: "none" });
  });

  it("counts a passed date as overdue, by whole days", () => {
    assert.deepEqual(strategyDeadline(dated({ targetDate: "2026-09-04" }), TODAY),
      { state: "overdue", targetDate: "2026-09-04", daysOverdue: 10 });
  });

  it("treats the target day itself as due, not overdue", () => {
    // Someone has until the end of the day they set. Calling it late that morning would be
    // wrong by one day, every time.
    assert.deepEqual(strategyDeadline(dated({ targetDate: TODAY }), TODAY),
      { state: "approaching", targetDate: TODAY, daysRemaining: 0 });
  });

  it("separates approaching from merely scheduled at the window edge", () => {
    assert.equal(strategyDeadline(dated({ targetDate: "2026-10-14" }), TODAY).state, "approaching", "30 days is inside");
    assert.equal(strategyDeadline(dated({ targetDate: "2026-10-15" }), TODAY).state, "scheduled", "31 days is not");
  });

  it("does not depend on the time of day or the reader's timezone", () => {
    // Whether something is overdue must be the same fact in London and in Auckland, and the
    // same at 23:59 as at 00:01 — so the comparison is calendar days at midnight UTC.
    const withTime = strategyDeadline(dated({ targetDate: "2026-09-20T23:30:00+13:00" }), "2026-09-14T00:30:00Z");
    assert.deepEqual(withTime, { state: "approaching", targetDate: "2026-09-20T23:30:00+13:00", daysRemaining: 6 });
  });

  it("says nothing rather than 'due today' when the date cannot be read", () => {
    // A zero-on-failure default would turn bad data into a live reminder.
    assert.deepEqual(strategyDeadline(dated({ targetDate: "not a date" }), TODAY), { state: "none" });
  });

  it("orders signals worst first, and counts them", () => {
    const plan = [
      dated({ targetDate: "2026-10-01" }),
      { ...dated({ targetDate: "2026-08-01" }), id: "late-badly", title: "late badly" },
      { ...dated({ targetDate: "2026-09-10" }), id: "late-a-little", title: "late a little" },
      { ...dated({ targetDate: "2027-06-01" }), id: "far-off", title: "far off" },
      { ...dated({ targetDate: null }), id: "undated", title: "undated" },
    ];
    const signals = strategyDeadlineSignals(plan, TODAY);
    assert.deepEqual(signals.map((entry) => entry.strategy.title), ["late badly", "late a little", "s"]);
    // The far-off and undated ones are not signals — a plan going to plan is not news.
    assert.deepEqual(strategyDeadlineSummary(signals), { overdue: 2, approaching: 1, total: 3 });
  });
});

describe("the reverse of the SRS alignment", () => {
  it("names the strategies advancing a requirement", () => {
    // The question readiness asks: given this requirement, what is the client doing?
    const byRequirement = strategiesBySrsRequirement([
      action("solar", { srsRequirementIds: ["req-metrics"], title: "Rooftop solar" }),
      action("fleet", { srsRequirementIds: ["req-metrics", "req-gov"], title: "Fleet to EV" }),
      action("board", { srsRequirementIds: ["req-gov"], title: "Board oversight" }),
    ]);
    assert.deepEqual(byRequirement.get("req-metrics")?.map((entry) => entry.title), ["Fleet to EV", "Rooftop solar"]);
    // A strategy advancing two requirements is named under both — it is one piece of work
    // doing two jobs, not two records.
    assert.deepEqual(byRequirement.get("req-gov")?.map((entry) => entry.title), ["Board oversight", "Fleet to EV"]);
  });

  it("returns nothing for a requirement no strategy addresses, so the view can say so", () => {
    const byRequirement = strategiesBySrsRequirement([action("solar", { srsRequirementIds: ["req-metrics"] })]);
    assert.equal(byRequirement.get("req-untouched"), undefined);
    assert.equal(byRequirement.has("req-untouched"), false);
  });

  it("leaves out withdrawn strategies rather than overstating readiness", () => {
    // A strategy taken off the plan is not answering anything. Counting it would make a
    // requirement look addressed by work the client is no longer doing.
    const byRequirement = strategiesBySrsRequirement([
      action("dropped", { srsRequirementIds: ["req-gov"], active: false, title: "Abandoned" }),
      action("live", { srsRequirementIds: ["req-gov"], title: "Board oversight" }),
    ]);
    assert.deepEqual(byRequirement.get("req-gov")?.map((entry) => entry.title), ["Board oversight"]);
  });

  it("puts the furthest along first, and orders ties by title", () => {
    const byRequirement = strategiesBySrsRequirement([
      action("b", { srsRequirementIds: ["r"], title: "Beta", progressPct: 10 }),
      action("c", { srsRequirementIds: ["r"], title: "Alpha", progressPct: 10 }),
      action("a", { srsRequirementIds: ["r"], title: "Gamma", progressPct: 80 }),
    ]);
    assert.deepEqual(byRequirement.get("r")?.map((entry) => entry.title), ["Gamma", "Alpha", "Beta"]);
  });

  it("holds an empty plan without inventing a requirement", () => {
    assert.equal(strategiesBySrsRequirement([]).size, 0);
  });
});
