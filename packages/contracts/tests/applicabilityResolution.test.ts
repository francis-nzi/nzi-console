import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { categoryGhgOf, filedSuffixFor, resolveFactorForEntry, type ApplicabilityLookup, type CategoryVariant, type FactorRule, type MappingInputs } from "../src";

/**
 * Dedup slice 3: a (base, category) pair resolved by applicability — the base's own value, filed under the category — instead of by
 * the existence of a `<base><suffix>` row. Supplied applicability is the flag's path; absent, every outcome is today's (the
 * existing sub-flow suite runs without it and is unchanged).
 */
const REGISTRY: CategoryVariant[] = [
  { suffixCode: "-c", label: "Commuting", ghgCategory: "3.7", description: "", status: "active", sortOrder: 10 },
  { suffixCode: "-b", label: "Business travel", ghgCategory: "3.6", description: "", status: "active", sortOrder: 20 },
  { suffixCode: "-d", label: "Downstream", ghgCategory: "3.9", description: "", status: "active", sortOrder: 50 },
  { suffixCode: "-bcp", label: "Business travel, petrol car", ghgCategory: "3.6", description: "", status: "active", sortOrder: 110 },
  { suffixCode: "-x", label: "Withdrawn", ghgCategory: "3.4", description: "", status: "retired", sortOrder: 30 },
];
const VEHICLE_RULES: FactorRule[] = [
  { kind: "basis-branch", ruleKey: "fuel-litres", ordering: 10, factorBase: "diesel", basisFieldKey: "unit", basisValue: "litres" },
];
const commuting: FactorRule = { kind: "sub-flow", ruleKey: "car-via-vehicle-flow", ordering: 10, subFlowCategory: "1.company-vehicles", suffixCode: "-c" };
const lookup = (entries: Record<string, string[]>): ApplicabilityLookup => (base) => (entries[base] ? new Set(entries[base]) : undefined);

const inputs = (over: Partial<MappingInputs>): MappingInputs => ({
  rules: [commuting], specGhgCategory: "3", entry: { unit: "litres" },
  available: [{ factorId: "diesel", scopes: ["1", "3"], unit: "litres" }],
  registry: REGISTRY, rulesByCategory: { "1.company-vehicles": VEHICLE_RULES }, reconcileUnit: () => ({ ok: true }), ...over,
});

describe("resolving a (base, category) pair by applicability (dedup slice 3)", () => {
  it("files the base under the category when the category is applicable — no variant row needed", () => {
    const outcome = resolveFactorForEntry(inputs({ applicability: lookup({ diesel: ["-c"] }) }));
    assert.equal(outcome.kind, "resolved");
    if (outcome.kind !== "resolved") return;
    assert.equal(outcome.factorId, "diesel", "the base itself, priced off its own value");
    assert.equal(outcome.filedSuffixCode, "-c");
    assert.equal(outcome.scope.ghgCategory, "3.7", "filed under commuting");
  });

  it("stops — never falls to the base — when the category is not applicable (D1, as applicability)", () => {
    const outcome = resolveFactorForEntry(inputs({ applicability: lookup({ diesel: ["-b"] }) }));
    assert.equal(outcome.kind, "free-search");
    if (outcome.kind === "free-search") assert.match(outcome.reason, /could not be composed|rather than filed against the base/);
    assert.equal(resolveFactorForEntry(inputs({ applicability: lookup({}) })).kind, "free-search", "no applicability at all: stops too");
  });

  it("off the flag's path (no applicability supplied) a missing variant row still stops, exactly as today", () => {
    assert.equal(resolveFactorForEntry(inputs({})).kind, "free-search");
    const withRow = resolveFactorForEntry(inputs({ available: [{ factorId: "diesel", scopes: ["1", "3"], unit: "litres" }, { factorId: "diesel-c", scopes: ["3"], unit: "litres" }] }));
    assert.ok(withRow.kind === "resolved" && withRow.factorId === "diesel-c" && withRow.filedSuffixCode === undefined, "the variant row, with no pair recorded");
  });

  it("filedSuffixFor: the category's applicable suffix for a base, never for a variant id, never a retired suffix", () => {
    const applicability = lookup({ car: ["-c", "-b", "-bcp"], ship: ["-d"], lorry: ["-x"] });
    const filed = (factorId: string, categoryCode: string) => filedSuffixFor({ factorId, categoryCode, applicability, registry: REGISTRY });
    assert.equal(filed("car", "3.7"), "-c");
    assert.equal(filed("car", "3.6"), "-b", "two business-travel suffixes: the registry's first by its stated order");
    assert.equal(filed("ship", "3.9"), "-d", "downstream freight off the one base");
    assert.equal(filed("ship", "3.4"), null, "upstream: the base used natively, no pair");
    assert.equal(filed("lorry", "3.4"), null, "a retired suffix files nothing");
    assert.equal(filed("car-c", "3.7"), null, "a variant id already says what it is");
    // Even if applicability were (wrongly) recorded on a variant id — 0170's trigger refuses it — a variant is never filed again.
    assert.equal(filedSuffixFor({ factorId: "car-c", categoryCode: "3.7", applicability: lookup({ "car-c": ["-c"] }), registry: REGISTRY }), null);
    assert.equal(filed("unknown", "3.7"), null);
    assert.deepEqual(["3.7", "3.10", "1.company-vehicles", "2.purchased-electricity"].map(categoryGhgOf), ["3.7", "3.10", "1", "2"]);
  });
});
