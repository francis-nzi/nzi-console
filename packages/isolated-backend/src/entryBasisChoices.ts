// Data entry D1 (R4): the basis a client last recorded an entry on, per category. Its own module, with no command imports, so the
// scope-row create can record a choice in its transaction without importing the admin command that sits beside the reads.
import type { EntryBasis } from "@nzi/contracts";
import type { Queryable } from "./postgres";

/**
 * Record the drawer's basis as this client's last choice for the category, in the caller's transaction. The job names the client;
 * a job that names none (it cannot: jobs require one) records nothing rather than guess.
 */
export async function recordClientEntryBasisChoice(
  db: Queryable, organisationId: string, jobId: string, categoryCode: string, basis: EntryBasis, actorId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.client_entry_basis_choices (organisation_id, client_id, category_code, basis, chosen_by)
     SELECT j.organisation_id, j.client_id, $3, $4, $5 FROM nzi_console.jobs j WHERE j.organisation_id = $1 AND j.job_id = $2
     ON CONFLICT (organisation_id, client_id, category_code)
       DO UPDATE SET basis = EXCLUDED.basis, chosen_at = now(), chosen_by = EXCLUDED.chosen_by`,
    [organisationId, jobId, categoryCode, basis, actorId]);
}
