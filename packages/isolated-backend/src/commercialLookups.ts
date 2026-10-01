import { randomUUID } from "node:crypto";
import {
  currencyListSpec, vatRateListSpec,
  type CommandContext, type CommandInputMap, type CurrencyDirectoryEntry, type CurrencyListFilterKey, type CurrencyListQuery, type CurrencyListSortKey,
  type ListPage, type VatRateListFilterKey, type VatRateListQuery, type VatRateListSortKey,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { defineListSql, readListPage } from "./listPage";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * Commercial lookups (admin Phase E1; ruled `phaseE-commercial-catalogue-plan.md`, E-Q1–E-Q3): VAT rates (0139's table,
 * imported by C4) and currencies (0145), added, edited, made the default, deactivated and reinstated through the command
 * runner (admin.lookups, idempotency, `expectedVersion`, audit with before and after) — never deleted (R3).
 *
 * - **Exactly one default** each. A new row is the default only when it is the organisation's first; otherwise the
 *   default moves by `*.set_default` (the old one cleared first, so the partial unique index never sees two), and the
 *   default can never be deactivated. 0145's deferred trigger checks "at least one" at commit, whatever writes.
 * - **A deactivated rate or currency still resolves** on whatever already names it: a job type keeps its VAT rate, a
 *   client keeps its currency (`assertClientCurrency` lets a held value stand).
 * - **A currency's code is set once** — a create field only; 0145 grants the role no UPDATE on it.
 * - **`readCurrencyDirectory`** is what `currencySymbol(code)` reads from (D3c's lookup, swapped in here).
 */

const cleanName = (value: string) => value.trim().replace(/\s+/g, " ");
const iso = (date: unknown) => date instanceof Date ? date.toISOString() : String(date);
export type CommercialProvenance = "v7" | "added" | "seeded";
const PROVENANCE_SQL = (alias: string) =>
  `CASE WHEN ${alias}.source_system IS NOT NULL THEN 'v7' WHEN ${alias}.created_by LIKE 'migration:%' THEN 'seeded' ELSE 'added' END AS provenance`;

// ── VAT rates: the list ────────────────────────────────────────────────────────────────────────────────────────────

export type VatRateRow = {
  vatRateId: string; name: string; ratePct: number; isDefault: boolean; active: boolean; version: number;
  provenance: CommercialProvenance; updatedAt: string;
  /** Job types naming this rate — they keep it whatever happens to it. */
  inUse: number;
};
export type VatRatePage = ListPage<VatRateRow, VatRateListFilterKey, Record<string, never>>;

const vatRateSql = defineListSql<VatRateListSortKey, VatRateListFilterKey>({
  base: `SELECT v.organisation_id, v.vat_rate_id, v.name, v.rate_pct, v.is_default, v.active, v.version, v.updated_at,
      CASE WHEN v.active THEN 'active' ELSE 'inactive' END AS status, ${PROVENANCE_SQL("v")},
      (SELECT count(*) FROM nzi_console.job_types jt WHERE jt.organisation_id = v.organisation_id AND jt.vat_rate_id = v.vat_rate_id)::int AS in_use
    FROM nzi_console.vat_rates v`,
  search: ["name"],
  filters: { status: { kind: "equals", column: "status", facet: { noneLabel: "—", values: ["active", "inactive"] } } },
  sort: { ratePct: { column: "rate_pct" }, name: { column: "name", text: true }, status: { column: "status", text: true } },
  tiebreak: "vat_rate_id",
});

export async function listVatRatesPage(db: Queryable, query: VatRateListQuery): Promise<VatRatePage> {
  return readListPage(db, vatRateSql, vatRateListSpec, query, {
    mapRow: (row) => ({
      vatRateId: String(row.vat_rate_id), name: String(row.name), ratePct: Number(row.rate_pct), isDefault: row.is_default === true,
      active: row.active === true, version: Number(row.version), provenance: row.provenance as CommercialProvenance, updatedAt: iso(row.updated_at),
      inUse: Number(row.in_use),
    }),
    mapSummary: () => ({}),
  });
}

// ── VAT rates: commands ────────────────────────────────────────────────────────────────────────────────────────────

type StoredVat = { name: string; rate_pct: string; is_default: boolean; active: boolean; version: number };
type VatSnapshot = { name: string; ratePct: number; isDefault: boolean; active: boolean };
const vatSnapshot = (row: StoredVat): VatSnapshot => ({ name: row.name, ratePct: Number(row.rate_pct), isDefault: row.is_default, active: row.active });
/** What the rate now is — the runner records it as the audit's after_json, beside `before`. No amounts here are sensitive. */
export type VatRateResult = VatSnapshot & { vatRateId: string; version: number };
const VAT_RETURNING = "RETURNING name, rate_pct::text, is_default, active, version";

async function lockVat(db: Queryable, context: CommandContext, vatRateId: string, expectedVersion: number): Promise<StoredVat> {
  const { rows: [row] } = await db.query<StoredVat>(
    `SELECT name, rate_pct::text, is_default, active, version FROM nzi_console.vat_rates WHERE organisation_id = $1 AND vat_rate_id = $2 FOR UPDATE`,
    [context.organisationId, vatRateId]);
  if (!row) throw new CommandValidationError([{ field: "vatRateId", code: "NOT_FOUND", message: "That VAT rate is not here." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

/** A name belongs to one rate, active or not — 0139's index, said as a field error. */
async function assertVatNameFree(db: Queryable, context: CommandContext, name: string, exceptId?: string) {
  const { rows: [taken] } = await db.query<{ taken: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM nzi_console.vat_rates WHERE organisation_id = $1 AND lower(name) = lower($2) AND vat_rate_id IS DISTINCT FROM $3) AS taken`,
    [context.organisationId, name, exceptId ?? null]);
  if (taken?.taken) throw new CommandValidationError([{ field: "name", code: "DUPLICATE", message: "Another VAT rate — active or not — already has that name." }]);
}

export function createVatRate(pool: PoolLike, input: CommandInputMap["vat.create"], context: CommandContext): Promise<StoredOutcome<VatRateResult>> {
  return runPostgresCommand(pool, "vat.create", input, context, async (db) => {
    const name = cleanName(input.name);
    await assertVatNameFree(db, context, name);
    // Serialise the "is this the first?" question per organisation: two first rates at once must not both be default.
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('vat-rates:' || $1, 0))`, [context.organisationId]);
    const { rows: [held] } = await db.query<{ any: boolean }>(`SELECT EXISTS (SELECT 1 FROM nzi_console.vat_rates WHERE organisation_id = $1) AS any`, [context.organisationId]);
    const isDefault = !held?.any;
    const vatRateId = `vat:${randomUUID()}`;
    const { rows: [saved] } = await db.query<StoredVat>(
      `INSERT INTO nzi_console.vat_rates (organisation_id, vat_rate_id, name, rate_pct, is_default, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6) ${VAT_RETURNING}`,
      [context.organisationId, vatRateId, name, input.ratePct, isDefault, context.actorId]);
    return { data: { vatRateId, version: saved!.version, ...vatSnapshot(saved!) }, entityType: "vat_rate", entityId: vatRateId, topic: "vat.created" };
  });
}

export function updateVatRate(pool: PoolLike, input: CommandInputMap["vat.update"], context: CommandContext): Promise<StoredOutcome<VatRateResult>> {
  return runPostgresCommand(pool, "vat.update", input, context, async (db) => {
    const current = await lockVat(db, context, input.vatRateId, input.expectedVersion);
    const name = cleanName(input.name);
    await assertVatNameFree(db, context, name, input.vatRateId);
    const { rows: [saved] } = await db.query<StoredVat>(
      `UPDATE nzi_console.vat_rates SET name = $3, rate_pct = $4, version = version + 1, updated_at = now(), updated_by = $5
        WHERE organisation_id = $1 AND vat_rate_id = $2 ${VAT_RETURNING}`,
      [context.organisationId, input.vatRateId, name, input.ratePct, context.actorId]);
    return { data: { vatRateId: input.vatRateId, version: saved!.version, ...vatSnapshot(saved!) }, entityType: "vat_rate", entityId: input.vatRateId,
      topic: "vat.updated", before: vatSnapshot(current) };
  });
}

export function setDefaultVatRate(pool: PoolLike, input: CommandInputMap["vat.set_default"], context: CommandContext): Promise<StoredOutcome<VatRateResult & { previousDefault: string | null }>> {
  return runPostgresCommand(pool, "vat.set_default", input, context, async (db) => {
    const current = await lockVat(db, context, input.vatRateId, input.expectedVersion);
    if (current.is_default) throw new CommandValidationError([{ field: "vatRateId", code: "ALREADY_DEFAULT", message: "That VAT rate is already the default." }]);
    if (!current.active) throw new CommandValidationError([{ field: "vatRateId", code: "INACTIVE", message: "Reinstate the VAT rate before making it the default — a default is always active." }]);
    const { rows: [cleared] } = await db.query<{ vat_rate_id: string }>(
      `UPDATE nzi_console.vat_rates SET is_default = false, version = version + 1, updated_at = now(), updated_by = $2
        WHERE organisation_id = $1 AND is_default RETURNING vat_rate_id`, [context.organisationId, context.actorId]);
    const { rows: [saved] } = await db.query<StoredVat>(
      `UPDATE nzi_console.vat_rates SET is_default = true, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND vat_rate_id = $2 ${VAT_RETURNING}`, [context.organisationId, input.vatRateId, context.actorId]);
    return { data: { vatRateId: input.vatRateId, version: saved!.version, ...vatSnapshot(saved!), previousDefault: cleared?.vat_rate_id ?? null },
      entityType: "vat_rate", entityId: input.vatRateId, topic: "vat.default_set", before: vatSnapshot(current) };
  });
}

export function deactivateVatRate(pool: PoolLike, input: CommandInputMap["vat.deactivate"], context: CommandContext): Promise<StoredOutcome<VatRateResult>> {
  return runPostgresCommand(pool, "vat.deactivate", input, context, async (db) => {
    const current = await lockVat(db, context, input.vatRateId, input.expectedVersion);
    if (current.is_default) throw new CommandValidationError([{ field: "vatRateId", code: "DEFAULT_PROTECTED", message: "The default VAT rate cannot be deactivated. Make another rate the default first." }]);
    if (!current.active) throw new CommandValidationError([{ field: "vatRateId", code: "ALREADY_INACTIVE", message: "That VAT rate is already inactive." }]);
    const { rows: [saved] } = await db.query<StoredVat>(
      `UPDATE nzi_console.vat_rates SET active = false, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND vat_rate_id = $2 ${VAT_RETURNING}`, [context.organisationId, input.vatRateId, context.actorId]);
    return { data: { vatRateId: input.vatRateId, version: saved!.version, ...vatSnapshot(saved!) }, entityType: "vat_rate", entityId: input.vatRateId,
      topic: "vat.deactivated", before: vatSnapshot(current) };
  });
}

export function reinstateVatRate(pool: PoolLike, input: CommandInputMap["vat.reinstate"], context: CommandContext): Promise<StoredOutcome<VatRateResult>> {
  return runPostgresCommand(pool, "vat.reinstate", input, context, async (db) => {
    const current = await lockVat(db, context, input.vatRateId, input.expectedVersion);
    if (current.active) throw new CommandValidationError([{ field: "vatRateId", code: "ALREADY_ACTIVE", message: "That VAT rate is already active." }]);
    const { rows: [saved] } = await db.query<StoredVat>(
      `UPDATE nzi_console.vat_rates SET active = true, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND vat_rate_id = $2 ${VAT_RETURNING}`, [context.organisationId, input.vatRateId, context.actorId]);
    return { data: { vatRateId: input.vatRateId, version: saved!.version, ...vatSnapshot(saved!) }, entityType: "vat_rate", entityId: input.vatRateId,
      topic: "vat.reinstated", before: vatSnapshot(current) };
  });
}

// ── Currencies: the list ───────────────────────────────────────────────────────────────────────────────────────────

export type CurrencyRow = {
  code: string; name: string; symbol: string; isDefault: boolean; active: boolean; version: number;
  provenance: CommercialProvenance; updatedAt: string;
  /** Clients holding this currency — they keep it whatever happens to it. */
  inUse: number;
};
export type CurrencyPage = ListPage<CurrencyRow, CurrencyListFilterKey, Record<string, never>>;

const currencySql = defineListSql<CurrencyListSortKey, CurrencyListFilterKey>({
  base: `SELECT cu.organisation_id, cu.code, cu.name, cu.symbol, cu.is_default, cu.active, cu.version, cu.updated_at,
      CASE WHEN cu.active THEN 'active' ELSE 'inactive' END AS status, ${PROVENANCE_SQL("cu")},
      (SELECT count(*) FROM nzi_console.clients c WHERE c.organisation_id = cu.organisation_id AND upper(btrim(c.currency)) = cu.code)::int AS in_use
    FROM nzi_console.currencies cu`,
  search: ["code", "name"],
  filters: { status: { kind: "equals", column: "status", facet: { noneLabel: "—", values: ["active", "inactive"] } } },
  sort: { code: { column: "code", text: true }, name: { column: "name", text: true }, status: { column: "status", text: true } },
  tiebreak: "code",
});

export async function listCurrenciesPage(db: Queryable, query: CurrencyListQuery): Promise<CurrencyPage> {
  return readListPage(db, currencySql, currencyListSpec, query, {
    mapRow: (row) => ({
      code: String(row.code), name: String(row.name), symbol: String(row.symbol), isDefault: row.is_default === true, active: row.active === true,
      version: Number(row.version), provenance: row.provenance as CommercialProvenance, updatedAt: iso(row.updated_at), inUse: Number(row.in_use),
    }),
    mapSummary: () => ({}),
  });
}

/**
 * The organisation's currencies as `currencySymbol` reads them — active and inactive alike, so a client still holding a
 * deactivated currency still reads in its symbol (R3).
 */
export async function readCurrencyDirectory(db: Queryable, organisationId: string): Promise<CurrencyDirectoryEntry[]> {
  const { rows } = await db.query<CurrencyDirectoryEntry>(
    `SELECT code, name, symbol FROM nzi_console.currencies WHERE organisation_id = $1 ORDER BY code`, [organisationId]);
  return rows;
}

/**
 * E-Q3: a client's currency is one of the organisation's active currencies. The value a client already holds always
 * stands — an edit that leaves it alone is never refused because the set changed under it (R3) — so only a change is
 * checked. Called by `client.update` before it writes.
 */
export async function assertClientCurrency(db: Queryable, organisationId: string, next: string, held: string | null | undefined): Promise<void> {
  const code = next.trim().toUpperCase();
  if (held != null && code === held.trim().toUpperCase()) return;
  const { rows: [row] } = await db.query<{ active: boolean }>(
    `SELECT active FROM nzi_console.currencies WHERE organisation_id = $1 AND code = $2`, [organisationId, code]);
  if (row?.active) return;
  throw new CommandValidationError([{ field: "currency", code: row ? "CURRENCY_INACTIVE" : "CURRENCY_UNKNOWN", message: row
    ? `${code} is deactivated in Admin → Tax & currency. Reinstate it there to choose it.`
    : `${code} is not one of this organisation's currencies. Add it in Admin → Tax & currency first.` }]);
}

// ── Currencies: commands ───────────────────────────────────────────────────────────────────────────────────────────

type StoredCurrency = { name: string; symbol: string; is_default: boolean; active: boolean; version: number };
type CurrencySnapshot = { name: string; symbol: string; isDefault: boolean; active: boolean };
const currencySnapshot = (row: StoredCurrency): CurrencySnapshot => ({ name: row.name, symbol: row.symbol, isDefault: row.is_default, active: row.active });
export type CurrencyResult = CurrencySnapshot & { code: string; version: number };
const CURRENCY_RETURNING = "RETURNING name, symbol, is_default, active, version";

async function lockCurrency(db: Queryable, context: CommandContext, code: string, expectedVersion: number): Promise<StoredCurrency> {
  const { rows: [row] } = await db.query<StoredCurrency>(
    `SELECT name, symbol, is_default, active, version FROM nzi_console.currencies WHERE organisation_id = $1 AND code = $2 FOR UPDATE`,
    [context.organisationId, code]);
  if (!row) throw new CommandValidationError([{ field: "code", code: "NOT_FOUND", message: "That currency is not here." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

export function createCurrency(pool: PoolLike, input: CommandInputMap["currency.create"], context: CommandContext): Promise<StoredOutcome<CurrencyResult>> {
  return runPostgresCommand(pool, "currency.create", input, context, async (db) => {
    const code = input.code;
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('currencies:' || $1, 0))`, [context.organisationId]);
    const { rows: [state] } = await db.query<{ taken: boolean; any: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM nzi_console.currencies WHERE organisation_id = $1 AND code = $2) AS taken,
              EXISTS (SELECT 1 FROM nzi_console.currencies WHERE organisation_id = $1) AS any`, [context.organisationId, code]);
    if (state?.taken) throw new CommandValidationError([{ field: "code", code: "DUPLICATE", message: `${code} is already one of this organisation's currencies — active or not.` }]);
    const { rows: [saved] } = await db.query<StoredCurrency>(
      `INSERT INTO nzi_console.currencies (organisation_id, code, name, symbol, is_default, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6) ${CURRENCY_RETURNING}`,
      [context.organisationId, code, cleanName(input.name), input.symbol.trim(), !state?.any, context.actorId]);
    return { data: { code, version: saved!.version, ...currencySnapshot(saved!) }, entityType: "currency", entityId: code, topic: "currency.created" };
  });
}

export function updateCurrency(pool: PoolLike, input: CommandInputMap["currency.update"], context: CommandContext): Promise<StoredOutcome<CurrencyResult>> {
  return runPostgresCommand(pool, "currency.update", input, context, async (db) => {
    const current = await lockCurrency(db, context, input.code, input.expectedVersion);
    const { rows: [saved] } = await db.query<StoredCurrency>(
      `UPDATE nzi_console.currencies SET name = $3, symbol = $4, version = version + 1, updated_at = now(), updated_by = $5
        WHERE organisation_id = $1 AND code = $2 ${CURRENCY_RETURNING}`,
      [context.organisationId, input.code, cleanName(input.name), input.symbol.trim(), context.actorId]);
    return { data: { code: input.code, version: saved!.version, ...currencySnapshot(saved!) }, entityType: "currency", entityId: input.code,
      topic: "currency.updated", before: currencySnapshot(current) };
  });
}

export function setDefaultCurrency(pool: PoolLike, input: CommandInputMap["currency.set_default"], context: CommandContext): Promise<StoredOutcome<CurrencyResult & { previousDefault: string | null }>> {
  return runPostgresCommand(pool, "currency.set_default", input, context, async (db) => {
    const current = await lockCurrency(db, context, input.code, input.expectedVersion);
    if (current.is_default) throw new CommandValidationError([{ field: "code", code: "ALREADY_DEFAULT", message: "That currency is already the default." }]);
    if (!current.active) throw new CommandValidationError([{ field: "code", code: "INACTIVE", message: "Reinstate the currency before making it the default — a default is always active." }]);
    const { rows: [cleared] } = await db.query<{ code: string }>(
      `UPDATE nzi_console.currencies SET is_default = false, version = version + 1, updated_at = now(), updated_by = $2
        WHERE organisation_id = $1 AND is_default RETURNING code`, [context.organisationId, context.actorId]);
    const { rows: [saved] } = await db.query<StoredCurrency>(
      `UPDATE nzi_console.currencies SET is_default = true, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND code = $2 ${CURRENCY_RETURNING}`, [context.organisationId, input.code, context.actorId]);
    return { data: { code: input.code, version: saved!.version, ...currencySnapshot(saved!), previousDefault: cleared?.code ?? null },
      entityType: "currency", entityId: input.code, topic: "currency.default_set", before: currencySnapshot(current) };
  });
}

export function deactivateCurrency(pool: PoolLike, input: CommandInputMap["currency.deactivate"], context: CommandContext): Promise<StoredOutcome<CurrencyResult>> {
  return runPostgresCommand(pool, "currency.deactivate", input, context, async (db) => {
    const current = await lockCurrency(db, context, input.code, input.expectedVersion);
    if (current.is_default) throw new CommandValidationError([{ field: "code", code: "DEFAULT_PROTECTED", message: "The default currency cannot be deactivated. Make another currency the default first." }]);
    if (!current.active) throw new CommandValidationError([{ field: "code", code: "ALREADY_INACTIVE", message: "That currency is already inactive." }]);
    const { rows: [saved] } = await db.query<StoredCurrency>(
      `UPDATE nzi_console.currencies SET active = false, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND code = $2 ${CURRENCY_RETURNING}`, [context.organisationId, input.code, context.actorId]);
    return { data: { code: input.code, version: saved!.version, ...currencySnapshot(saved!) }, entityType: "currency", entityId: input.code,
      topic: "currency.deactivated", before: currencySnapshot(current) };
  });
}

export function reinstateCurrency(pool: PoolLike, input: CommandInputMap["currency.reinstate"], context: CommandContext): Promise<StoredOutcome<CurrencyResult>> {
  return runPostgresCommand(pool, "currency.reinstate", input, context, async (db) => {
    const current = await lockCurrency(db, context, input.code, input.expectedVersion);
    if (current.active) throw new CommandValidationError([{ field: "code", code: "ALREADY_ACTIVE", message: "That currency is already active." }]);
    const { rows: [saved] } = await db.query<StoredCurrency>(
      `UPDATE nzi_console.currencies SET active = true, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND code = $2 ${CURRENCY_RETURNING}`, [context.organisationId, input.code, context.actorId]);
    return { data: { code: input.code, version: saved!.version, ...currencySnapshot(saved!) }, entityType: "currency", entityId: input.code,
      topic: "currency.reinstated", before: currencySnapshot(current) };
  });
}
