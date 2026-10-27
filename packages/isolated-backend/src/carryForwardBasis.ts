import type { CommandContext } from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { CommandValidationError } from "./postgresCommands";

/**
 * Data entry D3 (R3): the prior job a job carries forward from — **stored when first chosen, never recomputed** (0195,
 * `job_carry_forward_basis`).
 *
 * Before this the prior job was worked out again on every read: "the latest earlier CRP job for this client with spend". A job
 * created later, or re-dated, changed that answer — and with it which year a job's carried lines were said to come from, after the
 * fact. Now the first carry-forward (spend lines or rows) stores the job it used, with that job's period as it stood; the previews
 * read the stored basis, and a carry-forward from any other job is refused. Until a job has carried anything forward, the previews
 * show the candidate — said as proposed, not as the basis.
 */
export type CarryForwardBasis = { priorJobId: string; priorJobNumber: string; priorYear: number; fixed: boolean };

/** The basis the job has stored, or null. Tenant-scoped by the caller's transaction (RLS). */
export async function storedCarryForwardBasis(db: Queryable, jobId: string): Promise<CarryForwardBasis | null> {
  const { rows } = await db.query<{ prior_job_id: string; job_number: string; reporting_year: number }>(
    `SELECT b.prior_job_id,p.job_number,coalesce(p.reporting_year,extract(year from p.start_date)::int) AS reporting_year
       FROM nzi_console.job_carry_forward_basis b
       JOIN nzi_console.jobs p ON (p.organisation_id,p.job_id)=(b.organisation_id,b.prior_job_id)
      WHERE b.job_id=$1`,
    [jobId],
  );
  const row = rows[0];
  return row ? { priorJobId: row.prior_job_id, priorJobNumber: row.job_number, priorYear: row.reporting_year, fixed: true } : null;
}

/**
 * Store `priorJobId` as the job's basis, inside the carry-forward's own transaction — or, when one is stored, require that it is
 * the same job. Concurrent first carry-forwards race on the primary key; the loser reads the winner's and is held to it.
 */
export async function fixCarryForwardBasis(db: Queryable, context: CommandContext, jobId: string, priorJobId: string, field: string): Promise<CarryForwardBasis> {
  const refuse = (basis: CarryForwardBasis) => new CommandValidationError([{
    field, code: "CARRY_FORWARD_BASIS_FIXED",
    message: `This job carries forward from ${basis.priorJobNumber} (FY${basis.priorYear}), chosen the first time it carried anything forward. Carrying forward from another job would change, after the fact, which year its carried lines came from.`,
  }]);
  const stored = await storedCarryForwardBasis(db, jobId);
  if (stored) {
    if (stored.priorJobId !== priorJobId) throw refuse(stored);
    return stored;
  }
  // The prior job's period as it stands now — its own dates, else its emissions window — kept with the choice.
  await db.query(
    `INSERT INTO nzi_console.job_carry_forward_basis (organisation_id,job_id,prior_job_id,prior_period_from,prior_period_to,chosen_by)
     SELECT $1,$2,p.job_id,
            CASE WHEN p.reporting_period_start IS NOT NULL AND p.reporting_period_end IS NOT NULL THEN p.reporting_period_start ELSE ec.reporting_from END,
            CASE WHEN p.reporting_period_start IS NOT NULL AND p.reporting_period_end IS NOT NULL THEN p.reporting_period_end ELSE ec.reporting_to END,
            $4
       FROM nzi_console.jobs p
       LEFT JOIN nzi_console.job_emissions_config ec ON (ec.organisation_id,ec.job_id)=(p.organisation_id,p.job_id)
      WHERE p.organisation_id=$1 AND p.job_id=$3
     ON CONFLICT (organisation_id,job_id) DO NOTHING`,
    [context.organisationId, jobId, priorJobId, context.actorId],
  );
  const now = await storedCarryForwardBasis(db, jobId);
  if (!now) throw new CommandValidationError([{ field, code: "NOT_FOUND", message: "The prior job was not found." }]);
  if (now.priorJobId !== priorJobId) throw refuse(now);
  return now;
}
