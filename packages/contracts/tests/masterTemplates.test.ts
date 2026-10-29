import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandDefinitions, commandGrantForRole, groupMasterTemplateRows, masterFactorServes, masterTemplateRowIssues, masterTemplateTitle, validateCommand,
  type CommandContext, type MasterTemplateRow, type MasterTemplateRowInput,
} from "../src/index";

/**
 * Data-entry R1 (0197, ruled 29 Oct 2026) — the master templates' contract: the naming convention, the line shape (a
 * category always; no quantity, site or dataset, refused rather than stripped), the category's activities, and the
 * commands under the catalogue's gate with an archive that says why.
 */
const context = (reason?: string): CommandContext => ({ organisationId: "o", actorId: "a", principal: "staff", idempotencyKey: "k", correlationId: "c",
  grant: commandGrantForRole("admin", "o", "a"), ...(reason ? { reason } : {}) });
const row = (over: Partial<MasterTemplateRowInput> = {}): MasterTemplateRowInput =>
  ({ scope: "2", categoryCode: "2.purchased-electricity", sourceLabel: "Grid electricity", reportLabel: null, factorId: "electricity-uk", unit: "kWh", ...over });
const codes = (rows: unknown) => masterTemplateRowIssues(rows).map((issue) => `${issue.field}:${issue.code}`);

describe("master templates (data-entry R1)", () => {
  it("names a master `Master · <Type>`", () => {
    assert.deepEqual(["Default", "Construction", "Office"].map(masterTemplateTitle), ["Master · Default", "Master · Construction", "Master · Office"]);
  });

  it("takes a curated line — and an empty set, since a master starts empty", () => {
    assert.deepEqual(codes([row(), row({ scope: "3", categoryCode: "3.1", factorId: null, unit: null, sourceLabel: "Purchased goods (spend)" })]), []);
    assert.deepEqual(codes([]), []);
  });

  it("refuses a line with no category, or one of another scope — nothing in a master is to categorise", () => {
    assert.deepEqual(codes([row({ categoryCode: "" as never })]), ["rows[0].categoryCode:REQUIRED"]);
    assert.deepEqual(codes([row({ categoryCode: null as never })]), ["rows[0].categoryCode:REQUIRED"]);
    assert.deepEqual(codes([row({ scope: "1" })]), ["rows[0].categoryCode:CATEGORY_SCOPE"]);
    assert.deepEqual(codes([row({ sourceLabel: "  " })]), ["rows[0].sourceLabel:REQUIRED"]);
  });

  it("refuses a quantity, a site or a dataset outright — a template is a shell, resolved on the job it seeds", () => {
    assert.deepEqual(codes([{ ...row(), quantity: 1200 }]), ["rows[0].quantity:QUANTITY_NOT_HELD"]);
    assert.deepEqual(codes([{ ...row(), quantity: null }]), ["rows[0].quantity:QUANTITY_NOT_HELD"], "even an empty one: the key is not part of a master line");
    assert.deepEqual(codes([{ ...row(), monthlyActivity: [] }]), ["rows[0].monthlyActivity:QUANTITY_NOT_HELD"]);
    assert.deepEqual(codes([{ ...row(), siteId: "site-hq" }, { ...row(), datasetId: "desnz-2026" }]), ["rows[0].siteId:NOT_HELD", "rows[1].datasetId:NOT_HELD"]);
  });

  it("offers a category the factors whose scopes carry it — the bare scope for 1 and 2, the category's own code for Scope 3", () => {
    const electricity = { scopes: ["2"] }, travel = { scopes: ["3.6"] }, both = { scopes: ["1", "3.3"] };
    assert.equal(masterFactorServes(electricity, { scope: "2", categoryCode: "2.purchased-electricity" }), true);
    assert.equal(masterFactorServes(travel, { scope: "3", categoryCode: "3.6" }), true);
    assert.equal(masterFactorServes(travel, { scope: "3", categoryCode: "3.7" }), false);
    assert.equal(masterFactorServes(both, { scope: "3", categoryCode: "3.3" }), true);
    assert.equal(masterFactorServes(electricity, { scope: "3", categoryCode: null }), false, "no category, no activities");
  });

  it("groups the lines by scope, then category, in order", () => {
    const read = (over: Partial<MasterTemplateRow>): MasterTemplateRow => ({ ...row(), rowId: String(over.ordering), ordering: 0, categoryName: null, factorLabel: null, ...over });
    const grouped = groupMasterTemplateRows([read({ ordering: 2, scope: "1", categoryCode: "1.natural-gas" }), read({ ordering: 0 }), read({ ordering: 1, scope: "1", categoryCode: "1.refrigerants" })]);
    assert.deepEqual(grouped.map((group) => [group.scope, group.categories.map((category) => category.categoryCode)]), [["1", ["1.refrigerants", "1.natural-gas"]], ["2", ["2.purchased-electricity"]]]);
  });

  it("puts every command under admin.lookups; an archive needs its reason; each write after the create names a version", () => {
    for (const key of ["master.template.create", "master.template.rename", "master.template.archive", "master.template.reinstate", "master.template.rows.set"] as const) {
      assert.equal(commandDefinitions[key].permission, "admin.lookups", key);
      assert.equal(commandDefinitions[key].reasonRequired, key === "master.template.archive", key);
    }
    assert.ok(validateCommand("master.template.archive", { masterId: "m", expectedVersion: 1 }, context()).some((issue) => issue.field === "reason"));
    assert.deepEqual(validateCommand("master.template.archive", { masterId: "m", expectedVersion: 1 }, context("Superseded by Office")), []);
    assert.ok(validateCommand("master.template.rows.set", { masterId: "m", expectedVersion: 0, rows: [] }, context()).some((issue) => issue.field === "expectedVersion"));
    assert.ok(validateCommand("master.template.create", { name: " " }, context()).some((issue) => issue.field === "name"));
    assert.ok(validateCommand("master.template.rename", { masterId: "m", expectedVersion: 1, name: "x".repeat(81) }, context()).some((issue) => issue.code === "TOO_LONG"));
  });
});
