import { randomUUID } from "node:crypto";
import type { LookupCategory } from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row, V7Table } from "./v7ClientExtract";

/**
 * The v7 lookup import (admin Phase A3; ruled plan `admin-phaseA-plan.md` §5): v7's twelve simple lookups →
 * `reference_values`, reconciled onto what the console already holds.
 *
 * **Reconcile, per category (R5)** — for each v7 value:
 * 1. **its v7 identity** (`source_system`, `legacy_db_id`) — a value this import made or stamped before;
 * 2. else **the normalised label** (trimmed, case-insensitive), among values with no v7 identity yet — seeded or added
 *    here — **reinstating an archived match**, which is stamped with the v7 identity from then on;
 * 3. else **inserted**.
 * `is_active` and (where v7 has one) the sort order are carried; every value it touches records its v7 identity and
 * `legacy_values`, what it was loaded as.
 *
 * **Seeded values v7 lacks are reported, never archived (ruled P6).** Nothing is deleted.
 *
 * **Re-runs (R4)** — a value already loaded: v7 unchanged since → left alone; v7 changed and the value is still as an
 * import wrote it (`updated_by` is an import run) → v7 wins; v7 changed **and** the value was edited here since →
 * refused and reported by category and label, never silently.
 *
 * **Portfolio owners** — each active v7 portfolio's owner client is linked (`portfolio_owners`, 0138) when that client
 * was imported; an owner not in the console is reported. Same re-run rule.
 *
 * Tenant-scoped (one transaction per category, as the application role, so RLS and every constraint apply); a dry run
 * is the load, rolled back.
 */

export const LOOKUP_RUN_PREFIX = "v7-lookups-";

/** Each v7 lookup table, the category it fills, and its id column. */
export const V7_LOOKUP_TABLES: ReadonlyArray<{ table: V7Table; category: LookupCategory; id: string }> = [
  { table: "industries_lookup", category: "industries", id: "industry_id" },
  { table: "referrals_lookup", category: "referrals", id: "referral_id" },
  { table: "portfolios_lookup", category: "portfolios", id: "portfolio_id" },
  { table: "payment_terms_lookup", category: "payment_terms", id: "term_id" },
  { table: "positions_lookup", category: "positions", id: "position_id" },
  { table: "processes_lookup", category: "processes", id: "process_id" },
  { table: "client_teams_lookup", category: "client_teams", id: "client_team_id" },
  { table: "action_categories_lookup", category: "action_categories", id: "category_id" },
  { table: "governance_subjects_lookup", category: "governance_subjects", id: "governance_subject_id" },
  { table: "bd_bin_reasons_lookup", category: "bd_bin_reasons", id: "bin_reason_id" },
  { table: "uom_lookup", category: "units_of_measure", id: "uom_id" },
  { table: "job_item_categories_lookup", category: "job_item_categories", id: "category_id" },
];
export const V7_LOOKUP_TABLE_NAMES = V7_LOOKUP_TABLES.map((entry) => entry.table);

export type LegacyLookupValues = { name: string | null; isActive: boolean | null; sortOrder: number | null };
export type PlannedLookupValue = {
  legacyDbId: string; label: string; active: boolean; sortOrder: number | null; legacyValues: LegacyLookupValues;
  /** Portfolios only: v7's owner client id. */
  ownerClientLegacyId: string | null;
};
export type LookupPlan = {
  categories: Array<{ category: LookupCategory; table: V7Table; values: PlannedLookupValue[] }>;
  /** Rows left out, each with its reason: no id, no name, a sort order that is not a number, a duplicate active label. */
  skipped: Array<{ table: V7Table; legacyDbId: string; reason: string }>;
};

const text = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };
export const normaliseLabel = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();
const flag = (value: string | null | undefined): boolean | null => {
  const v = value?.trim().toLowerCase();
  return v === "t" || v === "true" || v === "1" ? true : v === "f" || v === "false" || v === "0" ? false : null;
};

/** v7's lookup rows → planned values. Pure: no database. */
export function planV7Lookups(extract: Partial<Record<V7Table, readonly V7Row[]>>): LookupPlan {
  const plan: LookupPlan = { categories: [], skipped: [] };
  for (const entry of V7_LOOKUP_TABLES) planLookupTable(extract, entry, plan);
  return plan;
}

/** One v7 lookup table → its planned values, appended to `plan` (also how the time import plans v7's `time_subjects`). */
export function planLookupTable(extract: Partial<Record<V7Table, readonly V7Row[]>>, { table, category, id }: { table: V7Table; category: LookupCategory; id: string }, plan: LookupPlan): void {
  {
    const values: PlannedLookupValue[] = [];
    const activeLabels = new Map<string, string>();
    const rows = [...(extract[table] ?? [])].sort((a, b) => Number(a[id]) - Number(b[id]));
    for (const row of rows) {
      const legacyDbId = text(row[id]);
      if (!legacyDbId) { plan.skipped.push({ table, legacyDbId: "(blank)", reason: "a row with no id" }); continue; }
      const name = text(row.name);
      if (!name) { plan.skipped.push({ table, legacyDbId, reason: "a value with no name" }); continue; }
      const isActive = flag(row.is_active);
      const rawSort = text(row.sort_order);
      const sortOrder = rawSort === null ? null : Number(rawSort);
      if (sortOrder !== null && !Number.isInteger(sortOrder)) { plan.skipped.push({ table, legacyDbId, reason: "a sort order that is not a whole number" }); continue; }
      // An omitted is_active (a deployment without the column) reads as active — v7's own default.
      const active = isActive ?? true;
      const label = name.replace(/\s+/g, " ");
      if (active) {
        const clash = activeLabels.get(normaliseLabel(label));
        if (clash) { plan.skipped.push({ table, legacyDbId, reason: `the same label as v7 value ${clash}, and both are active` }); continue; }
        activeLabels.set(normaliseLabel(label), legacyDbId);
      }
      values.push({ legacyDbId, label, active, sortOrder, legacyValues: { name, isActive, sortOrder },
        ownerClientLegacyId: table === "portfolios_lookup" ? text(row.portfolio_owner_client_db_id) : null });
    }
    plan.categories.push({ category, table, values });
  }
}

// ── Loading ───────────────────────────────────────────────────────────────────────────────────────────────────

type Existing = {
  value_id: string; label: string; sort_order: number; active: boolean; version: number; source: string;
  source_system: string | null; legacy_db_id: string | null; legacy_values: LegacyLookupValues | null; updated_by: string;
};

export type LookupCategoryOutcome = {
  category: LookupCategory;
  inserted: number; stamped: number; reinstated: number;
  /** Stamped values that were active here and are inactive in v7 — is_active is carried, so they are deactivated (never deleted). */
  deactivated: number; updated: number; unchanged: number;
  /** R4: changed in v7 and edited here since — nothing written for these. */
  conflicts: Array<{ label: string; reason: string }>;
  /** Values the console holds that v7 does not — reported, never archived (P6). */
  seededOnly: string[];
  /** v7's own counts against the console's v7-identified values, after the load. */
  parity: { v7Active: number; v7Inactive: number; consoleActive: number; consoleInactive: number };
  owners?: { linked: number; unchanged: number; updated: number; ownerNotImported: string[]; conflicts: string[] };
  failed?: string;
};
export type LookupLoadOutcome = { committed: boolean; runId: string; categories: LookupCategoryOutcome[] };

class DryRunRollback extends Error {}
const sameValues = (a: LegacyLookupValues | null, b: LegacyLookupValues) =>
  a !== null && a.name === b.name && a.isActive === b.isActive && a.sortOrder === b.sortOrder;
const byImport = (updatedBy: string) => updatedBy.startsWith(LOOKUP_RUN_PREFIX);

export async function loadV7Lookups(pool: PoolLike, organisationId: string, plan: LookupPlan, options: { commit: boolean; runId?: string }): Promise<LookupLoadOutcome> {
  const runId = options.runId ?? `${LOOKUP_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(LOOKUP_RUN_PREFIX)) throw new Error(`A lookup run id must start ${LOOKUP_RUN_PREFIX} — it is how a re-run knows a value is still as an import wrote it.`);
  const outcome: LookupLoadOutcome = { committed: options.commit, runId, categories: [] };
  for (const planned of plan.categories) {
    const result: LookupCategoryOutcome = {
      category: planned.category, inserted: 0, stamped: 0, reinstated: 0, deactivated: 0, updated: 0, unchanged: 0, conflicts: [], seededOnly: [],
      parity: { v7Active: planned.values.filter((v) => v.active).length, v7Inactive: planned.values.filter((v) => !v.active).length, consoleActive: 0, consoleInactive: 0 },
    };
    try {
      await withTenantWrite(pool, organisationId, async (db) => {
        await loadCategory(db, organisationId, planned.category, planned.values, runId, result);
        if (!options.commit) throw new DryRunRollback();
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) result.failed = error instanceof Error ? error.message : String(error);
    }
    outcome.categories.push(result);
  }
  return outcome;
}

/**
 * One category's reconcile, inside the caller's transaction. `runId` must start {@link LOOKUP_RUN_PREFIX} (R4 reads it).
 * Returns v7 id → console value id for every value it placed. Exported for the time import, which reconciles v7's
 * `time_subjects` into `activity_types` in its own transaction, with the entries that use them.
 */
export async function loadCategory(db: Queryable, org: string, category: LookupCategory, values: readonly PlannedLookupValue[], runId: string, result: LookupCategoryOutcome): Promise<Map<string, string>> {
  const { rows: existing } = await db.query<Existing>(
    `SELECT value_id, label, sort_order, active, version, source, source_system, legacy_db_id, legacy_values, updated_by
       FROM nzi_console.reference_values WHERE organisation_id = $1 AND category_key = $2 ORDER BY value_id FOR UPDATE`, [org, category]);
  const claimed = new Set<string>();
  const valueIdOf = new Map<string, string>(); // v7 id → console value id
  let nextSort = existing.reduce((max, value) => Math.max(max, value.sort_order), 0);

  // Deactivations first, then the rest in v7's order — so a label freed by one value can be taken by another in the
  // same run without tripping the one-active-label index.
  const ordered = [...values].sort((a, b) => Number(a.active) - Number(b.active));
  for (const value of ordered) {
    const byIdentity = existing.find((row) => row.source_system === SOURCE_SYSTEM && row.legacy_db_id === value.legacyDbId);
    if (byIdentity) {
      claimed.add(byIdentity.value_id); valueIdOf.set(value.legacyDbId, byIdentity.value_id);
      if (sameValues(byIdentity.legacy_values, value.legacyValues)) { result.unchanged += 1; continue; }
      if (!byImport(byIdentity.updated_by)) {
        result.conflicts.push({ label: byIdentity.label, reason: "changed in v7 since the last load, and edited here since" });
        continue;
      }
      await db.query(
        `UPDATE nzi_console.reference_values SET label = $4, active = $5, sort_order = $6, legacy_values = $7::jsonb,
                version = version + 1, updated_at = now(), updated_by = $8
          WHERE organisation_id = $1 AND category_key = $2 AND value_id = $3`,
        [org, category, byIdentity.value_id, value.label, value.active, value.sortOrder ?? byIdentity.sort_order, JSON.stringify(value.legacyValues), runId]);
      result.updated += 1;
      continue;
    }

    // By label, among values with no v7 identity yet — an active one first, then an archived one (reinstated).
    const candidates = existing.filter((row) => row.source_system === null && !claimed.has(row.value_id) && normaliseLabel(row.label) === normaliseLabel(value.label));
    const byLabel = candidates.find((row) => row.active) ?? candidates[0];
    if (byLabel) {
      claimed.add(byLabel.value_id); valueIdOf.set(value.legacyDbId, byLabel.value_id);
      await db.query(
        `UPDATE nzi_console.reference_values SET label = $4, active = $5, sort_order = $6, source_system = $7, legacy_db_id = $8,
                legacy_values = $9::jsonb, version = version + 1, updated_at = now(), updated_by = $10
          WHERE organisation_id = $1 AND category_key = $2 AND value_id = $3`,
        [org, category, byLabel.value_id, value.label, value.active, value.sortOrder ?? byLabel.sort_order, SOURCE_SYSTEM, value.legacyDbId,
          JSON.stringify(value.legacyValues), runId]);
      result.stamped += 1;
      if (!byLabel.active && value.active) result.reinstated += 1;
      if (byLabel.active && !value.active) result.deactivated += 1;
      continue;
    }

    const valueId = `${category}:v7-${value.legacyDbId}`;
    nextSort = value.sortOrder ?? nextSort + 10;
    await db.query(
      `INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, sort_order, active, source,
         source_system, legacy_db_id, legacy_values, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'import', $7, $8, $9::jsonb, $10, $10)`,
      [org, category, valueId, value.label, value.sortOrder ?? nextSort, value.active, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues), runId]);
    valueIdOf.set(value.legacyDbId, valueId);
    result.inserted += 1;
  }

  // Seeded (or added-here) values v7 does not have — reported, never archived (P6).
  result.seededOnly = existing.filter((row) => row.source_system === null && !claimed.has(row.value_id)).map((row) => `${row.label}${row.active ? "" : " (inactive)"}`);

  if (category === "portfolios") result.owners = await linkOwners(db, org, values, valueIdOf, runId);

  const { rows: [parity] } = await db.query<{ active: string; inactive: string }>(
    `SELECT count(*) FILTER (WHERE active)::text AS active, count(*) FILTER (WHERE NOT active)::text AS inactive
       FROM nzi_console.reference_values WHERE organisation_id = $1 AND category_key = $2 AND source_system = $3`, [org, category, SOURCE_SYSTEM]);
  result.parity.consoleActive = Number(parity?.active ?? 0);
  result.parity.consoleInactive = Number(parity?.inactive ?? 0);

  const touched = result.inserted + result.stamped + result.updated + (result.owners ? result.owners.linked + result.owners.updated : 0);
  if (touched > 0) {
    await db.query(
      `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
       VALUES ($1, $2, $3, 'system', 'reference.values.imported', 'reference_category', $4, $5, $6, $7::jsonb)`,
      [org, randomUUID(), IMPORT_ACTOR, category, runId, "Lookup values reconciled from NZ Insights Pro v7 (admin A3)",
        JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, category, inserted: result.inserted, stamped: result.stamped, reinstated: result.reinstated, deactivated: result.deactivated,
          updated: result.updated, unchanged: result.unchanged, conflicts: result.conflicts.length, seededOnly: result.seededOnly.length, owners: result.owners ?? null })]);
  }
  return valueIdOf;
}

/** A fresh category outcome — for a caller of {@link loadCategory} outside {@link loadV7Lookups}. */
export const emptyCategoryOutcome = (category: LookupCategory, values: readonly PlannedLookupValue[]): LookupCategoryOutcome => ({
  category, inserted: 0, stamped: 0, reinstated: 0, deactivated: 0, updated: 0, unchanged: 0, conflicts: [], seededOnly: [],
  parity: { v7Active: values.filter((v) => v.active).length, v7Inactive: values.filter((v) => !v.active).length, consoleActive: 0, consoleInactive: 0 },
});

async function linkOwners(db: Queryable, org: string, values: readonly PlannedLookupValue[], valueIdOf: Map<string, string>, runId: string) {
  const owners = { linked: 0, unchanged: 0, updated: 0, ownerNotImported: [] as string[], conflicts: [] as string[] };
  // v7 carries only active links (the client import reported the same way): an inactive portfolio's owner is not linked.
  for (const value of values.filter((v) => v.active && v.ownerClientLegacyId)) {
    const valueId = valueIdOf.get(value.legacyDbId);
    if (!valueId) continue; // refused above, and reported there
    const { rows: [client] } = await db.query<{ client_id: string }>(
      `SELECT client_id FROM nzi_console.clients WHERE organisation_id = $1 AND source_system = $2 AND legacy_db_id = $3`, [org, SOURCE_SYSTEM, value.ownerClientLegacyId]);
    if (!client) { owners.ownerNotImported.push(`${value.label} (v7 client ${value.ownerClientLegacyId})`); continue; }
    const { rows: [current] } = await db.query<{ owner_client_id: string; updated_by: string }>(
      `SELECT owner_client_id, updated_by FROM nzi_console.portfolio_owners WHERE organisation_id = $1 AND portfolio_value_id = $2 FOR UPDATE`, [org, valueId]);
    if (!current) {
      await db.query(
        `INSERT INTO nzi_console.portfolio_owners (organisation_id, portfolio_value_id, owner_client_id, source_system, legacy_db_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`, [org, valueId, client.client_id, SOURCE_SYSTEM, value.legacyDbId, runId]);
      owners.linked += 1;
    } else if (current.owner_client_id === client.client_id) {
      owners.unchanged += 1;
    } else if (byImport(current.updated_by)) {
      await db.query(
        `UPDATE nzi_console.portfolio_owners SET owner_client_id = $3, version = version + 1, updated_at = now(), updated_by = $4
          WHERE organisation_id = $1 AND portfolio_value_id = $2`, [org, valueId, client.client_id, runId]);
      owners.updated += 1;
    } else {
      owners.conflicts.push(`${value.label}: its owner was set here, and v7 names a different one`);
    }
  }
  return owners;
}
