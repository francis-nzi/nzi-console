import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changeJobStage, CommandValidationError, createJob, IdempotencyConflictError, runPostgresCommand, VersionConflictError } from "../src/index";

const context = { organisationId: "org-a", actorId: "staff-a", principal: "staff" as const, idempotencyKey: "create-job-1", correlationId: "corr-create-job-1" };
const input = { clientId: "client-a", family: "crp" as const, title: "Synthetic CRP", workflowStage: "Setup", owner: "A. Owner", startDate: "2026-08-25", dueDate: "2026-12-31", reportingYear: 2026 };

function commandPool() {
  const calls: string[] = [];
  let stored: { request_hash: string; outcome_json: Record<string, unknown> } | undefined;
  let auditCount = 0;
  let outboxCount = 0;
  let allocationCount = 0;
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push(sql);
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: stored ? [stored] : [] };
      if (sql.includes("allocate_job_sequence")) { allocationCount += 1; return { rows: [{ sequence: 717 }] }; }
      if (sql.includes("INSERT INTO nzi_console.jobs")) return { rows: [{ job_number: "J000717" }] };
      if (sql.includes("INSERT INTO nzi_console.audit_events")) auditCount += 1;
      if (sql.includes("INSERT INTO nzi_console.transactional_outbox")) outboxCount += 1;
      if (sql.includes("INSERT INTO nzi_console.command_idempotency")) stored = { request_hash: String(values?.[3]), outcome_json: JSON.parse(String(values?.[4])) as Record<string, unknown> };
      return { rows: [] };
    },
    release() { calls.push("RELEASE"); },
  };
  return { pool: { connect: async () => client } as never, calls, metrics: () => ({ auditCount, outboxCount, allocationCount }) };
}

describe("Postgres command boundary", () => {
  it("creates and numbers a job once, then replays the stored outcome", async () => {
    const state = commandPool();
    const first = await createJob(state.pool, input, context);
    const replay = await createJob(state.pool, input, context);
    assert.equal(first.data.jobNumber, "J000717");
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.data.jobNumber, "J000717");
    assert.deepEqual(state.metrics(), { auditCount: 1, outboxCount: 1, allocationCount: 1 });
  });

  it("rejects reuse of an idempotency key with a different request", async () => {
    const state = commandPool();
    await createJob(state.pool, input, context);
    await assert.rejects(() => createJob(state.pool, { ...input, title: "Different" }, context), IdempotencyConflictError);
  });

  it("rolls back the whole command when its handler fails", async () => {
    const state = commandPool();
    await assert.rejects(() => runPostgresCommand(state.pool, "client.create", { name: "Synthetic", status: "active", sector: "Services", location: "London", owner: "A. Owner" }, context, async () => { throw new Error("forced failure"); }));
    assert.ok(state.calls.includes("ROLLBACK"));
    assert.equal(state.calls.includes("COMMIT"), false);
    assert.deepEqual(state.metrics(), { auditCount: 0, outboxCount: 0, allocationCount: 0 });
  });

  it("moves a job one adjacent stage and records history in the same transaction", async () => {
    const calls: string[] = [];
    const client = { async query(sql: string) {
      calls.push(sql);
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("SELECT job_family")) return { rows: [{ job_family: "crp", workflow_stage: "Data entry", version: 3 }] };
      if (sql.includes("UPDATE nzi_console.jobs SET workflow_stage")) return { rows: [{ version: 4 }] };
      return { rows: [] };
    }, release() {} };
    const result = await changeJobStage({ connect: async () => client } as never, { jobId: "712", fromStage: "Data entry", toStage: "Factor mapping", expectedVersion: 3, note: "Data collection complete" }, { ...context, idempotencyKey: "stage-1" });
    assert.equal(result.data.version, 4);
    assert.equal(result.data.toStage, "Factor mapping");
    assert.ok(calls.some((sql) => sql.includes("INSERT INTO nzi_console.job_stage_history")));
    assert.ok(calls.some((sql) => sql.includes("INSERT INTO nzi_console.audit_events")));
    assert.ok(calls.some((sql) => sql.includes("COMMIT")));
  });

  it("rejects stale versions and skipped stages", async () => {
    const poolFor = (version: number) => ({ connect: async () => ({ async query(sql: string) {
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("SELECT job_family")) return { rows: [{ job_family: "crp", workflow_stage: "Data entry", version }] };
      return { rows: [] };
    }, release() {} }) }) as never;
    await assert.rejects(() => changeJobStage(poolFor(4), { jobId: "712", fromStage: "Data entry", toStage: "Factor mapping", expectedVersion: 3 }, { ...context, idempotencyKey: "stage-stale" }), VersionConflictError);
    await assert.rejects(() => changeJobStage(poolFor(3), { jobId: "712", fromStage: "Data entry", toStage: "Report & publish", expectedVersion: 3 }, { ...context, idempotencyKey: "stage-skip" }), CommandValidationError);
  });
});
