import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandDefinitions, isAllowedJobStageTransition, jobWorkflowStages, validateCommand, type CommandContext } from "../src/index";
const context: CommandContext = { organisationId: "org-nzi", actorId: "user-1", principal: "staff", idempotencyKey: "idem-1", correlationId: "corr-1" };
describe("command contracts", () => {
  it("defines adjacent forward and backward transitions for every job family", () => {
    for (const [family, stages] of Object.entries(jobWorkflowStages)) {
      const typedFamily = family as keyof typeof jobWorkflowStages;
      assert.equal(isAllowedJobStageTransition(typedFamily, stages[0]!, stages[1]!), true);
      assert.equal(isAllowedJobStageTransition(typedFamily, stages[1]!, stages[0]!), true);
      assert.equal(isAllowedJobStageTransition(typedFamily, stages[0]!, stages[2]!), false);
    }
  });
  it("validates client and job creation before transport", () => {
    assert.equal(validateCommand("client.create", { name: "", status: "active", sector: "Services", location: "London", owner: "A" }, context).some((issue) => issue.field === "name"), true);
    assert.equal(validateCommand("job.create", { clientId: "c1", family: "crp", title: "CRP", workflowStage: "Setup", owner: "A", startDate: "2026-12-31", dueDate: "2026-01-01" }, context).some((issue) => issue.code === "INVALID_RANGE"), true);
  });
  it("registers each material mutation with permission, transaction and audit action", () => { for (const definition of Object.values(commandDefinitions)) { assert.ok(definition.permission); assert.ok(definition.transaction); assert.ok(definition.auditAction); } });
  it("blocks report publication without the validated precondition", () => assert.ok(validateCommand("report.publish", { reportVersionId: "r1", expectedStatus: "draft" as "validated", manifestVersion: 1, reviewedSnapshotId: "s1" }, context).some((issue) => issue.code === "PRECONDITION")));
  it("requires a reason for manual dataset overrides", () => assert.ok(validateCommand("dataset.override.add", { jobId: "712", scope: "3", datasetId: "d1", reportingFrom: "2024-01-01", reportingTo: "2024-12-31" }, context).some((issue) => issue.field === "reason")));
});
