import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandDefinitions, commandGrantForRole, v7ImportBatchResumeIssues, v7ImportBatchStartIssues, validateCommand, type CommandContext,
  type V7ImportBatchResumeInput, type V7ImportBatchStartInput } from "../src/index";

/** The import, server-side, Phase E: a batch names the client (and, to resume, the run). Nothing else; no reason needed. */
const RUN = "v7-batch-00000000-0000-4000-8000-000000000000";
const start = (input: unknown) => v7ImportBatchStartIssues(input as V7ImportBatchStartInput).map((issue) => issue.code);
const resume = (input: unknown) => v7ImportBatchResumeIssues(input as V7ImportBatchResumeInput).map((issue) => issue.code);
const context: CommandContext = { organisationId: "org-a", actorId: "staff-admin", principal: "staff", idempotencyKey: "k", correlationId: "c",
  grant: commandGrantForRole("admin", "org-a", "staff-admin") };

describe("import.refreshBatch — the inputs, closed", () => {
  it("start names the client; resume names the client and a batch run id", () => {
    assert.deepEqual(start({ clientId: "c1" }), []);
    assert.deepEqual(start({}), ["REQUIRED"]);
    assert.deepEqual(resume({ clientId: "c1", runId: RUN }), []);
    assert.deepEqual(resume({ clientId: "c1", runId: "v7-reingest-x" }), ["INVALID"]);
    assert.deepEqual(resume({ runId: RUN }), ["REQUIRED"]);
  });
  it("anything else is refused, the key named and its value never", () => {
    const [issue] = v7ImportBatchStartIssues({ clientId: "c1", jobs: ["secret-job"] } as unknown as V7ImportBatchStartInput);
    assert.equal(issue?.code, "UNKNOWN_FIELD");
    assert.ok(!issue!.message.includes("secret-job"));
    assert.deepEqual(resume({ clientId: "c1", runId: RUN, force: true }), ["UNKNOWN_FIELD"]);
  });
  it("both are import.refresh_batch, need no reason (each commit carries the fast path's own), and validate as commands", () => {
    for (const key of ["import.refreshBatch.start", "import.refreshBatch.resume"] as const) {
      assert.equal(commandDefinitions[key].permission, "import.refresh_batch");
      assert.equal(commandDefinitions[key].reasonRequired, false);
    }
    assert.deepEqual(validateCommand("import.refreshBatch.start", { clientId: "c1" }, context), []);
    assert.deepEqual(validateCommand("import.refreshBatch.resume", { clientId: "c1", runId: RUN }, context), []);
  });
});
