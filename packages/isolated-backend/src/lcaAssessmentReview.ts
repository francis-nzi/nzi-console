// Track C — LCA/PCF reference module, slice 4: the assessment review/sign-off
// (L4; NZC-055). Binds `review_status` to `reviewed_version`, exactly the
// invariant `lca_assessment_reviewed_shape` enforces
// ((review_status='pending')=(reviewed_version IS NULL)) — the LCA analogue
// of CRP's `scope.review.approve`/`reject`, one level up (per-assessment, not
// per-row, since a whole assessment is what gets cited in a report).
import type { CommandContext, CommandInputMap, CommandOutcome } from "@nzi/contracts";
import { CommandValidationError, runPostgresCommand } from "./postgresCommands";
import { VersionConflictError } from "./errors";
import type { PoolLike } from "./postgres";

async function requireAssessment(db: import("./postgres").Queryable, organisationId: string, jobId: string, assessmentId: string): Promise<{ version: number }> {
  const found = await db.query<{ version: number }>(
    `SELECT a.version FROM nzi_console.lca_assessments a JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(a.organisation_id,a.job_id)
     WHERE a.organisation_id=$1 AND a.assessment_id=$2 AND a.job_id=$3 AND j.job_family IN ('lca','pcf') FOR UPDATE OF a`,
    [organisationId, assessmentId, jobId],
  );
  const row = found.rows[0];
  if (!row) throw new CommandValidationError([{ field: "assessmentId", code: "NOT_FOUND", message: "Assessment was not found for this job." }]);
  return row;
}

export async function approveLcaAssessment(
  pool: PoolLike,
  input: CommandInputMap["lca.assessment.review.approve"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ assessmentId: string; version: number }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.assessment.review.approve", input, context, async (db) => {
    const assessment = await requireAssessment(db, context.organisationId, input.jobId, input.assessmentId);
    if (assessment.version !== input.expectedVersion) throw new VersionConflictError();
    const updated = await db.query<{ version: number }>(
      `UPDATE nzi_console.lca_assessments SET review_status='approved',reviewed_version=$4,reviewed_by=$5,reviewed_at=now(),reviewer_note=$6,updated_by=$5,updated_at=now()
       WHERE organisation_id=$1 AND assessment_id=$2 AND version=$3 RETURNING version`,
      [context.organisationId, input.assessmentId, input.expectedVersion, input.expectedVersion, context.actorId, input.reviewerNote?.trim() || null],
    );
    if (!updated.rows[0]) throw new VersionConflictError();
    return { data: { assessmentId: input.assessmentId, version: updated.rows[0].version }, entityType: "lca_assessment", entityId: input.assessmentId, topic: "lca.assessment.approved" };
  });
}

export async function rejectLcaAssessment(
  pool: PoolLike,
  input: CommandInputMap["lca.assessment.review.reject"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ assessmentId: string; version: number }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.assessment.review.reject", input, context, async (db) => {
    const assessment = await requireAssessment(db, context.organisationId, input.jobId, input.assessmentId);
    if (assessment.version !== input.expectedVersion) throw new VersionConflictError();
    const updated = await db.query<{ version: number }>(
      `UPDATE nzi_console.lca_assessments SET review_status='rejected',reviewed_version=$4,reviewed_by=$5,reviewed_at=now(),reviewer_note=$6,updated_by=$5,updated_at=now()
       WHERE organisation_id=$1 AND assessment_id=$2 AND version=$3 RETURNING version`,
      [context.organisationId, input.assessmentId, input.expectedVersion, input.expectedVersion, context.actorId, input.reviewerNote.trim()],
    );
    if (!updated.rows[0]) throw new VersionConflictError();
    return { data: { assessmentId: input.assessmentId, version: updated.rows[0].version }, entityType: "lca_assessment", entityId: input.assessmentId, topic: "lca.assessment.rejected" };
  });
}
