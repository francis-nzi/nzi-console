// Track C — LCA/PCF reference module, slice 3: transport legs (NZC-054;
// docs/MODEL_FIDELITY_JOB_FAMILIES.md §2). Reads/writes `lca_transport_legs`
// (migration 0046) — an ordered, geocoded (or manually entered) leg sequence
// on a transport-module line item. Per the live app, transport legs only
// belong to modules A2 (transport to manufacturer), A4 (transport to
// site/user) and C2 (transport to waste processing) — every other module is
// a product/use/end-of-life module, not a transport leg. No `client_factor_id`
// column on this table (unlike line items) — 'client' is not a valid
// `factorSource` here. The parent line item caches `transport_kgco2e =
// sum(legs.calculated_kgco2e)` so read-time aggregation never joins; each
// leg's own `calculated_kgco2e` is left null until the calc engine (L4) runs
// — same honest "don't fake it" stance as line items in slice 2.
import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap, CommandOutcome, LcaTransportLeg } from "@nzi/contracts";
import { CommandValidationError, runPostgresCommand } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

const TRANSPORT_MODULES = ["A2", "A4", "C2"] as const;

/** Validate the line item exists for this job/assessment, belongs to an lca/pcf job, AND is a transport module. */
async function requireTransportLineItem(db: Queryable, organisationId: string, jobId: string, assessmentId: string, lineItemId: string): Promise<void> {
  const found = await db.query<{ module_code: string }>(
    `SELECT li.module_code FROM nzi_console.lca_line_items li
     JOIN nzi_console.lca_assessments a ON (a.organisation_id,a.assessment_id)=(li.organisation_id,li.assessment_id)
     JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(a.organisation_id,a.job_id)
     WHERE li.organisation_id=$1 AND li.line_item_id=$2 AND li.assessment_id=$3 AND a.job_id=$4 AND j.job_family IN ('lca','pcf')`,
    [organisationId, lineItemId, assessmentId, jobId],
  );
  const row = found.rows[0];
  if (!row) throw new CommandValidationError([{ field: "lineItemId", code: "NOT_FOUND", message: "Line item was not found for this assessment." }]);
  if (!(TRANSPORT_MODULES as readonly string[]).includes(row.module_code)) {
    throw new CommandValidationError([{ field: "lineItemId", code: "WRONG_MODULE", message: "Transport legs only belong to A2, A4 or C2 line items." }]);
  }
}

/** Recompute the parent line item's cached transport total from its legs' own calculated_kgco2e. */
async function recomputeLineItemTransportTotal(db: Queryable, organisationId: string, lineItemId: string): Promise<void> {
  await db.query(
    `UPDATE nzi_console.lca_line_items SET transport_kgco2e=(
       SELECT COALESCE(SUM(calculated_kgco2e),0) FROM nzi_console.lca_transport_legs WHERE organisation_id=$1 AND line_item_id=$2
     ) WHERE organisation_id=$1 AND line_item_id=$2`,
    [organisationId, lineItemId],
  );
}

type LegRow = {
  leg_id: string; leg_order: number; from_label: string; from_lat: string | null; from_lng: string | null;
  to_label: string; to_lat: string | null; to_lng: string | null; mode: LcaTransportLeg["mode"];
  distance_km: string; distance_source: LcaTransportLeg["distanceSource"]; factor_source: LcaTransportLeg["factorSource"];
  dataset_id: string | null; factor_id: string | null; factor_value: string | null; calculated_kgco2e: string | null; notes: string;
};
const mapLeg = (row: LegRow): LcaTransportLeg => ({
  id: row.leg_id, legOrder: row.leg_order, fromLabel: row.from_label,
  fromLat: row.from_lat == null ? null : Number(row.from_lat), fromLng: row.from_lng == null ? null : Number(row.from_lng),
  toLabel: row.to_label, toLat: row.to_lat == null ? null : Number(row.to_lat), toLng: row.to_lng == null ? null : Number(row.to_lng),
  mode: row.mode, distanceKm: Number(row.distance_km), distanceSource: row.distance_source, factorSource: row.factor_source,
  datasetId: row.dataset_id, factorId: row.factor_id, factorValue: row.factor_value == null ? null : Number(row.factor_value),
  calculatedKgco2e: row.calculated_kgco2e == null ? null : Number(row.calculated_kgco2e), notes: row.notes,
});
const LEG_COLUMNS = `leg_id,leg_order,from_label,from_lat::text,from_lng::text,to_label,to_lat::text,to_lng::text,mode,
  distance_km::text,distance_source,factor_source,dataset_id,factor_id,factor_value::text,calculated_kgco2e::text,notes`;

export async function listLcaTransportLegs(db: Queryable, lineItemId: string): Promise<LcaTransportLeg[]> {
  const { rows } = await db.query<LegRow>(
    `SELECT ${LEG_COLUMNS} FROM nzi_console.lca_transport_legs WHERE line_item_id=$1 ORDER BY leg_order`,
    [lineItemId],
  );
  return rows.map(mapLeg);
}

/** Batched — one query for every line item's legs, so the inventory list never N+1s. */
export async function listLcaTransportLegsByLineItems(db: Queryable, lineItemIds: readonly string[]): Promise<Map<string, LcaTransportLeg[]>> {
  const byLineItem = new Map<string, LcaTransportLeg[]>();
  if (lineItemIds.length === 0) return byLineItem;
  const { rows } = await db.query<LegRow & { line_item_id: string }>(
    `SELECT line_item_id,${LEG_COLUMNS} FROM nzi_console.lca_transport_legs WHERE line_item_id=ANY($1::text[]) ORDER BY line_item_id,leg_order`,
    [lineItemIds],
  );
  for (const row of rows) {
    const leg = mapLeg(row);
    const bucket = byLineItem.get(row.line_item_id);
    if (bucket) bucket.push(leg); else byLineItem.set(row.line_item_id, [leg]);
  }
  return byLineItem;
}

export async function createLcaTransportLeg(
  pool: PoolLike,
  input: CommandInputMap["lca.transportLeg.create"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ legId: string }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.transportLeg.create", input, context, async (db) => {
    await requireTransportLineItem(db, context.organisationId, input.jobId, input.assessmentId, input.lineItemId);
    const order = await db.query<{ next: string }>(
      "SELECT COALESCE(MAX(leg_order)+1,0)::text AS next FROM nzi_console.lca_transport_legs WHERE organisation_id=$1 AND line_item_id=$2",
      [context.organisationId, input.lineItemId],
    );
    const legId = randomUUID();
    await db.query(
      `INSERT INTO nzi_console.lca_transport_legs
        (organisation_id,leg_id,line_item_id,leg_order,from_label,from_lat,from_lng,to_label,to_lat,to_lng,mode,
         distance_km,distance_source,factor_source,dataset_id,factor_id,factor_value,notes,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        context.organisationId, legId, input.lineItemId, Number(order.rows[0]!.next), input.fromLabel.trim(),
        input.fromLat ?? null, input.fromLng ?? null, input.toLabel.trim(), input.toLat ?? null, input.toLng ?? null,
        input.mode, input.distanceKm, input.distanceSource ?? "manual", input.factorSource ?? "unmapped",
        input.datasetId ?? null, input.factorId ?? null, input.factorValue ?? null, input.notes?.trim() || "",
        context.actorId,
      ],
    );
    await recomputeLineItemTransportTotal(db, context.organisationId, input.lineItemId);
    return { data: { legId }, entityType: "lca_line_item", entityId: input.lineItemId, topic: "lca.transport_leg.created" };
  });
}

export async function updateLcaTransportLeg(
  pool: PoolLike,
  input: CommandInputMap["lca.transportLeg.update"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ legId: string }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.transportLeg.update", input, context, async (db) => {
    await requireTransportLineItem(db, context.organisationId, input.jobId, input.assessmentId, input.lineItemId);
    const found = await db.query(
      "SELECT 1 FROM nzi_console.lca_transport_legs WHERE organisation_id=$1 AND line_item_id=$2 AND leg_id=$3 FOR UPDATE",
      [context.organisationId, input.lineItemId, input.legId],
    );
    if (!found.rows[0]) throw new CommandValidationError([{ field: "legId", code: "NOT_FOUND", message: "Transport leg was not found." }]);
    await db.query(
      `UPDATE nzi_console.lca_transport_legs SET
         from_label=$4,from_lat=$5,from_lng=$6,to_label=$7,to_lat=$8,to_lng=$9,mode=$10,distance_km=$11,
         distance_source=$12,factor_source=$13,dataset_id=$14,factor_id=$15,factor_value=$16,notes=$17
       WHERE organisation_id=$1 AND line_item_id=$2 AND leg_id=$3`,
      [
        context.organisationId, input.lineItemId, input.legId, input.fromLabel.trim(), input.fromLat ?? null, input.fromLng ?? null,
        input.toLabel.trim(), input.toLat ?? null, input.toLng ?? null, input.mode, input.distanceKm,
        input.distanceSource ?? "manual", input.factorSource ?? "unmapped", input.datasetId ?? null, input.factorId ?? null,
        input.factorValue ?? null, input.notes?.trim() || "",
      ],
    );
    await recomputeLineItemTransportTotal(db, context.organisationId, input.lineItemId);
    return { data: { legId: input.legId }, entityType: "lca_line_item", entityId: input.lineItemId, topic: "lca.transport_leg.updated" };
  });
}

export async function deleteLcaTransportLeg(
  pool: PoolLike,
  input: CommandInputMap["lca.transportLeg.delete"],
  context: CommandContext,
): Promise<Extract<CommandOutcome<{ legId: string }>, { state: "success" }>> {
  return runPostgresCommand(pool, "lca.transportLeg.delete", input, context, async (db) => {
    await requireTransportLineItem(db, context.organisationId, input.jobId, input.assessmentId, input.lineItemId);
    const deleted = await db.query(
      "DELETE FROM nzi_console.lca_transport_legs WHERE organisation_id=$1 AND line_item_id=$2 AND leg_id=$3 RETURNING leg_id",
      [context.organisationId, input.lineItemId, input.legId],
    );
    if (!deleted.rows[0]) throw new CommandValidationError([{ field: "legId", code: "NOT_FOUND", message: "Transport leg was not found." }]);
    await recomputeLineItemTransportTotal(db, context.organisationId, input.lineItemId);
    return { data: { legId: input.legId }, entityType: "lca_line_item", entityId: input.lineItemId, topic: "lca.transport_leg.deleted" };
  });
}
