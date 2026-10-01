import { randomUUID } from "node:crypto";
import {
  jobItemListSpec,
  type CommandContext, type CommandInputMap, type JobItemListFilterKey, type JobItemListQuery, type JobItemListSortKey, type ListPage,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { defineListSql, readListPage } from "./listPage";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * The service catalogue (admin Phase E2; ruled `phaseE-commercial-catalogue-plan.md`, E-Q4/E-Q5/E-Q8/E-Q9): 0146's
 * `job_items`, added, edited, deactivated and reinstated through the command runner (admin.lookups) — never deleted.
 *
 * - **The code is set once** (E-Q4): a create field only; 0146 grants the role no UPDATE on it.
 * - **The amounts are finance.manage's** (E-Q8): `job_item.price.set` is the only command that writes them, and its
 *   result — the audit's after_json, the idempotency record, the outbox payload — names which amounts were set, never
 *   the amounts (NZC-120). The list returns them only to a finance.manage holder (`amounts: null` otherwise, never 0).
 * - **One currency** (E-Q9): an item is made in the organisation's default currency and its amounts are held in it.
 * - **References** — a category must be a `job_item_categories` value, a unit a `units_of_measure` value, a VAT rate one
 *   of E1's; each **active** to be chosen, and one an item already holds still stands (R3).
 */

const blank = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };
const cleanName = (value: string) => value.trim().replace(/\s+/g, " ");
const iso = (date: unknown) => date instanceof Date ? date.toISOString() : String(date);
const amount = (value: unknown) => value === null || value === undefined ? null : Number(value);

// ── The list ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type JobItemProvenance = "v7" | "added" | "seeded";
export type JobItemRow = {
  itemId: string; code: string; name: string; description: string | null;
  categoryValueId: string | null; category: string | null; unitValueId: string | null; unit: string | null;
  defaultHours: number | null; vatRateId: string | null; vatRate: string | null; currency: string;
  /** Null when the reader may not see them (finance.manage) — never 0 for "hidden". Within, null is "not yet priced". */
  amounts: { cost: number | null; sell: number | null } | null;
  sortOrder: number; active: boolean; version: number; provenance: JobItemProvenance; updatedAt: string;
  /** Job-type templates naming this item — null until E3's templates exist (shown "none yet", not 0). */
  inUse: number | null;
};
export type JobItemPage = ListPage<JobItemRow, JobItemListFilterKey, Record<string, never>>;

const jobItemSql = defineListSql<JobItemListSortKey, JobItemListFilterKey>({
  base: `SELECT ji.organisation_id, ji.item_id, ji.item_code AS code, ji.name, ji.description, ji.category_value_id, cat.label AS category,
      ji.unit_value_id, uom.label AS unit, ji.default_hours AS hours, ji.vat_rate_id, vat.name || ' · ' || trim_scale(vat.rate_pct)::text || '%' AS vat_rate,
      ji.currency_code, ji.default_cost_amount, ji.default_sell_amount, ji.sort_order, ji.active, ji.version, ji.updated_at,
      CASE WHEN ji.active THEN 'active' ELSE 'inactive' END AS status,
      CASE WHEN ji.source_system IS NOT NULL THEN 'v7' WHEN ji.created_by LIKE 'migration:%' THEN 'seeded' ELSE 'added' END AS provenance
    FROM nzi_console.job_items ji
    LEFT JOIN nzi_console.reference_values cat ON (cat.organisation_id, cat.value_id) = (ji.organisation_id, ji.category_value_id)
    LEFT JOIN nzi_console.reference_values uom ON (uom.organisation_id, uom.value_id) = (ji.organisation_id, ji.unit_value_id)
    LEFT JOIN nzi_console.vat_rates vat ON (vat.organisation_id, vat.vat_rate_id) = (ji.organisation_id, ji.vat_rate_id)`,
  search: ["code", "name"],
  filters: {
    status: { kind: "equals", column: "status", facet: { noneLabel: "—", values: ["active", "inactive"] } },
    category: { kind: "equals", column: "category", facet: { noneLabel: "No category" } },
  },
  sort: {
    sortOrder: { column: "sort_order" }, code: { column: "code", text: true }, name: { column: "name", text: true },
    category: { column: "category", text: true }, hours: { column: "hours" }, status: { column: "status", text: true },
  },
  tiebreak: "item_id",
});

/** The catalogue, a page at a time. `showAmounts` is whether the reader holds finance.manage (E-Q8). */
export async function listJobItemsPage(db: Queryable, query: JobItemListQuery, options: { showAmounts: boolean }): Promise<JobItemPage> {
  return readListPage(db, jobItemSql, jobItemListSpec, query, {
    mapRow: (row) => ({
      itemId: String(row.item_id), code: String(row.code), name: String(row.name), description: row.description === null ? null : String(row.description),
      categoryValueId: row.category_value_id === null ? null : String(row.category_value_id), category: row.category === null ? null : String(row.category),
      unitValueId: row.unit_value_id === null ? null : String(row.unit_value_id), unit: row.unit === null ? null : String(row.unit),
      defaultHours: amount(row.hours), vatRateId: row.vat_rate_id === null ? null : String(row.vat_rate_id), vatRate: row.vat_rate === null ? null : String(row.vat_rate),
      currency: String(row.currency_code),
      amounts: options.showAmounts ? { cost: amount(row.default_cost_amount), sell: amount(row.default_sell_amount) } : null,
      sortOrder: Number(row.sort_order), active: row.active === true, version: Number(row.version), provenance: row.provenance as JobItemProvenance,
      updatedAt: iso(row.updated_at),
      // E3 adds job-type templates; it adds the count here.
      inUse: null,
    }),
    mapSummary: () => ({}),
  });
}

/** What the drawer's pickers offer: the active categories, units and VAT rates — and the organisation's currency. */
export type JobItemPickers = {
  categories: Array<{ valueId: string; label: string; active: boolean }>;
  units: Array<{ valueId: string; label: string; active: boolean }>;
  vatRates: Array<{ vatRateId: string; label: string; isDefault: boolean; active: boolean }>;
  currency: string | null;
};
export async function listJobItemPickers(db: Queryable, organisationId: string): Promise<JobItemPickers> {
  const [values, vat, currency] = await Promise.all([
    db.query<{ category_key: string; value_id: string; label: string; active: boolean }>(
      `SELECT category_key, value_id, label, active FROM nzi_console.reference_values
        WHERE organisation_id = $1 AND category_key IN ('job_item_categories', 'units_of_measure') ORDER BY sort_order, lower(label)`, [organisationId]),
    db.query<{ vat_rate_id: string; name: string; rate_pct: string; is_default: boolean; active: boolean }>(
      `SELECT vat_rate_id, name, trim_scale(rate_pct)::text AS rate_pct, is_default, active FROM nzi_console.vat_rates WHERE organisation_id = $1 ORDER BY rate_pct DESC, name`, [organisationId]),
    db.query<{ code: string }>(`SELECT code FROM nzi_console.currencies WHERE organisation_id = $1 AND is_default`, [organisationId]),
  ]);
  const of = (key: string) => values.rows.filter((row) => row.category_key === key).map((row) => ({ valueId: row.value_id, label: row.label, active: row.active }));
  return {
    categories: of("job_item_categories"), units: of("units_of_measure"),
    vatRates: vat.rows.map((row) => ({ vatRateId: row.vat_rate_id, label: `${row.name} · ${row.rate_pct}%`, isDefault: row.is_default, active: row.active })),
    currency: currency.rows[0]?.code ?? null,
  };
}

// ── Commands: the definition (admin.lookups) ─────────────────────────────────────────────────────────────────────

type StoredItem = {
  item_code: string; name: string; description: string | null; category_value_id: string | null; unit_value_id: string | null;
  default_hours: string | null; vat_rate_id: string | null; sort_order: number; active: boolean; version: number; currency_code: string;
};
/** The definition as the audit records it, before and after. No amounts: they are never written here (E-Q8). */
type ItemSnapshot = {
  code: string; name: string; description: string | null; categoryValueId: string | null; unitValueId: string | null;
  defaultHours: number | null; vatRateId: string | null; sortOrder: number; active: boolean; currency: string;
};
const snapshot = (row: StoredItem): ItemSnapshot => ({
  code: row.item_code, name: row.name, description: row.description, categoryValueId: row.category_value_id, unitValueId: row.unit_value_id,
  defaultHours: amount(row.default_hours), vatRateId: row.vat_rate_id, sortOrder: row.sort_order, active: row.active, currency: row.currency_code,
});
export type JobItemResult = ItemSnapshot & { itemId: string; version: number };
const RETURNING = "RETURNING item_code, name, description, category_value_id, unit_value_id, default_hours::text, vat_rate_id, sort_order, active, version, currency_code";

async function lockItem(db: Queryable, context: CommandContext, itemId: string, expectedVersion: number): Promise<StoredItem> {
  const { rows: [row] } = await db.query<StoredItem>(
    `SELECT item_code, name, description, category_value_id, unit_value_id, default_hours::text, vat_rate_id, sort_order, active, version, currency_code
       FROM nzi_console.job_items WHERE organisation_id = $1 AND item_id = $2 FOR UPDATE`, [context.organisationId, itemId]);
  if (!row) throw new CommandValidationError([{ field: "itemId", code: "NOT_FOUND", message: "That catalogue item is not here." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

/**
 * Each reference is the organisation's, of the right kind, and active — unless the item already holds it (R3: a value
 * deactivated since still stands where it is held).
 */
async function assertReferences(db: Queryable, context: CommandContext, next: { categoryValueId: string | null; unitValueId: string | null; vatRateId: string | null },
  held: { categoryValueId: string | null; unitValueId: string | null; vatRateId: string | null } | null) {
  const issues: Array<{ field: string; code: string; message: string }> = [];
  for (const [field, key, label] of [["categoryValueId", "job_item_categories", "category"], ["unitValueId", "units_of_measure", "unit"]] as const) {
    const value = next[field];
    if (value === null || value === held?.[field]) continue;
    const { rows: [row] } = await db.query<{ category_key: string; active: boolean }>(
      `SELECT category_key, active FROM nzi_console.reference_values WHERE organisation_id = $1 AND value_id = $2`, [context.organisationId, value]);
    if (!row || row.category_key !== key) issues.push({ field, code: "NOT_FOUND", message: `That ${label} is not one of this organisation's ${label === "unit" ? "units of measure" : "job item categories"}.` });
    else if (!row.active) issues.push({ field, code: "INACTIVE", message: `That ${label} is deactivated; reinstate it in Lookups to choose it.` });
  }
  if (next.vatRateId !== null && next.vatRateId !== held?.vatRateId) {
    const { rows: [row] } = await db.query<{ active: boolean }>(`SELECT active FROM nzi_console.vat_rates WHERE organisation_id = $1 AND vat_rate_id = $2`, [context.organisationId, next.vatRateId]);
    if (!row) issues.push({ field: "vatRateId", code: "NOT_FOUND", message: "That VAT rate is not one of this organisation's." });
    else if (!row.active) issues.push({ field: "vatRateId", code: "INACTIVE", message: "That VAT rate is deactivated; reinstate it in Tax & currency to choose it." });
  }
  if (issues.length) throw new CommandValidationError(issues);
}

const definitionOf = (input: CommandInputMap["job_item.create"] | CommandInputMap["job_item.update"]) => ({
  name: cleanName(input.name), description: blank(input.description), categoryValueId: blank(input.categoryValueId), unitValueId: blank(input.unitValueId),
  defaultHours: input.defaultHours ?? null, vatRateId: blank(input.vatRateId),
});

export function createJobItem(pool: PoolLike, input: CommandInputMap["job_item.create"], context: CommandContext): Promise<StoredOutcome<JobItemResult>> {
  return runPostgresCommand(pool, "job_item.create", input, context, async (db) => {
    const fields = definitionOf(input);
    const { rows: [taken] } = await db.query<{ taken: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM nzi_console.job_items WHERE organisation_id = $1 AND lower(item_code) = lower($2)) AS taken`, [context.organisationId, input.itemCode]);
    if (taken?.taken) throw new CommandValidationError([{ field: "itemCode", code: "DUPLICATE", message: "Another catalogue item — active or not — already has that code." }]);
    await assertReferences(db, context, fields, null);
    // E-Q9: an item is made in the organisation's selling currency.
    const { rows: [currency] } = await db.query<{ code: string }>(`SELECT code FROM nzi_console.currencies WHERE organisation_id = $1 AND is_default`, [context.organisationId]);
    if (!currency) throw new CommandValidationError([{ field: "currency", code: "NO_DEFAULT_CURRENCY", message: "This organisation has no default currency; set one in Tax & currency first." }]);
    const sortOrder = input.sortOrder ?? Number((await db.query<{ next: string }>(
      `SELECT (coalesce(max(sort_order), 0) + 10)::text AS next FROM nzi_console.job_items WHERE organisation_id = $1`, [context.organisationId])).rows[0]!.next);
    const itemId = `job-item:${randomUUID()}`;
    const { rows: [saved] } = await db.query<StoredItem>(
      `INSERT INTO nzi_console.job_items (organisation_id, item_id, item_code, name, description, category_value_id, unit_value_id, default_hours, vat_rate_id,
         currency_code, sort_order, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) ${RETURNING}`,
      [context.organisationId, itemId, input.itemCode, fields.name, fields.description, fields.categoryValueId, fields.unitValueId, fields.defaultHours,
        fields.vatRateId, currency.code, sortOrder, context.actorId]);
    return { data: { itemId, version: saved!.version, ...snapshot(saved!) }, entityType: "job_item", entityId: itemId, topic: "job_item.created" };
  });
}

export function updateJobItem(pool: PoolLike, input: CommandInputMap["job_item.update"], context: CommandContext): Promise<StoredOutcome<JobItemResult>> {
  return runPostgresCommand(pool, "job_item.update", input, context, async (db) => {
    const current = await lockItem(db, context, input.itemId, input.expectedVersion);
    const fields = definitionOf(input);
    await assertReferences(db, context, fields, { categoryValueId: current.category_value_id, unitValueId: current.unit_value_id, vatRateId: current.vat_rate_id });
    const { rows: [saved] } = await db.query<StoredItem>(
      `UPDATE nzi_console.job_items SET name = $3, description = $4, category_value_id = $5, unit_value_id = $6, default_hours = $7, vat_rate_id = $8,
              sort_order = $9, version = version + 1, updated_at = now(), updated_by = $10
        WHERE organisation_id = $1 AND item_id = $2 ${RETURNING}`,
      [context.organisationId, input.itemId, fields.name, fields.description, fields.categoryValueId, fields.unitValueId, fields.defaultHours, fields.vatRateId,
        input.sortOrder ?? current.sort_order, context.actorId]);
    return { data: { itemId: input.itemId, version: saved!.version, ...snapshot(saved!) }, entityType: "job_item", entityId: input.itemId,
      topic: "job_item.updated", before: snapshot(current) };
  });
}

export function deactivateJobItem(pool: PoolLike, input: CommandInputMap["job_item.deactivate"], context: CommandContext): Promise<StoredOutcome<JobItemResult>> {
  return runPostgresCommand(pool, "job_item.deactivate", input, context, async (db) => {
    const current = await lockItem(db, context, input.itemId, input.expectedVersion);
    if (!current.active) throw new CommandValidationError([{ field: "itemId", code: "ALREADY_INACTIVE", message: "That catalogue item is already inactive." }]);
    const { rows: [saved] } = await db.query<StoredItem>(
      `UPDATE nzi_console.job_items SET active = false, version = version + 1, updated_at = now(), updated_by = $3 WHERE organisation_id = $1 AND item_id = $2 ${RETURNING}`,
      [context.organisationId, input.itemId, context.actorId]);
    return { data: { itemId: input.itemId, version: saved!.version, ...snapshot(saved!) }, entityType: "job_item", entityId: input.itemId,
      topic: "job_item.deactivated", before: snapshot(current) };
  });
}

export function reinstateJobItem(pool: PoolLike, input: CommandInputMap["job_item.reinstate"], context: CommandContext): Promise<StoredOutcome<JobItemResult>> {
  return runPostgresCommand(pool, "job_item.reinstate", input, context, async (db) => {
    const current = await lockItem(db, context, input.itemId, input.expectedVersion);
    if (current.active) throw new CommandValidationError([{ field: "itemId", code: "ALREADY_ACTIVE", message: "That catalogue item is already active." }]);
    const { rows: [saved] } = await db.query<StoredItem>(
      `UPDATE nzi_console.job_items SET active = true, version = version + 1, updated_at = now(), updated_by = $3 WHERE organisation_id = $1 AND item_id = $2 ${RETURNING}`,
      [context.organisationId, input.itemId, context.actorId]);
    return { data: { itemId: input.itemId, version: saved!.version, ...snapshot(saved!) }, entityType: "job_item", entityId: input.itemId,
      topic: "job_item.reinstated", before: snapshot(current) };
  });
}

// ── Command: the amounts (finance.manage) ────────────────────────────────────────────────────────────────────────

/**
 * What the price command returns — and so what its audit event, idempotency record and outbox event hold: which item,
 * its new version, and **which** amounts were set or cleared. **Never the amounts** (E-Q8, NZC-120): they live in the
 * finance-gated columns alone, and the audit is read by a wider audience than finance.manage.
 */
export type JobItemPriceResult = { itemId: string; version: number; currency: string; changed: Array<"defaultCostAmount" | "defaultSellAmount"> };

export function setJobItemPrice(pool: PoolLike, input: CommandInputMap["job_item.price.set"], context: CommandContext): Promise<StoredOutcome<JobItemPriceResult>> {
  return runPostgresCommand(pool, "job_item.price.set", input, context, async (db) => {
    const { rows: [current] } = await db.query<{ version: number; currency_code: string; cost: string | null; sell: string | null }>(
      `SELECT version, currency_code, default_cost_amount::text AS cost, default_sell_amount::text AS sell FROM nzi_console.job_items
        WHERE organisation_id = $1 AND item_id = $2 FOR UPDATE`, [context.organisationId, input.itemId]);
    if (!current) throw new CommandValidationError([{ field: "itemId", code: "NOT_FOUND", message: "That catalogue item is not here." }]);
    if (current.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, current.version);
    const changed = ([["defaultCostAmount", amount(current.cost), input.defaultCostAmount], ["defaultSellAmount", amount(current.sell), input.defaultSellAmount]] as const)
      .filter(([, was, now]) => was !== now).map(([field]) => field);
    if (changed.length === 0) throw new CommandValidationError([{ field: "defaultSellAmount", code: "UNCHANGED", message: "Those are the amounts it already holds." }]);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.job_items SET default_cost_amount = $3, default_sell_amount = $4, version = version + 1, updated_at = now(), updated_by = $5
        WHERE organisation_id = $1 AND item_id = $2 RETURNING version`,
      [context.organisationId, input.itemId, input.defaultCostAmount, input.defaultSellAmount, context.actorId]);
    return { data: { itemId: input.itemId, version: saved!.version, currency: current.currency_code, changed }, entityType: "job_item", entityId: input.itemId, topic: "job_item.price_set" };
  });
}
