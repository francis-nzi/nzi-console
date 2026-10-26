import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandGrantForRole, strategyIsReportable, strategyLeverCoverage, strategyNextStatuses, strategyStatuses, strategyStatusLabels, strategyTransitionAllowed,
  validateCommand, type ClientStrategy, type CommandContext, type Lever, type StrategyStatus,
} from "../src/index";

/**
 * Actions A1 (BUILD-actions-A1-library-and-plan), the pure rules: the status ladder and its legal moves (R3), what a
 * report may compose (R5), the lever-coverage summary (R2), and the command rules for the library's lever allocation,
 * a new action's starting status, and its origin (R6, R7).
 */

const context: CommandContext = { organisationId: "org-nzi", actorId: "user-1", principal: "staff", idempotencyKey: "idem-1", correlationId: "corr-1", grant: commandGrantForRole("admin", "org-nzi", "user-1") };
const action = (id: string, over: Partial<ClientStrategy> = {}): ClientStrategy => ({
  id, clientId: "client-a", leverIds: ["lever-energy"], srsRequirementIds: ["req-1"], includeInReport: true, strategyId: null, title: id, scope: "2", category: "",
  controlLevel: "direct_control", iconKey: "energy", status: "agreed", owner: "", ownerContactId: null, origin: "plan", originSrsRequirementId: null, targetDate: null,
  progressPct: 0, notes: "", active: true, version: 1, estimate: null, ...over,
});
const lever = (id: string, ordering: number, active = true): Lever => ({ id, key: id, title: id, iconKey: "target", ordering, active });

describe("the status ladder (R3)", () => {
  it("is the settled six, in reading order, with labels — and a label for reports frozen before it", () => {
    assert.deepEqual([...strategyStatuses], ["proposed", "agreed", "in_progress", "complete", "on_hold", "declined"]);
    assert.equal(strategyStatusLabels.planned, "Planned", "a report issued before A1 still renders its statuses");
  });

  it("allows the ladder's moves and refuses the rest", () => {
    const legal: Array<[StrategyStatus, StrategyStatus]> = [
      ["proposed", "agreed"], ["proposed", "declined"], ["agreed", "in_progress"], ["agreed", "complete"], ["agreed", "on_hold"], ["agreed", "declined"],
      ["in_progress", "complete"], ["in_progress", "on_hold"], ["in_progress", "declined"], ["complete", "in_progress"],
      ["on_hold", "agreed"], ["on_hold", "in_progress"], ["on_hold", "declined"], ["declined", "proposed"],
    ];
    for (const from of strategyStatuses) {
      for (const to of strategyStatuses) {
        const expected = from === to || legal.some(([a, b]) => a === from && b === to);
        assert.equal(strategyTransitionAllowed(from, to), expected, `${from} → ${to}`);
      }
    }
    // The ones the brief names: work cannot start before it is agreed, and a declined action is not quietly completed.
    assert.equal(strategyTransitionAllowed("proposed", "in_progress"), false);
    assert.equal(strategyTransitionAllowed("declined", "complete"), false);
  });

  it("offers a status select only where it is and where it may go", () => {
    assert.deepEqual(strategyNextStatuses("proposed"), ["proposed", "agreed", "declined"]);
    assert.deepEqual(strategyNextStatuses("complete"), ["in_progress", "complete"]);
  });
});

describe("what a report composes (R5)", () => {
  it("is included AND agreed or beyond, and on the plan", () => {
    const reportable = (over: Partial<ClientStrategy>) => strategyIsReportable(action("a", over));
    assert.equal(reportable({}), true);
    assert.equal(reportable({ status: "in_progress" }), true);
    assert.equal(reportable({ status: "complete", progressPct: 100 }), true);
    for (const status of ["proposed", "on_hold", "declined"] as const) assert.equal(reportable({ status }), false, status);
    assert.equal(reportable({ includeInReport: false }), false);
    assert.equal(reportable({ active: false }), false);
  });
});

describe("the lever-coverage summary (R2)", () => {
  it("says, per live lever in order, how much is agreed under it — and which levers are thin", () => {
    const coverage = strategyLeverCoverage([
      action("a", { leverIds: ["energy", "buildings"] }), action("b", { leverIds: ["energy"], status: "complete", progressPct: 100 }),
      action("c", { leverIds: ["transport"], status: "proposed" }), action("d", { leverIds: ["transport"], status: "declined" }),
      action("e", { leverIds: ["waste"], active: false }),
    ], [lever("waste", 4), lever("energy", 1), lever("transport", 3), lever("buildings", 2), lever("old", 5, false)]);
    assert.deepEqual(coverage.map((entry) => [entry.lever.id, entry.actions, entry.agreed, entry.complete, entry.thin]), [
      ["energy", 2, 2, 1, false], ["buildings", 1, 1, 0, false],
      ["transport", 1, 0, 0, true], // a proposal alone is thin; the declined action counts for nothing
      ["waste", 0, 0, 0, true], // a removed action counts for nothing either
    ]);
  });
});

describe("the commands' rules", () => {
  const library = { key: "k", title: "T", scope: "2", controlLevel: "direct_control", iconKey: "target" };
  const assign = { clientId: "client-a", bespoke: { title: "T", scope: "1", controlLevel: "direct_control" }, srsRequirementIds: ["req-1"] };
  const issues = <K extends Parameters<typeof validateCommand>[0]>(key: K, input: Parameters<typeof validateCommand<K>>[1]) =>
    validateCommand(key, input, context).map((issue) => `${issue.field}:${issue.code}`);

  it("allocate every library strategy to at least one lever (R1)", () => {
    assert.deepEqual(issues("strategy.library.upsert", { ...library, leverIds: ["lever-energy"] }), []);
    assert.deepEqual(issues("strategy.library.upsert", { ...library, leverIds: [] }), ["leverIds:REQUIRED"]);
    assert.deepEqual(issues("strategy.library.upsert", { ...library, leverIds: ["  "] }), ["leverIds:REQUIRED"]);
  });

  it("keep a lever's key a key, and its withdrawal reasoned", () => {
    assert.deepEqual(issues("strategy.lever.upsert", { key: "water", title: "Water", iconKey: "drop" }), []);
    assert.deepEqual(issues("strategy.lever.upsert", { key: "Water & Waste", title: "Water", iconKey: "drop" }), ["key:INVALID"]);
    assert.ok(validateCommand("strategy.lever.deactivate", { leverId: "l", expectedVersion: 1, reason: "" }, context).some((issue) => issue.field === "reason"));
  });

  it("start a new action Proposed or Agreed, never further up the ladder", () => {
    assert.deepEqual(issues("client.strategy.assign", { ...assign, status: "agreed" }), []);
    assert.deepEqual(issues("client.strategy.assign", { ...assign, status: "in_progress" }), ["status:INVALID"]);
  });

  it("record where it came from: the plan, or an SRS gap that names its requirement — a client proposal is the portal's (A2)", () => {
    assert.deepEqual(issues("client.strategy.assign", assign), []);
    assert.deepEqual(issues("client.strategy.assign", { ...assign, origin: "srs_gap", originSrsRequirementId: "req-1" }), []);
    assert.deepEqual(issues("client.strategy.assign", { ...assign, origin: "srs_gap" }), ["originSrsRequirementId:REQUIRED"]);
    assert.deepEqual(issues("client.strategy.assign", { ...assign, originSrsRequirementId: "req-1" }), ["originSrsRequirementId:INVALID"]);
    assert.deepEqual(issues("client.strategy.assign", { ...assign, origin: "client_proposal" }), ["origin:INVALID"]);
  });

  it("accept any of the six statuses on update — whether the move is legal is the command's, against the row", () => {
    const update = { clientStrategyId: "cs", expectedVersion: 1, progressPct: 0, srsRequirementIds: ["req-1"], includeInReport: true };
    for (const status of strategyStatuses.filter((value) => value !== "complete")) assert.deepEqual(issues("client.strategy.update", { ...update, status }), [], status);
    assert.deepEqual(issues("client.strategy.update", { ...update, status: "planned" }), ["status:INVALID"], "0075's planned is gone from the live ladder");
  });
});
