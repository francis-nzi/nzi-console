import { randomUUID } from "node:crypto";
import { JOB_ITEM_CODE_PATTERN, JOB_ITEM_DESCRIPTION_MAX, JOB_ITEM_NAME_MAX } from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row, V7Table } from "./v7ClientExtract";

/**
 * The v7 service-catalogue import (admin Phase E2, `load:v7-job-items`; ruled `phaseE-commercial-catalogue-plan.md`
 * E-Q4/E-Q8/E-Q9): v7's `job_items` → 0146's `job_items`, reconciled onto what the console already holds.
 *
 * **The plan (pure)** parses each v7 item: its code (upper-cased; one that cannot be a console code is left out), name,
 * description, the category and unit **as v7's free text**, hours, its VAT (v7's rate id, or its bare percentage), its
 * currency (cost and sell must agree — E-Q9, one currency per catalogue), its amounts, order and state.
 *
 * **The load** resolves the references against the organisation, as the console holds them:
 * - category → a `job_item_categories` value by label; unit → a `units_of_measure` value by label or its singular
 *   ("day" is "days"); VAT → the rate C4 loaded from that v7 id, else the one rate with that percentage. Anything that
 *   does not resolve is left blank and **noted**, never guessed.
 * - currency → must be the organisation's default (E-Q9); an item in another currency is **refused** and reported.
 * Then per item: **its v7 identity**, else **its code** among items with none (stamped — a person's item keeps its own
 * definition, noted), else **inserted**. Re-runs (R4): v7 unchanged → left alone; changed and the row still as an
 * import wrote it → v7 wins; changed **and** edited here since → refused and reported. Nothing is deleted or
 * deactivated; items here that v7 lacks are reported.
 *
 * **Amounts (E-Q8).** The import writes cost and sell, as v7 holds them — but its audit event, and the report it
 * prints, say how many items were priced and which differ, **never the figures**.
 *
 * One transaction; a dry run is the whole load, rolled back.
 */

export const JOB_ITEMS_RUN_PREFIX = "v7-job-items-";
export const V7_JOB_ITEM_TABLES: readonly V7Table[] = ["job_items"];

const text = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };
const collapse = (value: string) => value.trim().replace(/\s+/g, " ");
const norm = (value: string) => collapse(value).toLowerCase();
const flag = (value: string | null | undefined): boolean | null => {
  const v = value?.trim().toLowerCase();
  return v === "t" || v === "true" || v === "1" ? true : v === "f" || v === "false" || v === "0" ? false : null;
};
/** A non-negative number held to two places, or undefined when it is not one (a blank is null). */
const twoPlaces = (value: string | null | undefined, max: number): number | null | undefined => {
  const raw = text(value);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max && Math.abs(Math.round(parsed * 100) - parsed * 100) < 1e-6 ? Math.round(parsed * 100) / 100 : undefined;
};

// ── The plan (pure) ────────────────────────────────────────────────────────────────────────────────────────────

export type PlannedJobItem = {
  legacyDbId: string; code: string; name: string; description: string | null;
  categoryText: string | null; unitText: string | null; defaultHours: number | null;
  vatLegacyId: string | null; vatPct: number | null; currency: string;
  costAmount: number | null; sellAmount: number | null; sortOrder: number; active: boolean;
  legacyValues: Record<string, unknown>;
};
export type JobItemSkip = { legacyDbId: string; reason: string };
export type JobItemsPlan = { values: PlannedJobItem[]; skipped: JobItemSkip[] };

export function planV7JobItems(extract: Partial<Record<V7Table, readonly V7Row[]>>): JobItemsPlan {
  const values: PlannedJobItem[] = [];
  const skipped: JobItemSkip[] = [];
  const codes = new Map<string, string>();
  for (const row of [...(extract.job_items ?? [])].sort((a, b) => Number(a.item_id) - Number(b.item_id))) {
    const legacyDbId = text(row.item_id);
    if (!legacyDbId) { skipped.push({ legacyDbId: "(blank)", reason: "a row with no id" }); continue; }
    const skip = (reason: string) => skipped.push({ legacyDbId, reason });
    const code = (text(row.item_code) ?? "").toUpperCase();
    if (!JOB_ITEM_CODE_PATTERN.test(code)) { skip(`code "${row.item_code ?? ""}" is not a console code (upper-case letters, digits, - and _, up to 30)`); continue; }
    if (codes.has(code)) { skip(`the same code as v7 item ${codes.get(code)}`); continue; }
    const name = text(row.item_name);
    if (!name) { skip("an item with no name"); continue; }
    if (collapse(name).length > JOB_ITEM_NAME_MAX) { skip(`a name longer than ${JOB_ITEM_NAME_MAX} characters`); continue; }
    const description = text(row.description);
    if (description && description.length > JOB_ITEM_DESCRIPTION_MAX) { skip(`a description longer than ${JOB_ITEM_DESCRIPTION_MAX} characters`); continue; }
    const hours = twoPlaces(row.estimated_hours, 10_000);
    if (hours === undefined) { skip("hours that are not a number from 0, to two places"); continue; }
    const cost = twoPlaces(row.cost_amount, 9_999_999_999.99);
    const sell = twoPlaces(row.sell_amount, 9_999_999_999.99);
    if (cost === undefined || sell === undefined) { skip("an amount that is not a number from 0, to two places"); continue; }
    const sellCurrency = (text(row.sell_currency) ?? "GBP").toUpperCase();
    const costCurrency = (text(row.cost_currency) ?? sellCurrency).toUpperCase();
    if (costCurrency !== sellCurrency) { skip(`cost in ${costCurrency} but sell in ${sellCurrency}: the catalogue holds one currency (E-Q9)`); continue; }
    const vatPct = twoPlaces(row.vat_rate, 100);
    const sortOrder = Number(text(row.sort_order) ?? "0");
    codes.set(code, legacyDbId);
    values.push({
      legacyDbId, code, name: collapse(name), description, categoryText: text(row.category), unitText: text(row.unit),
      defaultHours: hours, vatLegacyId: text(row.vat_rate_id), vatPct: vatPct ?? null, currency: sellCurrency,
      costAmount: cost, sellAmount: sell, sortOrder: Number.isInteger(sortOrder) && sortOrder >= 0 ? sortOrder : 0, active: flag(row.is_active) ?? true,
      // What v7 held — the amounts included, so a re-run can tell v7 changed them (this column is never audited or listed).
      legacyValues: { code: row.item_code, name, description, category: row.category ?? null, unit: row.unit ?? null, estimatedHours: hours,
        vatRateId: row.vat_rate_id ?? null, vatRate: vatPct ?? null, costAmount: cost, sellAmount: sell, currency: sellCurrency,
        sortOrder: row.sort_order ?? null, isActive: row.is_active ?? null },
    });
  }
  return { values, skipped };
}

// ── Loading ────────────────────────────────────────────────────────────────────────────────────────────────────

export type JobItemsOutcome = {
  committed: boolean; runId: string;
  inserted: number; stamped: number; updated: number; unchanged: number;
  /** Items refused at load: another currency (E-Q9), R4 conflicts. Nothing written for these. */
  refused: string[];
  /** References v7 named that do not resolve here — left blank, never guessed — and other notes. */
  notes: string[];
  /** Codes here that v7 lacks — reported, never deactivated. */
  hereOnly: string[];
  /** How many loaded items carry a sell price, and which items' amounts differ from v7's after the load — never the amounts. */
  priced: number;
  amountDifferences: string[];
  parity: { v7Active: number; v7Inactive: number; consoleActive: number; consoleInactive: number };
};

class DryRunRollback extends Error {}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  : value;
const same = (a: unknown, b: unknown) => a !== null && a !== undefined && JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const byImport = (actor: string) => actor.startsWith(JOB_ITEMS_RUN_PREFIX);

type Held = { item_id: string; item_code: string; source_system: string | null; legacy_db_id: string | null; legacy_values: unknown; created_by: string; updated_by: string };

export async function loadV7JobItems(pool: PoolLike, organisationId: string, plan: JobItemsPlan, options: { commit: boolean; runId?: string }): Promise<JobItemsOutcome> {
  const runId = options.runId ?? `${JOB_ITEMS_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(JOB_ITEMS_RUN_PREFIX)) throw new Error(`A job-items run id must start ${JOB_ITEMS_RUN_PREFIX} — it is how a re-run knows a row is still as an import wrote it.`);
  const outcome: JobItemsOutcome = {
    committed: options.commit, runId, inserted: 0, stamped: 0, updated: 0, unchanged: 0, refused: [], notes: [], hereOnly: [], priced: 0, amountDifferences: [],
    parity: { v7Active: plan.values.filter((value) => value.active).length, v7Inactive: plan.values.filter((value) => !value.active).length, consoleActive: 0, consoleInactive: 0 },
  };
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      await reconcile(db, organisationId, plan, runId, outcome);
      if (outcome.inserted + outcome.stamped + outcome.updated > 0) {
        await db.query(
          `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
           VALUES ($1, $2, $3, 'system', 'job_items.imported', 'job_items', 'job_items', $4, $5, $6::jsonb)`,
          [organisationId, randomUUID(), IMPORT_ACTOR, runId, "Service catalogue reconciled from NZ Insights Pro v7 (admin E2)",
            // Counts only — never an amount (E-Q8, NZC-120).
            JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, inserted: outcome.inserted, stamped: outcome.stamped, updated: outcome.updated,
              unchanged: outcome.unchanged, refused: outcome.refused.length, hereOnly: outcome.hereOnly.length, priced: outcome.priced })]);
      }
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}

async function reconcile(db: Queryable, org: string, plan: JobItemsPlan, runId: string, outcome: JobItemsOutcome) {
  // One after another: the one transaction client runs one query at a time.
  const items = await db.query<Held>(`SELECT item_id, item_code, source_system, legacy_db_id, legacy_values, created_by, updated_by FROM nzi_console.job_items WHERE organisation_id = $1 ORDER BY item_id FOR UPDATE`, [org]);
  const values = await db.query<{ category_key: string; value_id: string; label: string }>(
    `SELECT category_key, value_id, label FROM nzi_console.reference_values WHERE organisation_id = $1 AND category_key IN ('job_item_categories', 'units_of_measure')`, [org]);
  const vat = await db.query<{ vat_rate_id: string; rate_pct: string; source_system: string | null; legacy_db_id: string | null }>(
    `SELECT vat_rate_id, rate_pct::text, source_system, legacy_db_id FROM nzi_console.vat_rates WHERE organisation_id = $1`, [org]);
  const currency = await db.query<{ code: string }>(`SELECT code FROM nzi_console.currencies WHERE organisation_id = $1 AND is_default`, [org]);
  const selling = currency.rows[0]?.code ?? null;
  const categoryOf = (label: string | null) => {
    if (label === null) return null;
    return values.rows.find((row) => row.category_key === "job_item_categories" && norm(row.label) === norm(label))?.value_id ?? undefined;
  };
  const unitOf = (label: string | null) => {
    if (label === null) return null;
    const wanted = norm(label);
    const singular = (value: string) => value.endsWith("s") ? value.slice(0, -1) : value;
    return values.rows.find((row) => row.category_key === "units_of_measure" && (norm(row.label) === wanted || singular(norm(row.label)) === singular(wanted)))?.value_id ?? undefined;
  };
  const vatOf = (value: PlannedJobItem) => {
    if (value.vatLegacyId !== null) {
      const byIdentity = vat.rows.find((row) => row.source_system === SOURCE_SYSTEM && row.legacy_db_id === value.vatLegacyId);
      if (byIdentity) return byIdentity.vat_rate_id;
    }
    if (value.vatPct !== null) {
      const byRate = vat.rows.filter((row) => Number(row.rate_pct) === value.vatPct);
      if (byRate.length === 1) return byRate[0]!.vat_rate_id;
    }
    return value.vatLegacyId === null && value.vatPct === null ? null : undefined;
  };
  const claimed = new Set<string>();

  for (const value of plan.values) {
    if (selling === null || value.currency !== selling) {
      outcome.refused.push(`${value.code}: in ${value.currency}, but this organisation sells in ${selling ?? "no default currency"} (E-Q9: one currency per catalogue)`);
      continue;
    }
    const category = categoryOf(value.categoryText);
    const unit = unitOf(value.unitText);
    const vatRateId = vatOf(value);
    if (category === undefined) outcome.notes.push(`${value.code}: v7's category "${value.categoryText}" is not a job item category here — left blank`);
    if (unit === undefined) outcome.notes.push(`${value.code}: v7's unit "${value.unitText}" is not a unit of measure here — left blank`);
    if (vatRateId === undefined) outcome.notes.push(`${value.code}: v7's VAT (rate ${value.vatLegacyId ?? "—"}, ${value.vatPct ?? "—"}%) does not resolve to one VAT rate here — left blank`);
    const fields = [value.name, value.description, category ?? null, unit ?? null, value.defaultHours, vatRateId ?? null, value.costAmount, value.sellAmount, value.currency,
      value.sortOrder, value.active, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues)] as const;

    const identity = items.rows.find((row) => row.source_system === SOURCE_SYSTEM && row.legacy_db_id === value.legacyDbId);
    const natural = identity ? undefined : items.rows.find((row) => row.source_system === null && !claimed.has(row.item_id) && row.item_code.toUpperCase() === value.code);
    const match = identity ?? natural;
    if (match) claimed.add(match.item_id);
    if (!match) {
      await db.query(
        `INSERT INTO nzi_console.job_items (organisation_id, item_id, item_code, name, description, category_value_id, unit_value_id, default_hours, vat_rate_id,
           default_cost_amount, default_sell_amount, currency_code, sort_order, active, source_system, legacy_db_id, legacy_values, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $18)`,
        [org, `job-item:v7-${value.legacyDbId}`, value.code, ...fields, runId]);
      outcome.inserted += 1;
      continue;
    }
    if (identity) {
      if (same(identity.legacy_values, value.legacyValues)) { outcome.unchanged += 1; continue; }
      if (!byImport(identity.updated_by)) { outcome.refused.push(`${value.code}: changed in v7 since the last load, and edited here since (R4)`); continue; }
      await db.query(
        `UPDATE nzi_console.job_items SET name = $3, description = $4, category_value_id = $5, unit_value_id = $6, default_hours = $7, vat_rate_id = $8,
                default_cost_amount = $9, default_sell_amount = $10, currency_code = $11, sort_order = $12, active = $13, source_system = $14, legacy_db_id = $15,
                legacy_values = $16::jsonb, version = version + 1, updated_at = now(), updated_by = $17
          WHERE organisation_id = $1 AND item_id = $2`, [org, identity.item_id, ...fields, runId]);
      outcome.updated += 1;
      continue;
    }
    // Matched by code: an item a person made here with v7's code. Its definition and amounts stand; it takes v7's
    // identity so the next run reconciles onto it.
    await db.query(
      `UPDATE nzi_console.job_items SET source_system = $3, legacy_db_id = $4, legacy_values = $5::jsonb, version = version + 1, updated_at = now()
        WHERE organisation_id = $1 AND item_id = $2`,
      [org, natural!.item_id, SOURCE_SYSTEM, value.legacyDbId, JSON.stringify(value.legacyValues)]);
    outcome.notes.push(`${value.code}: already held here — stamped with v7's identity; its own definition and amounts stand`);
    outcome.stamped += 1;
  }

  const v7Codes = new Set(plan.values.map((value) => value.code));
  outcome.hereOnly = items.rows.filter((row) => !v7Codes.has(row.item_code.toUpperCase())).map((row) => row.item_code);
  const { rows } = await db.query<{ legacy_db_id: string; cost: string | null; sell: string | null; active: boolean }>(
    `SELECT legacy_db_id, default_cost_amount::text AS cost, default_sell_amount::text AS sell, active FROM nzi_console.job_items WHERE organisation_id = $1 AND source_system = $2`,
    [org, SOURCE_SYSTEM]);
  outcome.parity.consoleActive = rows.filter((row) => row.active).length;
  outcome.parity.consoleInactive = rows.filter((row) => !row.active).length;
  outcome.priced = rows.filter((row) => row.sell !== null).length;
  for (const value of plan.values) {
    const row = rows.find((candidate) => candidate.legacy_db_id === value.legacyDbId);
    if (!row) continue;
    const differs = [["cost", value.costAmount, row.cost], ["sell", value.sellAmount, row.sell]].filter(([, v7, here]) => (v7 === null ? null : Number(v7)) !== (here === null ? null : Number(here))).map(([field]) => field);
    // Which, never what (E-Q8).
    if (differs.length) outcome.amountDifferences.push(`${value.code}: ${differs.join(" and ")} differ from v7's`);
  }
}
