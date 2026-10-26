import test from "node:test";
import assert from "node:assert/strict";
import {
  commandDefinitions, strategyAwaitingDecision, strategyClientNextStatuses, strategyClientTransitionAllowed, strategyOnPlan, strategyStatuses,
  strategyTransitionAllowed, type CommandContext, type StrategyProposal,
} from "../src/index";

/**
 * Actions A2 in the contracts: the owner's half of the ladder, what "on the plan" means once a client can propose, and
 * the new commands' validators — the client's half refuses staff fields by name; staff's approval needs an alignment and
 * a decline needs the reason the client reads.
 */

const portal: CommandContext = { organisationId: "org", actorId: "portal-ada", principal: "portal", portal: { portalUserId: "portal-ada", clientId: "client-a" }, idempotencyKey: "k", correlationId: "c" };
const staff = (reason?: string): CommandContext => ({ organisationId: "org", actorId: "sam", principal: "staff", idempotencyKey: "k", correlationId: "c", ...(reason ? { reason } : {}) } as CommandContext);
const codes = (issues: Array<{ field: string; code: string }>) => issues.map((issue) => `${issue.field}:${issue.code}`).sort();
const proposal = (state: StrategyProposal["state"]): StrategyProposal => ({ state, note: "", decisionReason: state === "declined" ? "no" : null, proposedOn: "2026-10-26", decidedOn: state === "pending" ? null : "2026-10-27" });

test("the owner's moves are A1's ladder narrowed: start, pause, finish, reopen — never agree, decline or revive", () => {
  const allowed = strategyStatuses.flatMap((from) => strategyStatuses.filter((to) => to !== from && strategyClientTransitionAllowed(from, to)).map((to) => `${from}→${to}`));
  assert.deepEqual(allowed.sort(), [
    "agreed→complete", "agreed→in_progress", "agreed→on_hold",
    "complete→in_progress",
    "in_progress→complete", "in_progress→on_hold",
    "on_hold→in_progress",
  ].sort());
  // Every owner move is a legal A1 move: the owner never gets a move staff could not make.
  for (const move of allowed) { const [from, to] = move.split("→") as [never, never]; assert.ok(strategyTransitionAllowed(from, to), move); }
  assert.deepEqual(strategyClientNextStatuses("proposed"), ["proposed"], "a proposal waits for staff");
  assert.deepEqual(strategyClientNextStatuses("declined"), ["declined"], "a declined action is not revived from the portal");
});

test("on the plan means active and — for a client's proposal — approved", () => {
  assert.equal(strategyOnPlan({ active: true, proposal: null }), true);
  assert.equal(strategyOnPlan({ active: false, proposal: null }), false);
  assert.equal(strategyOnPlan({ active: true, proposal: proposal("pending") }), false);
  assert.equal(strategyOnPlan({ active: true, proposal: proposal("declined") }), false);
  assert.equal(strategyOnPlan({ active: true, proposal: proposal("approved") }), true);
  assert.equal(strategyAwaitingDecision({ active: true, proposal: proposal("pending") }), true);
  assert.equal(strategyAwaitingDecision({ active: true, proposal: proposal("approved") }), false);
});

test("the client's update refuses staff fields by name, and says when nothing changed", () => {
  const validate = commandDefinitions["portal.strategy.update"].validate;
  assert.deepEqual(codes(validate({ clientStrategyId: "a", expectedVersion: 1, includeInReport: false, srsRequirementIds: [], notes: "x" } as never, portal)),
    // Only staff fields, so nothing the client may change either.
    ["clientStrategyId:NOTHING_TO_SAVE", "includeInReport:STAFF_ONLY_FIELD", "notes:STAFF_ONLY_FIELD", "srsRequirementIds:STAFF_ONLY_FIELD"]);
  assert.deepEqual(codes(validate({ clientStrategyId: "a", expectedVersion: 1 }, portal)), ["clientStrategyId:NOTHING_TO_SAVE"]);
  assert.deepEqual(codes(validate({ clientStrategyId: "a", expectedVersion: 1, progressPct: 101, status: "nonsense" }, portal)), ["progressPct:INVALID", "status:INVALID"]);
  assert.deepEqual(validate({ clientStrategyId: "a", expectedVersion: 1, ownerContactId: null }, portal), [], "clearing an owner is a change");
});

test("a proposal needs words and a scope; the client is never asked for an alignment", () => {
  const validate = commandDefinitions["portal.strategy.propose"].validate;
  assert.deepEqual(codes(validate({ clientId: "client-a", title: " ", scope: "4" }, portal)), ["scope:INVALID", "title:REQUIRED"]);
  assert.deepEqual(validate({ clientId: "client-a", title: "Electric vans", scope: "1", note: "Lease ends in March." }, portal), []);
});

test("staff approve with an alignment, and decline with the reason the client reads", () => {
  const approve = commandDefinitions["client.strategy.proposal.approve"].validate;
  assert.ok(codes(approve({ clientStrategyId: "a", expectedVersion: 1, title: "t", scope: "1", controlLevel: "direct_control", srsRequirementIds: [], includeInReport: true }, staff())).includes("srsRequirementIds:REQUIRED"));
  const decline = commandDefinitions["client.strategy.proposal.decline"].validate;
  assert.ok(codes(decline({ clientStrategyId: "a", expectedVersion: 1, reason: "" }, staff())).includes("reason:REQUIRED"));
  assert.deepEqual(decline({ clientStrategyId: "a", expectedVersion: 1, reason: "Already covered." }, staff("Already covered.")), []);
  assert.equal(commandDefinitions["client.strategy.proposal.decline"].reasonRequired, true);
});

test("there is no portal command that deletes or removes", () => {
  const portalKeys = Object.values(commandDefinitions).filter((definition) => (definition as { principal?: string }).principal === "portal").map((definition) => definition.key);
  assert.ok(portalKeys.every((key) => !/remove|delete|withdraw/.test(key)), portalKeys.join(", "));
});
