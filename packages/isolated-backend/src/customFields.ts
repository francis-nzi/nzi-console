import { randomUUID } from "node:crypto";
import {
  customFieldListSpec, customFieldOptionIssues, customFieldValueIssue,
  type CommandContext, type CommandInputMap, type CustomFieldEntityType, type CustomFieldListFilterKey, type CustomFieldListQuery, type CustomFieldListSortKey,
  type CustomFieldOption, type CustomFieldType, type ListPage,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { defineListSql, readListPage } from "./listPage";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * Custom field definitions (admin Phase F3; ruled `phaseF-comms-crm-plan.md`, F-Q5): 0151's `custom_field_definitions`,
 * through the command runner under admin.settings — never deleted.
 *
 * - **Entity, key and type are set once** (create fields only; 0151 grants no UPDATE on them).
 * - **Options are never removed**: an update must carry every option value the definition already holds (it may relabel,
 *   reorder, deactivate and add), so every value stored downstream still resolves.
 * - **The default is valid for the type** — and, for a select, an active option.
 * - The values are not here: they are each entity's own workstream's (`docs/CUSTOM_FIELD_VALUES_CONTRACT.md`).
 */

const iso = (date: unknown) => date instanceof Date ? date.toISOString() : String(date);
const cleanLabel = (value: string) => value.trim().replace(/\s+/g, " ");

export type CustomFieldProvenance = "v7" | "added";
export type CustomFieldRow = {
  definitionId: string; entityType: CustomFieldEntityType; key: string; type: CustomFieldType; label: string;
  required: boolean; sortOrder: number; options: CustomFieldOption[] | null; defaultValue: string | null;
  active: boolean; version: number; provenance: CustomFieldProvenance; updatedAt: string;
};
export type CustomFieldPage = ListPage<CustomFieldRow, CustomFieldListFilterKey, Record<string, never>>;

const definitionSql = defineListSql<CustomFieldListSortKey, CustomFieldListFilterKey>({
  base: `SELECT d.organisation_id, d.definition_id, d.entity_type, d.field_key, d.field_type, d.label, d.required, d.sort_order, d.options,
      d.default_value, d.active, d.version, d.updated_at,
      CASE WHEN d.active THEN 'active' ELSE 'inactive' END AS status,
      CASE WHEN d.source_system IS NOT NULL THEN 'v7' ELSE 'added' END AS provenance
    FROM nzi_console.custom_field_definitions d`,
  search: ["field_key", "label"],
  filters: {
    entity: { kind: "equals", column: "entity_type", facet: { noneLabel: "—", values: ["client", "job", "contact", "quote", "supplier"] } },
    status: { kind: "equals", column: "status", facet: { noneLabel: "—", values: ["active", "inactive"] } },
  },
  sort: { sortOrder: { column: "sort_order" }, label: { column: "label", text: true }, key: { column: "field_key", text: true }, type: { column: "field_type", text: true }, status: { column: "status", text: true } },
  tiebreak: "definition_id",
});

const toRow = (row: Record<string, unknown>): CustomFieldRow => ({
  definitionId: String(row.definition_id), entityType: row.entity_type as CustomFieldEntityType, key: String(row.field_key), type: row.field_type as CustomFieldType,
  label: String(row.label), required: row.required === true, sortOrder: Number(row.sort_order), options: (row.options as CustomFieldOption[] | null) ?? null,
  defaultValue: row.default_value === null ? null : String(row.default_value), active: row.active === true, version: Number(row.version),
  provenance: row.provenance as CustomFieldProvenance, updatedAt: iso(row.updated_at),
});

export async function listCustomFieldsPage(db: Queryable, query: CustomFieldListQuery): Promise<CustomFieldPage> {
  return readListPage(db, definitionSql, customFieldListSpec, query, { mapRow: toRow, mapSummary: () => ({}) });
}

/** An entity's active definitions, in order — what a downstream form renders (the values contract's read). */
export async function listActiveCustomFields(db: Queryable, entityType: CustomFieldEntityType): Promise<CustomFieldRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT definition_id, entity_type, field_key, field_type, label, required, sort_order, options, default_value, active, version, updated_at,
            CASE WHEN source_system IS NOT NULL THEN 'v7' ELSE 'added' END AS provenance
       FROM nzi_console.custom_field_definitions WHERE entity_type = $1 AND active ORDER BY sort_order, lower(label), definition_id`, [entityType]);
  return rows.map(toRow);
}

// ── Commands (admin.settings) ────────────────────────────────────────────────────────────────────────────────────

type Stored = { entity_type: CustomFieldEntityType; field_key: string; field_type: CustomFieldType; label: string; required: boolean; sort_order: number;
  options: CustomFieldOption[] | null; default_value: string | null; active: boolean; version: number };
type Snapshot = { entityType: CustomFieldEntityType; key: string; type: CustomFieldType; label: string; required: boolean; sortOrder: number;
  options: CustomFieldOption[] | null; defaultValue: string | null; active: boolean };
const snapshot = (row: Stored): Snapshot => ({ entityType: row.entity_type, key: row.field_key, type: row.field_type, label: row.label, required: row.required,
  sortOrder: row.sort_order, options: row.options, defaultValue: row.default_value, active: row.active });
export type CustomFieldResult = Snapshot & { definitionId: string; version: number };
const COLUMNS = "entity_type, field_key, field_type, label, required, sort_order, options, default_value, active, version";

/** Options as stored: trimmed labels, in the order given; null for any type but a select. */
const normaliseOptions = (type: CustomFieldType, options: CustomFieldOption[] | null) =>
  type === "select" ? (options ?? []).map((option) => ({ value: option.value, label: cleanLabel(option.label), active: option.active })) : null;

/** Options compared as value, label and state in order — jsonb reorders an object's keys, so not as JSON text. */
const sameOptions = (a: CustomFieldOption[] | null, b: CustomFieldOption[] | null) =>
  JSON.stringify(a?.map((option) => [option.value, option.label, option.active]) ?? null) === JSON.stringify(b?.map((option) => [option.value, option.label, option.active]) ?? null);

/** The checks that need the type: the options suit it, and the default is valid for it. */
function assertTyped(type: CustomFieldType, options: CustomFieldOption[] | null, defaultValue: string | null) {
  const issues = customFieldOptionIssues(type, options).map((message) => ({ field: "options", code: "INVALID", message }));
  if (defaultValue !== null) {
    const problem = customFieldValueIssue(type, defaultValue, options);
    if (problem) issues.push({ field: "defaultValue", code: "INVALID", message: `The default: ${problem}` });
  }
  if (issues.length) throw new CommandValidationError(issues);
}

async function lock(db: Queryable, context: CommandContext, definitionId: string, expectedVersion: number): Promise<Stored> {
  const { rows: [row] } = await db.query<Stored>(
    `SELECT ${COLUMNS} FROM nzi_console.custom_field_definitions WHERE organisation_id = $1 AND definition_id = $2 FOR UPDATE`, [context.organisationId, definitionId]);
  if (!row) throw new CommandValidationError([{ field: "definitionId", code: "NOT_FOUND", message: "That custom field is not here." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

export function createCustomField(pool: PoolLike, input: CommandInputMap["custom_field.create"], context: CommandContext): Promise<StoredOutcome<CustomFieldResult>> {
  return runPostgresCommand(pool, "custom_field.create", input, context, async (db) => {
    const options = normaliseOptions(input.fieldType, input.options);
    const defaultValue = input.defaultValue?.trim() ? input.defaultValue : null;
    assertTyped(input.fieldType, options, defaultValue);
    const { rows: [taken] } = await db.query<{ taken: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM nzi_console.custom_field_definitions WHERE organisation_id = $1 AND entity_type = $2 AND field_key = $3) AS taken`,
      [context.organisationId, input.entityType, input.fieldKey]);
    if (taken?.taken) throw new CommandValidationError([{ field: "fieldKey", code: "DUPLICATE", message: "That entity already has a field — active or not — with that key." }]);
    const definitionId = `custom-field:${randomUUID()}`;
    const { rows: [saved] } = await db.query<Stored>(
      `INSERT INTO nzi_console.custom_field_definitions (organisation_id, definition_id, entity_type, field_key, field_type, label, required, sort_order, options, default_value, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $11) RETURNING ${COLUMNS}`,
      [context.organisationId, definitionId, input.entityType, input.fieldKey, input.fieldType, cleanLabel(input.label), input.required, input.sortOrder,
        options === null ? null : JSON.stringify(options), defaultValue, context.actorId]);
    return { data: { definitionId, version: saved!.version, ...snapshot(saved!) }, entityType: "custom_field", entityId: definitionId, topic: "custom_field.created" };
  });
}

export function updateCustomField(pool: PoolLike, input: CommandInputMap["custom_field.update"], context: CommandContext): Promise<StoredOutcome<CustomFieldResult>> {
  return runPostgresCommand(pool, "custom_field.update", input, context, async (db) => {
    const current = await lock(db, context, input.definitionId, input.expectedVersion);
    const options = normaliseOptions(current.field_type, input.options);
    const defaultValue = input.defaultValue?.trim() ? input.defaultValue : null;
    assertTyped(current.field_type, options, defaultValue);
    // Never remove an option: every value already held keeps resolving (relabel, reorder, deactivate and add are fine).
    const dropped = (current.options ?? []).filter((held) => !(options ?? []).some((option) => option.value === held.value)).map((held) => held.value);
    if (dropped.length) throw new CommandValidationError([{ field: "options", code: "OPTION_REMOVED", message: `Options are never removed — deactivate ${dropped.map((value) => `"${value}"`).join(", ")} instead.` }]);
    const label = cleanLabel(input.label);
    if (label === current.label && input.required === current.required && input.sortOrder === current.sort_order && defaultValue === current.default_value
      && sameOptions(options, current.options)) {
      throw new CommandValidationError([{ field: "label", code: "UNCHANGED", message: "That is what the field already holds." }]);
    }
    const { rows: [saved] } = await db.query<Stored>(
      `UPDATE nzi_console.custom_field_definitions SET label = $3, required = $4, sort_order = $5, options = $6::jsonb, default_value = $7,
              version = version + 1, updated_at = now(), updated_by = $8
        WHERE organisation_id = $1 AND definition_id = $2 RETURNING ${COLUMNS}`,
      [context.organisationId, input.definitionId, label, input.required, input.sortOrder, options === null ? null : JSON.stringify(options), defaultValue, context.actorId]);
    return { data: { definitionId: input.definitionId, version: saved!.version, ...snapshot(saved!) }, entityType: "custom_field", entityId: input.definitionId,
      topic: "custom_field.updated", before: snapshot(current) };
  });
}

function setActive(key: "custom_field.deactivate" | "custom_field.reinstate", active: boolean) {
  return (pool: PoolLike, input: CommandInputMap[typeof key], context: CommandContext): Promise<StoredOutcome<CustomFieldResult>> =>
    runPostgresCommand(pool, key, input, context, async (db) => {
      const current = await lock(db, context, input.definitionId, input.expectedVersion);
      if (current.active === active) throw new CommandValidationError([{ field: "definitionId", code: active ? "ALREADY_ACTIVE" : "ALREADY_INACTIVE", message: `That field is already ${active ? "active" : "inactive"}.` }]);
      const { rows: [saved] } = await db.query<Stored>(
        `UPDATE nzi_console.custom_field_definitions SET active = $3, version = version + 1, updated_at = now(), updated_by = $4
          WHERE organisation_id = $1 AND definition_id = $2 RETURNING ${COLUMNS}`, [context.organisationId, input.definitionId, active, context.actorId]);
      return { data: { definitionId: input.definitionId, version: saved!.version, ...snapshot(saved!) }, entityType: "custom_field", entityId: input.definitionId,
        topic: active ? "custom_field.reinstated" : "custom_field.deactivated", before: snapshot(current) };
    });
}
/** A deactivated field leaves the forms; every value held for it is kept, and still shown where it was entered. */
export const deactivateCustomField = setActive("custom_field.deactivate", false);
export const reinstateCustomField = setActive("custom_field.reinstate", true);
