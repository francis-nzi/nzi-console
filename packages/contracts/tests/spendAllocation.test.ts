import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandDefinitions, normaliseDescription, normaliseGlCode, routeSpendLine, rowScopeForCategory, spendAllocationKey, spendRoutingLabel, vatAppliesByDefault,
  type CommandContext, type SpendAllocationEntry,
} from "../src/index";

const context = { organisationId: "org", actorId: "u", principal: "staff", idempotencyKey: "k", correlationId: "c" } as CommandContext;
const entry = (over: Partial<SpendAllocationEntry>): SpendAllocationEntry => ({
  allocationId: "a", keyKind: "gl", matchKey: "7420", targetCategoryCode: "3.15", vatApplies: false, defaultDatasetId: null, defaultFactorId: null, ...over,
});

describe("Data entry D2 — the allocation map's keys and routing", () => {
  it("a GL code is one code however it is spaced or cased; a description drops digits and punctuation", () => {
    assert.equal(normaliseGlCode(" 74 20 "), "7420");
    assert.equal(normaliseGlCode("gl-7420a"), "GL-7420A");
    assert.equal(normaliseGlCode("   "), null);
    assert.equal(normaliseDescription("Pensions admin — Q1 2025"), "pensions admin q");
    assert.equal(normaliseDescription("PENSIONS ADMIN, Q2"), "pensions admin q");
    assert.equal(normaliseDescription("2025 / 03"), null);
  });

  it("a line is keyed by its GL code where it has one, else its description (R1)", () => {
    assert.deepEqual(spendAllocationKey({ glCode: "7420", description: "Pensions" }), { kind: "gl", key: "7420" });
    assert.deepEqual(spendAllocationKey({ glCode: "", description: "Fuel card — fleet" }), { kind: "description", key: "fuel card fleet" });
    assert.equal(spendAllocationKey({ glCode: null, description: "" }), null);
  });

  it("routes by GL code, else description, else the PG&S residual; an unknown GL code never falls back to the description (R2/R3)", () => {
    const map = [entry({}), entry({ allocationId: "b", keyKind: "description", matchKey: "fuel card fleet", targetCategoryCode: "1.company-vehicles", vatApplies: true })];
    assert.deepEqual(routeSpendLine(map, { glCode: "74 20", description: "x" }), { categoryCode: "3.15", by: "gl", vatApplies: false, allocationId: "a", defaultDatasetId: null, defaultFactorId: null });
    assert.equal(routeSpendLine(map, { description: "FUEL CARD - FLEET 03" }).categoryCode, "1.company-vehicles");
    assert.equal(routeSpendLine(map, { glCode: "9999", description: "Fuel card fleet" }).by, "residual", "the GL code is the client's own classification");
    assert.deepEqual(routeSpendLine([], { glCode: "1" }), { categoryCode: "3.1", by: "residual", vatApplies: true, allocationId: null, defaultDatasetId: null, defaultFactorId: null });
  });

  it("VAT applies by default, except Investments (R6); a row's scope for a category is granular in Scope 3", () => {
    assert.equal(vatAppliesByDefault("3.15"), false);
    for (const code of ["3.1", "3.6", "1.company-vehicles"]) assert.equal(vatAppliesByDefault(code), true);
    assert.equal(rowScopeForCategory("3.15"), "3.15");
    assert.equal(rowScopeForCategory("1.company-vehicles"), "1");
    assert.equal(rowScopeForCategory("9.9"), null);
    assert.match(spendRoutingLabel({ categoryCode: "3.1", by: "residual" }), /PG&S residual/);
    assert.match(spendRoutingLabel({ categoryCode: "3.15", by: "gl" }), /Investments \(3\.15\) — this client's map, by GL code/);
  });

  it("the map's commands are admin.lookups's; the move at review is scoperow.edit's; each validates its fields", () => {
    for (const key of ["spend_allocation.create", "spend_allocation.update", "spend_allocation.archive", "spend_allocation.reinstate"] as const) assert.equal(commandDefinitions[key].permission, "admin.lookups", key);
    assert.equal(commandDefinitions["scope.row.reallocate"].permission, "scoperow.edit");
    assert.equal(commandDefinitions["scope.row.reallocate"].auditAction, "scope_row_reallocated");
    const create = commandDefinitions["spend_allocation.create"];
    assert.deepEqual(create.validate({ clientId: "c", keyKind: "gl", key: "7420", targetCategoryCode: "3.15", vatApplies: false }, context), []);
    assert.deepEqual(create.validate({ clientId: "c", keyKind: "account", key: "", targetCategoryCode: "9.9", vatApplies: "yes", defaultDatasetId: "d" } as never, context).map((issue) => issue.field).sort(),
      ["defaultFactorId", "key", "keyKind", "targetCategoryCode", "vatApplies"]);
    const move = commandDefinitions["scope.row.reallocate"];
    assert.deepEqual(move.validate({ jobId: "j", rowId: "r", expectedVersion: 1, categoryCode: "3.6" }, context), []);
    assert.deepEqual(move.validate({ jobId: "j", rowId: "r", expectedVersion: 1, categoryCode: "3.6", datasetId: "d" }, context).map((issue) => issue.code), ["PAIRED"]);
  });
});
