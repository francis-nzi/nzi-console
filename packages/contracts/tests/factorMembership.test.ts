import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  categoriesForLevels, commandDefinitions, familylessCategories, isUnfiled, levelsAreFiled, membersOfCategory, normaliseLevel, parseFactorId, roleCapabilityGrants, ruleMatches,
  validateCommand, variantCategoryCode, type CategoryVariant, type CommandContext, type MembershipRule,
} from "../src";

/**
 * NZC-171, ruled: a factor belongs to the categories its DESNZ family is filed under. The rule is pure and tested here; the seeded map and
 * the read that applies it are tested against a real Postgres (factorCategoryMembershipReal).
 */
const rule = (sourceL1: string, sourceL2: string | null, sourceL3: string | null, categoryCode: string | null): MembershipRule => ({ sourceL1, sourceL2, sourceL3, categoryCode });
const RULES: MembershipRule[] = [
  rule("Business travel- land", null, null, "3.6"), rule("Business travel- land", null, null, "3.7"), rule("Business travel- air", null, null, "3.6"),
  rule("Freighting goods", null, null, "3.4"), rule("Freighting goods", null, null, "3.9"),
  rule("Fuels", "Gaseous fuels", "Natural gas", "1.natural-gas"), rule("Fuels", "Gaseous fuels", "LPG", "1.other-stationary-fuels"),
  rule("Heat and steam", null, null, null),
];
const variant = (suffixCode: string, ghgCategory: string): CategoryVariant => ({ suffixCode, label: suffixCode, ghgCategory, description: "", status: "active", sortOrder: 0 });
const REGISTRY = [variant("-c", "3.7"), variant("-b", "3.6"), variant("-vcd", "1")];
const parse = (factorId: string) => parseFactorId(factorId, REGISTRY);
const context = (reason?: string): CommandContext => ({ organisationId: "org", actorId: "ada", principal: "staff", idempotencyKey: "k", correlationId: "c", ...(reason ? { reason } : {}) } as CommandContext);
const codes = (issues: Array<{ field: string; code: string }>) => issues.map((issue) => `${issue.field}:${issue.code}`).sort();

describe("the membership key", () => {
  it("compares case-insensitively with whitespace collapsed - the source carries double spaces and newlines", () => {
    assert.equal(normaliseLevel("  Central  \n government "), "central government");
    assert.ok(ruleMatches(rule("Central government", null, null, "3.1"), ["Central \n government"]));
    assert.ok(ruleMatches(rule("business travel- LAND", null, null, "3.6"), ["Business travel- land", "Cars (by size)"]));
  });

  it("an absent level is any; a named level narrows - and a rule never claims an empty path", () => {
    assert.deepEqual(categoriesForLevels(RULES, ["Business travel- land", "Cars (by size)"]), ["3.6", "3.7"]);
    assert.deepEqual(categoriesForLevels(RULES, ["Business travel- air", "Flights"]), ["3.6"], "air is business travel alone");
    assert.deepEqual(categoriesForLevels(RULES, ["Fuels", "Gaseous fuels", "Natural gas"]), ["1.natural-gas"]);
    assert.deepEqual(categoriesForLevels(RULES, ["Fuels", "Gaseous fuels", "LPG"]), ["1.other-stationary-fuels"]);
    assert.deepEqual(categoriesForLevels(RULES, ["Fuels", "Gaseous fuels", "Butane"]), [], "a gas the map does not know is not filed by its neighbours");
    assert.equal(ruleMatches(rule("", null, null, "3.1"), []), false);
  });

  it("a family held back is known (filed) but belongs to no category", () => {
    assert.deepEqual(categoriesForLevels(RULES, ["Heat and steam", "Heat and steam"]), []);
    assert.equal(levelsAreFiled(RULES, ["Heat and steam"]), true);
    assert.equal(levelsAreFiled(RULES, ["Hovercraft"]), false);
  });

  it("a category no rule names has no family of its own", () => {
    assert.ok(familylessCategories(RULES).includes("3.10") && familylessCategories(RULES).includes("3.14"));
    assert.ok(!familylessCategories(RULES).includes("3.7"));
  });
});

describe("membersOfCategory", () => {
  const FACTORS = [
    { factorId: "car", activityUnit: "miles", sourceLevels: ["Business travel- land", "Cars (by size)"] },
    { factorId: "car-c", activityUnit: "miles", sourceLevels: ["Employee commuting- land", "Cars (by size)"] },
    { factorId: "flight", activityUnit: "passenger.km", sourceLevels: ["Business travel- air", "Flights"] },
    { factorId: "ship", activityUnit: "tonne.km", sourceLevels: ["Freighting goods", "Cargo ship"] },
    { factorId: "spend", activityUnit: "GBP", sourceLevels: ["Legal services"] },
    { factorId: "spend-b", activityUnit: "GBP", sourceLevels: ["Legal services"] },
    { factorId: "mystery", activityUnit: "kg", sourceLevels: ["Hovercraft"] },
    { factorId: "diesel-vcd", activityUnit: "litres", sourceLevels: ["Fuels", "Liquid fuels"] },
  ];
  const members = (categoryCode: string, paired: Record<string, string[]> = {}) => membersOfCategory({
    categoryCode, rules: [...RULES, rule("Employee commuting- land", null, null, "3.7"), rule("Legal", null, null, "3.1")], factors: FACTORS, parse,
    pairedCategories: (base) => (paired[base] ? new Set(paired[base]) : undefined),
  });

  it("offers a category the factors whose family maps to it, and no other category's", () => {
    assert.deepEqual(members("3.7"), ["car", "car-c"], "the business-travel car serves commuting; the flight and the ship do not");
    assert.deepEqual(members("3.6"), ["car", "flight", "spend-b"], "and its own -b variant");
    assert.deepEqual(members("3.4"), ["ship"]);
    assert.ok(!members("3.4")!.includes("car") && !members("3.7")!.includes("ship"), "freight never under commuting; commuting never under freight");
  });

  it("a variant belongs to the category its suffix names, a vehicle suffix to Company Vehicles - and a pair adds a base to its category", () => {
    assert.equal(variantCategoryCode(variant("-vcd", "1")), "1.company-vehicles");
    assert.deepEqual(members("3.6", { spend: ["3.6"] }), ["car", "flight", "spend", "spend-b"], "the pair adds the base; the -b variant is business travel's by its suffix");
    assert.ok(!members("3.1")!.includes("spend-b") && !members("3.7")!.includes("spend-b"), "a -b copy is business travel's and nobody else's, whatever its base's family");
  });

  it("spend belongs to the spend categories, and to the category a pair names", () => {
    assert.deepEqual(members("3.1"), ["spend"], "Rule S: 3.1 is a spend category");
    assert.ok(!members("3.4")!.includes("spend"), "3.4 is not, unless a pair files it there");
    assert.ok(members("3.4", { spend: ["3.4"] })!.includes("spend"));
  });

  it("a category with no rule has no list to enforce (null): the caller offers the scope, with a notice", () => {
    assert.equal(members("3.10"), null);
    assert.equal(members("3.14"), null);
  });

  it("unfiled: a physical, unvarianted, unpaired factor no rule claims - never a spend factor, a variant or a paired base", () => {
    const unfiled = (factorId: string, paired = false) => isUnfiled(FACTORS.find((factor) => factor.factorId === factorId)!, RULES, parse, paired);
    assert.equal(unfiled("mystery"), true);
    assert.equal(unfiled("mystery", true), false, "a pair files it");
    assert.equal(unfiled("spend"), false);
    assert.equal(unfiled("car"), false);
    assert.equal(isUnfiled({ factorId: "x-c", activityUnit: "kg", sourceLevels: [] }, RULES, parse, false), false, "a variant says what it is");
  });
});

describe("factor.membership.add / .retire", () => {
  it("are registered under factor.manage, which only Admin holds; retire needs a reason", () => {
    for (const key of ["factor.membership.add", "factor.membership.retire"] as const) {
      assert.equal(commandDefinitions[key].permission, "factor.manage");
      assert.ok(roleCapabilityGrants("admin").some((grant) => grant.capability === "factor.manage"));
      assert.ok(!roleCapabilityGrants("consultant").some((grant) => grant.capability === "factor.manage"));
    }
    assert.deepEqual([commandDefinitions["factor.membership.add"].reasonRequired, commandDefinitions["factor.membership.retire"].reasonRequired], [false, true]);
    assert.deepEqual([commandDefinitions["factor.membership.add"].auditAction, commandDefinitions["factor.membership.retire"].auditAction], ["factor.membership.added", "factor.membership.retired"]);
  });

  it("validates: a family, a category in the taxonomy (or none, to hold it back), levels in order", () => {
    assert.deepEqual(validateCommand("factor.membership.add", { sourceL1: "Freighting goods", categoryCode: "3.4" }, context()), []);
    assert.deepEqual(validateCommand("factor.membership.add", { sourceL1: "Heat and steam", categoryCode: null }, context()), []);
    assert.deepEqual(codes(validateCommand("factor.membership.add", { sourceL1: " ", categoryCode: "3.4" }, context())), ["sourceL1:REQUIRED"]);
    assert.deepEqual(codes(validateCommand("factor.membership.add", { sourceL1: "x", categoryCode: "9.9" }, context())), ["categoryCode:INVALID"]);
    assert.deepEqual(codes(validateCommand("factor.membership.add", { sourceL1: "x", sourceL3: "y", categoryCode: "3.4" }, context())), ["sourceL3:INVALID"]);
    assert.deepEqual(codes(validateCommand("factor.membership.add", { sourceL1: "x", categoryCode: "3.4", note: "n".repeat(301) }, context())), ["note:TOO_LONG"]);
    assert.ok(codes(validateCommand("factor.membership.retire", { sourceL1: "x", categoryCode: "3.4" }, context())).some((issue) => issue.startsWith("reason:")), "a retirement states its reason");
    assert.deepEqual(validateCommand("factor.membership.retire", { sourceL1: "x", categoryCode: "3.4" }, context("Filed in error")), []);
  });
});
