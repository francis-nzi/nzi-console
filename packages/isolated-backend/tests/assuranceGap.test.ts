import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandValidationError, VersionConflictError, resolveAssuranceGap } from "../src/index";

const context = { organisationId: "org-a", actorId: "reviewer-a", principal: "staff" as const, idempotencyKey: "gap-1", correlationId: "corr-gap-1" };

function gapPool(opts: { jobFamily?: string; existingVersion?: number } = {}) {
  const writes: Array<{ sql: string; values: readonly unknown[] }> = [];
  let auditCount = 0;
  let stored: { request_hash: string; outcome_json: Record<string, unknown> } | undefined;
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: stored ? [stored] : [] };
      if (sql.includes("SELECT job_family FROM nzi_console.jobs")) return { rows: opts.jobFamily === undefined || opts.jobFamily === "crp" ? [{ job_family: "crp" }] : opts.jobFamily === null ? [] : [{ job_family: opts.jobFamily }] };
      if (sql.includes("SELECT resolution_id, version FROM nzi_console.gap_resolutions")) return { rows: opts.existingVersion ? [{ resolution_id: "existing-id", version: opts.existingVersion }] : [] };
      if (sql.startsWith("INSERT INTO nzi_console.gap_resolutions") || sql.startsWith("UPDATE nzi_console.gap_resolutions")) writes.push({ sql, values });
      if (sql.includes("INSERT INTO nzi_console.audit_events")) auditCount += 1;
      if (sql.includes("INSERT INTO nzi_console.command_idempotency")) stored = { request_hash: String(values[3]), outcome_json: JSON.parse(String(values[4])) as Record<string, unknown> };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, writes, metrics: () => ({ auditCount }) };
}

const input = { jobId: "job-a", gapKey: "unmapped:row-9", flagType: "unmapped" as const, scopeRowId: "row-9", reason: "Immaterial supplier; mapping deferred.", expectedVersion: 0 };

describe("resolveAssuranceGap (DA1d+DA3b / NZC-060)", () => {
  it("inserts a new resolution at version 1, keyed to job + gap_key, with reason + reviewer", async () => {
    const state = gapPool();
    const result = await resolveAssuranceGap(state.pool, input, context);
    assert.equal(result.data.gapKey, "unmapped:row-9");
    assert.equal(result.data.version, 1);
    const write = state.writes.find((w) => w.sql.startsWith("INSERT INTO nzi_console.gap_resolutions"))!;
    assert.ok(write.values.includes("Immaterial supplier; mapping deferred."));
    assert.ok(write.values.includes("reviewer-a"));
    assert.ok(write.values.includes("row-9"));
    assert.deepEqual(state.metrics(), { auditCount: 1 });
  });

  it("re-resolving at the current version overwrites the row and bumps the version", async () => {
    const state = gapPool({ existingVersion: 1 });
    const result = await resolveAssuranceGap(state.pool, { ...input, reason: "Revised reason.", expectedVersion: 1 }, context);
    assert.equal(result.data.resolutionId, "existing-id");
    assert.equal(result.data.version, 2);
    assert.ok(state.writes.some((w) => w.sql.startsWith("UPDATE nzi_console.gap_resolutions")));
    assert.ok(!state.writes.some((w) => w.sql.startsWith("INSERT INTO nzi_console.gap_resolutions")));
  });

  it("a stale expectedVersion is a version conflict", async () => {
    const state = gapPool({ existingVersion: 2 });
    await assert.rejects(
      () => resolveAssuranceGap(state.pool, { ...input, expectedVersion: 1 }, context),
      VersionConflictError,
    );
  });

  it("rejects a blank reason, unknown flag type, bad version and non-CRP job", async () => {
    await assert.rejects(() => resolveAssuranceGap(gapPool().pool, { ...input, reason: "  " }, context), CommandValidationError);
    await assert.rejects(() => resolveAssuranceGap(gapPool().pool, { ...input, flagType: "bogus" as never }, context), CommandValidationError);
    await assert.rejects(() => resolveAssuranceGap(gapPool().pool, { ...input, expectedVersion: -1 }, context), CommandValidationError);
    await assert.rejects(() => resolveAssuranceGap(gapPool({ jobFamily: "lca" }).pool, input, context), CommandValidationError);
  });
});
