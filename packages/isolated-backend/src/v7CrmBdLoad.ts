import { randomUUID } from "node:crypto";
import { BD_STAGE_KEY_PATTERN, BD_STAGE_NAME_MAX, LOOKUP_CODE_MAX, LOOKUP_LABEL_MAX, type LookupCategory } from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row, V7Table } from "./v7ClientExtract";
import { normaliseLabel } from "./v7LookupLoad";

/**
 * The v7 CRM and business-development lookup imports (admin Phase F2; ruled `phaseF-comms-crm-plan.md`, F-Q4): one loader
 * per v7 table, each extract → dry run → verify → commit.
 *
 * - **`load:v7-crm-tags`** — v7's `crm_tags` → the `crm_tags` lookup. A tag is its name; v7's optional colour (which v7's
 *   own screens never show) is kept in the record of what v7 held, not modelled.
 * - **`load:v7-bd-service-lines`** — v7's `bd_service_lines` → the `bd_service_lines` lookup, **v7's key as the code**
 *   (it is how v7's leads name a service line) and as the value's v7 identity.
 * - **`load:v7-bd-funnel-stages`** — v7's `bd_funnel_stages` → `bd_funnel_stages`: key (set once), name, order and
 *   probability.
 *
 * Per value: **its v7 identity**; else **the same label (a stage: the same key)** among values with none — stamped with
 * v7's identity, a person's own value keeping its own label, order and state; else **inserted**. Re-runs (R4): v7
 * unchanged → left alone; changed and still as an import wrote it → v7 wins; edited here since → refused and reported.
 * Nothing is deleted; v7's `is_active` is carried. Values here that v7 lacks are reported. One transaction each; a dry
 * run is the whole load, rolled back. The audit event is counts only.
 */

export const CRM_BD_RUN_PREFIX = "v7-crm-bd-";

const text = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };
const collapse = (value: string) => value.trim().replace(/\s+/g, " ");
const flag = (value: string | null | undefined): boolean | null => {
  const v = value?.trim().toLowerCase();
  return v === "t" || v === "true" || v === "1" ? true : v === "f" || v === "false" || v === "0" ? false : null;
};
const wholeOrNull = (value: string | null | undefined): number | null | undefined => {
  const raw = text(value);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  : value;
const same = (a: unknown, b: unknown) => a !== null && a !== undefined && JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const byImport = (actor: string) => actor.startsWith(CRM_BD_RUN_PREFIX);
class DryRunRollback extends Error {}

export type Skip = { legacyDbId: string; reason: string };

// ── The two lookup categories ────────────────────────────────────────────────────────────────────────────────────

export type CrmBdLookupKind = "crm-tags" | "bd-service-lines";
const LOOKUP_SOURCES: Record<CrmBdLookupKind, { table: V7Table; category: LookupCategory; id: string; name: string; code: boolean; action: string }> = {
  "crm-tags": { table: "crm_tags", category: "crm_tags", id: "tag_id", name: "tag_name", code: false, action: "crm_tags.imported" },
  "bd-service-lines": { table: "bd_service_lines", category: "bd_service_lines", id: "service_key", name: "service_name", code: true, action: "bd_service_lines.imported" },
};
export const v7LookupTableFor = (kind: CrmBdLookupKind): V7Table => LOOKUP_SOURCES[kind].table;

export type PlannedCrmBdValue = { legacyDbId: string; label: string; code: string | null; active: boolean; sortOrder: number | null; legacyValues: Record<string, unknown> };
export type CrmBdLookupPlan = { kind: CrmBdLookupKind; category: LookupCategory; values: PlannedCrmBdValue[]; skipped: Skip[] };

export function planV7CrmBdLookup(kind: CrmBdLookupKind, extract: Partial<Record<V7Table, readonly V7Row[]>>): CrmBdLookupPlan {
  const source = LOOKUP_SOURCES[kind];
  const plan: CrmBdLookupPlan = { kind, category: source.category, values: [], skipped: [] };
  const activeLabels = new Map<string, string>();
  const rows = [...(extract[source.table] ?? [])].sort((a, b) => {
    const sa = Number(a.sort_order ?? 0), sb = Number(b.sort_order ?? 0);
    return sa - sb || String(a[source.id]).localeCompare(String(b[source.id]), "en", { numeric: true });
  });
  for (const row of rows) {
    const legacyDbId = text(row[source.id]);
    if (!legacyDbId) { plan.skipped.push({ legacyDbId: "(blank)", reason: "a row with no id" }); continue; }
    const skip = (reason: string) => plan.skipped.push({ legacyDbId, reason });
    const name = text(row[source.name]);
    if (!name) { skip("a value with no name"); continue; }
    const label = collapse(name);
    if (label.length > LOOKUP_LABEL_MAX) { skip(`a label longer than ${LOOKUP_LABEL_MAX} characters`); continue; }
    if (source.code && legacyDbId.length > LOOKUP_CODE_MAX) { skip(`a key longer than ${LOOKUP_CODE_MAX} characters`); continue; }
    const sortOrder = wholeOrNull(row.sort_order);
    if (sortOrder === undefined) { skip("a sort order that is not a whole number"); continue; }
    const active = flag(row.is_active) ?? true;
    if (active) {
      const clash = activeLabels.get(normaliseLabel(label));
      if (clash) { skip(`the same label as v7 value ${clash}, and both are active`); continue; }
      activeLabels.set(normaliseLabel(label), legacyDbId);
    }
    plan.values.push({
      legacyDbId, label, code: source.code ? legacyDbId : null, active, sortOrder,
      // What v7 held: the name, state and order — and a tag's colour, which is not modelled but is kept here.
      legacyValues: { name, isActive: row.is_active ?? null, sortOrder: row.sort_order ?? null, ...(kind === "crm-tags" ? { colorHex: row.color_hex ?? null } : {}) },
    });
  }
  return plan;
}

export type CrmBdLookupOutcome = {
  committed: boolean; runId: string; category: LookupCategory;
  inserted: number; stamped: number; updated: number; unchanged: number;
  refused: string[]; notes: string[];
  /** Labels here that v7 does not hold — reported, never deactivated. */
  hereOnly: string[];
  parity: { v7Active: number; v7Inactive: number; consoleActive: number; consoleInactive: number };
};

type HeldValue = { value_id: string; label: string; code: string | null; active: boolean; sort_order: number; source_system: string | null; legacy_db_id: string | null; legacy_values: unknown; updated_by: string };

export async function loadV7CrmBdLookup(pool: PoolLike, organisationId: string, plan: CrmBdLookupPlan, options: { commit: boolean; runId?: string }): Promise<CrmBdLookupOutcome> {
  const runId = options.runId ?? `${CRM_BD_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(CRM_BD_RUN_PREFIX)) throw new Error(`A CRM/BD run id must start ${CRM_BD_RUN_PREFIX} — it is how a re-run knows a row is still as an import wrote it.`);
  const outcome: CrmBdLookupOutcome = {
    committed: options.commit, runId, category: plan.category, inserted: 0, stamped: 0, updated: 0, unchanged: 0, refused: [], notes: [], hereOnly: [],
    parity: { v7Active: plan.values.filter((value) => value.active).length, v7Inactive: plan.values.filter((value) => !value.active).length, consoleActive: 0, consoleInactive: 0 },
  };
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      await reconcileLookup(db, organisationId, plan, runId, outcome);
      if (outcome.inserted + outcome.stamped + outcome.updated > 0) await audit(db, organisationId, runId, LOOKUP_SOURCES[plan.kind].action, plan.category,
        { inserted: outcome.inserted, stamped: outcome.stamped, updated: outcome.updated, unchanged: outcome.unchanged, refused: outcome.refused.length });
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}

async function reconcileLookup(db: Queryable, org: string, plan: CrmBdLookupPlan, runId: string, outcome: CrmBdLookupOutcome) {
  const { rows: held } = await db.query<HeldValue>(
    `SELECT value_id, label, code, active, sort_order, source_system, legacy_db_id, legacy_values, updated_by
       FROM nzi_console.reference_values WHERE organisation_id = $1 AND category_key = $2 ORDER BY value_id FOR UPDATE`, [org, plan.category]);
  const claimed = new Set<string>();
  let nextSort = held.reduce((max, value) => Math.max(max, value.sort_order), 0);
  // Deactivations first, so a label freed by one value can be taken by another in the same run.
  for (const value of [...plan.values].sort((a, b) => Number(a.active) - Number(b.active))) {
    const identity = held.find((row) => row.source_system === SOURCE_SYSTEM && row.legacy_db_id === value.legacyDbId);
    if (identity) {
      claimed.add(identity.value_id);
      if (same(identity.legacy_values, value.legacyValues)) { outcome.unchanged += 1; continue; }
      if (!byImport(identity.updated_by)) { outcome.refused.push(`v7 ${value.legacyDbId}: changed in v7 since the last load, and edited here since (R4)`); continue; }
      await db.query(
        `UPDATE nzi_console.reference_values SET label = $4, code = $5, active = $6, sort_order = $7, legacy_values = $8::jsonb, version = version + 1, updated_at = now(), updated_by = $9
          WHERE organisation_id = $1 AND category_key = $2 AND value_id = $3`,
        [org, plan.category, identity.value_id, value.label, value.code, value.active, value.sortOrder ?? identity.sort_order, JSON.stringify(value.legacyValues), runId]);
      outcome.updated += 1;
      continue;
    }
    const candidates = held.filter((row) => row.source_system === null && !claimed.has(row.value_id) && normaliseLabel(row.label) === normaliseLabel(value.label));
    const natural = candidates.find((row) => row.active) ?? candidates[0];
    if (natural) {
      // A value a person made here: its label, order and state stand; it takes v7's identity (and a service line, v7's
      // key as its code when it has none).
      claimed.add(natural.value_id);
      await db.query(
        `UPDATE nzi_console.reference_values SET code = coalesce(code, $4), source_system = $5, legacy_db_id = $6, legacy_values = $7::jsonb, version = version + 1, updated_at = now()
          WHERE organisation_id = $1 AND category_key = $2 AND value_id = $3`,
        [org, plan.category, natural.value_id, value.code, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues)]);
      outcome.notes.push(`v7 ${value.legacyDbId}: already held here as "${natural.label}" — stamped with v7's identity; its own label, order and state stand`);
      outcome.stamped += 1;
      continue;
    }
    nextSort = value.sortOrder ?? nextSort + 10;
    await db.query(
      `INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, code, sort_order, active, source, source_system, legacy_db_id, legacy_values, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'import', $8, $9, $10::jsonb, $11, $11)`,
      [org, plan.category, `${plan.category}:v7-${value.legacyDbId}`, value.label, value.code, nextSort, value.active, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues), runId]);
    outcome.inserted += 1;
  }
  outcome.hereOnly = held.filter((row) => !claimed.has(row.value_id)).map((row) => row.label);
  const { rows: [parity] } = await db.query<{ active: number; inactive: number }>(
    `SELECT count(*) FILTER (WHERE active)::int AS active, count(*) FILTER (WHERE NOT active)::int AS inactive
       FROM nzi_console.reference_values WHERE organisation_id = $1 AND category_key = $2 AND source_system = $3`, [org, plan.category, SOURCE_SYSTEM]);
  outcome.parity.consoleActive = parity?.active ?? 0;
  outcome.parity.consoleInactive = parity?.inactive ?? 0;
}

async function audit(db: Queryable, org: string, runId: string, action: string, entity: string, counts: Record<string, number>) {
  await db.query(
    `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
     VALUES ($1, $2, $3, 'system', $4, $5, $5, $6, $7, $8::jsonb)`,
    [org, randomUUID(), IMPORT_ACTOR, action, entity, runId, "Reconciled from NZ Insights Pro v7 (admin F2)", JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, ...counts })]);
}

// ── The funnel ──────────────────────────────────────────────────────────────────────────────────────────────────

export const V7_FUNNEL_TABLES: readonly V7Table[] = ["bd_funnel_stages"];
export type PlannedFunnelStage = { legacyDbId: string; key: string; name: string; sortOrder: number; probabilityPct: number; active: boolean; legacyValues: Record<string, unknown> };
export type FunnelPlan = { values: PlannedFunnelStage[]; skipped: Skip[] };

export function planV7FunnelStages(extract: Partial<Record<V7Table, readonly V7Row[]>>): FunnelPlan {
  const plan: FunnelPlan = { values: [], skipped: [] };
  const keys = new Map<string, string>();
  const names = new Map<string, string>();
  for (const row of [...(extract.bd_funnel_stages ?? [])].sort((a, b) => Number(a.stage_id) - Number(b.stage_id))) {
    const legacyDbId = text(row.stage_id);
    if (!legacyDbId) { plan.skipped.push({ legacyDbId: "(blank)", reason: "a row with no id" }); continue; }
    const skip = (reason: string) => plan.skipped.push({ legacyDbId, reason });
    const key = (text(row.stage_key) ?? "").toLowerCase();
    if (!BD_STAGE_KEY_PATTERN.test(key)) { skip(`key "${row.stage_key ?? ""}" is not a console stage key (lower-case letters, digits and -, up to 40)`); continue; }
    if (keys.has(key)) { skip(`the same key as v7 stage ${keys.get(key)}`); continue; }
    const rawName = text(row.stage_name);
    if (!rawName) { skip("a stage with no name"); continue; }
    const name = collapse(rawName);
    if (name.length > BD_STAGE_NAME_MAX) { skip(`a name longer than ${BD_STAGE_NAME_MAX} characters`); continue; }
    if (names.has(name.toLowerCase())) { skip(`the same name as v7 stage ${names.get(name.toLowerCase())}`); continue; }
    const sortOrder = wholeOrNull(row.stage_order);
    if (sortOrder === undefined || sortOrder === null) { skip("an order that is not a whole number from 0"); continue; }
    const rawProbability = text(row.probability_pct);
    const probability = rawProbability === null ? 0 : Number(rawProbability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 100) { skip("a probability that is not from 0 to 100"); continue; }
    keys.set(key, legacyDbId);
    names.set(name.toLowerCase(), legacyDbId);
    plan.values.push({
      legacyDbId, key, name, sortOrder, probabilityPct: Math.round(probability * 100) / 100, active: flag(row.is_active) ?? true,
      legacyValues: { key: row.stage_key, name: rawName, order: row.stage_order, probabilityPct: row.probability_pct ?? null, isActive: row.is_active ?? null },
    });
  }
  return plan;
}

export type FunnelOutcome = {
  committed: boolean; runId: string;
  inserted: number; stamped: number; updated: number; unchanged: number;
  refused: string[]; notes: string[]; hereOnly: string[];
  /** The entry stage after the load — the first active by order. */
  entry: string | null;
  parity: { v7Active: number; v7Inactive: number; consoleActive: number; consoleInactive: number };
};

type HeldStage = { stage_id: string; stage_key: string; name: string; active: boolean; source_system: string | null; legacy_db_id: string | null; legacy_values: unknown; updated_by: string };

export async function loadV7FunnelStages(pool: PoolLike, organisationId: string, plan: FunnelPlan, options: { commit: boolean; runId?: string }): Promise<FunnelOutcome> {
  const runId = options.runId ?? `${CRM_BD_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(CRM_BD_RUN_PREFIX)) throw new Error(`A CRM/BD run id must start ${CRM_BD_RUN_PREFIX} — it is how a re-run knows a row is still as an import wrote it.`);
  const outcome: FunnelOutcome = {
    committed: options.commit, runId, inserted: 0, stamped: 0, updated: 0, unchanged: 0, refused: [], notes: [], hereOnly: [], entry: null,
    parity: { v7Active: plan.values.filter((value) => value.active).length, v7Inactive: plan.values.filter((value) => !value.active).length, consoleActive: 0, consoleInactive: 0 },
  };
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      await reconcileFunnel(db, organisationId, plan, runId, outcome);
      if (outcome.inserted + outcome.stamped + outcome.updated > 0) await audit(db, organisationId, runId, "bd_funnel_stages.imported", "bd_funnel_stages",
        { inserted: outcome.inserted, stamped: outcome.stamped, updated: outcome.updated, unchanged: outcome.unchanged, refused: outcome.refused.length });
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}

async function reconcileFunnel(db: Queryable, org: string, plan: FunnelPlan, runId: string, outcome: FunnelOutcome) {
  const { rows: held } = await db.query<HeldStage>(
    `SELECT stage_id, stage_key, name, active, source_system, legacy_db_id, legacy_values, updated_by FROM nzi_console.bd_funnel_stages WHERE organisation_id = $1 ORDER BY stage_id FOR UPDATE`, [org]);
  const claimed = new Set<string>();
  for (const value of plan.values) {
    const fields = [value.name, value.sortOrder, value.probabilityPct, value.active, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues)] as const;
    const identity = held.find((row) => row.source_system === SOURCE_SYSTEM && row.legacy_db_id === value.legacyDbId);
    if (identity) {
      claimed.add(identity.stage_id);
      if (same(identity.legacy_values, value.legacyValues)) { outcome.unchanged += 1; continue; }
      if (!byImport(identity.updated_by)) { outcome.refused.push(`${value.key}: changed in v7 since the last load, and edited here since (R4)`); continue; }
      if (identity.stage_key !== value.key) { outcome.refused.push(`${identity.stage_key}: v7 has renamed its key to ${value.key}, and a key never changes here`); continue; }
      await db.query(
        `UPDATE nzi_console.bd_funnel_stages SET name = $3, sort_order = $4, probability_pct = $5, active = $6, source_system = $7, legacy_db_id = $8, legacy_values = $9::jsonb,
                version = version + 1, updated_at = now(), updated_by = $10 WHERE organisation_id = $1 AND stage_id = $2`, [org, identity.stage_id, ...fields, runId]);
      outcome.updated += 1;
      continue;
    }
    const natural = held.find((row) => row.source_system === null && !claimed.has(row.stage_id) && row.stage_key === value.key);
    if (natural) {
      claimed.add(natural.stage_id);
      await db.query(
        `UPDATE nzi_console.bd_funnel_stages SET source_system = $3, legacy_db_id = $4, legacy_values = $5::jsonb, version = version + 1, updated_at = now()
          WHERE organisation_id = $1 AND stage_id = $2`, [org, natural.stage_id, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues)]);
      outcome.notes.push(`${value.key}: already held here — stamped with v7's identity; its own name, order, probability and state stand`);
      outcome.stamped += 1;
      continue;
    }
    if (held.some((row) => row.name.toLowerCase() === value.name.toLowerCase())) { outcome.refused.push(`${value.key}: another stage here already has the name "${value.name}"`); continue; }
    await db.query(
      `INSERT INTO nzi_console.bd_funnel_stages (organisation_id, stage_id, stage_key, name, sort_order, probability_pct, active, source_system, legacy_db_id, legacy_values, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $11)`, [org, `bd-stage:v7-${value.legacyDbId}`, value.key, ...fields, runId]);
    outcome.inserted += 1;
  }
  outcome.hereOnly = held.filter((row) => !claimed.has(row.stage_id)).map((row) => row.stage_key);
  const { rows: [parity] } = await db.query<{ active: number; inactive: number }>(
    `SELECT count(*) FILTER (WHERE active)::int AS active, count(*) FILTER (WHERE NOT active)::int AS inactive FROM nzi_console.bd_funnel_stages WHERE organisation_id = $1 AND source_system = $2`,
    [org, SOURCE_SYSTEM]);
  outcome.parity.consoleActive = parity?.active ?? 0;
  outcome.parity.consoleInactive = parity?.inactive ?? 0;
  const { rows: [entry] } = await db.query<{ stage_key: string }>(
    `SELECT stage_key FROM nzi_console.bd_funnel_stages WHERE organisation_id = $1 AND active ORDER BY sort_order, lower(name), stage_id LIMIT 1`, [org]);
  outcome.entry = entry?.stage_key ?? null;
}
