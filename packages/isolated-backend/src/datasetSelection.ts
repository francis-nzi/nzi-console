import { DATASET_EDITION_SUFFIX, datasetDisplayLabel, datasetPreferenceRank, datasetSeriesKey } from "@nzi/contracts";
import type { Queryable } from "./postgres";

/**
 * A CRP job's emission-factor datasets, chosen against its reporting window (NZC-070's boundary) — said once, for
 * job.create (the first choice), dataset.override.add (a manual choice's warnings) and job.update (a window that
 * moves, ruled J2). Automatic selections are derived state, chosen **per series** — one source family in one country,
 * published as yearly editions (`datasetSeriesKey`) — of the job's own country (GB) and GLOBAL:
 *
 * - the edition **valid on the last day of the window** — the reporting year's edition, the year the period ends (JW-13,
 *   ruled: "reporting year = end year"); requiring an edition to cover the whole window chose nothing for a period that
 *   straddles two calendar years;
 * - else, **the latest edition already published** in that series (the greatest `valid_to` among editions starting on or
 *   before the window's end) — editions lag publication (DESNZ publishes a year's factors in June), so a current or
 *   future reporting year uses the latest available until its own is published (DATASET-CURRENCY, ruled 6 Oct). A
 *   series never borrows another country's edition: GB falls back to GB, never to GLOBAL.
 *
 * Every series' pick is selected; DESNZ, the preferred UK source, is ordered first (`datasetPreferenceRank`). Manual
 * selections are a person's choice, carrying the warnings that choice was made with.
 */

export type ReportingWindow = { from: string; to: string };

/** The reason an automatic selection records — the reporting year's edition, or the latest available until it is published. */
export const ON_DAY_REASON = "Matched the reporting year (the edition valid on the period's last day) and geography.";
export const fallbackReason = (editionYear: number) =>
  `The reporting year's edition is not published yet; the latest available (${editionYear}) is used until it is.`;

/** Each series' pick for a window: the edition valid on its last day, else the latest already published. */
const SERIES_PICKS = `
  SELECT dataset_id, name, valid_to, on_day, country_code FROM (
    SELECT d.dataset_id, d.name, d.valid_to, d.country_code, d.valid_to >= $2::date AS on_day,
           row_number() OVER (PARTITION BY regexp_replace(d.dataset_id, '${DATASET_EDITION_SUFFIX}', ''), d.country_code
                              ORDER BY (d.valid_to >= $2::date) DESC, d.valid_from DESC, d.valid_to DESC, d.dataset_id) AS pick
      FROM nzi_console.emission_factor_datasets d
     WHERE d.organisation_id = $1 AND d.status = 'active' AND d.country_code IN ('GB', 'GLOBAL') AND d.valid_from <= $2::date) series
   WHERE pick = 1`;

export type AutomaticDataset = { datasetId: string; name: string; fallback: boolean; editionYear: number; countryCode: string };

/** The automatic choice for a window — what job.create selects and job.update re-derives — preferred source first. */
export async function automaticDatasetsFor(db: Queryable, organisationId: string, window: ReportingWindow): Promise<AutomaticDataset[]> {
  const { rows } = await db.query<{ dataset_id: string; name: string; valid_to: string; on_day: boolean; country_code: string }>(
    `SELECT dataset_id, name, valid_to::text AS valid_to, on_day, country_code FROM (${SERIES_PICKS}) picks ORDER BY dataset_id`, [organisationId, window.to]);
  return rows.map((row) => ({ datasetId: row.dataset_id, name: row.name, fallback: !row.on_day, editionYear: Number(row.valid_to.slice(0, 4)), countryCode: row.country_code }))
    .sort((a, b) => datasetPreferenceRank(a.datasetId, "GB") - datasetPreferenceRank(b.datasetId, "GB") || a.datasetId.localeCompare(b.datasetId));
}

/** Select the automatic datasets for a window. A dataset already selected (by hand) keeps its manual selection. */
export async function selectAutomaticDatasets(db: Queryable, organisationId: string, jobId: string, window: ReportingWindow, actorId: string): Promise<void> {
  for (const pick of await automaticDatasetsFor(db, organisationId, window)) {
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,$2,$3,'automatic',$4,$5) ON CONFLICT DO NOTHING`,
      [organisationId, jobId, pick.datasetId, pick.fallback ? fallbackReason(pick.editionYear) : ON_DAY_REASON, actorId]);
  }
}

/**
 * DATASET-CURRENCY §3 (ruled 6 Oct): the newer editions a job could move to. For each of the job's **automatic** selections
 * that is a **fallback** — its edition ends before the job's window does — and whose series (the id without its edition
 * tail, in the same country) now has an edition the rule would pick **on the window's last day**, one update: from → to.
 * Read at call time from the same series picks as `automaticDatasetsFor`, so the banner never offers an edition the rule
 * would not choose. No stored marker: a fallback is the edition's validity against the window.
 */
export type DatasetUpdate = { seriesKey: string; countryCode: string; fromDatasetId: string; toDatasetId: string; fromLabel: string; toLabel: string };
export async function jobDatasetUpdates(db: Queryable, organisationId: string, jobId: string): Promise<DatasetUpdate[]> {
  const config = (await db.query<{ reporting_from: string; reporting_to: string }>(
    `SELECT reporting_from::text AS reporting_from, reporting_to::text AS reporting_to FROM nzi_console.job_emissions_config WHERE organisation_id = $1 AND job_id = $2`,
    [organisationId, jobId])).rows[0];
  if (!config) return [];
  const selected = (await db.query<{ dataset_id: string; country_code: string; valid_from: string; valid_to: string; source_name: string }>(
    `SELECT d.dataset_id, d.country_code, d.valid_from::text AS valid_from, d.valid_to::text AS valid_to, d.source_name
       FROM nzi_console.job_dataset_selections s JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (s.organisation_id, s.dataset_id)
      WHERE s.organisation_id = $1 AND s.job_id = $2 AND s.selection_source = 'automatic' AND d.valid_to < $3::date`,
    [organisationId, jobId, config.reporting_to])).rows;
  if (selected.length === 0) return [];
  const onDay = (await automaticDatasetsFor(db, organisationId, { from: config.reporting_from, to: config.reporting_to })).filter((pick) => !pick.fallback);
  const updates: DatasetUpdate[] = [];
  for (const from of selected) {
    const seriesKey = datasetSeriesKey(from.dataset_id);
    const to = onDay.find((pick) => pick.countryCode === from.country_code && datasetSeriesKey(pick.datasetId) === seriesKey && pick.datasetId !== from.dataset_id);
    if (!to) continue;
    const target = (await db.query<{ valid_from: string; valid_to: string; source_name: string }>(
      `SELECT valid_from::text AS valid_from, valid_to::text AS valid_to, source_name FROM nzi_console.emission_factor_datasets WHERE organisation_id = $1 AND dataset_id = $2`,
      [organisationId, to.datasetId])).rows[0]!;
    updates.push({ seriesKey, countryCode: from.country_code, fromDatasetId: from.dataset_id, toDatasetId: to.datasetId,
      fromLabel: datasetDisplayLabel({ datasetId: from.dataset_id, countryCode: from.country_code, validFrom: from.valid_from, validTo: from.valid_to, sourceName: from.source_name }),
      toLabel: datasetDisplayLabel({ datasetId: to.datasetId, countryCode: to.countryCode, validFrom: target.valid_from, validTo: target.valid_to, sourceName: target.source_name }) });
  }
  return updates.sort((a, b) => datasetPreferenceRank(a.fromDatasetId, a.countryCode) - datasetPreferenceRank(b.fromDatasetId, b.countryCode) || a.toLabel.localeCompare(b.toLabel));
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
