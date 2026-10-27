// Data entry D1 (R4, R6): what an add-entry drawer opens on — the organisation's admin default per category over the seed, and the
// client's last choice over both — and the Admin command that sets the default. See @nzi/contracts `entryBasis` for the rules.
import {
  emissionCategoryTaxonomy, isEntryBasis, seededEntryBasis,
  type CommandContext, type CommandInputMap, type EntryBasis, type EntryBasisDefaultRow, type JobEntryBasis,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";
import { activeSpendAllocationsForJob } from "./spendAllocationReads";

type DefaultRow = { category_code: string; default_basis: string; version: number };

/** Every taxonomy category as Admin lists it: the seed, and the organisation's setting where it has one. */
export async function listEntryBasisDefaults(db: Queryable, organisationId: string): Promise<EntryBasisDefaultRow[]> {
  const { rows } = await db.query<DefaultRow>(
    `SELECT category_code, default_basis, version FROM nzi_console.organisation_entry_basis_defaults WHERE organisation_id = $1`,
    [organisationId]);
  const set = new Map(rows.map((row) => [row.category_code, row]));
  return emissionCategoryTaxonomy.map((category) => {
    const row = set.get(category.code);
    return {
      categoryCode: category.code, name: category.name, scope: category.scope, seed: seededEntryBasis(category.code),
      setting: row && isEntryBasis(row.default_basis) ? row.default_basis : null, version: row?.version ?? null,
    };
  });
}

/**
 * What a job's drawers open on: the organisation's defaults and the job's client's last choices, by category, and the client's
 * currency. Read with the job's own tenant; a job not found reads as nothing chosen, in GBP — the drawer then opens on the seed.
 */
export async function readJobEntryBasis(db: Queryable, organisationId: string, jobId: string): Promise<JobEntryBasis> {
  const [defaults, choices, client, allocations, sites] = await Promise.all([
    db.query<{ category_code: string; default_basis: string }>(
      `SELECT category_code, default_basis FROM nzi_console.organisation_entry_basis_defaults WHERE organisation_id = $1`, [organisationId]),
    db.query<{ category_code: string; basis: string }>(
      `SELECT c.category_code, c.basis FROM nzi_console.client_entry_basis_choices c
         JOIN nzi_console.jobs j ON (j.organisation_id, j.client_id) = (c.organisation_id, c.client_id)
        WHERE j.organisation_id = $1 AND j.job_id = $2`, [organisationId, jobId]),
    db.query<{ currency: string | null }>(
      `SELECT cl.currency FROM nzi_console.jobs j JOIN nzi_console.clients cl ON (cl.organisation_id, cl.client_id) = (j.organisation_id, j.client_id)
        WHERE j.organisation_id = $1 AND j.job_id = $2`, [organisationId, jobId]),
    activeSpendAllocationsForJob(db, organisationId, jobId),
    // D3 (R1): the sites that spend in a currency of their own — a spend line at one is captured in it.
    db.query<{ site_id: string; currency: string }>(
      `SELECT s.site_id, s.currency FROM nzi_console.client_sites s JOIN nzi_console.jobs j ON (j.organisation_id, j.client_id) = (s.organisation_id, s.client_id)
        WHERE j.organisation_id = $1 AND j.job_id = $2 AND s.currency IS NOT NULL`, [organisationId, jobId]),
  ]);
  const byCategory = (rows: Array<{ category_code: string; value: string }>) =>
    Object.fromEntries(rows.filter((row) => isEntryBasis(row.value)).map((row) => [row.category_code, row.value as EntryBasis]));
  return {
    defaults: byCategory(defaults.rows.map((row) => ({ category_code: row.category_code, value: row.default_basis }))),
    choices: byCategory(choices.rows.map((row) => ({ category_code: row.category_code, value: row.basis }))),
    currency: client.rows[0]?.currency?.trim() || "GBP",
    allocations,
    siteCurrencies: Object.fromEntries(sites.rows.map((row) => [row.site_id, row.currency])),
  };
}

export type EntryBasisDefaultResult = { categoryCode: string; defaultBasis: EntryBasis; version: number };

/** R4/R6: set the basis a category's drawer opens on, under admin.settings. Versioned per category; the first save creates the row. */
export function updateEntryBasisDefault(pool: PoolLike, input: CommandInputMap["admin.entryBasis.update"], context: CommandContext): Promise<StoredOutcome<EntryBasisDefaultResult>> {
  return runPostgresCommand(pool, "admin.entryBasis.update", input, context, async (db) => {
    const { rows: [current] } = await db.query<DefaultRow>(
      `SELECT category_code, default_basis, version FROM nzi_console.organisation_entry_basis_defaults
        WHERE organisation_id = $1 AND category_code = $2 FOR UPDATE`, [context.organisationId, input.categoryCode]);
    const expected = input.expectedVersion ?? null;
    if (current ? expected !== current.version : expected !== null) throw new VersionConflictError(expected ?? 0, current?.version ?? 0);
    const before = current ? current.default_basis : seededEntryBasis(input.categoryCode);
    if (before === input.defaultBasis) {
      throw new CommandValidationError([{ field: "defaultBasis", code: "UNCHANGED", message: "That is the basis already in force." }]);
    }
    const { rows: [saved] } = await db.query<{ version: number }>(
      `INSERT INTO nzi_console.organisation_entry_basis_defaults (organisation_id, category_code, default_basis, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organisation_id, category_code) DO UPDATE SET default_basis = EXCLUDED.default_basis,
         version = organisation_entry_basis_defaults.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING version`,
      [context.organisationId, input.categoryCode, input.defaultBasis, context.actorId]);
    return {
      data: { categoryCode: input.categoryCode, defaultBasis: input.defaultBasis, version: saved!.version },
      entityType: "organisation_entry_basis_default", entityId: input.categoryCode, topic: "entry_basis_default.updated",
      // The seed is what was in force before the first setting — said as such, so the audit reads truly.
      before: current ? { defaultBasis: current.default_basis } : { defaultBasis: before, seeded: true },
    };
  });
}
