// Track C — LCA/PCF reference module, slice 1: the assessment register
// (NZC-052/054/055; docs/MODEL_FIDELITY_JOB_FAMILIES.md §2/§6/§7). Reads and
// writes `lca_assessments` (migration 0046) — versioned, provenance, additive.
// `lines` is real as of slice 2 (`lcaLineItems.ts`); transport legs / scenarios
// / result snapshots are later slices — `scenarios` stays `[]` because no
// command yet creates any (truthful, not yet capable — not a shortcut).
import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap, CommandOutcome, LcaAssessment, LcaLineItem, LcaModuleCode, LcaScenario } from "@nzi/contracts";
import { CommandValidationError, runPostgresCommand } from "./postgresCommands";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { listLcaLineItemsByAssessments } from "./lcaLineItems";
import { listLcaScenariosByAssessments } from "./lcaScenarios";

async function requireLcaJob(db: Queryable, organisationId: string, jobId: string): Promise<void> {
  const found = await db.query<{ job_family: string }>(
    "SELECT job_family FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2",
    [organisationId, jobId],
  );
  const job = found.rows[0];
  if (!job) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "Job was not found." }]);
  if (job.job_family !== "lca" && job.job_family !== "pcf")
    throw new CommandValidationError([{ field: "jobId", code: "WRONG_FAMILY", message: "LCA assessments are available only for LCA/PCF jobs." }]);
}

type AssessmentRow = {
  assessment_id: string; job_id: string; job_number: string; client_id: string | null;
  assessment_type: "product" | "service"; name: string; sku: string | null;
  functional_unit_value: string; functional_unit_unit: string;
  confirmed_quantity: string | null; confirmed_quantity_unit: string;
  lifecycle_boundary: "cradle_to_gate" | "cradle_to_grave" | "custom";
  included_modules: LcaModuleCode[]; standard: string; reference_year: number | null; geography: string | null;
  version: number; review_status: "pending" | "approved" | "rejected"; reviewed_version: number | null;
  reviewed_by: string | null; reviewed_at: Date | string | null; reviewer_note: string | null;
  total_tco2e: string; last_calculated_at: Date | string | null;
};
const mapAssessment = (row: AssessmentRow, lines: LcaLineItem[], scenarios: LcaScenario[]): LcaAssessment => ({
  id: row.assessment_id, jobId: row.job_id, jobNumber: row.job_number, clientId: row.client_id,
  assessmentType: row.assessment_type,
  isPcf: row.standard === "ISO 14067" && row.lifecycle_boundary === "cradle_to_gate",
  name: row.name, sku: row.sku,
  functionalUnitValue: Number(row.functional_unit_value), functionalUnitUnit: row.functional_unit_unit,
  confirmedQuantity: row.confirmed_quantity == null ? null : Number(row.confirmed_quantity), confirmedQuantityUnit: row.confirmed_quantity_unit,
  lifecycleBoundary: row.lifecycle_boundary, includedModules: row.included_modules, standard: row.standard,
  referenceYear: row.reference_year, geography: row.geography,
  version: row.version, reviewStatus: row.review_status, reviewedVersion: row.reviewed_version,
  reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at == null ? null : new Date(row.reviewed_at).toISOString(),
  reviewerNote: row.reviewer_note,
  totalTco2e: Number(row.total_tco2e),
  lastCalculatedAt: row.last_calculated_at == null ? null : new Date(row.last_calculated_at).toISOString(),
  lines, scenarios,
});

export async function listLcaAssessments(db: Queryable, jobId: string): Promise<LcaAssessment[]> {
  const { rows } = await db.query<AssessmentRow>(
    `SELECT a.assessment_id,a.job_id,j.job_number,a.client_id,a.assessment_type,a.name,a.sku,
        a.functional_unit_value::text,a.functional_unit_unit,a.confirmed_quantity::text,a.confirmed_quantity_unit,
        a.lifecycle_boundary,a.included_modules,a.standard,a.reference_year,a.geography,
        a.version,a.review_status,a.reviewed_version,a.reviewed_by,a.reviewed_at,a.reviewer_note,
        a.total_tco2e::text,a.last_calculated_at
     FROM nzi_console.lca_assessments a
     JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(a.organisation_id,a.job_id)
     WHERE a.job_id=$1
     ORDER BY a.created_at,a.assessment_id`,
    [jobId],
  );
  const assessmentIds = rows.map((row) => row.assessment_id);
  const [linesByAssessment, scenariosByAssessment] = await Promise.all([
    listLcaLineItemsByAssessments(db, assessmentIds),
    listLcaScenariosByAssessments(db, assessmentIds),
  ]);
  return rows.map((row) => mapAssessment(row, linesByAssessment.get(row.assessment_id) ?? [], scenariosByAssessment.get(row.assessment_id) ?? []));
}

export async function createLcaAssessment(
  pool: PoolLike,
  input: CommandInputMap["lca.assessment.create"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ assessmentId: string; version: number }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.assessment.create", input, context, async (db) => {
    await requireLcaJob(db, context.organisationId, input.jobId);
    const job = await db.query<{ client_id: string }>("SELECT client_id FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2", [context.organisationId, input.jobId]);
    const assessmentId = randomUUID();
    await db.query(
      `INSERT INTO nzi_console.lca_assessments
       (organisation_id,assessment_id,job_id,client_id,assessment_type,name,sku,description,
        functional_unit_value,functional_unit_unit,confirmed_quantity,confirmed_quantity_unit,
        lifecycle_boundary,included_modules,standard,reference_year,geography,assumptions,data_sources_note,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20)`,
      [
        context.organisationId, assessmentId, input.jobId, job.rows[0]!.client_id,
        input.assessmentType, input.name.trim(), input.sku?.trim() || null, input.description?.trim() || "",
        input.functionalUnitValue, input.functionalUnitUnit.trim(), input.confirmedQuantity ?? null, input.confirmedQuantityUnit?.trim() || "kg",
        input.lifecycleBoundary, JSON.stringify(input.includedModules), input.standard?.trim() || "ISO 14067",
        input.referenceYear ?? null, input.geography?.trim() || null, input.assumptions?.trim() || "", input.dataSourcesNote?.trim() || "",
        context.actorId,
      ],
    );
    return { data: { assessmentId, version: 1 }, entityType: "lca_assessment", entityId: assessmentId, topic: "lca.assessment.created" };
  });
}

export async function updateLcaAssessment(
  pool: PoolLike,
  input: CommandInputMap["lca.assessment.update"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ assessmentId: string; version: number }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.assessment.update", input, context, async (db) => {
    await requireLcaJob(db, context.organisationId, input.jobId);
    const current = await db.query<{ version: number }>(
      "SELECT version FROM nzi_console.lca_assessments WHERE organisation_id=$1 AND job_id=$2 AND assessment_id=$3 FOR UPDATE",
      [context.organisationId, input.jobId, input.assessmentId],
    );
    const row = current.rows[0];
    if (!row) throw new CommandValidationError([{ field: "assessmentId", code: "NOT_FOUND", message: "Assessment was not found." }]);
    if (row.version !== input.expectedVersion) throw new VersionConflictError();
    await db.query(
      `UPDATE nzi_console.lca_assessments SET
         assessment_type=$4,name=$5,sku=$6,description=$7,functional_unit_value=$8,functional_unit_unit=$9,
         confirmed_quantity=$10,confirmed_quantity_unit=$11,lifecycle_boundary=$12,included_modules=$13::jsonb,
         standard=$14,reference_year=$15,geography=$16,assumptions=$17,data_sources_note=$18,
         version=version+1,updated_by=$19,updated_at=now()
       WHERE organisation_id=$1 AND job_id=$2 AND assessment_id=$3 AND version=$20`,
      [
        context.organisationId, input.jobId, input.assessmentId,
        input.assessmentType, input.name.trim(), input.sku?.trim() || null, input.description?.trim() || "",
        input.functionalUnitValue, input.functionalUnitUnit.trim(), input.confirmedQuantity ?? null, input.confirmedQuantityUnit?.trim() || "kg",
        input.lifecycleBoundary, JSON.stringify(input.includedModules), input.standard?.trim() || "ISO 14067",
        input.referenceYear ?? null, input.geography?.trim() || null, input.assumptions?.trim() || "", input.dataSourcesNote?.trim() || "",
        context.actorId, input.expectedVersion,
      ],
    );
    return { data: { assessmentId: input.assessmentId, version: row.version + 1 }, entityType: "lca_assessment", entityId: input.assessmentId, topic: "lca.assessment.updated" };
  });
}
