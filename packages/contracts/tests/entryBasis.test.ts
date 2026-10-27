import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandDefinitions, entryBasisOfUnit, entryBasisUnitIssue, isCurrencyUnit, openingEntryBasis, openingEntryBasisSource, seededEntryBasis,
  type CommandContext,
} from "../src/index";

const context = { organisationId: "org", actorId: "u", principal: "staff", idempotencyKey: "k", correlationId: "c" } as CommandContext;

describe("Data entry D1 — the basis rules", () => {
  it("a currency is spend and anything else is activity; no unit says nothing", () => {
    assert.equal(entryBasisOfUnit("GBP"), "spend");
    assert.equal(entryBasisOfUnit("EUR"), "spend");
    for (const unit of ["kWh", "litres", "km", "mi", "tonnes", "passenger.km", "nights", "m²"]) assert.equal(entryBasisOfUnit(unit), "activity", unit);
    assert.equal(entryBasisOfUnit(null), null);
    assert.equal(entryBasisOfUnit(""), null);
    assert.ok(isCurrencyUnit("USD") && !isCurrencyUnit("gbp") && !isCurrencyUnit("kWh"));
  });

  it("the seed: PG&S opens on Spend, every other category on Activity — 3.2 and 3.15 included (settled 27 Oct)", () => {
    assert.equal(seededEntryBasis("3.1"), "spend");
    for (const code of ["3.2", "3.15", "3.6", "1.company-vehicles", "2.purchased-electricity"]) assert.equal(seededEntryBasis(code), "activity", code);
  });

  it("opens on the client's last choice, else the admin default, else the seed — never on Spend where it cannot be chosen", () => {
    assert.equal(openingEntryBasis({ categoryCode: "3.6", spendAvailable: true }), "activity");
    assert.equal(openingEntryBasis({ categoryCode: "3.6", organisationDefault: "spend", spendAvailable: true }), "spend");
    assert.equal(openingEntryBasis({ categoryCode: "3.6", organisationDefault: "spend", clientChoice: "activity", spendAvailable: true }), "activity");
    assert.equal(openingEntryBasis({ categoryCode: "3.1", spendAvailable: true }), "spend");
    assert.equal(openingEntryBasis({ categoryCode: "3.1", spendAvailable: false }), "activity", "no spend factor: Activity, whatever the seed");
    assert.equal(openingEntryBasis({ categoryCode: "3.6", clientChoice: "spend", spendAvailable: false }), "activity");
    assert.equal(openingEntryBasisSource({ clientChoice: "spend", organisationDefault: "activity" }), "client");
    assert.equal(openingEntryBasisSource({ organisationDefault: "activity" }), "organisation");
    assert.equal(openingEntryBasisSource({}), "seed");
  });

  it("a stated basis must agree with the unit", () => {
    assert.equal(entryBasisUnitIssue("spend", "GBP"), null);
    assert.equal(entryBasisUnitIssue("activity", "km"), null);
    assert.equal(entryBasisUnitIssue("spend", null), null, "a draft before its factor has no unit to disagree with");
    assert.match(entryBasisUnitIssue("spend", "km") ?? "", /currency/);
    assert.match(entryBasisUnitIssue("activity", "GBP") ?? "", /spend entry/);
  });

  it("the create validates the basis; the Admin command is admin.settings's and validates its category and basis", () => {
    const create = commandDefinitions["scope.row.create"];
    const base = { jobId: "j", scope: "3.6", categoryCode: "3.6", sourceLabel: "x", quantity: 1, unit: "GBP", datasetId: "d", factorId: "f", factorVersion: null, factorLabel: null, qualityTier: null };
    assert.deepEqual(create.validate({ ...base, entryBasis: "spend" } as never, context).map((issue) => issue.code), []);
    assert.deepEqual(create.validate({ ...base, entryBasis: "activity" } as never, context).map((issue) => issue.code), ["BASIS_UNIT_MISMATCH"]);
    assert.deepEqual(create.validate({ ...base, entryBasis: "money" } as never, context).map((issue) => issue.code), ["INVALID"]);
    const admin = commandDefinitions["admin.entryBasis.update"];
    assert.equal(admin.permission, "admin.settings");
    assert.equal(admin.auditAction, "entry_basis_default_updated");
    assert.deepEqual(admin.validate({ categoryCode: "3.6", defaultBasis: "spend" }, context), []);
    assert.deepEqual(admin.validate({ categoryCode: "9.9", defaultBasis: "both" } as never, context).map((issue) => issue.field), ["categoryCode", "defaultBasis"]);
  });
});
