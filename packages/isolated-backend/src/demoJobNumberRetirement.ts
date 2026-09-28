import { randomUUID } from "node:crypto";
import { withTenantWrite, type PoolLike } from "./postgres";

/**
 * Move the demo organisation's job numbers out of v7's range, before the v7 load (docs/CLIENT_JOB_IMPORT_DESIGN.md
 * §4, decision 1a: "only demo-organisation clashes are retired, nothing else is renumbered").
 *
 * ## Why
 *
 * `jobs.sequence` is unique across every organisation, and the counter began at 0, so staging's demo jobs hold J000001
 * upwards — exactly the numbers v7's jobs keep (J000001–J000764, §9). The loader refuses any client whose number is
 * already held. This clears the way.
 *
 * ## What it does
 *
 * In **one organisation, which must not be net-zero-international**, every job numbered at or below `above` is given
 * the next free number above both `above` and the organisation's own highest — in its existing order, so the demo keeps
 * its sequence — and the counter is then caught up with `advance_job_sequence_past_existing()` (0134). The counter never
 * runs ahead of a number that exists, so NZC-025's gapless allocation holds. `job_number` is generated from `sequence`,
 * so it follows.
 *
 * One transaction, as the application role inside that organisation's tenant, so row-level security confines every
 * statement to it. One audit event per job moved, with its old and new number. A dry run is the same work, rolled back.
 *
 * ## What it leaves alone
 *
 * Copies of a job number frozen elsewhere — an issued snapshot's payload, a training entitlement's `source_job_number` —
 * are records of what the number was when they were made, and stay as written. They are counted and reported.
 */

export const PROTECTED_ORGANISATION = "net-zero-international";
export const RETIREMENT_ACTOR = "maintenance:retire-demo-job-numbers";

export class DemoRetirementRefused extends Error {}
class DryRunRollback extends Error {}

export type RetirementOutcome = {
  organisationId: string; committed: boolean; correlationId: string;
  moved: Array<{ jobId: string; from: string; to: string }>;
  /** Frozen copies of a moved job's old number, which keep it. */
  frozenCopies: { trainingEntitlements: number };
  counterAt: number | null;
};

export async function retireDemoJobNumbers(
  pool: PoolLike,
  options: { organisationId: string; above: number; commit: boolean },
): Promise<RetirementOutcome> {
  const organisationId = options.organisationId.trim();
  if (organisationId === PROTECTED_ORGANISATION) {
    throw new DemoRetirementRefused(`${PROTECTED_ORGANISATION} holds real jobs and v7's imported numbers; it is never renumbered (decision 1a).`);
  }
  if (!Number.isInteger(options.above) || options.above < 1 || options.above > 999_000) {
    throw new DemoRetirementRefused(`--above must be v7's highest job number as an integer (764 from §9, or the dry run's "up to J…"); got ${options.above}.`);
  }
  const correlationId = `retire-demo-job-numbers-${randomUUID()}`;
  const outcome: RetirementOutcome = {
    organisationId, committed: options.commit, correlationId, moved: [], frozenCopies: { trainingEntitlements: 0 }, counterAt: null,
  };

  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      // Row-level security confines every read and write below to this organisation, and each statement names it too;
      // the guard above keeps it off
      // net-zero-international, and this checks the tenant really is the one named.
      const tenant = (await db.query<{ tenant: string }>(`SELECT current_setting('app.organisation_id', true) AS tenant`)).rows[0]!.tenant;
      if (tenant !== organisationId || tenant === PROTECTED_ORGANISATION) throw new DemoRetirementRefused(`the tenant is ${tenant}, not ${organisationId}`);

      const imported = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.jobs WHERE organisation_id=$1 AND source_system IS NOT NULL`, [organisationId])).rows[0]!.n;
      if (imported > 0) throw new DemoRetirementRefused(`${organisationId} holds ${imported} imported job(s): an organisation with imported history is not a demo, and its numbers are not retired.`);

      const clashing = (await db.query<{ job_id: string; sequence: number; job_number: string }>(
        `SELECT job_id, sequence, job_number FROM nzi_console.jobs WHERE organisation_id=$1 AND sequence <= $2 ORDER BY sequence FOR UPDATE`, [organisationId, options.above])).rows;
      if (clashing.length === 0) return;
      const highest = (await db.query<{ n: number }>(`SELECT coalesce(max(sequence), 0)::int AS n FROM nzi_console.jobs WHERE organisation_id=$1`, [organisationId])).rows[0]!.n;

      let next = Math.max(options.above, highest);
      for (const job of clashing) {
        next += 1;
        const moved = (await db.query<{ job_number: string }>(
          `UPDATE nzi_console.jobs SET sequence=$2, version=version+1, updated_at=now() WHERE organisation_id=$3 AND job_id=$1 RETURNING job_number`, [job.job_id, next, organisationId])).rows[0]!;
        await db.query(
          `INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,reason,before_json,after_json)
           VALUES ($1,$2,$3,'system','job.renumbered','job',$4,$5,$6,$7::jsonb,$8::jsonb)`,
          [organisationId, randomUUID(), RETIREMENT_ACTOR, job.job_id, correlationId,
            `Demo job number moved out of v7's range (J000001–J${String(options.above).padStart(6, "0")}) before the v7 load (decision 1a)`,
            JSON.stringify({ sequence: job.sequence, jobNumber: job.job_number }), JSON.stringify({ sequence: next, jobNumber: moved.job_number })]);
        outcome.moved.push({ jobId: job.job_id, from: job.job_number, to: moved.job_number });
      }
      outcome.frozenCopies.trainingEntitlements = (await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM nzi_console.training_entitlements WHERE source_job_number = ANY($1::text[])`,
        [clashing.map((job) => job.job_number)])).rows[0]!.n;

      // Catch the counter up to the moved numbers, so the next job is issued after them (0134; never ahead of one).
      outcome.counterAt = (await db.query<{ n: number }>(`SELECT nzi_console.advance_job_sequence_past_existing() AS n`)).rows[0]!.n;
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}
