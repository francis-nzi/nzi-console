import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeCommand } from "../src/index";
const context = { organisationId: "org-nzi", actorId: "user-1", principal: "staff" as const, idempotencyKey: "idem-1", correlationId: "corr-1" };
describe("command client", () => {
  it("does not call transport for invalid commands", async () => { let called = false; const result = await executeCommand("job.stage.change", { jobId: "712", fromStage: "Review", toStage: "Review", expectedVersion: 2 }, context, async () => { called = true; return new Response(); }); assert.equal(result.state, "validation_failed"); assert.equal(called, false); });
  it("maps stale writes to conflict", async () => { const result = await executeCommand("job.stage.change", { jobId: "712", fromStage: "Review", toStage: "Report", expectedVersion: 2 }, context, async () => new Response(JSON.stringify({ code: "VERSION_CONFLICT" }), { status: 409 })); assert.equal(result.state, "conflict"); });
  it("identifies idempotent success replays", async () => { const result = await executeCommand("sales.opportunity.convert", { opportunityId: "opp-1", expectedStatus: "WON", quoteId: "q1", createJob: true }, context, async () => new Response(JSON.stringify({ data: { jobNumber: "J000720" }, auditEventId: "aud-1" }), { status: 200, headers: { "x-idempotent-replay": "true" } })); assert.equal(result.state, "success"); if (result.state === "success") assert.equal(result.replayed, true); });
});
