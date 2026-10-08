import type { Queryable } from "./postgres";
import { dateOnly } from "./dates";

/**
 * A client's assured series: one reviewed CRP snapshot per reporting **period**, the latest version of each (NZC-096,
 * NZC-098). The one selection the workspace's reporting chain and an issued report's pathway both read (RULING-reporting-RF,
 * RF-2), so the document and the screen cannot disagree about which assured total stands for a year — and a year frozen
 * twice is counted once.
 *
 * The period is the job's own recorded dates, else its emissions-config window; where neither exists the reporting-year
 * label separates the rows, which is all such a job has ever had. Rows come back with their periods; callers order and
 * filter chronologically. `excludeJobId` leaves one job out — the caller's own, whose snapshot it supplies itself.
 */
export type AssuredPeriodSnapshot = {
  snapshotId: string;
  dataHash: string;
  jobId: string;
  jobNumber: string;
  reportingYear: number;
  period: { from: string; to: string } | null;
  /** The frozen measurements' total, tCO₂e. */
  totalTco2e: number;
};

export async function listAssuredPeriodSnapshots(db: Queryable, clientId: string, options: { excludeJobId?: string } = {}): Promise<AssuredPeriodSnapshot[]> {
  const { rows } = await db.query<{
    snapshot_id: string; data_hash: string; job_id: string; job_number: string | null; reporting_year: number;
    period_from: Date | string | null; period_to: Date | string | null; measurements: Array<{ tco2e: number | string }> | null;
  }>(
    // One snapshot per reporting **period**, not per label (NZC-096). Two of a client's jobs can carry the same
    // reportingYear and mean different periods; DISTINCT ON the label kept one of them and dropped the other's assured
    // total out of the comparison silently. The SQL never excludes by label (NZC-098): under the end-year convention a job
    // whose period ends before another starts can carry a *larger* reporting year.
    `SELECT DISTINCT ON (coalesce(pj.reporting_period_start, ec.reporting_from, make_date((s.payload_json->>'reportingYear')::integer, 1, 1)),
                         coalesce(pj.reporting_period_end,   ec.reporting_to,   make_date((s.payload_json->>'reportingYear')::integer, 12, 31)))
       s.snapshot_id, s.data_hash, s.job_id, s.payload_json->>'jobNumber' AS job_number,
       (s.payload_json->>'reportingYear')::integer AS reporting_year,
       coalesce(pj.reporting_period_start, ec.reporting_from) AS period_from,
       coalesce(pj.reporting_period_end,   ec.reporting_to)   AS period_to,
       s.payload_json->'measurements' AS measurements
     FROM nzi_console.reviewed_crp_snapshots s
     JOIN nzi_console.jobs pj ON (pj.organisation_id, pj.job_id) = (s.organisation_id, s.job_id)
     LEFT JOIN nzi_console.job_emissions_config ec ON (ec.organisation_id, ec.job_id) = (pj.organisation_id, pj.job_id)
     WHERE pj.client_id = $1 AND pj.job_family = 'crp' AND pj.job_id IS DISTINCT FROM $2
     ORDER BY coalesce(pj.reporting_period_start, ec.reporting_from, make_date((s.payload_json->>'reportingYear')::integer, 1, 1)),
              coalesce(pj.reporting_period_end,   ec.reporting_to,   make_date((s.payload_json->>'reportingYear')::integer, 12, 31)),
              s.snapshot_version DESC`,
    [clientId, options.excludeJobId ?? null],
  );
  return rows.map((row) => ({
    snapshotId: row.snapshot_id, dataHash: row.data_hash, jobId: row.job_id, jobNumber: row.job_number ?? "",
    reportingYear: Number(row.reporting_year),
    period: row.period_from && row.period_to ? { from: dateOnly(row.period_from), to: dateOnly(row.period_to) } : null,
    totalTco2e: (row.measurements ?? []).reduce((total, measurement) => total + Number(measurement.tco2e), 0),
  }));
}
