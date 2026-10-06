import type { Queryable } from "./postgres";

/**
 * A CRP job's emission-factor datasets, chosen against its reporting window (NZC-070's boundary) — said once, for
 * job.create (the first choice), dataset.override.add (a manual choice's warnings) and job.update (a window that
 * moves, ruled J2). Automatic selections are derived state: every active GB or GLOBAL dataset **valid on the last day of
 * the window** — the reporting year's edition, the year the period ends (JW-13, ruled: "reporting year = end year", as
 * baselines and the reporting-year field already count it). Requiring an edition to cover the whole window chose nothing
 * for a period that straddles two calendar years — an April–March job — because every GB edition is a calendar year.
 * Manual selections are a person's choice, carrying the warnings that choice was made with.
 */

export type ReportingWindow = { from: string; to: string };

/** The automatic choice for a window, with each dataset's name — what job.create selects and job.update re-derives. */
export async function automaticDatasetsFor(db: Queryable, organisationId: string, window: ReportingWindow): Promise<Array<{ datasetId: string; name: string }>> {
  const { rows } = await db.query<{ dataset_id: string; name: string }>(
    `SELECT d.dataset_id, d.name FROM nzi_console.emission_factor_datasets d
      WHERE d.organisation_id=$1 AND d.status='active' AND d.valid_from<=$2 AND d.valid_to>=$2 AND d.country_code IN ('GB','GLOBAL')
      ORDER BY d.dataset_id`, [organisationId, window.to]);
  return rows.map((row) => ({ datasetId: row.dataset_id, name: row.name }));
}

/** Select the automatic datasets for a window. A dataset already selected (by hand) keeps its manual selection. */
export async function selectAutomaticDatasets(db: Queryable, organisationId: string, jobId: string, window: ReportingWindow, actorId: string): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
    SELECT $1,$2,d.dataset_id,'automatic','Matched the reporting year (the edition valid on the period''s last day) and geography.',$4 FROM nzi_console.emission_factor_datasets d
    WHERE d.organisation_id=$1 AND d.status='active' AND d.valid_from<=$3 AND d.valid_to>=$3 AND d.country_code IN ('GB','GLOBAL')
    ON CONFLICT DO NOTHING`,
    [organisationId, jobId, window.to, actorId]);
}

/**
 * Why a dataset may not suit a job: it does not cover the whole window, its geography differs, or it is not active.
 * All four dates are SQL `date` values compared as plain days — a day's shift on one side only would invent the
 * warning or hide it.
 */
export function datasetCoverageWarnings(dataset: { validFrom: string; validTo: string; country: string; status: string }, window: ReportingWindow, jobCountry: string): string[] {
  const warnings: string[] = [];
  if (dataset.validFrom > window.from || dataset.validTo < window.to) warnings.push("Dataset does not cover the complete reporting period.");
  if (dataset.country !== jobCountry && dataset.country !== "GLOBAL") warnings.push(`Dataset geography ${dataset.country} differs from job geography ${jobCountry}.`);
  if (dataset.status !== "active") warnings.push(`Dataset status is ${dataset.status}.`);
  return warnings;
}
