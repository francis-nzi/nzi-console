import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveFactorForEntry, type CategoryVariant, type FactorRule, type MappingInputs, type UnitReconciler } from "../src";

/**
 * A resolved factor must reconcile with the unit the entry was captured in, or the rule declines (NZC-160 D2).
 *
 * The characterisation found `dvla-diesel` resolving a diesel vehicle recorded in **km** to a **per-litre**
 * factor: the enriched rule reads fuel, never unit. Ruled: when the units do not reconcile, decline — and the
 * decline goes to the search, a person's pick, never to a coarser rule or the ILIKE matcher.
 *
 * The unit logic itself lives in the backend (`checkUnit`); the resolver is pure, so the caller hands it in.
 * What must not happen is that a caller who forgets to is quietly waved through — so an entry carrying a unit,
 * checked by nothing, declines. Failing towards the search is the direction every other rule here takes.
 */

// A stand-in for checkUnit: identical units reconcile, kWh and MWh convert, everything else is refused.
const reconcileUnit: UnitReconciler = (entered, factorUnit) => {
  const same = entered.trim().toLowerCase() === factorUnit.trim().toLowerCase();
  const energy = new Set(["kwh", "mwh"]);
  if (same || (energy.has(entered.toLowerCase()) && energy.has(factorUnit.toLowerCase()))) return { ok: true };
  return { ok: false, reason: `'${entered}' and '${factorUnit}' measure different things` };
};

const registry: CategoryVariant[] = [
  { suffixCode: "-b", label: "Business travel", ghgCategory: "3.6", description: "", status: "active", sortOrder: 1 },
];
const available = [
  { factorId: "diesel-demo", scopes: ["1"], unit: "litres" },
  { factorId: "diesel-demo-b", scopes: ["3"], unit: "litres" },
  { factorId: "car-diesel-km", scopes: ["1"], unit: "km" },
  { factorId: "electricity-demo", scopes: ["2"], unit: "kWh" },
];
const vehicleRules: FactorRule[] = [
  { kind: "enriched", ruleKey: "dvla-diesel", ordering: 5, factorBase: "diesel-demo",
    enrichmentSource: "dvla", enrichmentKeyField: "registrationFinder", basisFieldKey: "fuel", basisValue: "diesel" },
  { kind: "basis-branch", ruleKey: "fuel-litres", ordering: 10, factorBase: "diesel-demo", basisFieldKey: "unit", basisValue: "litres" },
];
const plated = (unit: string | null): Partial<MappingInputs> => ({
  entry: { registrationFinder: "AB12CDH", unit },
  enrichment: { dvla: { fuel: "diesel", class: "van" } },
});
const resolve = (over: Partial<MappingInputs>) => resolveFactorForEntry({
  rules: vehicleRules, specGhgCategory: "1", entry: {}, available, registry, reconcileUnit, ...over,
});
const factorOf = (outcome: ReturnType<typeof resolveFactorForEntry>) => outcome.kind === "resolved" ? outcome.factorId : null;

describe("a resolved factor reconciles with the entry's unit, or declines to the search (D2)", () => {
  it("declines a diesel vehicle recorded in km, rather than pricing kilometres per litre", () => {
    const outcome = resolve(plated("km"));
    assert.equal(outcome.kind, "free-search", "a per-litre factor was applied to a km entry");
    assert.ok(outcome.declined.some((decline) => decline.ruleKey === "dvla-diesel" && /km/.test(decline.reason)),
      "the decline does not say the unit was the reason");
  });

  it("never lets the coarser unit rule stand in once the lookup was consulted", () => {
    // fuel-litres would match nothing here anyway (km), but the property is the consultation filter: a
    // consulted lookup that declines leaves the entry for a person, never for a less specific rule.
    const outcome = resolve(plated("km"));
    assert.equal(factorOf(outcome), null);
    assert.ok(outcome.declined.some((decline) => decline.ruleKey === "fuel-litres" && /set aside/.test(decline.reason)));
  });

  it("still resolves the same vehicle recorded in litres", () => {
    assert.equal(factorOf(resolve(plated("litres"))), "diesel-demo");
  });

  it("resolves when no unit has been captured yet — there is nothing entered for the factor to contradict", () => {
    assert.equal(factorOf(resolve(plated(null))), "diesel-demo");
    assert.equal(factorOf(resolve(plated(""))), "diesel-demo");
  });

  it("accepts a unit the check can convert", () => {
    const outcome = resolveFactorForEntry({
      rules: [{ kind: "lookup", ruleKey: "grid", ordering: 10, factorBase: "electricity-demo" }],
      specGhgCategory: "2", entry: { unit: "MWh" }, available, registry, reconcileUnit,
    });
    assert.equal(factorOf(outcome), "electricity-demo");
  });

  it("lets an unconsulted rule that declines on unit fall through to one whose unit reconciles", () => {
    // Additive, as every decline is when nothing more specific was consulted.
    const outcome = resolveFactorForEntry({
      rules: [
        { kind: "lookup", ruleKey: "per-litre", ordering: 10, factorBase: "diesel-demo" },
        { kind: "lookup", ruleKey: "per-km", ordering: 20, factorBase: "car-diesel-km" },
      ],
      specGhgCategory: "1", entry: { unit: "km" }, available, registry, reconcileUnit,
    });
    assert.equal(factorOf(outcome), "car-diesel-km");
    assert.ok(outcome.declined.some((decline) => decline.ruleKey === "per-litre"));
  });

  it("declines through a sub-flow too, so business travel in km is not priced per litre", () => {
    const outcome = resolveFactorForEntry({
      rules: [{ kind: "sub-flow", ruleKey: "road", ordering: 10, subFlowCategory: "1.company-vehicles", suffixCode: "-b" }],
      specGhgCategory: "3", ...plated("km"), available, registry, reconcileUnit,
      rulesByCategory: { "1.company-vehicles": vehicleRules },
    } as MappingInputs);
    assert.equal(outcome.kind, "free-search");
    assert.equal(factorOf(outcome), null);
  });

  // ── The fail-safe direction: an entry with a unit that nothing checked is declined, not waved through ──

  it("declines when the caller supplied no unit check", () => {
    const outcome = resolveFactorForEntry({
      rules: vehicleRules, specGhgCategory: "1", ...plated("litres"), available, registry,
    } as MappingInputs);
    assert.equal(outcome.kind, "free-search", "an unchecked unit was waved through");
    assert.ok(outcome.declined.some((decline) => /could not be checked/.test(decline.reason)));
  });

  it("declines when the factor's own unit is not known", () => {
    const outcome = resolve({ ...plated("litres"), available: available.map(({ unit: _unit, ...rest }) => rest) });
    assert.equal(outcome.kind, "free-search", "a factor of unknown unit was accepted against a captured unit");
  });
});
