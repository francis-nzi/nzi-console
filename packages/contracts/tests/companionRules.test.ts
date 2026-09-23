import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { proposeCompanions, resolveFactorForEntry, type CompanionRule, type MappingOutcome } from "../src";

/**
 * Companions — one entry resolving to more than one row (NZC-154).
 *
 * The assertion this is judged on is the **pair**: the transmission-and-distribution companion is created
 * for grid supply, and is not created for electricity generated on site. A test that only checked the
 * first would pass against an engine that proposed T&D for everything, which is the failure that matters:
 * self-generated solar carrying transmission losses it never incurred, on a client's Scope 3.
 */

const grid: CompanionRule = {
  companionKey: "grid-td", ordering: 10, kind: "transmission-distribution",
  factorBase: "electricity-td-demo", ghgCategory: "3.3",
  whenFieldKey: "supplySource", whenValues: ["grid", "grid-renewable", "green-tariff", "rego"],
  label: "Transmission & distribution losses",
};

const available = [{ factorId: "electricity-demo", scopes: ["2"] }, { factorId: "electricity-td-demo", scopes: ["3"] }];

const resolvedPrimary: MappingOutcome = {
  kind: "resolved", factorId: "electricity-demo",
  rule: { kind: "lookup", ruleKey: "grid-electricity", ordering: 10, factorBase: "electricity-demo" },
  scope: { authority: "spec-category", ghgCategory: "2", factorScopes: ["2"], agreement: "agrees" },
  declined: [],
};

const propose = (supplySource: string | null, over: Partial<Parameters<typeof proposeCompanions>[0]> = {}) =>
  proposeCompanions({
    companions: [grid], entry: supplySource === null ? {} : { supplySource },
    available, primary: resolvedPrimary, ...over,
  });

describe("an entry can resolve to more than one row (NZC-154)", () => {
  it("creates the T&D companion for grid supply", () => {
    const outcome = propose("grid");
    assert.equal(outcome.proposed.length, 1);
    assert.equal(outcome.proposed[0]!.factorId, "electricity-td-demo");
    assert.equal(outcome.proposed[0]!.ghgCategory, "3.3", "T&D on a Scope 2 purchase is Scope 3.3");
  });

  it("creates it for a green tariff and for REGO-backed supply, which still crossed the network", () => {
    // The load-bearing correction. A certificate changes what the supply is *accounted as*, not the wires
    // it arrived on — so a renewable grid tariff loses in transmission exactly as an ordinary one does.
    for (const supply of ["grid-renewable", "green-tariff", "rego"]) {
      assert.equal(propose(supply).proposed.length, 1, `${supply} must still carry transmission losses`);
    }
  });

  it("does NOT create it for self-generated electricity", () => {
    // The other half of the pair, and the one that makes the first mean anything. On-site generation
    // crossed no network: a T&D row here is a number the client never incurred.
    const outcome = propose("self-generated");
    assert.equal(outcome.proposed.length, 0, "self-generated electricity was given transmission losses");
    assert.match(outcome.declined[0]!.reason, /not among the values this companion fires for/);
  });

  it("fires for nothing nobody listed, so a new supply kind is silent until someone decides", () => {
    // Enumerated positively. Written as "everything except self-generated", a supply kind added later
    // would start claiming transmission losses the day it was introduced.
    assert.equal(propose("nuclear-ppa").proposed.length, 0);
    assert.equal(propose("on-site-chp").proposed.length, 0);
  });

  it("declines while the supply has not been captured, rather than guessing grid", () => {
    // Mid-entry. Assuming grid would be right most of the time, which is exactly what makes it dangerous:
    // the wrong cases are invisible and the right ones build confidence in the guess.
    const outcome = propose(null);
    assert.equal(outcome.proposed.length, 0);
    assert.match(outcome.declined[0]!.reason, /has not been captured/);
  });

  it("declines when the dataset does not carry the companion's factor", () => {
    const outcome = propose("grid", { available: [{ factorId: "electricity-demo" }] });
    assert.equal(outcome.proposed.length, 0);
    assert.match(outcome.declined[0]!.reason, /not in the selected dataset/);
  });

  it("proposes nothing when the primary did not resolve", () => {
    // A companion to nothing is not a row: it would be transmission losses attributed to a supply the
    // system could not identify — a number with no parent and no way to check it.
    const outcome = propose("grid", {
      primary: { kind: "free-search", declined: [], reason: "no rules" },
    });
    assert.equal(outcome.proposed.length, 0);
    assert.match(outcome.declined[0]!.reason, /nothing for this to accompany/);
  });

  it("fires every companion that matches, not the first", () => {
    // Companions are not competing answers. This is what makes the end-of-life case — a stream with more
    // than one treatment — expressible at all, and it is the difference from the primary rules.
    const second: CompanionRule = { ...grid, companionKey: "second-td", ordering: 20, ghgCategory: "3.3" };
    const outcome = proposeCompanions({
      companions: [grid, second], entry: { supplySource: "grid" }, available, primary: resolvedPrimary,
    });
    assert.deepEqual(outcome.proposed.map((entry) => entry.companionKey), ["grid-td", "second-td"]);
  });

  it("records what fired it, so a proposed row can explain itself", () => {
    const outcome = propose("REGO");
    assert.equal(outcome.proposed.length, 1, "matching is case-insensitive like every other basis");
    assert.deepEqual(outcome.proposed[0]!.firedBy, { fieldKey: "supplySource", value: "REGO" });
  });
});
