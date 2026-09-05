import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandValidationError, createLcaResultSnapshot, listLcaResultSnapshots, VersionConflictError, withTenantRead } from "../src/index";

const context = (key: string) => ({ organisationId: "org-a", actorId: "consultant-a", principal: "staff" as const, idempotencyKey: key, correlationId: `corr-${key}` });

function snapshotPool(opts: { found?: boolean; version?: number; reviewStatus?: "pending" | "approved" | "rejected"; existingHash?: string | null } = {}) {
  const { found = true, version = 4, reviewStatus = "approved", existingHash = null } = opts;
  const writes: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      writes.push({ sql, values });
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("SELECT a.version,a.review_status FROM nzi_console.lca_assessments a JOIN")) return { rows: found ? [{ version, review_status: reviewStatus }] : [] };
      if (sql.includes("SELECT functional_unit_value::text,confirmed_quantity::text")) return { rows: [{ functional_unit_value: "1000", confirmed_quantity: "31.5" }] };
      if (sql.includes("SELECT line_item_id,module_code,line_label,quantity::text,unit,is_placeholder,calculated_kgco2e::text,transport_kgco2e::text")) {
        return { rows: [{ line_item_id: "li-1", module_code: "A1", line_label: "rPET tray", quantity: "31.5", unit: "kg", is_placeholder: false, calculated_kgco2e: "52.92", transport_kgco2e: "0" }] };
      }
      if (sql.includes("SELECT snapshot_id FROM nzi_console.lca_result_snapshots WHERE")) return { rows: existingHash ? [{ snapshot_id: "existing-snap" }] : [] };
      if (sql.startsWith("INSERT INTO nzi_console.lca_result_snapshots")) return { rows: [] };
      if (sql.includes("FROM nzi_console.lca_result_snapshots WHERE assessment_id=$1")) return { rows: [{ snapshot_id: "snap-1", assessment_id: "assess-1", scenario_id: null, assessment_version: version, data_hash: "sha256:x", total_tco2e: "52.92", module_breakdown: [{ moduleCode: "A1", tco2e: 52.92 }], hotspots: [], mass_reconciliation: { confirmedMassKg: 31.5, capturedMassKg: 31.5, deltaPct: 0 } }] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, writes };
}

describe("createLcaResultSnapshot (Track C / L4 — the DA freeze pattern)", () => {
  it("freezes an approved assessment into a content-addressed snapshot", async () => {
    const state = snapshotPool();
    const result = await createLcaResultSnapshot(state.pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 4 }, context("snap-1"));
    assert.equal(result.data.reused, false);
    assert.ok(result.data.dataHash.startsWith("sha256:"));
    const insert = state.writes.find((w) => w.sql.startsWith("INSERT INTO nzi_console.lca_result_snapshots"));
    assert.ok(insert);
  });

  it("reuses an existing snapshot with the same data hash instead of inserting a duplicate", async () => {
    const state = snapshotPool({ existingHash: "sha256:whatever" });
    const result = await createLcaResultSnapshot(state.pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 4 }, context("snap-reuse"));
    assert.equal(result.data.reused, true);
    assert.equal(result.data.snapshotId, "existing-snap");
    assert.ok(!state.writes.some((w) => w.sql.startsWith("INSERT INTO nzi_console.lca_result_snapshots")), "no duplicate insert");
  });

  it("rejects an unreviewed (pending) or rejected assessment — only 'approved' may be frozen", async () => {
    await assert.rejects(
      () => createLcaResultSnapshot(snapshotPool({ reviewStatus: "pending" }).pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 4 }, context("snap-pending")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_APPROVED"),
    );
    await assert.rejects(
      () => createLcaResultSnapshot(snapshotPool({ reviewStatus: "rejected" }).pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 4 }, context("snap-rejected")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_APPROVED"),
    );
  });

  it("rejects an unknown assessment and a stale expectedVersion", async () => {
    await assert.rejects(
      () => createLcaResultSnapshot(snapshotPool({ found: false }).pool, { jobId: "job-1", assessmentId: "assess-missing", expectedVersion: 1 }, context("snap-missing")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_FOUND"),
    );
    await assert.rejects(() => createLcaResultSnapshot(snapshotPool({ version: 4 }).pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 3 }, context("snap-stale")), VersionConflictError);
  });
});

describe("listLcaResultSnapshots (Track C / L4)", () => {
  it("maps a row, newest first", async () => {
    const snapshots = await withTenantRead(snapshotPool().pool, "org-a", (db) => listLcaResultSnapshots(db, "assess-1"));
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.totalTco2e, 52.92);
    assert.equal(snapshots[0]!.dataHash, "sha256:x");
  });
});
