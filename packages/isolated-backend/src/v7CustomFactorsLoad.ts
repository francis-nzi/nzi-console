import { randomUUID } from "node:crypto";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row, V7Table } from "./v7ClientExtract";
import { normaliseV7Unit } from "./v7Reingest";
import { chooseFactorForYear } from "./monthlyPricing";

/**
 * V7's client custom factors into the console's client factors (cause 7; PLAN-v7-client-custom-factors §3, D-3 approved; 0240).
 *
 * V7 has two families, and both are loaded, one console client factor **per V7 factor**:
 *   - `custom_factors` — a client's own (`client_db_id`, `is_global` false) or **global** (`COALESCE(is_global, TRUE)`, as V7's
 *     resolver reads it). A global one is an **organisation-level** factor here (no client, D-3): V7 offers it to every client.
 *     Its values are `factor_2018…2030`, overlaid by `custom_factor_year_values` — as V7 overlays them;
 *   - `job_custom_factors` ("Job-Only Factors", `JCF-{job}-{factor}`) — client-scoped since V7's 0057 (`job_id` is provenance only,
 *     so it is not carried as a pin). Its value is `factor` for `factor_year`, overlaid by `job_custom_factor_year_values`.
 *
 * Each factor's **headline** (`kgco2e_per_unit`, `vintage_year`) is V7's stored value: a job-only factor's `factor` and
 * `factor_year`; a custom factor's latest year (V7's `_choose_factor_for_year` with no year). The year values go into
 * `client_factor_year_values` under the factor's version. V7's `ghg_unit` is honoured as V7 calculates (`kg` anywhere in it is per
 * kg; otherwise per tonne, so ×1000). Archived, or not active, in V7 → loaded archived. Ids, numbers, units, scope, category and
 * country only: `description` and `source` are not read; `report_label` is, as the console shows it.
 *
 * Re-runs: keyed by the import's own identity (`source_system` + `legacy_db_id` = `custom_factors:<id>` / `job_custom_factors:<id>`).
 * Unchanged → left alone; changed → updated in place with a **version bump** and a new set of year values; never duplicated. A
 * factor whose client was not imported, with no value, no year, no unit, a negative value or an unreadable scope is left out and
 * reported. One transaction per organisation; a dry run is the whole load, rolled back. One audit event per run.
 */

export const CUSTOM_FACTORS_RUN_PREFIX = "v7-custom-factors-";
export const CUSTOM_FACTORS_AUDIT_ACTION = "v7.custom_factors.loaded";
export const V7_CUSTOM_FACTOR_TABLES: readonly V7Table[] = ["custom_factors", "custom_factor_year_values", "job_custom_factors", "job_custom_factor_year_values"];
const YEAR_COLUMNS = Array.from({ length: 13 }, (_, index) => 2018 + index);

const text = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed && !/^(nan|none|null)$/i.test(trimmed) ? trimmed : null; };
const flag = (value: string | null | undefined): boolean | null => {
  const v = value?.trim().toLowerCase();
  return v === "t" || v === "true" || v === "1" ? true : v === "f" || v === "false" || v === "0" ? false : null;
};
const number = (value: string | null | undefined): number | null => {
  const cell = text(value);
  if (cell === null) return null;
  const parsed = Number(cell);
  return Number.isFinite(parsed) ? parsed : null;
};
const integer = (value: string | null | undefined): number | null => { const parsed = number(value); return parsed !== null && Number.isInteger(parsed) ? parsed : null; };
/** V7's scope as a top-level scope: "Scope 3", "3" or "3.6" → "3". */
const topScope = (value: string | null | undefined): "1" | "2" | "3" | null => {
  const match = /^\s*(?:scope\s*)?([123])(?:\.\d+)?\s*$/i.exec(value ?? "");
  return match ? (match[1] as "1" | "2" | "3") : null;
};
/** V7's `_calc_tco2e`: a unit with "kg" in it (or none) is per kg; any other (tCO2e) is per tonne. */
const perKg = (ghgUnit: string | null) => (ghgUnit ?? "kgCO2e").toLowerCase().includes("kg") || !text(ghgUnit);

// ── The plan (pure) ────────────────────────────────────────────────────────────────────────────────────────────

export type CustomFactorFamily = "custom" | "job-only";
export type PlannedCustomFactor = {
  legacyDbId: string; family: CustomFactorFamily; legacyCustomId: string;
  /** V7's client; null = organisation-level (a global custom factor, D-3). */
  v7ClientDbId: string | null;
  scope: "1" | "2" | "3"; categoryPath: string[]; unit: string; geography: string; reportLabel: string;
  kgco2ePerUnit: number; vintageYear: number;
  /** Sorted by year. */
  yearValues: Array<{ year: number; kgco2ePerUnit: number }>;
  archived: boolean;
};
export type CustomFactorSkip = { legacyDbId: string; reason: string };
export type CustomFactorsPlan = { factors: PlannedCustomFactor[]; skipped: CustomFactorSkip[] };

const childValues = (rows: readonly V7Row[] | undefined) => {
  const out = new Map<string, Map<number, number>>();
  for (const row of rows ?? []) {
    const id = text(row.factor_id), year = integer(row.year), value = number(row.factor);
    if (id === null || year === null || value === null) continue;
    const held = out.get(id) ?? new Map<number, number>();
    held.set(year, value);
    out.set(id, held);
  }
  return out;
};

export function planV7CustomFactors(extract: Partial<Record<V7Table, readonly V7Row[]>>): CustomFactorsPlan {
  const factors: PlannedCustomFactor[] = [];
  const skipped: CustomFactorSkip[] = [];
  const customYears = childValues(extract.custom_factor_year_values);
  const jobOnlyYears = childValues(extract.job_custom_factor_year_values);
  const byId = (a: V7Row, b: V7Row) => Number(a.factor_id) - Number(b.factor_id);

  const plan = (family: CustomFactorFamily, row: V7Row, values: Map<number, number>, headline: { kg: number; year: number } | null, client: string | null) => {
    const legacyDbId = `${family === "custom" ? "custom_factors" : "job_custom_factors"}:${row.factor_id}`;
    const skip = (reason: string) => { skipped.push({ legacyDbId, reason }); };
    const legacyCustomId = text(row.custom_id);
    if (!legacyCustomId) return skip("no custom id: no V7 row can name it");
    const scope = topScope(row.scope);
    if (!scope) return skip(`scope "${row.scope ?? ""}" is not Scope 1, 2 or 3`);
    const unit = normaliseV7Unit(row.uom ?? null);
    if (!unit) return skip("no unit");
    if (!headline) return skip("no value, or no year for it");
    const scale = perKg(row.ghg_unit ?? null) ? 1 : 1000;
    if ([headline.kg, ...values.values()].some((value) => value < 0)) return skip("a negative value: a client factor is never below zero");
    const country = text(row.country);
    factors.push({
      legacyDbId, family, legacyCustomId, v7ClientDbId: client, scope, unit,
      categoryPath: text(row.category) ? [text(row.category)!] : [],
      geography: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : "GB",
      reportLabel: text(row.report_label) ?? legacyCustomId,
      kgco2ePerUnit: headline.kg * scale, vintageYear: headline.year,
      yearValues: [...values].sort(([a], [b]) => a - b).map(([year, value]) => ({ year, kgco2ePerUnit: value * scale })),
      archived: flag(row.archived) === true || flag(row.is_active) === false,
    });
  };

  for (const row of [...(extract.custom_factors ?? [])].sort(byId)) {
    const values = new Map<number, number>();
    for (const year of YEAR_COLUMNS) { const value = number(row[`factor_${year}`]); if (value !== null) values.set(year, value); }
    for (const [year, value] of customYears.get(text(row.factor_id) ?? "") ?? []) values.set(year, value);
    // V7: `COALESCE(is_global, TRUE)` — a global factor is every client's; else it is its client's.
    const global = flag(row.is_global) ?? true;
    const client = global ? null : text(row.client_db_id);
    if (!global && client === null) { skipped.push({ legacyDbId: `custom_factors:${row.factor_id}`, reason: "neither global nor any client's" }); continue; }
    const latest = chooseFactorForYear(values, null);
    plan("custom", row, values, latest ? { kg: latest.value, year: latest.year } : null, client);
  }
  for (const row of [...(extract.job_custom_factors ?? [])].sort(byId)) {
    const values = new Map<number, number>();
    const factor = number(row.factor), factorYear = integer(row.factor_year);
    if (factor !== null && factorYear !== null) values.set(factorYear, factor);
    for (const [year, value] of jobOnlyYears.get(text(row.factor_id) ?? "") ?? []) values.set(year, value);
    const client = text(row.client_db_id);
    if (client === null) { skipped.push({ legacyDbId: `job_custom_factors:${row.factor_id}`, reason: "no client" }); continue; }
    // The stored value is V7's headline: `factor` at `factor_year` (or, with no factor_year, the latest year's value).
    const latest = chooseFactorForYear(values, null);
    const headline = factor !== null ? (factorYear !== null ? { kg: factor, year: factorYear } : latest ? { kg: factor, year: latest.year } : null)
      : latest ? { kg: latest.value, year: latest.year } : null;
    plan("job-only", row, values, headline, client);
  }
  return { factors, skipped };
}

// ── Loading ────────────────────────────────────────────────────────────────────────────────────────────────────

export type CustomFactorsOutcome = {
  committed: boolean; runId: string;
  inserted: number; updated: number; unchanged: number; organisationLevel: number; yearValues: number;
  byFamily: Record<CustomFactorFamily, number>;
  /** Left out at load time: the client was not imported, or another loaded factor holds the id. */
  skipped: CustomFactorSkip[];
};

class DryRunRollback extends Error {}

type Held = { client_factor_id: string; client_id: string | null; scope: string; unit: string; kg: string; vintage_year: number; report_label: string;
  archived: boolean; legacy_custom_id: string | null; geography: string; category_path_json: string[]; version: number };

export async function loadV7CustomFactors(pool: PoolLike, organisationId: string, plan: CustomFactorsPlan, options: { commit: boolean; runId?: string }): Promise<CustomFactorsOutcome> {
  const runId = options.runId ?? `${CUSTOM_FACTORS_RUN_PREFIX}${randomUUID()}`;
  const outcome: CustomFactorsOutcome = { committed: options.commit, runId, inserted: 0, updated: 0, unchanged: 0, organisationLevel: 0, yearValues: 0,
    byFamily: { custom: 0, "job-only": 0 }, skipped: [] };
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      for (const factor of plan.factors) await reconcile(db, organisationId, factor, runId, outcome);
      if (outcome.inserted + outcome.updated > 0) {
        await db.query(
          `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
           VALUES ($1, $2, $3, 'system', $4, 'client_factors', 'v7-custom-factors', $5, $6, $7::jsonb)`,
          [organisationId, randomUUID(), IMPORT_ACTOR, CUSTOM_FACTORS_AUDIT_ACTION, runId, "V7's client custom factors loaded, one per V7 factor (PLAN-v7-client-custom-factors §3)",
            JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, inserted: outcome.inserted, updated: outcome.updated, unchanged: outcome.unchanged,
              organisationLevel: outcome.organisationLevel, yearValues: outcome.yearValues, byFamily: outcome.byFamily, skipped: outcome.skipped.length })]);
      }
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}

const sameValues = (a: Array<{ year: number; kg: number }>, b: Array<{ year: number; kgco2ePerUnit: number }>) =>
  a.length === b.length && a.every((value, index) => value.year === b[index]!.year && value.kg === b[index]!.kgco2ePerUnit);

async function reconcile(db: Queryable, org: string, factor: PlannedCustomFactor, runId: string, outcome: CustomFactorsOutcome): Promise<void> {
  const skip = (reason: string) => { outcome.skipped.push({ legacyDbId: factor.legacyDbId, reason }); };
  let clientId: string | null = null;
  if (factor.v7ClientDbId !== null) {
    clientId = (await db.query<{ client_id: string }>(
      `SELECT client_id FROM nzi_console.clients WHERE organisation_id = $1 AND source_system = $2 AND legacy_db_id = $3`, [org, SOURCE_SYSTEM, factor.v7ClientDbId])).rows[0]?.client_id ?? null;
    if (clientId === null) return skip(`its client (V7 ${factor.v7ClientDbId}) was not imported`);
  }
  // The id is unique per organisation, client and scope (0240): another loaded factor holding it is reported, never overwritten.
  const holder = (await db.query<{ legacy_db_id: string | null }>(
    `SELECT legacy_db_id FROM nzi_console.client_factors WHERE organisation_id = $1 AND coalesce(client_id, '') = coalesce($2, '') AND legacy_custom_id = $3 AND scope = $4`,
    [org, clientId, factor.legacyCustomId, factor.scope])).rows[0];
  if (holder && holder.legacy_db_id !== factor.legacyDbId) return skip(`${factor.legacyCustomId} (Scope ${factor.scope}) is already ${holder.legacy_db_id ?? "a factor made here"}`);

  const held = (await db.query<Held>(
    `SELECT client_factor_id, client_id, scope, unit, kgco2e_per_unit::text AS kg, vintage_year, report_label, archived, legacy_custom_id, geography, category_path_json, version
       FROM nzi_console.client_factors WHERE organisation_id = $1 AND source_system = $2 AND legacy_db_id = $3 FOR UPDATE`, [org, SOURCE_SYSTEM, factor.legacyDbId])).rows[0];
  const addValues = async (clientFactorId: string, version: number) => {
    for (const value of factor.yearValues) {
      await db.query(`INSERT INTO nzi_console.client_factor_year_values (organisation_id, client_factor_id, version, year, kgco2e_per_unit, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [org, clientFactorId, version, value.year, value.kgco2ePerUnit, runId]);
      outcome.yearValues += 1;
    }
  };
  const source = factor.family === "job-only" ? "NZ Insights Pro v7 (job-only factor)" : "NZ Insights Pro v7 (custom factor)";
  if (!held) {
    const clientFactorId = randomUUID();
    await db.query(
      `INSERT INTO nzi_console.client_factors (organisation_id, client_factor_id, client_id, job_id, scope, category_path_json, report_label, description, unit, ghg_unit,
         kgco2e_per_unit, geography, vintage_year, source, archived, created_by, source_system, legacy_db_id, legacy_custom_id)
       VALUES ($1, $2, $3, NULL, $4, $5::jsonb, $6, '', $7, 'kgCO2e', $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [org, clientFactorId, clientId, factor.scope, JSON.stringify(factor.categoryPath), factor.reportLabel, factor.unit, factor.kgco2ePerUnit, factor.geography,
        factor.vintageYear, source, factor.archived, IMPORT_ACTOR, SOURCE_SYSTEM, factor.legacyDbId, factor.legacyCustomId]);
    await addValues(clientFactorId, 1);
    outcome.inserted += 1; outcome.byFamily[factor.family] += 1;
    if (clientId === null) outcome.organisationLevel += 1;
    return;
  }
  const heldValues = (await db.query<{ year: number; kg: number }>(
    `SELECT year, kgco2e_per_unit AS kg FROM nzi_console.client_factor_year_values WHERE organisation_id = $1 AND client_factor_id = $2 AND version = $3 ORDER BY year`,
    [org, held.client_factor_id, held.version])).rows;
  const same = held.client_id === clientId && held.scope === factor.scope && held.unit === factor.unit && Number(held.kg) === factor.kgco2ePerUnit
    && held.vintage_year === factor.vintageYear && held.report_label === factor.reportLabel && held.archived === factor.archived
    && held.legacy_custom_id === factor.legacyCustomId && held.geography === factor.geography
    && JSON.stringify(held.category_path_json ?? []) === JSON.stringify(factor.categoryPath) && sameValues(heldValues, factor.yearValues);
  outcome.byFamily[factor.family] += 1;
  if (clientId === null) outcome.organisationLevel += 1;
  if (same) { outcome.unchanged += 1; return; }
  const version = held.version + 1;
  await db.query(
    `UPDATE nzi_console.client_factors SET client_id = $3, scope = $4, category_path_json = $5::jsonb, report_label = $6, unit = $7, kgco2e_per_unit = $8, geography = $9,
            vintage_year = $10, archived = $11, legacy_custom_id = $12, source = $13, version = $14, updated_by = $15, updated_at = now()
      WHERE organisation_id = $1 AND client_factor_id = $2`,
    [org, held.client_factor_id, clientId, factor.scope, JSON.stringify(factor.categoryPath), factor.reportLabel, factor.unit, factor.kgco2ePerUnit, factor.geography,
      factor.vintageYear, factor.archived, factor.legacyCustomId, source, version, IMPORT_ACTOR]);
  await addValues(held.client_factor_id, version);
  outcome.updated += 1;
}
