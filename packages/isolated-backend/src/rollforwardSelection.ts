import { dateOnly } from "./dates";
import type { Queryable } from "./postgres";

/**
 * Which job a rollforward draws from — two different questions, kept apart (NZC-101).
 *
 * The previews used to answer both with one query, and that is what made changing the selection
 * basis retroactive. They re-derived "the prior job" on every read and then reported the lineage of
 * whichever job that derivation happened to pick. Change the derivation and a completed job's
 * history appears to change with it: rows genuinely rolled forward from job X stop being listed at
 * all once the candidate becomes job Y, and the screen offers to roll the same work forward again
 * from a different year.
 *
 * ## The two questions
 *
 * **What did this job actually roll forward from?** Recorded, not derived. Every rolled-forward row
 * carries the id of the row it came from — `rolled_forward_from_source_id` (0039) for the spend
 * register, `rolled_forward_from_row_id` (0055) for canonical rows — and that resolves to its job.
 * Reading it back is exact, stable under any change of basis, and naturally handles a job that drew
 * from more than one prior job, which the commands permit: `scope.row.rollforward` takes a prior
 * job and a row subset per call, so two calls may name two different jobs.
 *
 * No new column and no backfill (NZC-092): the fact is already stored, once, on the rows
 * themselves. A `prior_job_id` beside it would be a second copy of a derivable fact, and lossy for
 * a job with two origins.
 *
 * **Which job should the next rollforward draw from?** Derived, and now by period rather than by
 * label (NZC-098): the job whose reporting period ends most recently *before* this job's period
 * starts. A reporting year is a label, and under the end-year rule an earlier period can carry a
 * larger number, so ordering by it picks the wrong neighbour for any client with an irregular
 * period. Ties break on `created_at` then `sequence`, so the choice is deterministic.
 *
 * Where either job records no period the selection falls back to the year, which is all a job
 * created before the period columns has.
 */

/** A prior job this job's rows actually came from, with how many came from it. */
export type RollforwardOrigin = {
  id: string;
  number: string;
  reportingYear: number | null;
  /** Rows in this job whose origin is that job. */
  rows: number;
};

type OriginRow = { job_id: string; job_number: string; reporting_year: number | null; rows: string };

/**
 * The prior jobs this job has rolled work forward from, most rows first.
 *
 * `kind` picks the mechanism: the spend register and the canonical scope rows record their origins
 * on different tables, and a job may have used both.
 */
export async function listRollforwardOrigins(
  db: Queryable,
  jobId: string,
  kind: "spend" | "scopeRow",
): Promise<RollforwardOrigin[]> {
  const sql = kind === "spend"
    ? `SELECT o.job_id, j.job_number, j.reporting_year, count(*)::text AS rows
         FROM nzi_console.job_emission_sources r
         JOIN nzi_console.job_emission_sources o
           ON (o.organisation_id, o.source_id) = (r.organisation_id, r.rolled_forward_from_source_id)
         JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (o.organisation_id, o.job_id)
        WHERE r.job_id = $1 AND r.rolled_forward_from_source_id IS NOT NULL
        GROUP BY o.job_id, j.job_number, j.reporting_year
        ORDER BY count(*) DESC, j.job_number`
    : `SELECT o.job_id, j.job_number, j.reporting_year, count(*)::text AS rows
         FROM nzi_console.job_scope_rows r
         JOIN nzi_console.job_scope_rows o
           ON (o.organisation_id, o.scope_row_id) = (r.organisation_id, r.rolled_forward_from_row_id)
         JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (o.organisation_id, o.job_id)
        WHERE r.job_id = $1 AND r.rolled_forward_from_row_id IS NOT NULL
        GROUP BY o.job_id, j.job_number, j.reporting_year
        ORDER BY count(*) DESC, j.job_number`;
  const { rows } = await db.query<OriginRow>(sql, [jobId]);
  return rows.map((row) => ({
    id: row.job_id, number: row.job_number, reportingYear: row.reporting_year, rows: Number(row.rows),
  }));
}

export type PriorJobCandidate = { id: string; number: string; reportingYear: number };

type TargetRow = {
  client_id: string; reporting_year: number | null; start_date: Date | string;
  period_from: Date | string | null; period_to: Date | string | null;
};

/** The job being rolled forward *into*, with the period the selection is measured against. */
export async function loadRollforwardTarget(db: Queryable, jobId: string): Promise<{
  clientId: string; year: number; periodStart: string | null;
} | null> {
  const { rows } = await db.query<TargetRow>(
    `SELECT j.client_id, j.reporting_year, j.start_date,
            coalesce(j.reporting_period_start, ec.reporting_from) AS period_from,
            coalesce(j.reporting_period_end,   ec.reporting_to)   AS period_to
       FROM nzi_console.jobs j
       LEFT JOIN nzi_console.job_emissions_config ec ON (ec.organisation_id, ec.job_id) = (j.organisation_id, j.job_id)
      WHERE j.job_id = $1 AND j.job_family = 'crp'`, [jobId]);
  const target = rows[0];
  if (!target) return null;
  return {
    clientId: target.client_id,
    year: target.reporting_year
      ?? Number(dateOnly(target.start_date).slice(0, 4)),
    periodStart: target.period_from ? dateOnly(target.period_from) : null,
  };
}

/**
 * The job the next rollforward should draw from: the one whose reporting period ends most recently
 * before this period starts, among jobs that have something to give.
 *
 * `hasRows` is the mechanism-specific existence test — a job with no enabled spend sources is not a
 * candidate for a spend rollforward however close its period is.
 */
export async function selectPriorJobByPeriod(
  db: Queryable,
  target: { clientId: string; year: number; periodStart: string | null },
  jobId: string,
  kind: "spend" | "scopeRow",
): Promise<PriorJobCandidate | null> {
  const hasRows = kind === "spend"
    ? `EXISTS(SELECT 1 FROM nzi_console.job_emission_sources s
               WHERE s.organisation_id=j.organisation_id AND s.job_id=j.job_id
                 AND s.source_type='spend' AND s.enabled=true)`
    : `EXISTS(SELECT 1 FROM nzi_console.job_scope_rows r
               WHERE r.organisation_id=j.organisation_id AND r.job_id=j.job_id AND r.enabled=true)`;

  // The candidate's own period end, falling back to its emissions-config window. A job that has a
  // period never reconstructs one (NZC-096); a job with neither is compared on its label instead.
  const periodEnd = `coalesce(j.reporting_period_end, ec.reporting_to)`;
  const label = `coalesce(j.reporting_year, extract(year from j.start_date)::int)`;

  const { rows } = await db.query<{ job_id: string; job_number: string; reporting_year: number }>(
    `SELECT j.job_id, j.job_number, ${label} AS reporting_year
       FROM nzi_console.jobs j
       LEFT JOIN nzi_console.job_emissions_config ec ON (ec.organisation_id, ec.job_id) = (j.organisation_id, j.job_id)
      WHERE j.client_id = $1 AND j.job_family = 'crp' AND j.job_id <> $2 AND ${hasRows}
        AND CASE
              WHEN $3::date IS NOT NULL AND ${periodEnd} IS NOT NULL THEN ${periodEnd} < $3::date
              ELSE ${label} < $4
            END
      ORDER BY CASE WHEN $3::date IS NOT NULL THEN ${periodEnd} END DESC NULLS LAST,
               ${label} DESC,
               j.created_at DESC,
               j.sequence DESC
      LIMIT 1`,
    [target.clientId, jobId, target.periodStart, target.year]);

  const row = rows[0];
  return row ? { id: row.job_id, number: row.job_number, reportingYear: row.reporting_year } : null;
}
