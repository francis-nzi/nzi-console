// UK SRS readiness — starting a dated assessment, answering a requirement, completing it.
//
// An assessment stamps the framework version in force when it is started, so the answers
// keep meaning what they meant when the framework moves. Reassessment is a new assessment,
// which is what gives readiness a trend.
import { randomUUID } from "node:crypto";
import { prefillFromNzi, type CommandContext, type CommandInputMap, type SrsNziFacts } from "@nzi/contracts";
import { getSrsFramework } from "./srsReadinessRecords";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
export * from "./srsReadinessRecords";

export type StartSrsAssessmentResult = { assessmentId: string; clientId: string; frameworkId: string; frameworkVersion: number; prefilled: number };

/**
 * Open a dated assessment against the framework in force.
 *
 * With `prefillFromNziData`, the requirements the client's own assured record already
 * answers are filled in and marked `auto`, each carrying the record it came from as its
 * evidence. Nothing is invented: a fact the platform does not hold produces no answer, and
 * the consultant can override every one of them.
 */
export function startSrsAssessment(pool: PoolLike, input: CommandInputMap["srs.assessment.start"], context: CommandContext): Promise<StoredOutcome<StartSrsAssessmentResult>> {
  return runPostgresCommand(pool, "srs.assessment.start", input, context, async (db) => {
    const framework = await getSrsFramework(db);
    if (!framework) throw new CommandValidationError([{ field: "clientId", code: "NO_FRAMEWORK", message: "No SRS framework is published for this organisation." }]);

    const open = await db.query<{ assessment_id: string }>(
      `SELECT assessment_id FROM nzi_console.srs_assessments WHERE organisation_id=$1 AND client_id=$2 AND status='draft' LIMIT 1`,
      [context.organisationId, input.clientId]);
    if (open.rows[0]) {
      throw new CommandValidationError([{ field: "clientId", code: "ASSESSMENT_OPEN", message: "This client already has an assessment in progress. Complete it before starting another." }]);
    }

    const assessmentId = randomUUID();
    await db.query(
      `INSERT INTO nzi_console.srs_assessments (organisation_id,assessment_id,client_id,framework_id,framework_version,status,assessed_on,assessed_by,notes,version)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,1)`,
      [context.organisationId, assessmentId, input.clientId, framework.frameworkId, framework.version, input.assessedOn, context.actorId, input.notes ?? ""]);

    let prefilled = 0;
    if (input.prefillFromNziData) {
      const facts = await resolveNziFacts(db, input.clientId);
      for (const suggestion of prefillFromNzi(framework, facts)) {
        await db.query(
          `INSERT INTO nzi_console.srs_assessment_items (organisation_id,assessment_id,requirement_id,maturity,source,evidence_kind,evidence_ref,evidence_note,updated_by)
           VALUES ($1,$2,$3,$4,'auto',$5,$6,$7,$8)`,
          [context.organisationId, assessmentId, suggestion.requirementId, suggestion.maturity,
            suggestion.evidence?.kind ?? null, suggestion.evidence?.ref ?? null, suggestion.evidence?.note ?? "", context.actorId]);
        prefilled += 1;
      }
    }

    return {
      data: { assessmentId, clientId: input.clientId, frameworkId: framework.frameworkId, frameworkVersion: framework.version, prefilled },
      entityType: "srs_assessment", entityId: assessmentId, topic: "srs.assessment.started",
      after: { clientId: input.clientId, frameworkId: framework.frameworkId, frameworkVersion: framework.version, assessedOn: input.assessedOn, prefilled },
    };
  });
}

export type SetSrsItemResult = { assessmentId: string; requirementId: string; version: number };

/** Answer one requirement. The assessment must still be a draft — a completed one is a record. */
export function setSrsAssessmentItem(pool: PoolLike, input: CommandInputMap["srs.assessment.item.set"], context: CommandContext): Promise<StoredOutcome<SetSrsItemResult>> {
  return runPostgresCommand(pool, "srs.assessment.item.set", input, context, async (db) => {
    const assessment = await db.query<{ status: "draft" | "complete"; framework_id: string }>(
      `SELECT status,framework_id FROM nzi_console.srs_assessments WHERE organisation_id=$1 AND assessment_id=$2`,
      [context.organisationId, input.assessmentId]);
    const header = assessment.rows[0];
    if (!header) throw new CommandValidationError([{ field: "assessmentId", code: "NOT_FOUND", message: "That assessment does not exist." }]);
    if (header.status !== "draft") throw new CommandValidationError([{ field: "assessmentId", code: "ASSESSMENT_COMPLETE", message: "This assessment is complete. Start a reassessment to record a new position." }]);

    // The requirement has to belong to the framework this assessment was made against.
    const requirement = await db.query<{ requirement_id: string }>(
      `SELECT requirement_id FROM nzi_console.srs_requirements WHERE organisation_id=$1 AND framework_id=$2 AND requirement_id=$3 AND active`,
      [context.organisationId, header.framework_id, input.requirementId]);
    if (!requirement.rows[0]) throw new CommandValidationError([{ field: "requirementId", code: "NOT_IN_FRAMEWORK", message: "That requirement is not in the framework this assessment was made against." }]);

    const existing = await db.query<{ version: number; maturity: number | null }>(
      `SELECT version,maturity FROM nzi_console.srs_assessment_items WHERE organisation_id=$1 AND assessment_id=$2 AND requirement_id=$3 FOR UPDATE`,
      [context.organisationId, input.assessmentId, input.requirementId]);
    const previous = existing.rows[0] ?? null;
    if ((previous?.version ?? 0) !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, previous?.version ?? 0);

    const evidenceKind = input.evidenceKind ?? null;
    const values = [
      context.organisationId, input.assessmentId, input.requirementId, input.maturity,
      evidenceKind, input.evidenceRef ?? null, input.evidenceNote ?? "",
      input.owner ?? "", input.dueDate ?? null, input.linkedActionId ?? null, context.actorId,
    ];
    const saved = previous
      ? await db.query<{ version: number }>(
        `UPDATE nzi_console.srs_assessment_items SET maturity=$4,source='entered',evidence_kind=$5,evidence_ref=$6,evidence_note=$7,owner=$8,due_date=$9,linked_action_id=$10,updated_by=$11,updated_at=now(),version=version+1
         WHERE organisation_id=$1 AND assessment_id=$2 AND requirement_id=$3 RETURNING version`, values)
      : await db.query<{ version: number }>(
        `INSERT INTO nzi_console.srs_assessment_items (organisation_id,assessment_id,requirement_id,maturity,source,evidence_kind,evidence_ref,evidence_note,owner,due_date,linked_action_id,updated_by)
         VALUES ($1,$2,$3,$4,'entered',$5,$6,$7,$8,$9,$10,$11) RETURNING version`, values);

    await db.query(`UPDATE nzi_console.srs_assessments SET updated_at=now() WHERE organisation_id=$1 AND assessment_id=$2`, [context.organisationId, input.assessmentId]);

    return {
      data: { assessmentId: input.assessmentId, requirementId: input.requirementId, version: saved.rows[0]!.version },
      entityType: "srs_assessment_item", entityId: `${input.assessmentId}:${input.requirementId}`, topic: "srs.assessment.item_set",
      ...(previous ? { before: { maturity: previous.maturity } } : {}),
      after: { maturity: input.maturity, evidence: evidenceKind, owner: input.owner ?? "", dueDate: input.dueDate ?? null, linkedActionId: input.linkedActionId ?? null },
    };
  });
}

export type CompleteSrsAssessmentResult = { assessmentId: string; version: number; assessed: number; total: number };

/** Close the assessment. It stays readable, and the next reassessment starts a new one. */
export function completeSrsAssessment(pool: PoolLike, input: CommandInputMap["srs.assessment.complete"], context: CommandContext): Promise<StoredOutcome<CompleteSrsAssessmentResult>> {
  return runPostgresCommand(pool, "srs.assessment.complete", input, context, async (db) => {
    const current = await db.query<{ version: number; status: "draft" | "complete"; framework_id: string }>(
      `SELECT version,status,framework_id FROM nzi_console.srs_assessments WHERE organisation_id=$1 AND assessment_id=$2 FOR UPDATE`,
      [context.organisationId, input.assessmentId]);
    const row = current.rows[0];
    if (!row) throw new CommandValidationError([{ field: "assessmentId", code: "NOT_FOUND", message: "That assessment does not exist." }]);
    if (row.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, row.version);
    if (row.status === "complete") throw new CommandValidationError([{ field: "assessmentId", code: "ASSESSMENT_COMPLETE", message: "This assessment is already complete." }]);

    const counts = await db.query<{ assessed: string; total: string }>(
      `SELECT count(i.maturity)::text AS assessed,
              (SELECT count(*)::text FROM nzi_console.srs_requirements r WHERE r.organisation_id=$1 AND r.framework_id=$3 AND r.active) AS total
       FROM nzi_console.srs_assessment_items i WHERE i.organisation_id=$1 AND i.assessment_id=$2`,
      [context.organisationId, input.assessmentId, row.framework_id]);

    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.srs_assessments SET status='complete',completed_at=now(),updated_at=now(),version=version+1
       WHERE organisation_id=$1 AND assessment_id=$2 RETURNING version`, [context.organisationId, input.assessmentId]);

    return {
      data: { assessmentId: input.assessmentId, version: saved.rows[0]!.version, assessed: Number(counts.rows[0]?.assessed ?? 0), total: Number(counts.rows[0]?.total ?? 0) },
      entityType: "srs_assessment", entityId: input.assessmentId, topic: "srs.assessment.completed",
      before: { status: "draft" }, after: { status: "complete", assessed: Number(counts.rows[0]?.assessed ?? 0) },
    };
  });
}

/**
 * What NZI already holds for this client, read from the assured record rather than asked.
 * Each fact is something the platform can actually see; anything it cannot see stays false
 * so no requirement is pre-filled on a guess.
 */
export async function resolveNziFacts(db: Queryable, clientId: string): Promise<SrsNziFacts> {
  const snapshots = await db.query<{ payload_json: { measurements?: Array<{ scope: string }>; provenance?: { source?: string } | null }; reporting_year: number }>(
    `SELECT s.payload_json, (s.payload_json->>'reportingYear')::int AS reporting_year
     FROM nzi_console.reviewed_crp_snapshots s
     JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(s.organisation_id,s.job_id)
     WHERE j.client_id=$1 ORDER BY (s.payload_json->>'reportingYear')::int DESC, s.snapshot_version DESC`, [clientId]);
  const years = new Set(snapshots.rows.map((row) => row.reporting_year));
  const latest = snapshots.rows[0]?.payload_json ?? null;
  const measurements = latest?.measurements ?? [];
  const provenance = latest?.provenance ?? null;

  const targets = await db.query<{ has_targets: boolean }>(
    `SELECT (near_term_year IS NOT NULL OR net_zero_year IS NOT NULL) AS has_targets
     FROM nzi_console.client_targets WHERE client_id=$1 ORDER BY version DESC LIMIT 1`, [clientId]);
  const intensity = await db.query<{ bases: string }>(
    `SELECT count(DISTINCT t.metric)::text AS bases FROM nzi_console.job_intensity_targets t
     JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(t.organisation_id,t.job_id)
     WHERE j.client_id=$1 AND t.reporting_denominator IS NOT NULL`, [clientId]);

  const hasScope = (scope: string) => measurements.some((measurement) => String(measurement.scope) === scope);
  return {
    assuredYears: years.size,
    scopesReported: { scope1: hasScope("1"), scope2: hasScope("2"), scope3: hasScope("3") },
    provenanceStamped: Boolean(provenance),
    provenanceVerified: provenance?.source === "issued",
    targetsSet: Boolean(targets.rows[0]?.has_targets),
    targetProgressMeasured: Boolean(targets.rows[0]?.has_targets) && years.size > 0,
    intensityBasesResolved: Number(intensity.rows[0]?.bases ?? 0),
    // The platform records who reviewed a snapshot, not whether a third party assured it.
    independentlyAssured: false,
  };
}
