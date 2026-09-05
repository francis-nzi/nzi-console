// Track C — LCA/PCF reference module, slice 2: the flat inventory (NZC-054/056;
// docs/MODEL_FIDELITY_JOB_FAMILIES.md §2). Reads/writes `lca_line_items`
// (migration 0046) — flat, one row per EN 15804 module, no BOM tree. Factor
// mapping is the SHARED `emission_factors`/`client_factors` — this file never
// reads/writes a parallel lookup. No `version` column on this table (unlike
// `lca_assessments`) — updates are last-write-wins, same as the schema itself.
// `transportLegs` (slice 3, `lcaTransportLegs.ts`) is attached batched, same
// N+1-avoidance shape as `lcaAssessments.ts` attaching lines.
import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap, CommandOutcome, LcaComponentOption, LcaLineItem, LcaLineItemWriteFields, LcaModuleCode, LcaTransportLeg } from "@nzi/contracts";
import { CommandValidationError, runPostgresCommand } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";
import { listLcaTransportLegsByLineItems } from "./lcaTransportLegs";

async function requireLcaAssessment(db: Queryable, organisationId: string, jobId: string, assessmentId: string): Promise<void> {
  const found = await db.query(
    `SELECT 1 FROM nzi_console.lca_assessments a JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(a.organisation_id,a.job_id)
     WHERE a.organisation_id=$1 AND a.assessment_id=$2 AND a.job_id=$3 AND j.job_family IN ('lca','pcf')`,
    [organisationId, assessmentId, jobId],
  );
  if (!found.rows[0]) throw new CommandValidationError([{ field: "assessmentId", code: "NOT_FOUND", message: "Assessment was not found for this job." }]);
}

type LineItemRow = {
  line_item_id: string; assessment_id: string; component_id: string | null; module_code: LcaModuleCode;
  line_label: string; material_category_id: string | null; quantity: string; unit: string;
  origin_country: string | null; energy_kwh: string | null; end_of_life_route: LcaLineItem["endOfLifeRoute"];
  factor_source: LcaLineItem["factorSource"]; dataset_id: string | null; factor_id: string | null; client_factor_id: string | null;
  factor_value: string | null; factor_unit: string | null; factor_label: string | null; factor_match_confidence: string | null;
  data_quality: LcaLineItem["dataQuality"]; is_gap_filled: boolean; gap_fill_method: string | null; is_placeholder: boolean;
  transport_kgco2e: string; calculated_kgco2e: string | null; notes: string;
};
const mapLineItem = (row: LineItemRow, transportLegs: LcaTransportLeg[]): LcaLineItem => ({
  id: row.line_item_id, assessmentId: row.assessment_id, componentId: row.component_id, moduleCode: row.module_code,
  lineLabel: row.line_label, materialCategoryId: row.material_category_id, quantity: Number(row.quantity), unit: row.unit,
  originCountry: row.origin_country, energyKwh: row.energy_kwh == null ? null : Number(row.energy_kwh), endOfLifeRoute: row.end_of_life_route,
  factorSource: row.factor_source, datasetId: row.dataset_id, factorId: row.factor_id, clientFactorId: row.client_factor_id,
  factorValue: row.factor_value == null ? null : Number(row.factor_value), factorUnit: row.factor_unit, factorLabel: row.factor_label,
  factorMatchConfidence: row.factor_match_confidence == null ? null : Number(row.factor_match_confidence),
  dataQuality: row.data_quality, isGapFilled: row.is_gap_filled, gapFillMethod: row.gap_fill_method, isPlaceholder: row.is_placeholder,
  transportKgco2e: Number(row.transport_kgco2e), calculatedKgco2e: row.calculated_kgco2e == null ? null : Number(row.calculated_kgco2e),
  notes: row.notes, transportLegs,
});

const LINE_ITEM_COLUMNS = `line_item_id,assessment_id,component_id,module_code,line_label,material_category_id,quantity::text,unit,
  origin_country,energy_kwh::text,end_of_life_route,factor_source,dataset_id,factor_id,client_factor_id,
  factor_value::text,factor_unit,factor_label,factor_match_confidence::text,data_quality,is_gap_filled,gap_fill_method,
  is_placeholder,transport_kgco2e::text,calculated_kgco2e::text,notes`;

export async function listLcaLineItems(db: Queryable, assessmentId: string): Promise<LcaLineItem[]> {
  const { rows } = await db.query<LineItemRow>(
    `SELECT ${LINE_ITEM_COLUMNS} FROM nzi_console.lca_line_items WHERE assessment_id=$1 ORDER BY module_code,lower(line_label)`,
    [assessmentId],
  );
  const legsByLineItem = await listLcaTransportLegsByLineItems(db, rows.map((row) => row.line_item_id));
  return rows.map((row) => mapLineItem(row, legsByLineItem.get(row.line_item_id) ?? []));
}

/** Batched — one query for every assessment's lines (+ their legs), so listing a job's whole register never N+1s. */
export async function listLcaLineItemsByAssessments(db: Queryable, assessmentIds: readonly string[]): Promise<Map<string, LcaLineItem[]>> {
  const byAssessment = new Map<string, LcaLineItem[]>();
  if (assessmentIds.length === 0) return byAssessment;
  const { rows } = await db.query<LineItemRow>(
    `SELECT ${LINE_ITEM_COLUMNS} FROM nzi_console.lca_line_items WHERE assessment_id=ANY($1::text[]) ORDER BY assessment_id,module_code,lower(line_label)`,
    [assessmentIds],
  );
  const legsByLineItem = await listLcaTransportLegsByLineItems(db, rows.map((row) => row.line_item_id));
  for (const row of rows) {
    const line = mapLineItem(row, legsByLineItem.get(row.line_item_id) ?? []);
    const bucket = byAssessment.get(row.assessment_id);
    if (bucket) bucket.push(line); else byAssessment.set(row.assessment_id, [line]);
  }
  return byAssessment;
}

function lineItemInsertValues(organisationId: string, lineItemId: string, assessmentId: string, input: LcaLineItemWriteFields, actorId: string) {
  return [
    organisationId, lineItemId, assessmentId, input.componentId ?? null, input.moduleCode, input.lineLabel.trim(),
    input.materialCategoryId ?? null, input.quantity, input.unit.trim(), input.originCountry?.trim() || null,
    input.energyKwh ?? null, input.endOfLifeRoute ?? null, input.factorSource ?? "unmapped", input.datasetId ?? null,
    input.factorId ?? null, input.clientFactorId ?? null, input.factorValue ?? null, input.factorUnit?.trim() || null,
    input.factorLabel?.trim() || null, input.isPlaceholder ?? false, input.dataQuality ?? "secondary", input.notes?.trim() || "",
    actorId,
  ];
}
const INSERT_LINE_ITEM_SQL = `INSERT INTO nzi_console.lca_line_items
  (organisation_id,line_item_id,assessment_id,component_id,module_code,line_label,material_category_id,quantity,unit,
   origin_country,energy_kwh,end_of_life_route,factor_source,dataset_id,factor_id,client_factor_id,factor_value,factor_unit,
   factor_label,is_placeholder,data_quality,notes,created_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`;

export async function createLcaLineItem(
  pool: PoolLike,
  input: CommandInputMap["lca.lineItem.create"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ lineItemId: string }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.lineItem.create", input, context, async (db) => {
    await requireLcaAssessment(db, context.organisationId, input.jobId, input.assessmentId);
    const lineItemId = randomUUID();
    await db.query(INSERT_LINE_ITEM_SQL, lineItemInsertValues(context.organisationId, lineItemId, input.assessmentId, input, context.actorId));
    return { data: { lineItemId }, entityType: "lca_line_item", entityId: lineItemId, topic: "lca.line_item.created" };
  });
}

export async function bulkCreateLcaLineItems(
  pool: PoolLike,
  input: CommandInputMap["lca.lineItem.bulkCreate"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ lineItemIds: string[] }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.lineItem.bulkCreate", input, context, async (db) => {
    await requireLcaAssessment(db, context.organisationId, input.jobId, input.assessmentId);
    const lineItemIds: string[] = [];
    for (const line of input.lines) {
      const lineItemId = randomUUID();
      await db.query(INSERT_LINE_ITEM_SQL, lineItemInsertValues(context.organisationId, lineItemId, input.assessmentId, line, context.actorId));
      lineItemIds.push(lineItemId);
    }
    return { data: { lineItemIds }, entityType: "lca_assessment", entityId: input.assessmentId, topic: "lca.line_items.bulk_created" };
  });
}

export async function updateLcaLineItem(
  pool: PoolLike,
  input: CommandInputMap["lca.lineItem.update"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ lineItemId: string }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.lineItem.update", input, context, async (db) => {
    await requireLcaAssessment(db, context.organisationId, input.jobId, input.assessmentId);
    const found = await db.query(
      "SELECT 1 FROM nzi_console.lca_line_items WHERE organisation_id=$1 AND assessment_id=$2 AND line_item_id=$3 FOR UPDATE",
      [context.organisationId, input.assessmentId, input.lineItemId],
    );
    if (!found.rows[0]) throw new CommandValidationError([{ field: "lineItemId", code: "NOT_FOUND", message: "Line item was not found." }]);
    await db.query(
      `UPDATE nzi_console.lca_line_items SET
         component_id=$4,module_code=$5,line_label=$6,material_category_id=$7,quantity=$8,unit=$9,origin_country=$10,
         energy_kwh=$11,end_of_life_route=$12,factor_source=$13,dataset_id=$14,factor_id=$15,client_factor_id=$16,
         factor_value=$17,factor_unit=$18,factor_label=$19,is_placeholder=$20,data_quality=$21,notes=$22,
         updated_by=$23,updated_at=now()
       WHERE organisation_id=$1 AND assessment_id=$2 AND line_item_id=$3`,
      [
        context.organisationId, input.assessmentId, input.lineItemId, input.componentId ?? null, input.moduleCode, input.lineLabel.trim(),
        input.materialCategoryId ?? null, input.quantity, input.unit.trim(), input.originCountry?.trim() || null,
        input.energyKwh ?? null, input.endOfLifeRoute ?? null, input.factorSource ?? "unmapped", input.datasetId ?? null,
        input.factorId ?? null, input.clientFactorId ?? null, input.factorValue ?? null, input.factorUnit?.trim() || null,
        input.factorLabel?.trim() || null, input.isPlaceholder ?? false, input.dataQuality ?? "secondary", input.notes?.trim() || "",
        context.actorId,
      ],
    );
    return { data: { lineItemId: input.lineItemId }, entityType: "lca_line_item", entityId: input.lineItemId, topic: "lca.line_item.updated" };
  });
}

export async function deleteLcaLineItem(
  pool: PoolLike,
  input: CommandInputMap["lca.lineItem.delete"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ lineItemId: string }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.lineItem.delete", input, context, async (db) => {
    await requireLcaAssessment(db, context.organisationId, input.jobId, input.assessmentId);
    const deleted = await db.query(
      "DELETE FROM nzi_console.lca_line_items WHERE organisation_id=$1 AND assessment_id=$2 AND line_item_id=$3 RETURNING line_item_id",
      [context.organisationId, input.assessmentId, input.lineItemId],
    );
    if (!deleted.rows[0]) throw new CommandValidationError([{ field: "lineItemId", code: "NOT_FOUND", message: "Line item was not found." }]);
    return { data: { lineItemId: input.lineItemId }, entityType: "lca_line_item", entityId: input.lineItemId, topic: "lca.line_item.deleted" };
  });
}

// ── Component library (NZC-053) — client-scoped or global, mirrors client_factors ──

type ComponentRow = {
  component_id: string; client_id: string | null; component_code: string | null; description: string;
  material_category_id: string | null; material_category_label: string | null;
  default_unit_mass: string | null; default_unit: string; origin_country: string | null; supplier_name: string | null;
};
export async function listLcaComponentsForJob(db: Queryable, jobId: string): Promise<LcaComponentOption[]> {
  const { rows } = await db.query<ComponentRow>(
    `SELECT c.component_id,c.client_id,c.component_code,c.description,c.material_category_id,mc.name AS material_category_label,
        c.default_unit_mass::text,c.default_unit,c.origin_country,c.supplier_name
     FROM nzi_console.lca_components c
     JOIN nzi_console.jobs j ON j.organisation_id=c.organisation_id
     LEFT JOIN nzi_console.lca_material_categories mc ON (mc.organisation_id,mc.material_category_id)=(c.organisation_id,c.material_category_id)
     WHERE j.job_id=$1 AND c.archived=false AND (c.client_id IS NULL OR c.client_id=j.client_id)
     ORDER BY lower(c.description)`,
    [jobId],
  );
  return rows.map((row) => ({
    id: row.component_id, clientId: row.client_id, componentCode: row.component_code, description: row.description,
    materialCategoryId: row.material_category_id, materialCategoryLabel: row.material_category_label,
    defaultUnitMass: row.default_unit_mass == null ? null : Number(row.default_unit_mass), defaultUnit: row.default_unit,
    originCountry: row.origin_country, supplierName: row.supplier_name,
  }));
}

export async function listLcaMaterialCategories(db: Queryable, jobId: string): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await db.query<{ material_category_id: string; name: string }>(
    `SELECT mc.material_category_id,mc.name FROM nzi_console.lca_material_categories mc
     JOIN nzi_console.jobs j ON j.organisation_id=mc.organisation_id
     WHERE j.job_id=$1 AND mc.is_active=true ORDER BY lower(mc.name)`,
    [jobId],
  );
  return rows.map((row) => ({ id: row.material_category_id, name: row.name }));
}
