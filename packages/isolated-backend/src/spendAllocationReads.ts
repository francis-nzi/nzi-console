// Data entry D2: the client's live allocation map as routing reads it. Its own module, with no command imports, so the spend import
// (which the command module imports) can route without a cycle.
import type { SpendAllocationEntry, SpendAllocationKeyKind } from "@nzi/contracts";
import type { Queryable } from "./postgres";

type EntryRow = { allocation_id: string; key_kind: SpendAllocationKeyKind; match_key: string; target_category_code: string; vat_applies: boolean;
  default_dataset_id: string | null; default_factor_id: string | null };

/** The live entries routing reads for one client. */
export async function activeSpendAllocations(db: Queryable, organisationId: string, clientId: string): Promise<SpendAllocationEntry[]> {
  const { rows } = await db.query<EntryRow>(
    `SELECT allocation_id, key_kind, match_key, target_category_code, vat_applies, default_dataset_id, default_factor_id
       FROM nzi_console.client_spend_allocations WHERE organisation_id = $1 AND client_id = $2 AND active`, [organisationId, clientId]);
  return rows.map((row) => ({ allocationId: row.allocation_id, keyKind: row.key_kind, matchKey: row.match_key, targetCategoryCode: row.target_category_code,
    vatApplies: row.vat_applies, defaultDatasetId: row.default_dataset_id, defaultFactorId: row.default_factor_id }));
}

export async function clientOfJob(db: Queryable, organisationId: string, jobId: string): Promise<string | null> {
  const { rows } = await db.query<{ client_id: string }>(`SELECT client_id FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [organisationId, jobId]);
  return rows[0]?.client_id ?? null;
}

/** The live entries for the client a job is for — what the drawer and the import route by. */
export async function activeSpendAllocationsForJob(db: Queryable, organisationId: string, jobId: string): Promise<SpendAllocationEntry[]> {
  const client = await clientOfJob(db, organisationId, jobId);
  return client ? activeSpendAllocations(db, organisationId, client) : [];
}
