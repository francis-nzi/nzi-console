// Track C — LCA/PCF reference module, slice 4: content-addressed result
// snapshots (L4; NZC-055). Same "DA freeze" discipline as
// `reviewed_crp_snapshots`/`report.snapshot.create` — a stable-JSON hash of
// the payload, an idempotent re-use when nothing has changed since the last
// freeze, immutable once written (no UPDATE/DELETE grant on this table).
// Gated on `review_status='approved'` — this session's considered ordering
// is calculate -> independent review -> freeze (an unreviewed number should
// not become the artefact a report cites), though the live product's exact
// sequence was not readable this session (see docs/ACCEPTANCE_LCA_MODULE_
// SLICE4.md's disclosure).
import { createHash, randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap, CommandOutcome, LcaResultSnapshot } from "@nzi/contracts";
import { CommandValidationError, runPostgresCommand } from "./postgresCommands";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { computeLcaAssessmentResult } from "./lcaCalcEngine";

const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
      : value;

export async function createLcaResultSnapshot(
  pool: PoolLike,
  input: CommandInputMap["lca.assessment.snapshot.create"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ snapshotId: string; dataHash: string; reused: boolean }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.assessment.snapshot.create", input, context, async (db) => {
    const found = await db.query<{ version: number; review_status: "pending" | "approved" | "rejected" }>(
      `SELECT a.version,a.review_status FROM nzi_console.lca_assessments a JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(a.organisation_id,a.job_id)
       WHERE a.organisation_id=$1 AND a.assessment_id=$2 AND a.job_id=$3 AND j.job_family IN ('lca','pcf')`,
      [context.organisationId, input.assessmentId, input.jobId],
    );
    const assessment = found.rows[0];
    if (!assessment) throw new CommandValidationError([{ field: "assessmentId", code: "NOT_FOUND", message: "Assessment was not found for this job." }]);
    if (assessment.version !== input.expectedVersion) throw new VersionConflictError();
    if (assessment.review_status !== "approved") throw new CommandValidationError([{ field: "assessmentId", code: "NOT_APPROVED", message: "Only an independently reviewed and approved assessment may be frozen into a result snapshot." }]);

    const result = await computeLcaAssessmentResult(db, context.organisationId, input.assessmentId);
    const payload = { assessmentId: input.assessmentId, assessmentVersion: assessment.version, ...result };
    const dataHash = `sha256:${createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex")}`;

    const existing = await db.query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM nzi_console.lca_result_snapshots WHERE organisation_id=$1 AND assessment_id=$2 AND data_hash=$3",
      [context.organisationId, input.assessmentId, dataHash],
    );
    if (existing.rows[0]) {
      return { data: { snapshotId: existing.rows[0].snapshot_id, dataHash, reused: true as boolean }, entityType: "lca_result_snapshot", entityId: existing.rows[0].snapshot_id, topic: "lca.result_snapshot.reused" };
    }

    const snapshotId = randomUUID();
    await db.query(
      `INSERT INTO nzi_console.lca_result_snapshots
        (organisation_id,snapshot_id,assessment_id,assessment_version,data_hash,total_tco2e,module_breakdown,hotspots,mass_reconciliation,calculated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)`,
      [
        context.organisationId, snapshotId, input.assessmentId, assessment.version, dataHash, result.totalTco2e,
        JSON.stringify(result.moduleBreakdown), JSON.stringify(result.hotspots), JSON.stringify(result.massReconciliation),
        context.actorId,
      ],
    );
    return { data: { snapshotId, dataHash, reused: false as boolean }, entityType: "lca_result_snapshot", entityId: snapshotId, topic: "lca.result_snapshot.created" };
  });
}

type SnapshotRow = {
  snapshot_id: string; assessment_id: string; scenario_id: string | null; assessment_version: number; data_hash: string;
  total_tco2e: string; module_breakdown: LcaResultSnapshot["moduleBreakdown"]; hotspots: LcaResultSnapshot["hotspots"];
  mass_reconciliation: LcaResultSnapshot["massReconciliation"];
};
const mapSnapshot = (row: SnapshotRow): LcaResultSnapshot => ({
  id: row.snapshot_id, assessmentId: row.assessment_id, scenarioId: row.scenario_id, assessmentVersion: row.assessment_version,
  dataHash: row.data_hash, totalTco2e: Number(row.total_tco2e), moduleBreakdown: row.module_breakdown, hotspots: row.hotspots,
  massReconciliation: row.mass_reconciliation,
});

export async function listLcaResultSnapshots(db: Queryable, assessmentId: string): Promise<LcaResultSnapshot[]> {
  const { rows } = await db.query<SnapshotRow>(
    `SELECT snapshot_id,assessment_id,scenario_id,assessment_version,data_hash,total_tco2e::text,module_breakdown,hotspots,mass_reconciliation
     FROM nzi_console.lca_result_snapshots WHERE assessment_id=$1 ORDER BY calculated_at DESC`,
    [assessmentId],
  );
  return rows.map(mapSnapshot);
}
