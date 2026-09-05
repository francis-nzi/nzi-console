import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approveLcaAssessment, CommandValidationError, rejectLcaAssessment, VersionConflictError } from "../src/index";

const context = (key: string) => ({ organisationId: "org-a", actorId: "consultant-a", principal: "staff" as const, idempotencyKey: key, correlationId: `corr-${key}` });

function assessmentPool(opts: { found?: boolean; version?: number } = {}) {
  const { found = true, version = 3 } = opts;
  const writes: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      writes.push({ sql, values });
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("FROM nzi_console.lca_assessments a JOIN")) return { rows: found ? [{ version }] : [] };
      if (sql.startsWith("UPDATE nzi_console.lca_assessments")) return { rows: found ? [{ version: version + 1 }] : [] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, writes };
}

describe("approveLcaAssessment (Track C / L4 — review sign-off, NZC-055)", () => {
  it("approves a matching-version assessment, binding reviewed_version", async () => {
    const state = assessmentPool();
    const result = await approveLcaAssessment(state.pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 3, reviewerNote: "Looks right" }, context("approve-1"));
    assert.equal(result.data.version, 4);
    const update = state.writes.find((w) => w.sql.startsWith("UPDATE nzi_console.lca_assessments"));
    assert.ok(update?.sql.includes("review_status='approved'"));
  });

  it("rejects an unknown assessment", async () => {
    await assert.rejects(
      () => approveLcaAssessment(assessmentPool({ found: false }).pool, { jobId: "job-1", assessmentId: "assess-missing", expectedVersion: 1 }, context("approve-missing")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_FOUND"),
    );
  });

  it("a stale expectedVersion is a version conflict", async () => {
    await assert.rejects(
      () => approveLcaAssessment(assessmentPool({ version: 3 }).pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 2 }, context("approve-stale")),
      VersionConflictError,
    );
  });
});

describe("rejectLcaAssessment (Track C / L4)", () => {
  it("rejects with a reviewer note, binding reviewed_version", async () => {
    const state = assessmentPool();
    const result = await rejectLcaAssessment(state.pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 3, reviewerNote: "Mass reconciliation is off — recheck the tray mass." }, context("reject-1"));
    assert.equal(result.data.version, 4);
    const update = state.writes.find((w) => w.sql.startsWith("UPDATE nzi_console.lca_assessments"));
    assert.ok(update?.sql.includes("review_status='rejected'"));
  });

  it("rejects a rejection with no reviewer note (validation, not the review verb)", async () => {
    await assert.rejects(() => rejectLcaAssessment(assessmentPool().pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 3, reviewerNote: "" }, context("reject-bad")), CommandValidationError);
  });
});
