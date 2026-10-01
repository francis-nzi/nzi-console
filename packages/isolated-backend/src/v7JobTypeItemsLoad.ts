import { randomUUID } from "node:crypto";
import { JOB_TYPE_ITEM_QUANTITY_MAX } from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row, V7Table } from "./v7ClientExtract";

/**
 * The v7 job-type templates import (admin Phase E3, `load:v7-job-type-items`; ruled `phaseE-commercial-catalogue-plan.md`
 * E-Q5/E-Q10): v7's `job_type_items` → 0147's `job_type_items`.
 *
 * Each v7 row names a v7 job type and a v7 catalogue item; both resolve **by their v7 identity** to what C4
 * (`load:v7-jobs-config`) and E2 (`load:v7-job-items`) loaded. A row whose type or item did not load is **left out and
 * reported**, never guessed. Then per (type, item) pair: **its v7 identity**, else the same pair with none (a row a
 * person included here — stamped, its own quantity and flag kept), else **inserted**. Re-runs (R4): v7 unchanged → left
 * alone; changed and still as an import wrote it → v7 wins; changed **and** edited here since → refused and reported.
 * A pair the console includes that v7 lacks is reported, never dropped. Every write bumps that type's
 * `items_version`, so an editor open on the template sees a conflict rather than overwriting the import.
 *
 * One transaction; a dry run is the whole load, rolled back. Run after `load:v7-jobs-config` and `load:v7-job-items`.
 */

export const JOB_TYPE_ITEMS_RUN_PREFIX = "v7-job-type-items-";
export const V7_JOB_TYPE_ITEM_TABLES: readonly V7Table[] = ["job_type_items"];

const text = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };
const flag = (value: string | null | undefined): boolean | null => {
  const v = value?.trim().toLowerCase();
  return v === "t" || v === "true" || v === "1" ? true : v === "f" || v === "false" || v === "0" ? false : null;
};

export type PlannedTemplateRow = {
  legacyDbId: string; jobTypeLegacyId: string; itemLegacyId: string; quantity: number; isRequired: boolean; sortOrder: number;
  legacyValues: Record<string, unknown>;
};
export type TemplateRowSkip = { legacyDbId: string; reason: string };
export type JobTypeItemsPlan = { values: PlannedTemplateRow[]; skipped: TemplateRowSkip[] };

export function planV7JobTypeItems(extract: Partial<Record<V7Table, readonly V7Row[]>>): JobTypeItemsPlan {
  const values: PlannedTemplateRow[] = [];
  const skipped: TemplateRowSkip[] = [];
  const pairs = new Map<string, string>();
  for (const row of [...(extract.job_type_items ?? [])].sort((a, b) => Number(a.job_type_item_id) - Number(b.job_type_item_id))) {
    const legacyDbId = text(row.job_type_item_id);
    if (!legacyDbId) { skipped.push({ legacyDbId: "(blank)", reason: "a row with no id" }); continue; }
    const jobTypeLegacyId = text(row.job_type_id), itemLegacyId = text(row.item_id);
    if (!jobTypeLegacyId || !itemLegacyId) { skipped.push({ legacyDbId, reason: "a row without its job type or item" }); continue; }
    const pair = `${jobTypeLegacyId}/${itemLegacyId}`;
    if (pairs.has(pair)) { skipped.push({ legacyDbId, reason: `the same job type and item as v7 row ${pairs.get(pair)}` }); continue; }
    const raw = text(row.quantity);
    const quantity = raw === null ? 1 : Number(raw);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > JOB_TYPE_ITEM_QUANTITY_MAX || Math.abs(Math.round(quantity * 100) - quantity * 100) > 1e-6) {
      skipped.push({ legacyDbId, reason: "a quantity that is not above 0, to two places" }); continue;
    }
    const sortOrder = Number(text(row.sort_order) ?? "0");
    pairs.set(pair, legacyDbId);
    values.push({
      legacyDbId, jobTypeLegacyId, itemLegacyId, quantity, isRequired: flag(row.is_required) ?? true,
      sortOrder: Number.isInteger(sortOrder) && sortOrder >= 0 ? sortOrder : 0,
      legacyValues: { jobTypeId: jobTypeLegacyId, itemId: itemLegacyId, quantity, isRequired: row.is_required ?? null, sortOrder: row.sort_order ?? null },
    });
  }
  return { values, skipped };
}

export type JobTypeItemsOutcome = {
  committed: boolean; runId: string;
  inserted: number; stamped: number; updated: number; unchanged: number;
  /** Rows whose v7 job type or item is not loaded here — left out, never guessed. */
  unresolved: string[];
  /** R4: changed in v7 and edited here since — nothing written for these. */
  conflicts: string[];
  /** Pairs a template here includes that v7 does not — reported, never dropped. */
  hereOnly: string[];
  notes: string[];
};

class DryRunRollback extends Error {}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  : value;
const same = (a: unknown, b: unknown) => a !== null && a !== undefined && JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const byImport = (actor: string) => actor.startsWith(JOB_TYPE_ITEMS_RUN_PREFIX);

export async function loadV7JobTypeItems(pool: PoolLike, organisationId: string, plan: JobTypeItemsPlan, options: { commit: boolean; runId?: string }): Promise<JobTypeItemsOutcome> {
  const runId = options.runId ?? `${JOB_TYPE_ITEMS_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(JOB_TYPE_ITEMS_RUN_PREFIX)) throw new Error(`A job-type-items run id must start ${JOB_TYPE_ITEMS_RUN_PREFIX} — it is how a re-run knows a row is still as an import wrote it.`);
  const outcome: JobTypeItemsOutcome = { committed: options.commit, runId, inserted: 0, stamped: 0, updated: 0, unchanged: 0, unresolved: [], conflicts: [], hereOnly: [], notes: [] };
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      await reconcile(db, organisationId, plan, runId, outcome);
      if (outcome.inserted + outcome.stamped + outcome.updated > 0) {
        await db.query(
          `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
           VALUES ($1, $2, $3, 'system', 'job_type_items.imported', 'job_type_items', 'job_type_items', $4, $5, $6::jsonb)`,
          [organisationId, randomUUID(), IMPORT_ACTOR, runId, "Job-type templates reconciled from NZ Insights Pro v7 (admin E3)",
            JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, inserted: outcome.inserted, stamped: outcome.stamped, updated: outcome.updated,
              unchanged: outcome.unchanged, unresolved: outcome.unresolved.length, conflicts: outcome.conflicts.length, hereOnly: outcome.hereOnly.length })]);
      }
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}

async function reconcile(db: Queryable, org: string, plan: JobTypeItemsPlan, runId: string, outcome: JobTypeItemsOutcome) {
  // One after another: the one transaction client runs one query at a time.
  const types = await db.query<{ job_type_id: string; legacy_db_id: string }>(`SELECT job_type_id, legacy_db_id FROM nzi_console.job_types WHERE organisation_id = $1 AND source_system = $2 FOR UPDATE`, [org, SOURCE_SYSTEM]);
  const items = await db.query<{ item_id: string; legacy_db_id: string; item_code: string }>(`SELECT item_id, legacy_db_id, item_code FROM nzi_console.job_items WHERE organisation_id = $1 AND source_system = $2`, [org, SOURCE_SYSTEM]);
  const rows = await db.query<{ job_type_id: string; item_id: string; included: boolean; source_system: string | null; legacy_db_id: string | null; legacy_values: unknown; updated_by: string }>(
    `SELECT job_type_id, item_id, included, source_system, legacy_db_id, legacy_values, updated_by FROM nzi_console.job_type_items WHERE organisation_id = $1 FOR UPDATE`, [org]);
  const typeOf = new Map(types.rows.map((row) => [row.legacy_db_id, row.job_type_id]));
  const itemOf = new Map(items.rows.map((row) => [row.legacy_db_id, row.item_id]));
  const touched = new Set<string>();
  const seen = new Set<string>();

  for (const value of plan.values) {
    const jobTypeId = typeOf.get(value.jobTypeLegacyId), itemId = itemOf.get(value.itemLegacyId);
    if (!jobTypeId || !itemId) {
      outcome.unresolved.push(`v7 row ${value.legacyDbId}: ${!jobTypeId ? `job type ${value.jobTypeLegacyId}` : ""}${!jobTypeId && !itemId ? " and " : ""}${!itemId ? `item ${value.itemLegacyId}` : ""} not loaded here`);
      continue;
    }
    seen.add(`${jobTypeId}/${itemId}`);
    const row = rows.rows.find((candidate) => candidate.job_type_id === jobTypeId && candidate.item_id === itemId);
    if (!row) {
      await db.query(
        `INSERT INTO nzi_console.job_type_items (organisation_id, job_type_id, item_id, quantity, is_required, sort_order, source_system, legacy_db_id, legacy_values, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10)`,
        [org, jobTypeId, itemId, value.quantity, value.isRequired, value.sortOrder, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues), runId]);
      outcome.inserted += 1; touched.add(jobTypeId);
      continue;
    }
    if (row.source_system === SOURCE_SYSTEM && row.legacy_db_id === value.legacyDbId) {
      if (same(row.legacy_values, value.legacyValues)) { outcome.unchanged += 1; continue; }
      if (!byImport(row.updated_by)) { outcome.conflicts.push(`v7 row ${value.legacyDbId}: changed in v7 since the last load, and edited here since`); continue; }
      await db.query(
        `UPDATE nzi_console.job_type_items SET quantity = $4, is_required = $5, sort_order = $6, included = true, legacy_values = $7::jsonb, version = version + 1, updated_at = now(), updated_by = $8
          WHERE organisation_id = $1 AND job_type_id = $2 AND item_id = $3`,
        [org, jobTypeId, itemId, value.quantity, value.isRequired, value.sortOrder, JSON.stringify(value.legacyValues), runId]);
      outcome.updated += 1; touched.add(jobTypeId);
      continue;
    }
    // The pair is already held here without v7's identity — a person included it. Its own quantity and flag stand.
    await db.query(
      `UPDATE nzi_console.job_type_items SET source_system = $4, legacy_db_id = $5, legacy_values = $6::jsonb, version = version + 1, updated_at = now()
        WHERE organisation_id = $1 AND job_type_id = $2 AND item_id = $3`,
      [org, jobTypeId, itemId, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues)]);
    outcome.notes.push(`v7 row ${value.legacyDbId}: already ${row.included ? "included" : "held (not included)"} here — stamped with v7's identity; its own quantity, flag and inclusion stand`);
    outcome.stamped += 1; touched.add(jobTypeId);
  }

  const loadedTypes = new Set(typeOf.values());
  const codeOf = new Map(items.rows.map((row) => [row.item_id, row.item_code]));
  outcome.hereOnly = rows.rows.filter((row) => row.included && loadedTypes.has(row.job_type_id) && !seen.has(`${row.job_type_id}/${row.item_id}`))
    .map((row) => `${row.job_type_id} includes ${codeOf.get(row.item_id) ?? row.item_id}`);
  if (touched.size) {
    await db.query(`UPDATE nzi_console.job_types SET items_version = items_version + 1 WHERE organisation_id = $1 AND job_type_id = ANY($2::text[])`, [org, [...touched]]);
  }
}
