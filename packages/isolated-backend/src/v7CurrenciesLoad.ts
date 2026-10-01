import { randomUUID } from "node:crypto";
import { CURRENCY_NAME_MAX, CURRENCY_SYMBOL_MAX } from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row, V7Table } from "./v7ClientExtract";

/**
 * The v7 currencies import (admin Phase E1, `load:v7-currencies`; ruled plan `phaseE-commercial-catalogue-plan.md`
 * §E1.2, E-Q1/E-Q2): v7's **two** currency tables consolidated into one clean ISO-4217 set in 0145's `currencies`.
 *
 * **Consolidation (the plan, pure).** `currency_lookup` (code, name, symbol, default, active, order) is v7's current
 * table; `currencies_lookup` (code, symbol, name, active) its legacy one. Rows are merged **by ISO code**:
 * - `currency_lookup` wins; the legacy table fills a name or symbol it lacks and adds a code it does not hold;
 * - **"UAE" is read as AED** (E-Q2: v7 stored the dirham as the country) — reported, and no "UAE" row, no alias;
 * - a code that is not three letters is left out and reported; `exchange_rate` is not read (E-Q1).
 * Each currency's v7 identity is its ISO code; `legacy_values` records what each v7 table held for it.
 *
 * **Reconcile (per currency)** — onto 0145's rows, by code:
 * - **inserted** when the console does not hold the code;
 * - **stamped** with its v7 identity when it does and has none yet: v7's name and symbol taken where 0145 seeded the row,
 *   kept (and noted) where a person made or edited it;
 * - **re-runs (R4)**: v7 unchanged → left alone; v7 changed and the row still as an import wrote it → v7 wins; changed in
 *   v7 **and** edited here since → refused and reported.
 * Rows v7 lacks are reported, never deactivated. Nothing is deleted.
 *
 * **One default.** v7 with more than one default, or an inactive one, is refused whole — never guessed. v7's default
 * moves the console's only when 0145 or an import set it; a default a person chose stands (noted).
 *
 * One transaction; a dry run is the whole load, rolled back.
 */

export const CURRENCIES_RUN_PREFIX = "v7-currencies-";
export const V7_CURRENCY_TABLES: readonly V7Table[] = ["currency_lookup", "currencies_lookup"];
/** E-Q2: the one non-ISO code v7 is known to hold, and what it means. */
const CORRECTIONS: Readonly<Record<string, string>> = { UAE: "AED" };

const text = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };
const collapse = (value: string) => value.trim().replace(/\s+/g, " ");
const flag = (value: string | null | undefined): boolean | null => {
  const v = value?.trim().toLowerCase();
  return v === "t" || v === "true" || v === "1" ? true : v === "f" || v === "false" || v === "0" ? false : null;
};

// ── The plan (pure) ────────────────────────────────────────────────────────────────────────────────────────────

export type PlannedCurrency = { code: string; name: string; symbol: string; isDefault: boolean; active: boolean; legacyValues: Record<string, unknown> };
export type CurrencySkip = { table: V7Table; code: string; reason: string };
export type CurrenciesPlan = { values: PlannedCurrency[]; refused: string | null; skipped: CurrencySkip[]; corrections: string[] };

export function planV7Currencies(extract: Partial<Record<V7Table, readonly V7Row[]>>): CurrenciesPlan {
  const skipped: CurrencySkip[] = [];
  const corrections: string[] = [];
  const isoOf = (table: V7Table, raw: string | null): string | null => {
    const code = raw?.trim().toUpperCase() ?? "";
    if (!code) { skipped.push({ table, code: "(blank)", reason: "a row with no currency code" }); return null; }
    const corrected = CORRECTIONS[code];
    if (corrected) { corrections.push(`${table}: v7's "${code}" is read as ${corrected} (the country is not a currency)`); return corrected; }
    if (!/^[A-Z]{3}$/.test(code)) { skipped.push({ table, code, reason: "not a three-letter ISO-4217 code" }); return null; }
    return code;
  };

  type Merged = { code: string; current: V7Row | null; legacy: V7Row | null };
  const merged = new Map<string, Merged>();
  const byId = (a: V7Row, b: V7Row) => Number(a.currency_id) - Number(b.currency_id);
  for (const row of [...(extract.currency_lookup ?? [])].sort(byId)) {
    const code = isoOf("currency_lookup", row.currency_code ?? null);
    if (!code) continue;
    const held = merged.get(code);
    if (held?.current) { skipped.push({ table: "currency_lookup", code: `${row.currency_code} (id ${row.currency_id})`, reason: `a second row for ${code}; v7 row ${held.current.currency_id} is the one taken` }); continue; }
    merged.set(code, { code, current: row, legacy: null });
  }
  for (const row of [...(extract.currencies_lookup ?? [])].sort((a, b) => String(a.currency_code).localeCompare(String(b.currency_code)))) {
    const code = isoOf("currencies_lookup", row.currency_code ?? null);
    if (!code) continue;
    const held = merged.get(code);
    if (held?.legacy) { skipped.push({ table: "currencies_lookup", code: String(row.currency_code), reason: `a second row for ${code}; the first is the one taken` }); continue; }
    merged.set(code, { code, current: held?.current ?? null, legacy: row });
  }

  const values: PlannedCurrency[] = [];
  for (const { code, current, legacy } of [...merged.values()].sort((a, b) => a.code.localeCompare(b.code))) {
    const name = collapse(text(current?.currency_name) ?? text(legacy?.name) ?? code);
    const symbol = (text(current?.symbol) ?? text(legacy?.symbol) ?? code).trim();
    if (name.length > CURRENCY_NAME_MAX) { skipped.push({ table: current ? "currency_lookup" : "currencies_lookup", code, reason: `a name longer than ${CURRENCY_NAME_MAX} characters` }); continue; }
    if (symbol.length > CURRENCY_SYMBOL_MAX) { skipped.push({ table: current ? "currency_lookup" : "currencies_lookup", code, reason: `a symbol longer than ${CURRENCY_SYMBOL_MAX} characters` }); continue; }
    values.push({
      code, name, symbol,
      isDefault: flag(current?.is_default) ?? false,
      active: flag(current?.is_active) ?? flag(legacy?.is_active) ?? true,
      // What each v7 table held for it — never the exchange rate, which is not read (E-Q1).
      legacyValues: {
        ...(current ? { currency_lookup: { id: current.currency_id, code: current.currency_code, name: current.currency_name ?? null, symbol: current.symbol ?? null,
          isDefault: current.is_default ?? null, isActive: current.is_active ?? null, sortOrder: current.sort_order ?? null } } : {}),
        ...(legacy ? { currencies_lookup: { code: legacy.currency_code, name: legacy.name ?? null, symbol: legacy.symbol ?? null, isActive: legacy.is_active ?? null } } : {}),
      },
    });
  }

  const defaults = values.filter((value) => value.isDefault);
  const refused = defaults.length > 1
    ? `v7 has ${defaults.length} default currencies (${defaults.map((value) => value.code).join(", ")}). Nothing is written until v7 has one; it is never guessed.`
    : defaults[0] && !defaults[0].active
      ? `v7's default currency ${defaults[0].code} is inactive. A default is always active here; nothing is written until v7 is put right.`
      : null;
  return { values, refused, skipped, corrections };
}

// ── Loading ────────────────────────────────────────────────────────────────────────────────────────────────────

export type CurrenciesOutcome = {
  committed: boolean; runId: string;
  /** The plan refused the load (defaults) — nothing written. */
  refused: string | null;
  inserted: number; stamped: number; updated: number; unchanged: number;
  /** R4: changed in v7 and edited here since — nothing written for these. */
  conflicts: string[];
  /** Codes the console holds that v7 does not — reported, never deactivated. */
  hereOnly: string[];
  notes: string[];
  parity: { v7Active: number; v7Inactive: number; consoleActive: number; consoleInactive: number };
};

class DryRunRollback extends Error {}

const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  : value;
const same = (a: unknown, b: unknown) => a !== null && a !== undefined && JSON.stringify(stable(a)) === JSON.stringify(stable(b));
/** Written by this import, or by 0145 — not yet by a person. */
const byImportOrMigration = (actor: string) => actor.startsWith(CURRENCIES_RUN_PREFIX) || actor.startsWith("migration:");

type Held = { code: string; name: string; symbol: string; is_default: boolean; active: boolean; source_system: string | null; legacy_db_id: string | null;
  legacy_values: unknown; created_by: string; updated_by: string };

export async function loadV7Currencies(pool: PoolLike, organisationId: string, plan: CurrenciesPlan, options: { commit: boolean; runId?: string }): Promise<CurrenciesOutcome> {
  const runId = options.runId ?? `${CURRENCIES_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(CURRENCIES_RUN_PREFIX)) throw new Error(`A currencies run id must start ${CURRENCIES_RUN_PREFIX} — it is how a re-run knows a row is still as an import wrote it.`);
  const outcome: CurrenciesOutcome = {
    committed: options.commit, runId, refused: plan.refused, inserted: 0, stamped: 0, updated: 0, unchanged: 0, conflicts: [], hereOnly: [], notes: [...plan.corrections],
    parity: { v7Active: plan.values.filter((value) => value.active).length, v7Inactive: plan.values.filter((value) => !value.active).length, consoleActive: 0, consoleInactive: 0 },
  };
  if (plan.refused) return outcome;
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      await reconcile(db, organisationId, plan, runId, outcome);
      if (outcome.inserted + outcome.stamped + outcome.updated > 0) {
        await db.query(
          `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, after_json)
           VALUES ($1, $2, $3, 'system', 'currencies.imported', 'currencies', 'currencies', $4, $5, $6::jsonb)`,
          [organisationId, randomUUID(), IMPORT_ACTOR, runId, "Currencies consolidated from NZ Insights Pro v7's two currency tables (admin E1)",
            JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, inserted: outcome.inserted, stamped: outcome.stamped, updated: outcome.updated,
              unchanged: outcome.unchanged, conflicts: outcome.conflicts.length, hereOnly: outcome.hereOnly.length })]);
      }
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}

async function reconcile(db: Queryable, org: string, plan: CurrenciesPlan, runId: string, outcome: CurrenciesOutcome) {
  const { rows: existing } = await db.query<Held>(
    `SELECT code, name, symbol, is_default, active, source_system, legacy_db_id, legacy_values, created_by, updated_by
       FROM nzi_console.currencies WHERE organisation_id = $1 ORDER BY code FOR UPDATE`, [org]);
  const held = new Map(existing.map((row) => [row.code, row]));

  // The default last, so every other currency is settled before the one-default index is asked to move.
  for (const value of [...plan.values].sort((a, b) => Number(a.isDefault) - Number(b.isDefault))) {
    const row = held.get(value.code);
    // v7's default claims the flag (processed last, so it moves the old one when 0145 or an import set it). Any other
    // currency keeps what it holds: a default v7 does not name moves only when v7 names another.
    const isDefault = value.isDefault ? await claimDefault(db, org, value.code, runId, outcome) : row?.is_default ?? false;
    const active = isDefault ? true : value.active;

    if (!row) {
      await db.query(
        `INSERT INTO nzi_console.currencies (organisation_id, code, name, symbol, is_default, active, source_system, legacy_db_id, legacy_values, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $2, $8::jsonb, $9, $9)`,
        [org, value.code, value.name, value.symbol, isDefault, active, SOURCE_SYSTEM, JSON.stringify(value.legacyValues), runId]);
      outcome.inserted += 1;
      continue;
    }
    const identified = row.source_system === SOURCE_SYSTEM && row.legacy_db_id === value.code;
    if (identified && same(row.legacy_values, value.legacyValues) && row.is_default === isDefault) { outcome.unchanged += 1; continue; }
    if (identified && !byImportOrMigration(row.updated_by) && !same(row.legacy_values, value.legacyValues)) {
      outcome.conflicts.push(`${value.code}: changed in v7 since the last load, and edited here since`);
      continue;
    }
    // A row 0145 seeded (or this import wrote) takes v7's name and symbol; one a person made or edited keeps its own.
    const takeV7 = byImportOrMigration(row.updated_by);
    if (!takeV7 && (row.name !== value.name || row.symbol !== value.symbol)) {
      outcome.notes.push(`${value.code}: kept as edited here ("${row.name}", ${row.symbol}); v7 holds "${value.name}", ${value.symbol}`);
    }
    await db.query(
      `UPDATE nzi_console.currencies SET name = $3, symbol = $4, is_default = $5, active = $6, source_system = $7, legacy_db_id = $2, legacy_values = $8::jsonb,
              version = version + 1, updated_at = now(), updated_by = $9
        WHERE organisation_id = $1 AND code = $2`,
      [org, value.code, takeV7 ? value.name : row.name, takeV7 ? value.symbol : row.symbol, isDefault, takeV7 ? active : row.active || isDefault,
        SOURCE_SYSTEM, JSON.stringify(value.legacyValues), takeV7 ? runId : row.updated_by]);
    if (identified) outcome.updated += 1; else outcome.stamped += 1;
  }

  const v7Codes = new Set(plan.values.map((value) => value.code));
  outcome.hereOnly = existing.filter((row) => !v7Codes.has(row.code)).map((row) => row.code);
  if (!plan.values.some((value) => value.isDefault)) outcome.notes.push("v7 has no default currency; the console's default stands");
  const { rows: [parity] } = await db.query<{ active: number; inactive: number }>(
    `SELECT count(*) FILTER (WHERE active)::int AS active, count(*) FILTER (WHERE NOT active)::int AS inactive
       FROM nzi_console.currencies WHERE organisation_id = $1 AND source_system = $2`, [org, SOURCE_SYSTEM]);
  outcome.parity.consoleActive = parity?.active ?? 0;
  outcome.parity.consoleInactive = parity?.inactive ?? 0;
}

/**
 * Whether v7's default may be set on `code`: yes when the console has none, or its default is this code, or 0145 or an
 * import set it (the old one is cleared first). A default a person chose stands, and v7's is loaded as not the default.
 */
async function claimDefault(db: Queryable, org: string, code: string, runId: string, outcome: CurrenciesOutcome): Promise<boolean> {
  const { rows: [current] } = await db.query<{ code: string; updated_by: string }>(
    `SELECT code, updated_by FROM nzi_console.currencies WHERE organisation_id = $1 AND is_default FOR UPDATE`, [org]);
  if (!current || current.code === code) return true;
  if (!byImportOrMigration(current.updated_by)) {
    outcome.notes.push(`the console's own default currency ${current.code} stands; v7's default ${code} is loaded as not the default`);
    return false;
  }
  await db.query(`UPDATE nzi_console.currencies SET is_default = false, version = version + 1, updated_at = now(), updated_by = $3 WHERE organisation_id = $1 AND code = $2`,
    [org, current.code, runId]);
  return true;
}
