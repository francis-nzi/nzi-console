// Track C — LCA/PCF reference module, slice 4: the calc engine (L4;
// docs/MODEL_FIDELITY_JOB_FAMILIES.md §2). Resolves each line item's and
// transport leg's factor mapping into a `calculated_kgco2e`, recomputes the
// assessment's module breakdown / hotspots / mass reconciliation / total, and
// resets its review — a recalculation invalidates any prior sign-off, same as
// `scope.row.calculate` does for CRP. Placeholder rows (`is_placeholder`) are
// excluded throughout, same as everywhere else in this module.
//
// The per-item maths mirrors the CRP convention in `postgresCommands.ts`'s
// `calculateScopeRow`: quantity × the factor's kgCO2e-per-unit, with a unit-
// match check for dataset/client factors (an inconsistent unit leaves the
// line honestly unmapped rather than silently miscalculating). Two
// DOCUMENTED SIMPLIFICATIONS versus a from-scratch engine, both because this
// session could not read the live `services/lca_engine.py`:
//   - A transport leg has no "unit" to match against a factor — a dataset/
//     manual leg factor is assumed to already be a per-km figure and is
//     multiplied straight against `distance_km`.
//   - Line-item results are PER FUNCTIONAL UNIT; the assessment's aggregate
//     figures (`total_tco2e`, module breakdown, hotspots) scale by
//     `functional_unit_value` and convert kg -> tonnes (÷1000) — this
//     reconciles with the illustrative `lcaFidelity.ts` fixture's own numbers
//     (a 31.5kg-per-pack tray × 1000 packs ÷ 1000 ≈ its 52.9t contribution).
import type { CommandContext, CommandInputMap, CommandOutcome, LcaModuleCode } from "@nzi/contracts";
import { lcaModuleCodes } from "@nzi/contracts";
import { CommandValidationError, runPostgresCommand } from "./postgresCommands";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";

const TRANSPORT_MODULES = new Set(["A2", "A4", "C2"]);

type LineForCalc = {
  line_item_id: string; module_code: LcaModuleCode; line_label: string; quantity: string; unit: string;
  factor_source: "dataset" | "client" | "manual" | "unmapped"; dataset_id: string | null; factor_id: string | null;
  client_factor_id: string | null; factor_value: string | null; is_placeholder: boolean;
};
type LegForCalc = {
  leg_id: string; line_item_id: string; distance_km: string;
  factor_source: "dataset" | "manual" | "unmapped"; dataset_id: string | null; factor_id: string | null; factor_value: string | null;
};

/** Resolve a dataset (or client) factor's kgCO2e-per-unit + activity unit, the same lookup CRP's own calculate uses. */
async function resolveFactorValue(
  db: Queryable, organisationId: string, jobId: string,
  source: "dataset" | "client", datasetId: string | null, factorId: string | null, clientFactorId: string | null,
): Promise<{ kgco2ePerUnit: number; activityUnit: string } | null> {
  if (source === "client") {
    const { rows } = await db.query<{ kgco2e_per_unit: string; unit: string }>(
      `SELECT cf.kgco2e_per_unit::text,cf.unit FROM nzi_console.client_factors cf
       JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(cf.organisation_id,cf.client_id)
       WHERE cf.organisation_id=$1 AND j.job_id=$2 AND cf.client_factor_id=$3 AND (cf.job_id IS NULL OR cf.job_id=j.job_id) AND cf.archived=false`,
      [organisationId, jobId, clientFactorId],
    );
    const row = rows[0];
    return row ? { kgco2ePerUnit: Number(row.kgco2e_per_unit), activityUnit: row.unit } : null;
  }
  const { rows } = await db.query<{ kgco2e_per_unit: string; activity_unit: string }>(
    `SELECT f.kgco2e_per_unit::text,f.activity_unit FROM nzi_console.emission_factors f
     JOIN nzi_console.job_dataset_selections s ON (s.organisation_id,s.dataset_id)=(f.organisation_id,f.dataset_id)
     WHERE f.organisation_id=$1 AND s.job_id=$2 AND f.dataset_id=$3 AND f.factor_id=$4 AND f.active=true`,
    [organisationId, jobId, datasetId, factorId],
  );
  const row = rows[0];
  return row ? { kgco2ePerUnit: Number(row.kgco2e_per_unit), activityUnit: row.activity_unit } : null;
}

export type LcaCalcResult = {
  totalTco2e: number;
  moduleBreakdown: Array<{ moduleCode: LcaModuleCode; tco2e: number }>;
  hotspots: Array<{ lineItemId: string; label: string; tco2e: number; sharePct: number }>;
  massReconciliation: { confirmedMassKg: number | null; capturedMassKg: number; deltaPct: number | null };
};

/**
 * Summarize an assessment's CURRENTLY STORED calculated figures — a pure
 * read, no factor resolution. Used both to derive `calculateLcaAssessment`'s
 * returned summary (right after it writes fresh calculated_kgco2e values)
 * and by `createLcaResultSnapshot` (to freeze exactly what's live), so the
 * two can never drift apart from independently re-deriving the same maths.
 */
export async function computeLcaAssessmentResult(db: Queryable, organisationId: string, assessmentId: string): Promise<LcaCalcResult> {
  const assessment = await db.query<{ functional_unit_value: string; confirmed_quantity: string | null }>(
    "SELECT functional_unit_value::text,confirmed_quantity::text FROM nzi_console.lca_assessments WHERE organisation_id=$1 AND assessment_id=$2",
    [organisationId, assessmentId],
  );
  const functionalUnitValue = Number(assessment.rows[0]?.functional_unit_value ?? 1);
  const confirmedMassKg = assessment.rows[0]?.confirmed_quantity == null ? null : Number(assessment.rows[0].confirmed_quantity);

  const { rows: lines } = await db.query<{ line_item_id: string; module_code: LcaModuleCode; line_label: string; quantity: string; unit: string; is_placeholder: boolean; calculated_kgco2e: string | null; transport_kgco2e: string }>(
    `SELECT line_item_id,module_code,line_label,quantity::text,unit,is_placeholder,calculated_kgco2e::text,transport_kgco2e::text
     FROM nzi_console.lca_line_items WHERE assessment_id=$1`,
    [assessmentId],
  );
  const active = lines.filter((row) => !row.is_placeholder);
  const perLine = active.map((row) => {
    const material = row.calculated_kgco2e == null ? 0 : Number(row.calculated_kgco2e);
    const transport = Number(row.transport_kgco2e);
    return { ...row, tco2e: ((material + transport) * functionalUnitValue) / 1000 };
  });

  const moduleBreakdown = lcaModuleCodes
    .map((moduleCode) => ({ moduleCode, tco2e: perLine.filter((row) => row.module_code === moduleCode).reduce((sum, row) => sum + row.tco2e, 0) }))
    .filter((entry) => entry.tco2e !== 0);
  const totalTco2e = moduleBreakdown.reduce((sum, entry) => sum + entry.tco2e, 0);

  const hotspots = [...perLine]
    .filter((row) => row.tco2e > 0)
    .sort((a, b) => b.tco2e - a.tco2e)
    .slice(0, 5)
    .map((row) => ({ lineItemId: row.line_item_id, label: row.line_label, tco2e: row.tco2e, sharePct: totalTco2e > 0 ? (row.tco2e / totalTco2e) * 100 : 0 }));

  // Captured mass = the product-module lines' own quantity (kg) — transport-
  // module lines' quantity is the same shipped mass already counted there,
  // so it's excluded to avoid double-counting.
  const capturedMassKg = active
    .filter((row) => !TRANSPORT_MODULES.has(row.module_code) && row.unit.trim().toLowerCase() === "kg")
    .reduce((sum, row) => sum + Number(row.quantity), 0);
  const deltaPct = confirmedMassKg && confirmedMassKg > 0 ? ((capturedMassKg - confirmedMassKg) / confirmedMassKg) * 100 : null;

  return { totalTco2e, moduleBreakdown, hotspots, massReconciliation: { confirmedMassKg, capturedMassKg, deltaPct } };
}

export async function calculateLcaAssessment(
  pool: PoolLike,
  input: CommandInputMap["lca.assessment.calculate"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ assessmentId: string; version: number } & LcaCalcResult>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.assessment.calculate", input, context, async (db) => {
    const found = await db.query<{ version: number }>(
      "SELECT version FROM nzi_console.lca_assessments a JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(a.organisation_id,a.job_id) WHERE a.organisation_id=$1 AND a.assessment_id=$2 AND a.job_id=$3 AND j.job_family IN ('lca','pcf') FOR UPDATE OF a",
      [context.organisationId, input.assessmentId, input.jobId],
    );
    const assessment = found.rows[0];
    if (!assessment) throw new CommandValidationError([{ field: "assessmentId", code: "NOT_FOUND", message: "Assessment was not found for this job." }]);
    if (assessment.version !== input.expectedVersion) throw new VersionConflictError();

    const { rows: lines } = await db.query<LineForCalc>(
      `SELECT line_item_id,module_code,line_label,quantity::text,unit,factor_source,dataset_id,factor_id,client_factor_id,factor_value::text,is_placeholder
       FROM nzi_console.lca_line_items WHERE organisation_id=$1 AND assessment_id=$2`,
      [context.organisationId, input.assessmentId],
    );
    for (const line of lines) {
      if (line.is_placeholder || line.factor_source === "unmapped") continue;
      const quantity = Number(line.quantity);
      let kgco2e: number | null = null;
      if (line.factor_source === "manual") {
        kgco2e = line.factor_value == null ? null : quantity * Number(line.factor_value);
      } else {
        const factor = await resolveFactorValue(db, context.organisationId, input.jobId, line.factor_source, line.dataset_id, line.factor_id, line.client_factor_id);
        if (factor && factor.activityUnit.trim().toLowerCase() === line.unit.trim().toLowerCase()) kgco2e = quantity * factor.kgco2ePerUnit;
        // else: an unresolvable or unit-mismatched factor leaves this line honestly uncalculated, same as unmapped.
      }
      await db.query("UPDATE nzi_console.lca_line_items SET calculated_kgco2e=$3 WHERE organisation_id=$1 AND line_item_id=$2", [context.organisationId, line.line_item_id, kgco2e]);
    }

    const transportLineIds = lines.filter((line) => TRANSPORT_MODULES.has(line.module_code)).map((line) => line.line_item_id);
    if (transportLineIds.length > 0) {
      const { rows: legs } = await db.query<LegForCalc>(
        `SELECT leg_id,line_item_id,distance_km::text,factor_source,dataset_id,factor_id,factor_value::text
         FROM nzi_console.lca_transport_legs WHERE organisation_id=$1 AND line_item_id=ANY($2::text[])`,
        [context.organisationId, transportLineIds],
      );
      for (const leg of legs) {
        let kgco2e: number | null = null;
        const distance = Number(leg.distance_km);
        if (leg.factor_source === "manual") kgco2e = leg.factor_value == null ? null : distance * Number(leg.factor_value);
        else if (leg.factor_source === "dataset") {
          const factor = await resolveFactorValue(db, context.organisationId, input.jobId, "dataset", leg.dataset_id, leg.factor_id, null);
          if (factor) kgco2e = distance * factor.kgco2ePerUnit;
        }
        await db.query("UPDATE nzi_console.lca_transport_legs SET calculated_kgco2e=$3 WHERE organisation_id=$1 AND leg_id=$2", [context.organisationId, leg.leg_id, kgco2e]);
      }
      for (const lineItemId of transportLineIds) {
        await db.query(
          `UPDATE nzi_console.lca_line_items SET transport_kgco2e=(
             SELECT COALESCE(SUM(calculated_kgco2e),0) FROM nzi_console.lca_transport_legs WHERE organisation_id=$1 AND line_item_id=$2
           ) WHERE organisation_id=$1 AND line_item_id=$2`,
          [context.organisationId, lineItemId],
        );
      }
    }

    const result = await computeLcaAssessmentResult(db, context.organisationId, input.assessmentId);
    const updated = await db.query<{ version: number }>(
      `UPDATE nzi_console.lca_assessments SET total_tco2e=$3,last_calculated_at=now(),
         review_status='pending',reviewed_version=NULL,reviewed_by=NULL,reviewed_at=NULL,reviewer_note=NULL,
         version=version+1,updated_by=$4,updated_at=now()
       WHERE organisation_id=$1 AND assessment_id=$2 AND version=$5 RETURNING version`,
      [context.organisationId, input.assessmentId, result.totalTco2e, context.actorId, input.expectedVersion],
    );
    if (!updated.rows[0]) throw new VersionConflictError();

    return {
      data: { assessmentId: input.assessmentId, version: updated.rows[0].version, ...result },
      entityType: "lca_assessment", entityId: input.assessmentId, topic: "lca.assessment.calculated",
    };
  });
}
