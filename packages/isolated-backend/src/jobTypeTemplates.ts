import type { CommandContext, CommandInputMap, JobTypeTemplateEntry } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * Job-type templates (admin Phase E3; ruled `phaseE-commercial-catalogue-plan.md`, E-Q5/E-Q10): 0147's
 * `job_type_items`, the catalogue items a new job of a type starts with.
 *
 * - **Set whole** by `job_type.items.set` (admin.lookups): the included items in order, each with a quantity and a
 *   required flag, against the template's own version (`job_types.items_version`) — never the type's definition version.
 * - **Never deleted** (R3): an item the template drops is kept with `included = false`; one it takes back is included
 *   again. A row's pair (type, item) never changes.
 * - **An item must be active to be added**; one the template already includes stays when it is deactivated (R3).
 * - **The source, not the copy** (E-Q5): a new job's lines are copied from the included rows when the job is created —
 *   downstream; `docs/JOB_TYPE_TEMPLATE_CONTRACT.md`. Nothing here reaches an existing job.
 */

export type JobTypeTemplateItem = { itemId: string; code: string; name: string; unit: string | null; active: boolean; quantity: number; isRequired: boolean };
export type JobTypeTemplate = { itemsVersion: number; items: JobTypeTemplateItem[] };

/** Every job type's included items, in order — keyed by job type. A type with none has an empty template. */
export async function listJobTypeTemplates(db: Queryable): Promise<Record<string, JobTypeTemplate>> {
  const [types, rows] = await Promise.all([
    db.query<{ job_type_id: string; items_version: number }>(`SELECT job_type_id, items_version FROM nzi_console.job_types`),
    db.query<{ job_type_id: string; item_id: string; item_code: string; name: string; unit: string | null; active: boolean; quantity: string; is_required: boolean }>(
      `SELECT ti.job_type_id, ti.item_id, ji.item_code, ji.name, uom.label AS unit, ji.active, ti.quantity::text, ti.is_required
         FROM nzi_console.job_type_items ti
         JOIN nzi_console.job_items ji ON (ji.organisation_id, ji.item_id) = (ti.organisation_id, ti.item_id)
         LEFT JOIN nzi_console.reference_values uom ON (uom.organisation_id, uom.value_id) = (ji.organisation_id, ji.unit_value_id)
        WHERE ti.included ORDER BY ti.job_type_id, ti.sort_order, ji.item_code`),
  ]);
  const templates: Record<string, JobTypeTemplate> = Object.fromEntries(types.rows.map((row) => [row.job_type_id, { itemsVersion: row.items_version, items: [] }]));
  for (const row of rows.rows) {
    templates[row.job_type_id]?.items.push({ itemId: row.item_id, code: row.item_code, name: row.name, unit: row.unit, active: row.active,
      quantity: Number(row.quantity), isRequired: row.is_required });
  }
  return templates;
}

/** The catalogue as the template editor offers it: every item, active first — an inactive one is named only where held. */
export type TemplateCatalogueItem = { itemId: string; code: string; name: string; unit: string | null; active: boolean };
export async function listTemplateCatalogue(db: Queryable): Promise<TemplateCatalogueItem[]> {
  const { rows } = await db.query<{ item_id: string; item_code: string; name: string; unit: string | null; active: boolean }>(
    `SELECT ji.item_id, ji.item_code, ji.name, uom.label AS unit, ji.active FROM nzi_console.job_items ji
       LEFT JOIN nzi_console.reference_values uom ON (uom.organisation_id, uom.value_id) = (ji.organisation_id, ji.unit_value_id)
      ORDER BY ji.active DESC, ji.sort_order, ji.item_code`);
  return rows.map((row) => ({ itemId: row.item_id, code: row.item_code, name: row.name, unit: row.unit, active: row.active }));
}

/** What the command returns — the audit's after_json: the template as it now stands, and what it dropped. No amounts. */
export type JobTypeItemsResult = { jobTypeId: string; itemsVersion: number; items: JobTypeTemplateEntry[]; dropped: string[] };

export function setJobTypeItems(pool: PoolLike, input: CommandInputMap["job_type.items.set"], context: CommandContext): Promise<StoredOutcome<JobTypeItemsResult>> {
  return runPostgresCommand(pool, "job_type.items.set", input, context, async (db) => {
    const { rows: [type] } = await db.query<{ items_version: number }>(
      `SELECT items_version FROM nzi_console.job_types WHERE organisation_id = $1 AND job_type_id = $2 FOR UPDATE`, [context.organisationId, input.jobTypeId]);
    if (!type) throw new CommandValidationError([{ field: "jobTypeId", code: "NOT_FOUND", message: "That job type is not here." }]);
    if (type.items_version !== input.expectedItemsVersion) throw new VersionConflictError(input.expectedItemsVersion, type.items_version);

    const { rows: held } = await db.query<{ item_id: string; quantity: string; is_required: boolean; sort_order: number; included: boolean }>(
      `SELECT item_id, quantity::text, is_required, sort_order, included FROM nzi_console.job_type_items
        WHERE organisation_id = $1 AND job_type_id = $2 FOR UPDATE`, [context.organisationId, input.jobTypeId]);
    const was = new Map(held.map((row) => [row.item_id, row]));
    const before = held.filter((row) => row.included).sort((a, b) => a.sort_order - b.sort_order)
      .map((row) => ({ itemId: row.item_id, quantity: Number(row.quantity), isRequired: row.is_required }));

    // Each item exists here; one not already included must be active (R3: a held one stays when deactivated).
    const ids = input.items.map((item) => item.itemId);
    const { rows: items } = await db.query<{ item_id: string; active: boolean }>(
      `SELECT item_id, active FROM nzi_console.job_items WHERE organisation_id = $1 AND item_id = ANY($2::text[])`, [context.organisationId, ids]);
    const known = new Map(items.map((row) => [row.item_id, row.active]));
    const issues: Array<{ field: string; code: string; message: string }> = [];
    input.items.forEach((item, index) => {
      if (!known.has(item.itemId)) issues.push({ field: `items.${index}.itemId`, code: "NOT_FOUND", message: "That item is not in this organisation's catalogue." });
      else if (!known.get(item.itemId) && !was.get(item.itemId)?.included) issues.push({ field: `items.${index}.itemId`, code: "INACTIVE", message: "That item is deactivated in the catalogue; reinstate it to add it." });
    });
    if (issues.length) throw new CommandValidationError(issues);

    const unchanged = before.length === input.items.length && before.every((entry, index) => {
      const next = input.items[index]!;
      return entry.itemId === next.itemId && entry.quantity === next.quantity && entry.isRequired === next.isRequired;
    });
    if (unchanged) throw new CommandValidationError([{ field: "items", code: "UNCHANGED", message: "That is the template it already holds." }]);

    for (const [index, item] of input.items.entries()) {
      const sortOrder = (index + 1) * 10;
      const row = was.get(item.itemId);
      if (!row) {
        await db.query(
          `INSERT INTO nzi_console.job_type_items (organisation_id, job_type_id, item_id, quantity, is_required, sort_order, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [context.organisationId, input.jobTypeId, item.itemId, item.quantity, item.isRequired, sortOrder, context.actorId]);
      } else if (!row.included || Number(row.quantity) !== item.quantity || row.is_required !== item.isRequired || row.sort_order !== sortOrder) {
        await db.query(
          `UPDATE nzi_console.job_type_items SET quantity = $4, is_required = $5, sort_order = $6, included = true, version = version + 1, updated_at = now(), updated_by = $7
            WHERE organisation_id = $1 AND job_type_id = $2 AND item_id = $3`,
          [context.organisationId, input.jobTypeId, item.itemId, item.quantity, item.isRequired, sortOrder, context.actorId]);
      }
    }
    const dropped = before.map((entry) => entry.itemId).filter((itemId) => !ids.includes(itemId));
    if (dropped.length) {
      await db.query(
        `UPDATE nzi_console.job_type_items SET included = false, version = version + 1, updated_at = now(), updated_by = $4
          WHERE organisation_id = $1 AND job_type_id = $2 AND item_id = ANY($3::text[])`, [context.organisationId, input.jobTypeId, dropped, context.actorId]);
    }
    const { rows: [saved] } = await db.query<{ items_version: number }>(
      `UPDATE nzi_console.job_types SET items_version = items_version + 1 WHERE organisation_id = $1 AND job_type_id = $2 RETURNING items_version`,
      [context.organisationId, input.jobTypeId]);
    return {
      data: { jobTypeId: input.jobTypeId, itemsVersion: saved!.items_version, items: input.items.map(({ itemId, quantity, isRequired }) => ({ itemId, quantity, isRequired })), dropped },
      entityType: "job_type", entityId: input.jobTypeId, topic: "job_type.items_set", before: { items: before },
    };
  });
}

