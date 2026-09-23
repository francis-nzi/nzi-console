import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveFactorForEntry, type CategoryVariant, type FactorRule, type MappingInputs } from "../src";

/**
 * Declarative dataset mapping (NZC-149).
 *
 * The assertions that decide whether this works are the ones about **declining**. A resolver that returns
 * the first rule's factor regardless would pass every test written about the cases it should resolve; what
 * separates a mapping from a lookup table that happens to be right is what it does when the rule does not
 * apply, when the dataset lacks the factor, and when the factor disagrees about its own scope.
 */

const REGISTRY: CategoryVariant[] = [
  { suffixCode: "-c", label: "Commuting", ghgCategory: "3.7", description: "", status: "active", sortOrder: 10 },
  { suffixCode: "-b", label: "Business travel", ghgCategory: "3.6", description: "", status: "active", sortOrder: 20 },
  { suffixCode: "-x", label: "Withdrawn", ghgCategory: "3.9", description: "", status: "retired", sortOrder: 30 },
];

const inputs = (over: Partial<MappingInputs>): MappingInputs => ({
  rules: [],
  specGhgCategory: "1",
  entry: {},
  available: [{ factorId: "diesel-demo", scopes: ["1", "3"] }],
  registry: REGISTRY,
  ...over,
});

const lookup = (factorBase: string, ordering = 10): FactorRule =>
  ({ kind: "lookup", ruleKey: `lookup-${factorBase}`, ordering, factorBase });

describe("a category resolves its factor declaratively, or declines to the search (NZC-149)", () => {
  // ── Declining, which is what makes resolving mean anything ────────────────────────────

  it("declines to the free search when the category declares no rules", () => {
    // The additive guarantee: every category that has not been mapped yet behaves exactly as it does
    // today. If this ever returned a factor, rolling the feature out one category at a time would
    // silently change every other category at the same time.
    const outcome = resolveFactorForEntry(inputs({}));
    assert.equal(outcome.kind, "free-search");
    assert.match(outcome.kind === "free-search" ? outcome.reason : "", /declares no factor rules/);
  });

  it("declines when the rule names a factor this dataset does not carry", () => {
    // A dataset without the factor must not stop somebody capturing — and it must say so rather than
    // resolving to something adjacent.
    const outcome = resolveFactorForEntry(inputs({
      rules: [lookup("electricity-demo")],
      available: [{ factorId: "diesel-demo" }],
    }));
    assert.equal(outcome.kind, "free-search");
    assert.deepEqual(outcome.kind === "free-search" ? outcome.declined.map((d) => d.ruleKey) : [],
      ["lookup-electricity-demo"]);
    assert.match(outcome.kind === "free-search" ? outcome.declined[0]!.reason : "", /not in the selected dataset/);
  });

  it("says which rules it considered and why each passed", () => {
    // "Nothing matched" without a reason is the shape of answer that gets read as "the feature is
    // broken", and then somebody turns it off.
    const outcome = resolveFactorForEntry(inputs({
      rules: [lookup("missing-a", 10), lookup("missing-b", 20)],
      available: [],
    }));
    assert.equal(outcome.kind, "free-search");
    const declined = outcome.kind === "free-search" ? outcome.declined : [];
    assert.equal(declined.length, 2, "both rules must be accounted for, not just the first");
    assert.deepEqual(declined.map((entry) => entry.ruleKey), ["lookup-missing-a", "lookup-missing-b"]);
  });

  // ── lookup ─────────────────────────────────────────────────────────────────────────────

  it("resolves a lookup, and takes its category from the spec", () => {
    const outcome = resolveFactorForEntry(inputs({
      rules: [lookup("electricity-demo")],
      specGhgCategory: "2",
      available: [{ factorId: "electricity-demo", scopes: ["2"] }],
    }));
    assert.equal(outcome.kind, "resolved");
    if (outcome.kind !== "resolved") return;
    assert.equal(outcome.factorId, "electricity-demo");
    assert.equal(outcome.scope.authority, "spec-category");
    assert.equal(outcome.scope.ghgCategory, "2");
    assert.equal(outcome.scope.agreement, "agrees");
  });

  it("takes the first matching rule in order, not the first in the array", () => {
    // Ordering is the rule's own, so a row added later can be made to win without renumbering the rest.
    const outcome = resolveFactorForEntry(inputs({
      rules: [lookup("diesel-demo", 20), lookup("gas-demo", 10)],
      available: [{ factorId: "diesel-demo" }, { factorId: "gas-demo" }],
    }));
    assert.equal(outcome.kind === "resolved" ? outcome.factorId : null, "gas-demo");
  });

  // ── basis-branch ───────────────────────────────────────────────────────────────────────

  const vehicleRules: FactorRule[] = [
    { kind: "basis-branch", ruleKey: "fuel", ordering: 10, factorBase: "diesel-demo", basisFieldKey: "unit", basisValue: "litres" },
    { kind: "basis-branch", ruleKey: "distance", ordering: 20, factorBase: "vehicle-km-demo", basisFieldKey: "unit", basisValue: "km" },
  ];
  const vehicles = { rules: vehicleRules, available: [{ factorId: "diesel-demo", scopes: ["1"] }, { factorId: "vehicle-km-demo", scopes: ["1"] }] };

  it("branches on what was captured — litres and kilometres are different calculations", () => {
    // Not two spellings of one quantity: NZC-146 refuses to convert between them precisely because the
    // factor differs, and this is the other half of that.
    const fuel = resolveFactorForEntry(inputs({ ...vehicles, entry: { unit: "litres" } }));
    assert.equal(fuel.kind === "resolved" ? fuel.factorId : null, "diesel-demo");

    const distance = resolveFactorForEntry(inputs({ ...vehicles, entry: { unit: "km" } }));
    assert.equal(distance.kind === "resolved" ? distance.factorId : null, "vehicle-km-demo");
  });

  it("declines every branch while the basis has not been captured", () => {
    // Mid-entry is the common state, and guessing a branch then would attach a factor the user has not
    // chosen — the same defect class as a drawer opening on a row nobody clicked.
    const outcome = resolveFactorForEntry(inputs({ ...vehicles, entry: {} }));
    assert.equal(outcome.kind, "free-search");
    assert.ok((outcome.kind === "free-search" ? outcome.declined : []).every((d) => /not been captured/.test(d.reason)));
  });

  it("matches the basis on case and spacing, and on nothing else", () => {
    assert.equal(resolveFactorForEntry(inputs({ ...vehicles, entry: { unit: " LITRES " } })).kind, "resolved");
    // Not a fuzzy match: 'litre' is not 'litres'. A near-miss resolving would be a wrong factor that
    // looks deliberate.
    assert.equal(resolveFactorForEntry(inputs({ ...vehicles, entry: { unit: "litre" } })).kind, "free-search");
  });

  // ── suffix-variant, and the scopes[] ruling ────────────────────────────────────────────

  it("builds the variant id from the registry and files the row under the suffix's category", () => {
    const outcome = resolveFactorForEntry(inputs({
      rules: [{ kind: "suffix-variant", ruleKey: "commute", ordering: 10, factorBase: "car-demo", suffixCode: "-c" }],
      specGhgCategory: "3",
      available: [{ factorId: "car-demo-c", scopes: ["3.7"] }],
    }));
    assert.equal(outcome.kind, "resolved");
    if (outcome.kind !== "resolved") return;
    assert.equal(outcome.factorId, "car-demo-c");
    assert.equal(outcome.scope.authority, "suffix-variant");
    assert.equal(outcome.scope.ghgCategory, "3.7", "the registry's category, not the spec's '3'");
  });

  it("demotes a factor's scopes[] when it disagrees, and still files under the declared category", () => {
    // The ruling. A suffix exists so that one measured factor can be filed under several categories, so
    // the base's scopes[] cannot be the authority — letting it decide would either forbid the commuting
    // variant of a business-travel factor or silently file a commute under business travel. The second
    // is wrong invisibly, which is worse.
    const outcome = resolveFactorForEntry(inputs({
      rules: [{ kind: "suffix-variant", ruleKey: "commute", ordering: 10, factorBase: "car-demo", suffixCode: "-c" }],
      available: [{ factorId: "car-demo-c", scopes: ["3.6"] }],
    }));
    assert.equal(outcome.kind, "resolved");
    if (outcome.kind !== "resolved") return;
    assert.equal(outcome.scope.ghgCategory, "3.7", "the declared category wins");
    assert.equal(outcome.scope.agreement, "contradicts", "and the disagreement is recorded, not dropped");
    assert.deepEqual(outcome.scope.factorScopes, ["3.6"]);
  });

  it("treats a factor claiming the parent scope as agreement, and one claiming nothing as silence", () => {
    // Most factors are not category-specific. A library listing '3' rather than every category within it
    // is not contradicting anything, and an empty list is not a disagreement either — reporting both as
    // 'contradicts' would make the signal useless by crying wolf on the common case.
    const parent = resolveFactorForEntry(inputs({
      rules: [{ kind: "suffix-variant", ruleKey: "c", ordering: 10, factorBase: "car-demo", suffixCode: "-c" }],
      available: [{ factorId: "car-demo-c", scopes: ["3"] }],
    }));
    assert.equal(parent.kind === "resolved" ? parent.scope.agreement : null, "agrees");

    const silent = resolveFactorForEntry(inputs({
      rules: [{ kind: "suffix-variant", ruleKey: "c", ordering: 10, factorBase: "car-demo", suffixCode: "-c" }],
      available: [{ factorId: "car-demo-c", scopes: [] }],
    }));
    assert.equal(silent.kind === "resolved" ? silent.scope.agreement : null, "silent");
  });

  it("refuses a suffix the registry does not have, rather than inventing one", () => {
    // NZC-145: a suffix is a suffix only because the registry says so. Building 'car-demo-q' here would
    // attach a category nobody registered.
    const outcome = resolveFactorForEntry(inputs({
      rules: [{ kind: "suffix-variant", ruleKey: "bad", ordering: 10, factorBase: "car-demo", suffixCode: "-q" }],
      available: [{ factorId: "car-demo-q" }],
    }));
    assert.equal(outcome.kind, "free-search");
    assert.match(outcome.kind === "free-search" ? outcome.declined[0]!.reason : "", /not in the variant registry/);
  });

  it("does not use a retired suffix for a new entry, even though it still parses", () => {
    // Retirement withholds a suffix from new fan-outs while the factors already carrying it stay
    // readable — one flag could not have answered both questions correctly.
    const outcome = resolveFactorForEntry(inputs({
      rules: [{ kind: "suffix-variant", ruleKey: "old", ordering: 10, factorBase: "car-demo", suffixCode: "-x" }],
      available: [{ factorId: "car-demo-x" }],
    }));
    assert.equal(outcome.kind, "free-search");
    assert.match(outcome.kind === "free-search" ? outcome.declined[0]!.reason : "", /retired/);
  });

  it("falls through a declining rule to a later one that applies", () => {
    // The ordering and the declining have to compose: a specific rule first, a general one behind it.
    const outcome = resolveFactorForEntry(inputs({
      rules: [
        { kind: "basis-branch", ruleKey: "fuel", ordering: 10, factorBase: "diesel-demo", basisFieldKey: "unit", basisValue: "litres" },
        lookup("gas-demo", 20),
      ],
      entry: { unit: "kWh" },
      available: [{ factorId: "diesel-demo" }, { factorId: "gas-demo" }],
    }));
    assert.equal(outcome.kind === "resolved" ? outcome.factorId : null, "gas-demo");
    assert.deepEqual(outcome.kind === "resolved" ? outcome.declined.map((d) => d.ruleKey) : [], ["fuel"]);
  });
});

describe("a rule whose basis comes from an external lookup (NZC-151)", () => {
  const dvlaRule: FactorRule = {
    kind: "enriched", ruleKey: "dvla-diesel", ordering: 5, factorBase: "diesel-demo",
    enrichmentSource: "dvla", enrichmentKeyField: "registrationFinder",
    basisFieldKey: "fuel", basisValue: "diesel",
  };
  const withPlate = { registrationFinder: "AB12CDE" };

  it("resolves from what the lookup returned", () => {
    const outcome = resolveFactorForEntry(inputs({
      rules: [dvlaRule], entry: withPlate,
      enrichment: { dvla: { fuel: "diesel", class: "van", make: "Ford" } },
    }));
    assert.equal(outcome.kind, "resolved");
    assert.equal(outcome.kind === "resolved" ? outcome.factorId : null, "diesel-demo");
  });

  it("stays unresolved when the lookup returns nothing, rather than resolving on something else", () => {
    // **The assertion this rule kind is judged on.** A failed lookup must not become a factor chosen
    // because an external service was down — an answer that is wrong in a way nobody can see.
    //
    // The anti-vacuity half is the second rule: there is something else here that *would* match, so a
    // resolver that treated a null lookup as "no opinion" would return `gas-demo` and this test would
    // catch it. Without that rule the test would pass against a resolver that simply had nothing to
    // fall through to.
    const outcome = resolveFactorForEntry(inputs({
      rules: [dvlaRule, lookup("gas-demo", 20)],
      entry: withPlate,
      enrichment: { dvla: null },
      available: [{ factorId: "diesel-demo" }, { factorId: "gas-demo" }],
    }));
    assert.equal(outcome.kind, "free-search", "a failed lookup must not resolve to the next rule along");
    // Asserted across the list rather than at a fixed index: the coarser rule is now reported as set
    // aside too, and which of the two reasons comes first is not something this test is about.
    assert.ok((outcome.kind === "free-search" ? outcome.declined : [])
      .some((entry) => /returned nothing/.test(entry.reason)),
    "the failed lookup is not reported among the reasons");
  });

  it("distinguishes a lookup that was not performed from one that found nothing", () => {
    // Both decline, and they are different states: one is a half-filled form, the other is a service
    // that answered. Collapsing them would make the honest message impossible to write.
    const notAsked = resolveFactorForEntry(inputs({ rules: [dvlaRule], entry: withPlate }));
    assert.match(notAsked.kind === "free-search" ? notAsked.declined[0]!.reason : "", /has not been performed/);

    const asked = resolveFactorForEntry(inputs({
      rules: [dvlaRule], entry: withPlate, enrichment: { dvla: null },
    }));
    assert.match(asked.kind === "free-search" ? asked.declined[0]!.reason : "", /returned nothing/);
  });

  it("declines before looking when nothing has been entered to look up", () => {
    const outcome = resolveFactorForEntry(inputs({ rules: [dvlaRule], entry: {} }));
    assert.match(outcome.kind === "free-search" ? outcome.declined[0]!.reason : "", /nothing has been entered/);
  });

  it("declines when the lookup answered but not about this attribute", () => {
    const outcome = resolveFactorForEntry(inputs({
      rules: [dvlaRule], entry: withPlate,
      enrichment: { dvla: { fuel: "petrol", class: "car" } },
    }));
    assert.equal(outcome.kind, "free-search");
    assert.match(outcome.kind === "free-search" ? outcome.declined[0]!.reason : "", /says fuel is 'petrol'/);

    // An attribute the lookup simply did not return is its own reason — an electric vehicle has no
    // fuel keyword, and that is not the same as the lookup failing.
    const silent = resolveFactorForEntry(inputs({
      rules: [dvlaRule], entry: withPlate, enrichment: { dvla: { fuel: null, class: "car" } },
    }));
    assert.match(silent.kind === "free-search" ? silent.declined[0]!.reason : "", /returned no 'fuel'/);
  });

  it("never receives the lookup key — only the field that holds it", () => {
    // The boundary NZC-103 draws, asserted rather than described. The rule names `registrationFinder`;
    // the resolver reads whether it is empty and hands nothing onward. Every attribute it matches on
    // came from the caller, who did the lookup.
    const outcome = resolveFactorForEntry(inputs({
      rules: [dvlaRule], entry: { registrationFinder: "AB12CDE" },
      enrichment: { dvla: { fuel: "diesel" } },
    }));
    assert.equal(outcome.kind, "resolved");
    if (outcome.kind !== "resolved") return;
    const asText = JSON.stringify(outcome);
    assert.ok(!asText.includes("AB12CDE"), "the outcome carries the registration");
    assert.equal(outcome.rule.kind === "enriched" ? outcome.rule.enrichmentKeyField : null, "registrationFinder");
  });

  it("is only one source, so another lookup's answer cannot satisfy it", () => {
    const outcome = resolveFactorForEntry(inputs({
      rules: [dvlaRule], entry: withPlate,
      enrichment: { "some-other-service": { fuel: "diesel" } },
    }));
    assert.equal(outcome.kind, "free-search");
    assert.match(outcome.kind === "free-search" ? outcome.declined[0]!.reason : "", /has not been performed/);
  });
});

describe("a consulted lookup is not overruled by a coarser rule (NZC-151)", () => {
  const dvlaDiesel: FactorRule = {
    kind: "enriched", ruleKey: "dvla-diesel", ordering: 5, factorBase: "diesel-demo",
    enrichmentSource: "dvla", enrichmentKeyField: "registrationFinder",
    basisFieldKey: "fuel", basisValue: "diesel",
  };
  const dvlaPetrol: FactorRule = { ...dvlaDiesel, ruleKey: "dvla-petrol", ordering: 6, factorBase: "petrol-demo", basisValue: "petrol" };
  /** The coarser rule company vehicles actually carries: measured in litres, so diesel. */
  const byUnit: FactorRule = {
    kind: "basis-branch", ruleKey: "fuel-litres", ordering: 10, factorBase: "diesel-demo",
    basisFieldKey: "unit", basisValue: "litres",
  };
  const petrolEntry = { registrationFinder: "XY34ZAB", unit: "litres" };
  const bothFactors = [{ factorId: "diesel-demo" }, { factorId: "petrol-demo" }];

  it("leaves a petrol vehicle unresolved when only a diesel rule is declared", () => {
    // The ruled case. The lookup was consulted and said petrol; only diesel is declared. Falling
    // through to `unit = litres → diesel-demo` would file a petrol vehicle against a diesel factor —
    // roughly ten per cent wrong and entirely ordinary-looking on a report.
    const outcome = resolveFactorForEntry(inputs({
      rules: [dvlaDiesel, byUnit], entry: petrolEntry,
      enrichment: { dvla: { fuel: "petrol", class: "car" } },
      available: bothFactors,
    }));
    assert.equal(outcome.kind, "free-search", "a petrol vehicle resolved to the diesel factor");
    assert.match(outcome.kind === "free-search" ? outcome.reason : "", /consulted and matched no rule/);
    // And the coarser rule is reported as set aside, so the reason is legible rather than a silence.
    assert.ok((outcome.kind === "free-search" ? outcome.declined : [])
      .some((entry) => entry.ruleKey === "fuel-litres" && /set aside/.test(entry.reason)));
  });

  it("resolves the same entry once a petrol rule is declared", () => {
    // The pair. Without this, the test above would be satisfied by a resolver that had simply stopped
    // working for enriched rules altogether.
    const outcome = resolveFactorForEntry(inputs({
      rules: [dvlaDiesel, dvlaPetrol, byUnit], entry: petrolEntry,
      enrichment: { dvla: { fuel: "petrol", class: "car" } },
      available: bothFactors,
    }));
    assert.equal(outcome.kind, "resolved");
    if (outcome.kind !== "resolved") return;
    assert.equal(outcome.factorId, "petrol-demo");
    assert.equal(outcome.rule.ruleKey, "dvla-petrol");
  });

  it("reaches a sibling enriched rule, so 'stop' does not mean 'stop at the first decline'", () => {
    // The distinction the filter has to get right: coarser rules are set aside, sibling enriched rules
    // on the same lookup are not. A category with a rule per fuel must still reach the later one.
    const outcome = resolveFactorForEntry(inputs({
      rules: [dvlaDiesel, dvlaPetrol], entry: petrolEntry,
      enrichment: { dvla: { fuel: "petrol" } }, available: bothFactors,
    }));
    assert.equal(outcome.kind === "resolved" ? outcome.rule.ruleKey : null, "dvla-petrol");
  });

  it("does not set anything aside when the lookup was never consulted", () => {
    // The limit of the rule. A consultant who never used the finder is not blocked, and a category
    // whose lookup nobody performed still resolves by its other rules.
    const noPlate = resolveFactorForEntry(inputs({
      rules: [dvlaDiesel, byUnit], entry: { unit: "litres" }, available: bothFactors,
    }));
    assert.equal(noPlate.kind === "resolved" ? noPlate.rule.ruleKey : null, "fuel-litres");

    // A plate typed but no lookup performed yet is also not a consultation — the form is mid-flight.
    const notAsked = resolveFactorForEntry(inputs({
      rules: [dvlaDiesel, byUnit], entry: petrolEntry, available: bothFactors,
    }));
    assert.equal(notAsked.kind === "resolved" ? notAsked.rule.ruleKey : null, "fuel-litres");
  });

  it("sets coarser rules aside for a failed lookup too, which is the same rule", () => {
    const outcome = resolveFactorForEntry(inputs({
      rules: [dvlaDiesel, byUnit], entry: petrolEntry,
      enrichment: { dvla: null }, available: bothFactors,
    }));
    assert.equal(outcome.kind, "free-search");
    assert.match(outcome.kind === "free-search" ? outcome.reason : "", /left for a person to resolve/);
  });
});
