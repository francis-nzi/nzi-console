import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveFactorForEntry, type CategoryVariant, type FactorRule, type MappingInputs } from "../src";

/**
 * Sub-flow composition — reusing a flow and filing it under another category (NZC-158).
 *
 * Two leaks put the Scope 1 vehicle factor into business travel, and only one of them is obvious.
 *
 * The obvious one is resolving the base directly, which an assertion about the resolved identity catches.
 * The other is composing the variant, finding it missing, and using the base **because it is nearly
 * right** — same fuel, same litres, same arithmetic, wrong scope. That one produces a commute priced with
 * the company's Scope 1 factor and filed under Scope 3, and nothing about the number looks wrong. It is
 * the reason this file spends more assertions on what must *not* resolve than on what must.
 */

const REGISTRY: CategoryVariant[] = [
  { suffixCode: "-b", label: "Business travel", ghgCategory: "3.6", description: "", status: "active", sortOrder: 20 },
  { suffixCode: "-c", label: "Commuting", ghgCategory: "3.7", description: "", status: "active", sortOrder: 10 },
  { suffixCode: "-x", label: "Withdrawn", ghgCategory: "3.9", description: "", status: "retired", sortOrder: 30 },
];

/** The vehicle flow, referenced rather than restated — exactly as the seeded categories do. */
const VEHICLE_RULES: FactorRule[] = [
  { kind: "basis-branch", ruleKey: "fuel-litres", ordering: 10, factorBase: "diesel-demo", basisFieldKey: "unit", basisValue: "litres" },
];

const businessTravel: FactorRule = {
  kind: "sub-flow", ruleKey: "road-via-vehicle-flow", ordering: 10,
  subFlowCategory: "1.company-vehicles", suffixCode: "-b",
};
const commuting: FactorRule = { ...businessTravel, ruleKey: "car-via-vehicle-flow", suffixCode: "-c" };

const inputs = (over: Partial<MappingInputs>): MappingInputs => ({
  rules: [businessTravel],
  specGhgCategory: "3",
  entry: { unit: "litres" },
  available: [
    { factorId: "diesel-demo", scopes: ["1", "3"] },
    { factorId: "diesel-demo-b", scopes: ["3"] },
    { factorId: "diesel-demo-c", scopes: ["3"] },
  ],
  registry: REGISTRY,
  rulesByCategory: { "1.company-vehicles": VEHICLE_RULES },
  ...over,
});

describe("a category reuses another flow and files it under its own (NZC-158)", () => {
  // ── Half (a): the identity is the variant, and the two categories are distinct ────────

  it("resolves to the category variant, not the vehicle's Scope 1 base", () => {
    const outcome = resolveFactorForEntry(inputs({}));
    assert.equal(outcome.kind, "resolved");
    if (outcome.kind !== "resolved") return;
    assert.equal(outcome.factorId, "diesel-demo-b", "business travel resolved to the Scope 1 base");
    assert.notEqual(outcome.factorId, "diesel-demo");
    assert.equal(outcome.scope.ghgCategory, "3.6", "the registry's category, not the spec's '3'");
    assert.equal(outcome.scope.authority, "suffix-variant");
  });

  it("gives business travel and commuting distinct identities from the one flow", () => {
    // The same vehicle, the same litres, the same base — and two different rows, because the categories
    // differ. If these ever came back equal, the suffix would be doing nothing and both would be filed
    // wherever the first one happened to land.
    const travel = resolveFactorForEntry(inputs({ rules: [businessTravel] }));
    const commute = resolveFactorForEntry(inputs({ rules: [commuting] }));

    assert.equal(travel.kind === "resolved" ? travel.factorId : null, "diesel-demo-b");
    assert.equal(commute.kind === "resolved" ? commute.factorId : null, "diesel-demo-c");
    assert.notEqual(
      travel.kind === "resolved" ? travel.factorId : "a",
      commute.kind === "resolved" ? commute.factorId : "b",
      "business travel and commuting resolved to the same factor",
    );
    assert.equal(travel.kind === "resolved" ? travel.scope.ghgCategory : null, "3.6");
    assert.equal(commute.kind === "resolved" ? commute.scope.ghgCategory : null, "3.7");
  });

  // ── Addition 2: the second leak, which is the one worth the primitive ─────────────────

  it("STOPS when the suffix is not in the registry, and does NOT fall back to the base", () => {
    // The master hazard: the flow answered, the variant cannot be composed, and the base is sitting right
    // there being nearly right. Asserted twice over — that nothing resolved, and specifically that the
    // base is not what came back — because "free-search" alone would still pass if a later change
    // started returning the base with a different outcome kind.
    const outcome = resolveFactorForEntry(inputs({
      rules: [{ ...businessTravel, suffixCode: "-zz" }],
    }));
    assert.equal(outcome.kind, "free-search", "an unregistered suffix resolved to something");
    assert.match(outcome.kind === "free-search" ? outcome.reason : "", /left for a person/);
    assert.match(outcome.kind === "free-search" ? outcome.reason : "", /belongs to a different scope/);
  });

  it("STOPS when the composed variant is absent from the dataset, and does NOT fall back to the base", () => {
    // Same hazard, different cause: the suffix is registered, the factor simply is not carried. The base
    // `diesel-demo` IS in this dataset, so a resolver that fell back would succeed here — which is what
    // makes this assertion worth writing rather than assuming.
    const outcome = resolveFactorForEntry(inputs({
      available: [{ factorId: "diesel-demo", scopes: ["1", "3"] }],
    }));
    assert.equal(outcome.kind, "free-search", "the missing variant fell back to the Scope 1 base");
    assert.match(outcome.kind === "free-search" ? outcome.reason : "", /could not be composed/);
  });

  it("does not let a coarser rule stand in once the flow has answered", () => {
    // The stop is a stop, not merely "this rule declined". A category declaring both a sub-flow and a
    // plain lookup at the base would otherwise resolve to the base by the back door — the same silent
    // downgrade NZC-151 refuses one layer up.
    const outcome = resolveFactorForEntry(inputs({
      rules: [
        { ...businessTravel, suffixCode: "-zz" },
        { kind: "lookup", ruleKey: "fallback-to-base", ordering: 99, factorBase: "diesel-demo" },
      ],
    }));
    assert.equal(outcome.kind, "free-search", "a coarser rule supplied the Scope 1 base after the stop");
  });

  it("does not use a retired suffix, and still does not fall back", () => {
    const outcome = resolveFactorForEntry(inputs({ rules: [{ ...businessTravel, suffixCode: "-x" }] }));
    assert.equal(outcome.kind, "free-search");
    assert.match(outcome.kind === "free-search" ? outcome.reason : "", /left for a person/);
  });

  // ── Composition is the registry's, and the base may be hyphenated ─────────────────────

  it("composes through the registry, so a hyphenated base is not re-parsed", () => {
    // `diesel-demo` + `-b` is `diesel-demo-b`. Split on the last hyphen it would be `diesel` + `-b`, which
    // is an id nobody registered — and every seeded factor ends in something suffix-shaped, so this is the
    // ordinary case rather than an edge one (NZC-145).
    const outcome = resolveFactorForEntry(inputs({}));
    assert.equal(outcome.kind === "resolved" ? outcome.factorId : null, "diesel-demo-b");
    assert.notEqual(outcome.kind === "resolved" ? outcome.factorId : null, "diesel-b");
  });

  // ── Declining without stopping, where nothing was learned ─────────────────────────────

  it("declines without stopping when the referenced flow resolved nothing", () => {
    // Nothing was learned, so there is nothing to protect: the entry carries on to this category's other
    // rules. Distinguishing this from the stop above is what keeps the stop narrow enough to be safe.
    const outcome = resolveFactorForEntry(inputs({
      entry: { unit: "kWh" },
      rules: [businessTravel, { kind: "lookup", ruleKey: "other", ordering: 99, factorBase: "diesel-demo-c" }],
    }));
    assert.equal(outcome.kind === "resolved" ? outcome.factorId : null, "diesel-demo-c",
      "a later rule was blocked even though the flow had learned nothing");
  });

  it("declines when the referenced category's rules were not supplied", () => {
    // "That category has no rules" and "nobody loaded that category" are different, and treating the
    // second as the first would make a loading bug look like a spec decision.
    const outcome = resolveFactorForEntry(inputs({ rulesByCategory: {} }));
    assert.equal(outcome.kind, "free-search");
    assert.match(outcome.kind === "free-search" ? outcome.declined[0]!.reason : "", /were not supplied/);
  });

  it("refuses a cycle rather than looping", () => {
    // The migration refuses a category referencing itself; a longer ring can only be caught here. It
    // declines rather than throwing: a misconfigured spec should leave capture working through the
    // search, not take the surface down.
    const outcome = resolveFactorForEntry(inputs({
      rules: [{ kind: "sub-flow", ruleKey: "a", ordering: 10, subFlowCategory: "B", suffixCode: "-b" }],
      rulesByCategory: {
        B: [{ kind: "sub-flow", ruleKey: "b", ordering: 10, subFlowCategory: "C", suffixCode: "-c" }],
        C: [{ kind: "sub-flow", ruleKey: "c", ordering: 10, subFlowCategory: "B", suffixCode: "-b" }],
      },
    }));
    assert.equal(outcome.kind, "free-search");
  });
});
