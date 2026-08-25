import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandDefinitions, validateCommand, type CommandContext } from "../src/index";
const context: CommandContext = { organisationId: "org-nzi", actorId: "user-1", principal: "staff", idempotencyKey: "idem-1", correlationId: "corr-1" };
describe("command contracts", () => {
  it("registers each material mutation with permission, transaction and audit action", () => { for (const definition of Object.values(commandDefinitions)) { assert.ok(definition.permission); assert.ok(definition.transaction); assert.ok(definition.auditAction); } });
  it("blocks report publication without the validated precondition", () => assert.ok(validateCommand("report.publish", { reportVersionId: "r1", expectedStatus: "draft" as "validated", manifestVersion: 1, reviewedSnapshotId: "s1" }, context).some((issue) => issue.code === "PRECONDITION")));
  it("requires a reason for manual dataset overrides", () => assert.ok(validateCommand("dataset.override.add", { jobId: "712", scope: "3", datasetId: "d1", reportingFrom: "2024-01-01", reportingTo: "2024-12-31" }, context).some((issue) => issue.field === "reason")));
});
