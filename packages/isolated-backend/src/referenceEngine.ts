import { randomUUID } from "node:crypto";
import {
  LOOKUP_CATEGORIES, referenceValueListSpec, TIME_ACTIVITY_CATEGORY, type CommandContext, type CommandInputMap, type ListPage, type LookupCategory,
  type ReferenceValueListFilterKey, type ReferenceValueListQuery, type ReferenceValueListSortKey,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { defineListSql, readListPage } from "./listPage";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * The reference-value engine (admin Phase A2; docs/design/admin-prototype.html → Lookups). One engine for every simple
 * lookup: a value is added, edited, reordered, deactivated and reinstated — never deleted (R3) — through the command
 * runner (admin.lookups, idempotency, `expectedVersion`, audit with before and after).
 *
 * A deactivated value leaves the pickers (`/api/isolated/lookups` serves active values only) and still resolves on the
 * records that use it (`clientReferences` does not filter on `active`).
 */

// ── "In use" — which records point at a value, per category ────────────────────────────────────────────────────

/**
 * Where each lookup is referenced by id today. A category missing here has no console consumer yet, and its values
 * show "—" (not referenced yet) rather than 0 (ruled P8): "nothing uses this yet" and "no record uses this value" are
 * different facts. A later phase that links a column adds it here, and the count appears.
 */
export const LOOKUP_CONSUMERS: Partial<Record<LookupCategory, { table: string; column: string; label: string }>> = {
  industries: { table: "clients", column: "sector_value_id", label: "clients" },
  referrals: { table: "clients", column: "referral_value_id", label: "clients" },
  portfolios: { table: "clients", column: "portfolio_value_id", label: "clients" },
  // TIME (0155): an activity counts the time entries logged as it, voided ones included — they still resolve it.
  activity_types: { table: "time_entries", column: "activity_value_id", label: "time entries" },
};

const inUseSql = (value: string) => `CASE ${value}.category_key ${Object.entries(LOOKUP_CONSUMERS).map(([category, consumer]) =>
  `WHEN '${category}' THEN (SELECT count(*) FROM nzi_console.${consumer!.table} x WHERE (x.organisation_id, x.${consumer!.column}) = (${value}.organisation_id, ${value}.value_id))`).join(" ")} ELSE NULL END`;

// ── Categories ─────────────────────────────────────────────────────────────────────────────────────────────────

export type LookupCategorySummary = {
  key: LookupCategory; label: string; description: string; carriesCode: boolean; codeLabel: string | null;
  active: number; inactive: number; consumer: string | null;
};

export async function listLookupCategories(db: Queryable): Promise<LookupCategorySummary[]> {
  const { rows } = await db.query<{ category_key: LookupCategory; label: string; description: string; carries_code: boolean; code_label: string | null; active: string; inactive: string }>(
    `SELECT rc.category_key, rc.label, rc.description, rc.carries_code, rc.code_label,
            count(rv.value_id) FILTER (WHERE rv.active)::text AS active, count(rv.value_id) FILTER (WHERE NOT rv.active)::text AS inactive
       FROM nzi_console.reference_categories rc
       LEFT JOIN nzi_console.reference_values rv ON rv.category_key = rc.category_key
      WHERE rc.category_key = ANY($1::text[]) AND rc.active
      GROUP BY rc.category_key, rc.label, rc.description, rc.carries_code, rc.code_label`, [LOOKUP_CATEGORIES]);
  const byKey = new Map(rows.map((row) => [row.category_key, row]));
  // In the engine's own order (the design's chips), not the database's.
  return LOOKUP_CATEGORIES.flatMap((key) => {
    const row = byKey.get(key);
    return row ? [{ key, label: row.label, description: row.description, carriesCode: row.carries_code, codeLabel: row.code_label,
      active: Number(row.active), inactive: Number(row.inactive), consumer: LOOKUP_CONSUMERS[key]?.label ?? null }] : [];
  });
}

// ── The value list ─────────────────────────────────────────────────────────────────────────────────────────────

export type ReferenceProvenance = "v7" | "added" | "seeded";
export type ReferenceValueRow = {
  valueId: string; categoryKey: LookupCategory; label: string; code: string | null; sortOrder: number; active: boolean; version: number;
  provenance: ReferenceProvenance;
  /** Records pointing at this value; null where the category has no consumer yet (shown "—"). */
  inUse: number | null;
  /** For a portfolio: the client that owns it (0138), when one is recorded. */
  ownerClient: string | null;
  /** For an activity type (TIME Addendum): whether time logged as it is billable by default; null elsewhere. */
  billableDefault: boolean | null;
  updatedAt: string;
};
export type ReferenceValuePage = ListPage<ReferenceValueRow, ReferenceValueListFilterKey, Record<string, never>>;

const valueSql = defineListSql<ReferenceValueListSortKey, ReferenceValueListFilterKey>({
  base: `SELECT rv.organisation_id, rv.value_id, rv.category_key AS category, rv.label, rv.code, rv.sort_order, rv.active, rv.version, rv.updated_at,
      CASE WHEN rv.active THEN 'active' ELSE 'inactive' END AS status,
      CASE WHEN rv.source_system IS NOT NULL THEN 'v7' WHEN rv.source = 'admin' THEN 'added' ELSE 'seeded' END AS provenance,
      (${inUseSql("rv")})::int AS in_use
    FROM nzi_console.reference_values rv
    WHERE rv.category_key = $1 AND rv.category_key = ANY(ARRAY[${LOOKUP_CATEGORIES.map((key) => `'${key}'`).join(",")}])`,
  search: ["label", "code"],
  filters: {
    category: { kind: "equals", column: "category" },
    status: { kind: "equals", column: "status", facet: { noneLabel: "—", values: ["active", "inactive"] } },
  },
  sort: { sortOrder: { column: "sort_order" }, label: { column: "label", text: true }, inUse: { column: "in_use" }, status: { column: "status", text: true } },
  tiebreak: "value_id",
  pageColumns: `(SELECT c.name FROM nzi_console.portfolio_owners po JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (po.organisation_id, po.owner_client_id)
      WHERE (po.organisation_id, po.portfolio_value_id) = (base.organisation_id, base.value_id)) AS owner_client,
    (SELECT d.billable_default FROM nzi_console.time_activity_defaults d
      WHERE (d.organisation_id, d.value_id) = (base.organisation_id, base.value_id)) AS billable_default`,
});

/**
 * One category's values. The category scopes the list's base (a bound parameter), not just a filter over every
 * lookup — so "no values yet" and the All / Active / Inactive counts are this category's own.
 */
export async function listReferenceValuesPage(db: Queryable, query: ReferenceValueListQuery): Promise<ReferenceValuePage> {
  const category = query.filters.category?.[0] ?? LOOKUP_CATEGORIES[0];
  return readListPage(db, valueSql, referenceValueListSpec, query, {
    baseParams: [category],
    mapRow: (row) => ({
      valueId: String(row.value_id), categoryKey: row.category as LookupCategory, label: String(row.label), code: row.code === null ? null : String(row.code),
      sortOrder: Number(row.sort_order), active: row.active === true, version: Number(row.version), provenance: row.provenance as ReferenceProvenance,
      inUse: row.in_use === null || row.in_use === undefined ? null : Number(row.in_use),
      ownerClient: row.owner_client === null || row.owner_client === undefined ? null : String(row.owner_client),
      billableDefault: typeof row.billable_default === "boolean" ? row.billable_default : null,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    }),
    mapSummary: () => ({}),
  });
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────

type StoredValue = { label: string; code: string | null; sort_order: number; active: boolean; version: number };
const cleanCode = (code: string | null | undefined) => code?.trim() ? code.trim() : null;

async function categoryFor(db: Queryable, categoryKey: string): Promise<{ carries_code: boolean }> {
  const { rows: [category] } = await db.query<{ carries_code: boolean }>(
    `SELECT carries_code FROM nzi_console.reference_categories WHERE category_key = $1 AND active`, [categoryKey]);
  if (!category) throw new CommandValidationError([{ field: "categoryKey", code: "NOT_FOUND", message: "That lookup is not available." }]);
  return category;
}

async function assertLabelFree(db: Queryable, context: CommandContext, categoryKey: string, label: string, exceptValueId?: string) {
  const { rows } = await db.query<{ value_id: string }>(
    `SELECT value_id FROM nzi_console.reference_values
      WHERE organisation_id = $1 AND category_key = $2 AND active AND lower(btrim(label)) = lower(btrim($3)) AND value_id IS DISTINCT FROM $4`,
    [context.organisationId, categoryKey, label, exceptValueId ?? null]);
  if (rows[0]) throw new CommandValidationError([{ field: "label", code: "DUPLICATE", message: "An active value already has that label." }]);
}

async function lockValue(db: Queryable, context: CommandContext, categoryKey: string, valueId: string, expectedVersion: number): Promise<StoredValue> {
  const { rows: [value] } = await db.query<StoredValue>(
    `SELECT label, code, sort_order, active, version FROM nzi_console.reference_values
      WHERE organisation_id = $1 AND category_key = $2 AND value_id = $3 FOR UPDATE`, [context.organisationId, categoryKey, valueId]);
  if (!value) throw new CommandValidationError([{ field: "valueId", code: "NOT_FOUND", message: "That value is not in this lookup." }]);
  if (value.version !== expectedVersion) throw new VersionConflictError(expectedVersion, value.version);
  return value;
}

const snapshot = (value: StoredValue) => ({ label: value.label, code: value.code, sortOrder: value.sort_order, active: value.active });

/** An activity value's billable default (TIME Addendum), or null when the value is not an activity / has none yet. */
async function heldBillableDefault(db: Queryable, context: CommandContext, valueId: string): Promise<boolean | null> {
  const { rows: [row] } = await db.query<{ billable_default: boolean }>(
    `SELECT billable_default FROM nzi_console.time_activity_defaults WHERE organisation_id = $1 AND value_id = $2 FOR UPDATE`,
    [context.organisationId, valueId]);
  return row ? row.billable_default : null;
}

/** Writes an activity's billable default in the value's own command transaction, so the two never part. */
async function writeBillableDefault(db: Queryable, context: CommandContext, valueId: string, billableDefault: boolean) {
  await db.query(
    `INSERT INTO nzi_console.time_activity_defaults (organisation_id, value_id, billable_default, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (organisation_id, value_id) DO UPDATE SET billable_default = EXCLUDED.billable_default, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [context.organisationId, valueId, billableDefault, context.actorId]);
}

export type ReferenceValueResult = { valueId: string; categoryKey: string; version: number; active: boolean; billableDefault?: boolean | null };

export function createReferenceValue(pool: PoolLike, input: CommandInputMap["reference.value.create"], context: CommandContext): Promise<StoredOutcome<ReferenceValueResult & { inUse?: number }>> {
  return runPostgresCommand(pool, "reference.value.create", input, context, async (db) => {
    const category = await categoryFor(db, input.categoryKey);
    const code = cleanCode(input.code);
    if (code && !category.carries_code) throw new CommandValidationError([{ field: "code", code: "INVALID", message: "This lookup does not carry a code." }]);
    const label = input.label.trim();
    await assertLabelFree(db, context, input.categoryKey, label);
    const sortOrder = input.sortOrder ?? Number((await db.query<{ next: string }>(
      `SELECT (coalesce(max(sort_order), 0) + 10)::text AS next FROM nzi_console.reference_values WHERE organisation_id = $1 AND category_key = $2`,
      [context.organisationId, input.categoryKey])).rows[0]!.next);
    const valueId = `${input.categoryKey}:${randomUUID()}`;
    await db.query(
      `INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, code, sort_order, source, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'admin', $7, $7)`,
      [context.organisationId, input.categoryKey, valueId, label, code, sortOrder, context.actorId]);
    // An activity is created with its billable default — validate() made it required — so none is ever defaultless.
    const activity = input.categoryKey === TIME_ACTIVITY_CATEGORY;
    if (activity) await writeBillableDefault(db, context, valueId, input.billableDefault === true);
    return {
      // The audit's after_json is `data`: an activity's default is recorded there, so the Lookups trail carries it.
      data: { valueId, categoryKey: input.categoryKey, version: 1, active: true, ...(activity ? { billableDefault: input.billableDefault === true } : {}) },
      entityType: "reference_value", entityId: valueId, topic: "reference.value.created",
      after: { label, code, sortOrder, active: true, ...(activity ? { billableDefault: input.billableDefault === true } : {}) },
    };
  });
}

export function updateReferenceValue(pool: PoolLike, input: CommandInputMap["reference.value.update"], context: CommandContext): Promise<StoredOutcome<ReferenceValueResult>> {
  return runPostgresCommand(pool, "reference.value.update", input, context, async (db) => {
    const category = await categoryFor(db, input.categoryKey);
    const current = await lockValue(db, context, input.categoryKey, input.valueId, input.expectedVersion);
    const code = cleanCode(input.code);
    if (code && !category.carries_code) throw new CommandValidationError([{ field: "code", code: "INVALID", message: "This lookup does not carry a code." }]);
    const label = input.label.trim();
    if (current.active) await assertLabelFree(db, context, input.categoryKey, label, input.valueId);
    // An activity's billable default: omitted keeps the held one; given, it is written with the value and audited beside it.
    const activity = input.categoryKey === TIME_ACTIVITY_CATEGORY;
    const heldDefault = activity ? await heldBillableDefault(db, context, input.valueId) : null;
    const nextDefault = activity ? (input.billableDefault ?? heldDefault) : null;
    if (activity && nextDefault === null) throw new CommandValidationError([{ field: "billableDefault", code: "REQUIRED", message: "Say whether time logged as this activity is billable by default." }]);
    if (activity && nextDefault !== heldDefault) await writeBillableDefault(db, context, input.valueId, nextDefault!);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.reference_values SET label = $4, code = $5, sort_order = $6, version = version + 1, updated_at = now(), updated_by = $7
        WHERE organisation_id = $1 AND category_key = $2 AND value_id = $3 RETURNING version`,
      [context.organisationId, input.categoryKey, input.valueId, label, code, input.sortOrder, context.actorId]);
    return {
      data: { valueId: input.valueId, categoryKey: input.categoryKey, version: saved!.version, active: current.active, ...(activity ? { billableDefault: nextDefault } : {}) },
      entityType: "reference_value", entityId: input.valueId, topic: "reference.value.updated",
      before: { ...snapshot(current), ...(activity ? { billableDefault: heldDefault } : {}) },
      after: { label, code, sortOrder: input.sortOrder, active: current.active, ...(activity ? { billableDefault: nextDefault } : {}) },
    };
  });
}

export function deactivateReferenceValue(pool: PoolLike, input: CommandInputMap["reference.value.deactivate"], context: CommandContext): Promise<StoredOutcome<ReferenceValueResult & { inUse: number | null }>> {
  return runPostgresCommand(pool, "reference.value.deactivate", input, context, async (db) => {
    const current = await lockValue(db, context, input.categoryKey, input.valueId, input.expectedVersion);
    if (!current.active) throw new CommandValidationError([{ field: "valueId", code: "ALREADY_INACTIVE", message: "That value is already inactive." }]);
    const { rows: [usage] } = await db.query<{ in_use: number | null }>(
      `SELECT (${inUseSql("rv")})::int AS in_use FROM nzi_console.reference_values rv WHERE rv.organisation_id = $1 AND rv.category_key = $2 AND rv.value_id = $3`,
      [context.organisationId, input.categoryKey, input.valueId]);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.reference_values SET active = false, version = version + 1, updated_at = now(), updated_by = $4
        WHERE organisation_id = $1 AND category_key = $2 AND value_id = $3 RETURNING version`,
      [context.organisationId, input.categoryKey, input.valueId, context.actorId]);
    return {
      // The records still pointing at it come back, so the person who deactivated it knows what keeps resolving it.
      data: { valueId: input.valueId, categoryKey: input.categoryKey, version: saved!.version, active: false, inUse: usage?.in_use ?? null },
      entityType: "reference_value", entityId: input.valueId, topic: "reference.value.deactivated",
      before: snapshot(current), after: { ...snapshot(current), active: false },
    };
  });
}

export function reinstateReferenceValue(pool: PoolLike, input: CommandInputMap["reference.value.reinstate"], context: CommandContext): Promise<StoredOutcome<ReferenceValueResult>> {
  return runPostgresCommand(pool, "reference.value.reinstate", input, context, async (db) => {
    const current = await lockValue(db, context, input.categoryKey, input.valueId, input.expectedVersion);
    if (current.active) throw new CommandValidationError([{ field: "valueId", code: "ALREADY_ACTIVE", message: "That value is already active." }]);
    // Another active value may have taken the label while this one was inactive; reinstating would make two.
    await assertLabelFree(db, context, input.categoryKey, current.label, input.valueId);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.reference_values SET active = true, version = version + 1, updated_at = now(), updated_by = $4
        WHERE organisation_id = $1 AND category_key = $2 AND value_id = $3 RETURNING version`,
      [context.organisationId, input.categoryKey, input.valueId, context.actorId]);
    return {
      data: { valueId: input.valueId, categoryKey: input.categoryKey, version: saved!.version, active: true },
      entityType: "reference_value", entityId: input.valueId, topic: "reference.value.reinstated",
      before: snapshot(current), after: { ...snapshot(current), active: true },
    };
  });
}
