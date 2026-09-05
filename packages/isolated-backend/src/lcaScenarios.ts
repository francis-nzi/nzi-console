// Track C — LCA/PCF reference module, slice 5: what-if scenarios (L5;
// docs/MODEL_FIDELITY_JOB_FAMILIES.md §2). Reads/writes `lca_scenarios` +
// `lca_scenario_multipliers` (migration 0047). A scenario is a set of
// multiplier rules; `computeLcaScenarioResult` (lcaCalcEngine.ts) applies
// them and re-summarises — the live `apply_scenario_multipliers`. Scenario
// results are always computed on demand, never stored (they are what-ifs,
// not the reviewed artefact — that's the result snapshot).
import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap, CommandOutcome, LcaModuleCode, LcaScenario } from "@nzi/contracts";
import { CommandValidationError, runPostgresCommand } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";
import { computeLcaAssessmentResult, computeLcaScenarioResult, type LcaCalcResult } from "./lcaCalcEngine";

async function requireAssessmentForScenario(db: Queryable, organisationId: string, jobId: string, assessmentId: string): Promise<void> {
  const found = await db.query(
    `SELECT 1 FROM nzi_console.lca_assessments a JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(a.organisation_id,a.job_id)
     WHERE a.organisation_id=$1 AND a.assessment_id=$2 AND a.job_id=$3 AND j.job_family IN ('lca','pcf')`,
    [organisationId, assessmentId, jobId],
  );
  if (!found.rows[0]) throw new CommandValidationError([{ field: "assessmentId", code: "NOT_FOUND", message: "Assessment was not found for this job." }]);
}
async function requireScenario(db: Queryable, organisationId: string, assessmentId: string, scenarioId: string): Promise<void> {
  const found = await db.query(
    "SELECT 1 FROM nzi_console.lca_scenarios WHERE organisation_id=$1 AND assessment_id=$2 AND scenario_id=$3 FOR UPDATE",
    [organisationId, assessmentId, scenarioId],
  );
  if (!found.rows[0]) throw new CommandValidationError([{ field: "scenarioId", code: "NOT_FOUND", message: "Scenario was not found." }]);
}

type ScenarioRow = { scenario_id: string; assessment_id: string; name: string; description: string; is_baseline: boolean };
type MultiplierRow = { multiplier_id: string; scenario_id: string; module_code: LcaModuleCode; material_category_id: string | null; component_id: string | null; multiplier: string };

/** Batched — one query for every assessment's scenarios (+ their multipliers), so the register never N+1s. */
export async function listLcaScenariosByAssessments(db: Queryable, assessmentIds: readonly string[]): Promise<Map<string, LcaScenario[]>> {
  const byAssessment = new Map<string, LcaScenario[]>();
  if (assessmentIds.length === 0) return byAssessment;
  const { rows: scenarios } = await db.query<ScenarioRow>(
    "SELECT scenario_id,assessment_id,name,description,is_baseline FROM nzi_console.lca_scenarios WHERE assessment_id=ANY($1::text[]) ORDER BY is_baseline DESC,lower(name)",
    [assessmentIds],
  );
  const scenarioIds = scenarios.map((row) => row.scenario_id);
  const { rows: multipliers } = scenarioIds.length === 0 ? { rows: [] as MultiplierRow[] } : await db.query<MultiplierRow>(
    "SELECT multiplier_id,scenario_id,module_code,material_category_id,component_id,multiplier::text FROM nzi_console.lca_scenario_multipliers WHERE scenario_id=ANY($1::text[]) ORDER BY module_code",
    [scenarioIds],
  );
  const mulsByScenario = new Map<string, LcaScenario["multipliers"]>();
  for (const row of multipliers) {
    const entry = { id: row.multiplier_id, moduleCode: row.module_code, materialCategoryId: row.material_category_id, componentId: row.component_id, multiplier: Number(row.multiplier) };
    mulsByScenario.set(row.scenario_id, [...(mulsByScenario.get(row.scenario_id) ?? []), entry]);
  }
  for (const row of scenarios) {
    const scenario: LcaScenario = { id: row.scenario_id, name: row.name, description: row.description, isBaseline: row.is_baseline, multipliers: mulsByScenario.get(row.scenario_id) ?? [] };
    byAssessment.set(row.assessment_id, [...(byAssessment.get(row.assessment_id) ?? []), scenario]);
  }
  return byAssessment;
}

export async function listLcaScenarios(db: Queryable, assessmentId: string): Promise<LcaScenario[]> {
  return (await listLcaScenariosByAssessments(db, [assessmentId])).get(assessmentId) ?? [];
}

export type LcaScenarioComparison = {
  baseline: LcaCalcResult;
  scenarios: Array<{ scenarioId: string; name: string; isBaseline: boolean; result: LcaCalcResult }>;
};

/** The side-by-side comparison view (§9) — the baseline (stored result) and every scenario, computed on demand. */
export async function computeLcaScenarioComparison(db: Queryable, organisationId: string, jobId: string, assessmentId: string): Promise<LcaScenarioComparison> {
  const [baseline, scenarios] = await Promise.all([
    computeLcaAssessmentResult(db, organisationId, assessmentId),
    listLcaScenarios(db, assessmentId),
  ]);
  const results = await Promise.all(
    scenarios.map(async (scenario) => ({
      scenarioId: scenario.id, name: scenario.name, isBaseline: scenario.isBaseline,
      result: await computeLcaScenarioResult(db, organisationId, jobId, assessmentId, scenario.multipliers),
    })),
  );
  return { baseline, scenarios: results };
}

export async function createLcaScenario(
  pool: PoolLike, input: CommandInputMap["lca.scenario.create"], context: CommandContext,
): Promise<Extract<CommandOutcome<{ scenarioId: string }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.scenario.create", input, context, async (db) => {
    await requireAssessmentForScenario(db, context.organisationId, input.jobId, input.assessmentId);
    if (input.isBaseline) {
      const existing = await db.query("SELECT 1 FROM nzi_console.lca_scenarios WHERE organisation_id=$1 AND assessment_id=$2 AND is_baseline", [context.organisationId, input.assessmentId]);
      if (existing.rows[0]) throw new CommandValidationError([{ field: "isBaseline", code: "CONFLICT", message: "This assessment already has a baseline scenario." }]);
    }
    const scenarioId = randomUUID();
    await db.query(
      "INSERT INTO nzi_console.lca_scenarios (organisation_id,scenario_id,assessment_id,name,description,is_baseline,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [context.organisationId, scenarioId, input.assessmentId, input.name.trim(), input.description?.trim() || "", input.isBaseline ?? false, context.actorId],
    );
    return { data: { scenarioId }, entityType: "lca_scenario", entityId: scenarioId, topic: "lca.scenario.created" };
  });
}

export async function updateLcaScenario(
  pool: PoolLike, input: CommandInputMap["lca.scenario.update"], context: CommandContext,
): Promise<Extract<CommandOutcome<{ scenarioId: string }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.scenario.update", input, context, async (db) => {
    await requireAssessmentForScenario(db, context.organisationId, input.jobId, input.assessmentId);
    await requireScenario(db, context.organisationId, input.assessmentId, input.scenarioId);
    await db.query(
      "UPDATE nzi_console.lca_scenarios SET name=$4,description=$5 WHERE organisation_id=$1 AND assessment_id=$2 AND scenario_id=$3",
      [context.organisationId, input.assessmentId, input.scenarioId, input.name.trim(), input.description?.trim() || ""],
    );
    return { data: { scenarioId: input.scenarioId }, entityType: "lca_scenario", entityId: input.scenarioId, topic: "lca.scenario.updated" };
  });
}

export async function deleteLcaScenario(
  pool: PoolLike, input: CommandInputMap["lca.scenario.delete"], context: CommandContext,
): Promise<Extract<CommandOutcome<{ scenarioId: string }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.scenario.delete", input, context, async (db) => {
    await requireAssessmentForScenario(db, context.organisationId, input.jobId, input.assessmentId);
    const deleted = await db.query(
      "DELETE FROM nzi_console.lca_scenarios WHERE organisation_id=$1 AND assessment_id=$2 AND scenario_id=$3 RETURNING scenario_id",
      [context.organisationId, input.assessmentId, input.scenarioId],
    );
    if (!deleted.rows[0]) throw new CommandValidationError([{ field: "scenarioId", code: "NOT_FOUND", message: "Scenario was not found." }]);
    return { data: { scenarioId: input.scenarioId }, entityType: "lca_scenario", entityId: input.scenarioId, topic: "lca.scenario.deleted" };
  });
}

export async function setLcaScenarioMultiplier(
  pool: PoolLike, input: CommandInputMap["lca.scenario.multiplier.set"], context: CommandContext,
): Promise<Extract<CommandOutcome<{ multiplierId: string }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.scenario.multiplier.set", input, context, async (db) => {
    await requireAssessmentForScenario(db, context.organisationId, input.jobId, input.assessmentId);
    await requireScenario(db, context.organisationId, input.assessmentId, input.scenarioId);
    const categoryId = input.materialCategoryId?.trim() || null;
    const componentId = input.componentId?.trim() || null;
    // One rule per (scenario, module, category, component) target — replace on repeat.
    const existing = await db.query<{ multiplier_id: string }>(
      `SELECT multiplier_id FROM nzi_console.lca_scenario_multipliers
       WHERE organisation_id=$1 AND scenario_id=$2 AND module_code=$3
         AND material_category_id IS NOT DISTINCT FROM $4 AND component_id IS NOT DISTINCT FROM $5`,
      [context.organisationId, input.scenarioId, input.moduleCode, categoryId, componentId],
    );
    const multiplierId = existing.rows[0]?.multiplier_id ?? randomUUID();
    if (existing.rows[0]) {
      await db.query("UPDATE nzi_console.lca_scenario_multipliers SET multiplier=$2 WHERE organisation_id=$1 AND multiplier_id=$3", [context.organisationId, input.multiplier, multiplierId]);
    } else {
      await db.query(
        "INSERT INTO nzi_console.lca_scenario_multipliers (organisation_id,multiplier_id,scenario_id,module_code,material_category_id,component_id,multiplier) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [context.organisationId, multiplierId, input.scenarioId, input.moduleCode, categoryId, componentId, input.multiplier],
      );
    }
    return { data: { multiplierId }, entityType: "lca_scenario", entityId: input.scenarioId, topic: "lca.scenario.multiplier.set" };
  });
}

export async function deleteLcaScenarioMultiplier(
  pool: PoolLike, input: CommandInputMap["lca.scenario.multiplier.delete"], context: CommandContext,
): Promise<Extract<CommandOutcome<{ multiplierId: string }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.scenario.multiplier.delete", input, context, async (db) => {
    await requireAssessmentForScenario(db, context.organisationId, input.jobId, input.assessmentId);
    const deleted = await db.query(
      "DELETE FROM nzi_console.lca_scenario_multipliers WHERE organisation_id=$1 AND scenario_id=$2 AND multiplier_id=$3 RETURNING multiplier_id",
      [context.organisationId, input.scenarioId, input.multiplierId],
    );
    if (!deleted.rows[0]) throw new CommandValidationError([{ field: "multiplierId", code: "NOT_FOUND", message: "Multiplier rule was not found." }]);
    return { data: { multiplierId: input.multiplierId }, entityType: "lca_scenario", entityId: input.scenarioId, topic: "lca.scenario.multiplier.deleted" };
  });
}
