import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandDefinitions, roleCapabilityGrants, validateCommand, type CommandContext } from "../src";

/**
 * Dedup slice 5 Step B: `factor.applicability.add` and `.retire`, registered. The shape is checked here; whether the factor is a
 * base, exists, and whether the suffix is registered and active are the registry's questions, asked by the handler.
 */
const context = (reason?: string): CommandContext => ({ organisationId: "org", actorId: "ada", principal: "staff", idempotencyKey: "k", correlationId: "c", ...(reason ? { reason } : {}) } as CommandContext);
const codes = (issues: Array<{ field: string; code: string }>) => issues.map((issue) => `${issue.field}:${issue.code}`).sort();

describe("factor.applicability.add / .retire (dedup slice 5 Step B)", () => {
  it("are registered under factor.manage, which only Admin holds; retire needs a reason", () => {
    for (const key of ["factor.applicability.add", "factor.applicability.retire"] as const) {
      assert.equal(commandDefinitions[key].permission, "factor.manage");
      assert.ok(roleCapabilityGrants("admin").some((grant) => grant.capability === "factor.manage"), "Admin holds it");
      assert.ok(!roleCapabilityGrants("consultant").some((grant) => grant.capability === "factor.manage"), "a consultant does not");
    }
    assert.deepEqual([commandDefinitions["factor.applicability.add"].auditAction, commandDefinitions["factor.applicability.retire"].auditAction],
      ["factor.applicability.added", "factor.applicability.retired"]);
    assert.deepEqual([commandDefinitions["factor.applicability.add"].reasonRequired, commandDefinitions["factor.applicability.retire"].reasonRequired], [false, true]);
  });

  it("add: a factor and a registered-looking suffix; labels optional, but never blank or over-long", () => {
    assert.deepEqual(validateCommand("factor.applicability.add", { factorId: "uk-ghg-4_301", suffixCode: "-c" }, context()), []);
    assert.deepEqual(validateCommand("factor.applicability.add", { factorId: "uk-ghg-4_301", suffixCode: "-c", reportLabel: "Commuting: Large Car", label: null }, context()), []);
    assert.deepEqual(codes(validateCommand("factor.applicability.add", { factorId: " ", suffixCode: "" }, context())), ["factorId:REQUIRED", "suffixCode:REQUIRED"]);
    assert.deepEqual(codes(validateCommand("factor.applicability.add", { factorId: "x", suffixCode: "c" }, context())), ["suffixCode:INVALID"]);
    assert.deepEqual(codes(validateCommand("factor.applicability.add", { factorId: "x", suffixCode: "-C" }, context())), ["suffixCode:INVALID"]);
    assert.deepEqual(codes(validateCommand("factor.applicability.add", { factorId: "x", suffixCode: "-c", reportLabel: "  ", label: "y".repeat(301) }, context())), ["label:TOO_LONG", "reportLabel:REQUIRED"]);
  });

  it("retire: the same pair shape, and a reason", () => {
    assert.deepEqual(validateCommand("factor.applicability.retire", { factorId: "x", suffixCode: "-c" }, context("Moved to its own factor.")), []);
    assert.deepEqual(codes(validateCommand("factor.applicability.retire", { factorId: "x", suffixCode: "-c" }, context())), ["reason:REQUIRED"]);
    assert.deepEqual(codes(validateCommand("factor.applicability.retire", { factorId: "", suffixCode: "c" }, context("why"))), ["factorId:REQUIRED", "suffixCode:INVALID"]);
  });
});
