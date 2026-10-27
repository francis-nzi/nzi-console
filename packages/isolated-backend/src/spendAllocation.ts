// Data entry D2: a client's allocation map — the reads routing uses, Admin's commands over it, and the reviewer's re-allocation of a
// spend line, which teaches the map (R1–R4, R6, R8). The pure routing and key normalisation are @nzi/contracts `spendAllocation`.
import { randomUUID } from "node:crypto";
import {
  crpScopeCategoryPath, isCurrencyUnit, vatAppliesByDefault, normaliseDescription, normaliseGlCode, rowScopeForCategory, spendAllocationKey, spendCategoryOf,
  type CommandContext, type CommandInputMap, type SpendAllocationEntry, type SpendAllocationKeyKind, type SpendAllocationRow, type SpendAllocationSource,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { CommandValidationError, refuseMigratedRow, refuseReingestedRow, requireCrpJob, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";
export { activeSpendAllocations, activeSpendAllocationsForJob, clientOfJob } from "./spendAllocationReads";

type AllocationRow = {
  allocation_id: string; client_id: string; key_kind: SpendAllocationKeyKind; match_key: string; display_key: string; target_category_code: string;
  vat_applies: boolean; default_dataset_id: string | null; default_factor_id: string | null; source: SpendAllocationSource; active: boolean;
  version: number; updated_at: Date | string; updated_by: string; default_factor_label?: string | null;
};
const COLUMNS = `a.allocation_id, a.client_id, a.key_kind, a.match_key, a.display_key, a.target_category_code, a.vat_applies, a.default_dataset_id,
  a.default_factor_id, a.source, a.active, a.version, a.updated_at, a.updated_by`;

const entryOf = (row: AllocationRow): SpendAllocationEntry => ({
  allocationId: row.allocation_id, keyKind: row.key_kind, matchKey: row.match_key, targetCategoryCode: row.target_category_code,
  vatApplies: row.vat_applies, defaultDatasetId: row.default_dataset_id, defaultFactorId: row.default_factor_id,
});

/** Every entry for a client as Admin lists it, live first, with the default factor's label. */
export async function listClientSpendAllocations(db: Queryable, organisationId: string, clientId: string): Promise<SpendAllocationRow[]> {
  const { rows } = await db.query<AllocationRow>(
    `SELECT ${COLUMNS}, (SELECT f.label FROM nzi_console.emission_factors f
                          WHERE (f.organisation_id, f.dataset_id, f.factor_id) = (a.organisation_id, a.default_dataset_id, a.default_factor_id)) AS default_factor_label
       FROM nzi_console.client_spend_allocations a
      WHERE a.organisation_id = $1 AND a.client_id = $2
      ORDER BY a.active DESC, a.key_kind, a.match_key, a.updated_at DESC`, [organisationId, clientId]);
  return rows.map((row) => ({
    ...entryOf(row), clientId: row.client_id, displayKey: row.display_key, source: row.source, active: row.active, version: row.version,
    updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by, defaultFactorLabel: row.default_factor_label ?? null,
  }));
}

const matchKeyFor = (kind: SpendAllocationKeyKind, key: string): string | null => (kind === "gl" ? normaliseGlCode(key) : normaliseDescription(key));

/** A default spend factor must be one: priced per a currency, in the target category's scope (R1). */
async function requireDefaultSpendFactor(db: Queryable, organisationId: string, targetCategoryCode: string, datasetId: string | null | undefined, factorId: string | null | undefined): Promise<void> {
  if (!datasetId || !factorId) return;
  const { rows } = await db.query<{ activity_unit: string; scopes: string[] }>(
    `SELECT activity_unit, scopes FROM nzi_console.emission_factors WHERE organisation_id = $1 AND dataset_id = $2 AND factor_id = $3`,
    [organisationId, datasetId, factorId]);
  const factor = rows[0];
  if (!factor) throw new CommandValidationError([{ field: "defaultFactorId", code: "NOT_FOUND", message: "That factor is not in the factor library." }]);
  if (!isCurrencyUnit(factor.activity_unit)) throw new CommandValidationError([{ field: "defaultFactorId", code: "NOT_SPEND", message: "A default factor for a spend line is priced per a currency." }]);
  const root = spendCategoryOf(targetCategoryCode)!.scope;
  if (!factor.scopes.some((tag) => tag.split(".")[0] === root)) throw new CommandValidationError([{ field: "defaultFactorId", code: "FACTOR_NOT_IN_CATEGORY", message: `That factor is not a Scope ${root} factor.` }]);
}

async function refuseLiveDuplicate(db: Queryable, organisationId: string, clientId: string, kind: SpendAllocationKeyKind, matchKey: string, except: string | null): Promise<void> {
  const { rows } = await db.query<{ allocation_id: string }>(
    `SELECT allocation_id FROM nzi_console.client_spend_allocations
      WHERE organisation_id = $1 AND client_id = $2 AND key_kind = $3 AND match_key = $4 AND active AND allocation_id IS DISTINCT FROM $5`,
    [organisationId, clientId, kind, matchKey, except]);
  if (rows[0]) throw new CommandValidationError([{ field: "key", code: "DUPLICATE", message: "This client's map already routes that key. Change that entry rather than adding a second." }]);
}

export type SpendAllocationResult = { allocationId: string; version: number };
const snapshot = (row: AllocationRow) => ({ keyKind: row.key_kind, key: row.display_key, targetCategoryCode: row.target_category_code, vatApplies: row.vat_applies,
  defaultDatasetId: row.default_dataset_id, defaultFactorId: row.default_factor_id, active: row.active, source: row.source });

export function createSpendAllocation(pool: PoolLike, input: CommandInputMap["spend_allocation.create"], context: CommandContext): Promise<StoredOutcome<SpendAllocationResult>> {
  return runPostgresCommand(pool, "spend_allocation.create", input, context, async (db) => {
    const client = await db.query(`SELECT 1 FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [context.organisationId, input.clientId]);
    if (!client.rows[0]) throw new CommandValidationError([{ field: "clientId", code: "NOT_FOUND", message: "Client not found." }]);
    const matchKey = matchKeyFor(input.keyKind, input.key);
    if (!matchKey) throw new CommandValidationError([{ field: "key", code: "INVALID", message: "That key has nothing left to match on once normalised." }]);
    await refuseLiveDuplicate(db, context.organisationId, input.clientId, input.keyKind, matchKey, null);
    await requireDefaultSpendFactor(db, context.organisationId, input.targetCategoryCode, input.defaultDatasetId, input.defaultFactorId);
    const allocationId = randomUUID();
    await db.query(
      `INSERT INTO nzi_console.client_spend_allocations (organisation_id, allocation_id, client_id, key_kind, match_key, display_key, target_category_code,
         vat_applies, default_dataset_id, default_factor_id, source, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'admin', $11, $11)`,
      [context.organisationId, allocationId, input.clientId, input.keyKind, matchKey, input.key.trim(), input.targetCategoryCode, input.vatApplies,
        input.defaultDatasetId ?? null, input.defaultFactorId ?? null, context.actorId]);
    return { data: { allocationId, version: 1 }, entityType: "client_spend_allocation", entityId: allocationId, topic: "spend_allocation.created" };
  });
}

async function lockAllocation(db: Queryable, organisationId: string, allocationId: string, expectedVersion: number): Promise<AllocationRow> {
  const { rows } = await db.query<AllocationRow>(
    `SELECT ${COLUMNS} FROM nzi_console.client_spend_allocations a WHERE a.organisation_id = $1 AND a.allocation_id = $2 FOR UPDATE`, [organisationId, allocationId]);
  const row = rows[0];
  if (!row) throw new CommandValidationError([{ field: "allocationId", code: "NOT_FOUND", message: "That map entry was not found." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

export function updateSpendAllocation(pool: PoolLike, input: CommandInputMap["spend_allocation.update"], context: CommandContext): Promise<StoredOutcome<SpendAllocationResult>> {
  return runPostgresCommand(pool, "spend_allocation.update", input, context, async (db) => {
    const row = await lockAllocation(db, context.organisationId, input.allocationId, input.expectedVersion);
    if (!row.active) throw new CommandValidationError([{ field: "allocationId", code: "ARCHIVED", message: "Reinstate this entry before changing it." }]);
    const dataset = input.defaultDatasetId ?? null, factor = input.defaultFactorId ?? null;
    if (row.target_category_code === input.targetCategoryCode && row.vat_applies === input.vatApplies && row.default_dataset_id === dataset && row.default_factor_id === factor) {
      throw new CommandValidationError([{ field: "targetCategoryCode", code: "UNCHANGED", message: "That is what this entry already says." }]);
    }
    await requireDefaultSpendFactor(db, context.organisationId, input.targetCategoryCode, dataset, factor);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.client_spend_allocations SET target_category_code = $3, vat_applies = $4, default_dataset_id = $5, default_factor_id = $6,
              source = 'admin', version = version + 1, updated_at = now(), updated_by = $7
        WHERE organisation_id = $1 AND allocation_id = $2 RETURNING version`,
      [context.organisationId, input.allocationId, input.targetCategoryCode, input.vatApplies, dataset, factor, context.actorId]);
    return { data: { allocationId: input.allocationId, version: saved!.version }, entityType: "client_spend_allocation", entityId: input.allocationId,
      topic: "spend_allocation.updated", before: snapshot(row) };
  });
}

function setActive(key: "spend_allocation.archive" | "spend_allocation.reinstate", active: boolean) {
  return (pool: PoolLike, input: CommandInputMap["spend_allocation.archive"], context: CommandContext): Promise<StoredOutcome<SpendAllocationResult>> =>
    runPostgresCommand(pool, key, input, context, async (db) => {
      const row = await lockAllocation(db, context.organisationId, input.allocationId, input.expectedVersion);
      if (row.active === active) throw new CommandValidationError([{ field: "allocationId", code: "UNCHANGED", message: active ? "This entry is already in use." : "This entry is already archived." }]);
      if (active) await refuseLiveDuplicate(db, context.organisationId, row.client_id, row.key_kind, row.match_key, row.allocation_id);
      const { rows: [saved] } = await db.query<{ version: number }>(
        `UPDATE nzi_console.client_spend_allocations SET active = $3, version = version + 1, updated_at = now(), updated_by = $4
          WHERE organisation_id = $1 AND allocation_id = $2 RETURNING version`, [context.organisationId, input.allocationId, active, context.actorId]);
      return { data: { allocationId: input.allocationId, version: saved!.version }, entityType: "client_spend_allocation", entityId: input.allocationId,
        topic: active ? "spend_allocation.reinstated" : "spend_allocation.archived", before: snapshot(row) };
    });
}
export const archiveSpendAllocation = setActive("spend_allocation.archive", false);
export const reinstateSpendAllocation = setActive("spend_allocation.reinstate", true);

/**
 * Record what a person decided about a key — a re-allocation (R4) or a confirmed suggestion (R5) — in the caller's transaction:
 * the live entry for the key moves to the new category (its VAT rule and default factor kept, a new version), or a new entry is
 * made. Returns what was written, for the caller's audit.
 */
export async function learnSpendAllocation(
  db: Queryable, context: CommandContext, clientId: string, line: { glCode?: string | null; description?: string | null },
  targetCategoryCode: string, source: Exclude<SpendAllocationSource, "admin">, vatApplies?: boolean,
): Promise<{ allocationId: string; keyKind: SpendAllocationKeyKind; key: string; version: number; created: boolean } | null> {
  const key = spendAllocationKey(line);
  if (!key) return null;
  const display = (key.kind === "gl" ? line.glCode : line.description)!.trim().slice(0, 200);
  const { rows: [live] } = await db.query<AllocationRow>(
    `SELECT ${COLUMNS} FROM nzi_console.client_spend_allocations a
      WHERE a.organisation_id = $1 AND a.client_id = $2 AND a.key_kind = $3 AND a.match_key = $4 AND a.active FOR UPDATE`,
    [context.organisationId, clientId, key.kind, key.key]);
  if (live) {
    if (live.target_category_code === targetCategoryCode) return { allocationId: live.allocation_id, keyKind: key.kind, key: key.key, version: live.version, created: false };
    // A default factor priced in another scope cannot follow the line: it is dropped, not carried somewhere it cannot price.
    const keepFactor = live.default_dataset_id !== null && spendCategoryOf(live.target_category_code)!.scope === spendCategoryOf(targetCategoryCode)!.scope;
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.client_spend_allocations SET target_category_code = $3, vat_applies = $4,
              default_dataset_id = CASE WHEN $5 THEN default_dataset_id END, default_factor_id = CASE WHEN $5 THEN default_factor_id END,
              source = $6, version = version + 1, updated_at = now(), updated_by = $7
        WHERE organisation_id = $1 AND allocation_id = $2 RETURNING version`,
      // VAT follows the line to its new category (Investments takes none, the rest do), unless the caller says otherwise: the old
      // category's rule was about the old category.
      [context.organisationId, live.allocation_id, targetCategoryCode, vatApplies ?? vatAppliesByDefault(targetCategoryCode), keepFactor, source, context.actorId]);
    return { allocationId: live.allocation_id, keyKind: key.kind, key: key.key, version: saved!.version, created: false };
  }
  const allocationId = randomUUID();
  await db.query(
    `INSERT INTO nzi_console.client_spend_allocations (organisation_id, allocation_id, client_id, key_kind, match_key, display_key, target_category_code,
       vat_applies, source, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [context.organisationId, allocationId, clientId, key.kind, key.key, display, targetCategoryCode,
      vatApplies ?? vatAppliesByDefault(targetCategoryCode), source, context.actorId]);
  return { allocationId, keyKind: key.kind, key: key.key, version: 1, created: true };
}

export type ReallocateResult = { rowId: string; version: number; categoryCode: string; allocation: { allocationId: string; keyKind: SpendAllocationKeyKind; key: string; version: number; created: boolean } | null };

/**
 * R4: a reviewer moves a spend line to the category it belongs in. The row (and the register source it was synced from, so a re-sync
 * keeps the move) is re-filed there — scope, category, path; a PG&S sub-category only if it lands in PG&S — and goes back to
 * pending review with its calculation cleared, as any edit does. Its factor stays if it can price a line in the new scope; if not,
 * the move names a spend factor that can. Then the move is recorded in the client's map for the line's key, so the same GL code
 * routes there next time.
 */
export function reallocateScopeRow(pool: PoolLike, input: CommandInputMap["scope.row.reallocate"], context: CommandContext): Promise<StoredOutcome<ReallocateResult>> {
  return runPostgresCommand(pool, "scope.row.reallocate", input, context, async (db) => {
    await requireCrpJob(db, context.organisationId, input.jobId);
    await refuseMigratedRow(db, context.organisationId, input.jobId, input.rowId, "moved");
    await refuseReingestedRow(db, context, input.jobId, input.rowId, "moved");
    const { rows: [row] } = await db.query<{
      version: number; scope: string; category_code: string | null; unit: string | null; dataset_id: string | null; factor_id: string | null;
      factor_source: string; client_factor_id: string | null; column_text: string | null; source_label: string; source_id: string | null;
      group_id: string | null; purchased_goods_category_id: string | null; client_id: string;
    }>(
      `SELECT r.version, r.scope, r.category_code, r.unit, r.dataset_id, r.factor_id, r.factor_source, r.client_factor_id, r.column_text, r.source_label,
              r.source_id, r.group_id, r.purchased_goods_category_id, j.client_id
         FROM nzi_console.job_scope_rows r JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (r.organisation_id, r.job_id)
        WHERE r.organisation_id = $1 AND r.job_id = $2 AND r.scope_row_id = $3 FOR UPDATE OF r`, [context.organisationId, input.jobId, input.rowId]);
    if (!row) throw new CommandValidationError([{ field: "rowId", code: "NOT_FOUND", message: "That entry was not found on this job." }]);
    if (row.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, row.version);
    if (row.group_id) throw new CommandValidationError([{ field: "rowId", code: "GROUP_ROLLUP", message: "This row is a group roll-up — move its member sources instead." }]);
    if (!isCurrencyUnit(row.unit)) throw new CommandValidationError([{ field: "rowId", code: "NOT_SPEND", message: "Only a spend line is allocated by the map; an activity entry belongs where its factor is." }]);
    const current = row.category_code ?? (/^3\.\d+$/.test(row.scope) ? row.scope : null);
    if (current === input.categoryCode) throw new CommandValidationError([{ field: "categoryCode", code: "UNCHANGED", message: "The line is already in that category." }]);
    const scope = rowScopeForCategory(input.categoryCode)!;
    const root = spendCategoryOf(input.categoryCode)!.scope;

    // The factor the line will carry in its new home: the one named, else its own if that can price a line in the new scope.
    let datasetId = row.dataset_id, factorId = row.factor_id, factorLabel: string | null = null, factorVersion: string | null = null;
    if (input.factorId && input.datasetId) {
      const { rows: [factor] } = await db.query<{ activity_unit: string; scopes: string[]; label: string; version: string | null }>(
        `SELECT f.activity_unit, f.scopes, f.label, d.version FROM nzi_console.job_dataset_selections s
           JOIN nzi_console.emission_factors f ON (f.organisation_id, f.dataset_id) = (s.organisation_id, s.dataset_id)
           JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (f.organisation_id, f.dataset_id)
          WHERE s.organisation_id = $1 AND s.job_id = $2 AND f.dataset_id = $3 AND f.factor_id = $4 AND f.active`,
        [context.organisationId, input.jobId, input.datasetId, input.factorId]);
      if (!factor) throw new CommandValidationError([{ field: "factorId", code: "FACTOR_NOT_SELECTED", message: "That factor is not in a dataset selected for this job." }]);
      if (!isCurrencyUnit(factor.activity_unit) || factor.activity_unit !== row.unit) throw new CommandValidationError([{ field: "factorId", code: "UNIT_INCOMPATIBLE", message: `The line is in ${row.unit}; choose a spend factor priced per ${row.unit}.` }]);
      if (!factor.scopes.some((tag) => tag.split(".")[0] === root)) throw new CommandValidationError([{ field: "factorId", code: "FACTOR_NOT_IN_CATEGORY", message: `That factor is not a Scope ${root} factor.` }]);
      datasetId = input.datasetId; factorId = input.factorId; factorLabel = factor.label; factorVersion = factor.version;
    } else if (row.factor_source === "client") {
      const { rows: [factor] } = await db.query<{ scope: string }>(`SELECT scope FROM nzi_console.client_factors WHERE organisation_id = $1 AND client_factor_id = $2`, [context.organisationId, row.client_factor_id]);
      if (!factor || factor.scope.split(".")[0] !== root) throw new CommandValidationError([{ field: "factorId", code: "FACTOR_REQUIRED", message: `Its client factor cannot price a Scope ${root} line — choose a spend factor for the new category.` }]);
    } else {
      const { rows: [factor] } = await db.query<{ scopes: string[] }>(
        `SELECT scopes FROM nzi_console.emission_factors WHERE organisation_id = $1 AND dataset_id = $2 AND factor_id = $3`, [context.organisationId, row.dataset_id, row.factor_id]);
      if (!factor || !factor.scopes.some((tag) => tag.split(".")[0] === root)) {
        throw new CommandValidationError([{ field: "factorId", code: "FACTOR_REQUIRED", message: `Its factor cannot price a Scope ${root} line — choose a spend factor for the new category.` }]);
      }
    }

    const path = crpScopeCategoryPath(scope);
    const pgs = input.categoryCode === "3.1" ? row.purchased_goods_category_id : null;
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.job_scope_rows SET scope = $4, category_code = $5, level_1 = $6, level_2 = $7, level_3 = NULL, level_4 = NULL,
              purchased_goods_category_id = $8, dataset_id = $9, factor_id = $10,
              factor_label = coalesce($11, factor_label), factor_version = coalesce($12, factor_version), filed_suffix_code = NULL,
              calculated_tco2e = NULL, review_status = 'pending', reviewed_row_version = NULL, reviewed_by = NULL, reviewed_at = NULL, reviewer_note = NULL,
              version = version + 1, updated_at = now()
        WHERE organisation_id = $1 AND job_id = $2 AND scope_row_id = $3 RETURNING version`,
      [context.organisationId, input.jobId, input.rowId, scope, input.categoryCode, path[0], path[1], pgs, datasetId, factorId, factorLabel, factorVersion]);
    if (row.source_id) {
      await db.query(
        `UPDATE nzi_console.job_emission_sources SET scope = $3, category_code = $4, purchased_goods_category_id = $5, dataset_id = $6, factor_id = $7, updated_at = now()
          WHERE organisation_id = $1 AND source_id = $2`, [context.organisationId, row.source_id, scope, input.categoryCode, pgs, datasetId, factorId]);
    }
    // R4: the map learns — keyed on the line's GL code (its column text; for a line synced from an imported source, the source's GL
    // code), else its description.
    let glCode = row.column_text;
    if (!normaliseGlCode(glCode) && row.source_id) {
      glCode = (await db.query<{ source_subtype: string | null }>(`SELECT source_subtype FROM nzi_console.job_emission_sources WHERE organisation_id = $1 AND source_id = $2`,
        [context.organisationId, row.source_id])).rows[0]?.source_subtype ?? null;
    }
    const allocation = await learnSpendAllocation(db, context, row.client_id, { glCode, description: row.source_label }, input.categoryCode, "reallocation");
    return {
      data: { rowId: input.rowId, version: saved!.version, categoryCode: input.categoryCode, allocation },
      entityType: "scope_row", entityId: input.rowId, topic: "scope.row.reallocated",
      before: { scope: row.scope, categoryCode: current, datasetId: row.dataset_id, factorId: row.factor_id },
    };
  });
}

/** The clients Admin can pick a map for, with how many live entries each has. */
export async function listSpendAllocationClients(db: Queryable, organisationId: string): Promise<Array<{ clientId: string; name: string; entries: number }>> {
  const { rows } = await db.query<{ client_id: string; name: string; entries: number }>(
    `SELECT c.client_id, c.name,
            (SELECT count(*)::int FROM nzi_console.client_spend_allocations a WHERE (a.organisation_id, a.client_id) = (c.organisation_id, c.client_id) AND a.active) AS entries
       FROM nzi_console.clients c WHERE c.organisation_id = $1 ORDER BY lower(c.name), c.client_id`, [organisationId]);
  return rows.map((row) => ({ clientId: row.client_id, name: row.name, entries: row.entries }));
}

/** The spend factors (priced per a currency) in the organisation's library, for a map entry's optional default. */
export async function listSpendFactors(db: Queryable, organisationId: string): Promise<Array<{ datasetId: string; factorId: string; label: string; unit: string; scopes: string[]; dataset: string }>> {
  const { rows } = await db.query<{ dataset_id: string; factor_id: string; label: string; activity_unit: string; scopes: string[]; dataset: string }>(
    `SELECT f.dataset_id, f.factor_id, f.label, f.activity_unit, f.scopes, d.name AS dataset
       FROM nzi_console.emission_factors f JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (f.organisation_id, f.dataset_id)
      WHERE f.organisation_id = $1 AND f.active AND f.activity_unit ~ '^[A-Z]{3}$' AND d.status = 'active'
      ORDER BY f.label, d.name LIMIT 500`, [organisationId]);
  return rows.map((row) => ({ datasetId: row.dataset_id, factorId: row.factor_id, label: row.label, unit: row.activity_unit, scopes: row.scopes, dataset: row.dataset }));
}
