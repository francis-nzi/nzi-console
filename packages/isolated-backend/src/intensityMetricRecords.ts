import type { Queryable } from "./postgres";
import { listClientSites } from "./siteBoundary";
import { resolveFloorAreaDenominator, type ClientSiteReadModel, type IntensityMetricDefinition, type IntensityMetricValue, type ReportingPeriod } from "@nzi/contracts";

/**
 * Reading the client's intensity metric definitions and the annual values recorded against
 * its jobs. Read-only and dependency-free, so the workspace read model can use it without a
 * cycle through the command modules.
 */

/** The current version of each metric this client has defined, active or not. */
export async function listClientIntensityMetrics(db: Queryable, clientId: string): Promise<IntensityMetricDefinition[]> {
  const { rows } = await db.query<{
    metric_key: string; version: number; label: string; unit_wording: string; divider: number;
    icon_key: string; is_standard: boolean; value_source: "entered" | "site-floor-area"; active: boolean; ordering: number;
  }>(`SELECT DISTINCT ON (metric_key) metric_key,version,label,unit_wording,divider,icon_key,is_standard,value_source,active,ordering
      FROM nzi_console.client_intensity_metrics WHERE client_id=$1
      ORDER BY metric_key, version DESC`, [clientId]);
  return rows.map((row) => ({
    key: row.metric_key, version: row.version, label: row.label, unitWording: row.unit_wording,
    divider: row.divider as IntensityMetricDefinition["divider"], iconKey: row.icon_key,
    isStandard: row.is_standard, valueSource: row.value_source, active: row.active, ordering: row.ordering,
  })).sort((a, b) => Number(b.isStandard) - Number(a.isStandard) || a.ordering - b.ordering);
}

/** Every annual value recorded on this client's jobs, by reporting year. */
export async function listClientIntensityValues(db: Queryable, clientId: string): Promise<IntensityMetricValue[]> {
  const { rows } = await db.query<{ metric_key: string; reporting_year: number; period_key: string; value: string | null; overrides_resolved: boolean; note: string; version: number }>(
    `SELECT v.metric_key,v.reporting_year,v.period_key,v.value::text,v.overrides_resolved,v.note,v.version
     FROM nzi_console.job_intensity_values v
     JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id)=(v.organisation_id,v.job_id)
     WHERE j.client_id=$1
     ORDER BY v.reporting_year DESC, v.metric_key`, [clientId]);
  return rows.map((row) => ({
    metricKey: row.metric_key, reportingYear: row.reporting_year, periodKey: row.period_key,
    value: row.value === null ? null : Number(row.value),
    overridesResolved: row.overrides_resolved, note: row.note, version: row.version,
  }));
}

/** The values recorded on one job, for the annual capture screen. */
export async function listJobIntensityValues(db: Queryable, jobId: string, reportingYear: number): Promise<IntensityMetricValue[]> {
  const { rows } = await db.query<{ metric_key: string; reporting_year: number; period_key: string; value: string | null; overrides_resolved: boolean; note: string; version: number }>(
    `SELECT metric_key,reporting_year,period_key,value::text,overrides_resolved,note,version
     FROM nzi_console.job_intensity_values WHERE job_id=$1 AND reporting_year=$2 ORDER BY metric_key`, [jobId, reportingYear]);
  return rows.map((row) => ({
    metricKey: row.metric_key, reportingYear: row.reporting_year, periodKey: row.period_key,
    value: row.value === null ? null : Number(row.value),
    overridesResolved: row.overrides_resolved, note: row.note, version: row.version,
  }));
}

/**
 * Everything the job's annual-metrics capture needs for one reporting year: the client's
 * metric set, what this job has recorded, what the platform resolves by itself, and the
 * assured total that is the numerator. Assembled here so the screen makes one call and
 * cannot assemble a different truth than the client workspace does.
 */
export type JobAnnualMetricsReadModel = {
  jobId: string;
  clientId: string;
  reportingYear: number;
  /** Null until this year has a reviewed snapshot — intensity is unavailable until then. */
  assuredTotalTco2e: number | null;
  metrics: IntensityMetricDefinition[];
  values: IntensityMetricValue[];
  /** What the platform resolves without being told — today, site floor area (NZC-071). */
  resolved: Record<string, { value: number | null; reason?: string }>;
};

export async function getJobAnnualMetrics(db: Queryable, jobId: string, reportingYear: number): Promise<JobAnnualMetricsReadModel | null> {
  const job = await db.query<{ client_id: string; reporting_from: Date | string | null; reporting_to: Date | string | null }>(
    `SELECT j.client_id, c.reporting_from, c.reporting_to
     FROM nzi_console.jobs j LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id,c.job_id)=(j.organisation_id,j.job_id)
     WHERE j.job_id=$1`, [jobId]);
  const row = job.rows[0];
  if (!row) return null;

  const [metrics, values, sites, snapshot] = await Promise.all([
    listClientIntensityMetrics(db, row.client_id),
    listJobIntensityValues(db, jobId, reportingYear),
    listClientSites(db, row.client_id),
    db.query<{ measurements: Array<{ tco2e: number | string }> | null }>(
      `SELECT (payload_json->'measurements') AS measurements FROM nzi_console.reviewed_crp_snapshots
       WHERE job_id=$1 AND (payload_json->>'reportingYear')::int=$2 ORDER BY snapshot_version DESC LIMIT 1`, [jobId, reportingYear]),
  ]);

  const measurements = snapshot.rows[0]?.measurements ?? null;
  const assuredTotalTco2e = measurements === null ? null : measurements.reduce((total, measurement) => total + Number(measurement.tco2e), 0);
  const period: ReportingPeriod | null = row.reporting_from && row.reporting_to
    ? { from: String(row.reporting_from).slice(0, 10), to: String(row.reporting_to).slice(0, 10) }
    : null;

  const resolved: JobAnnualMetricsReadModel["resolved"] = {};
  for (const definition of metrics) {
    if (definition.valueSource !== "site-floor-area") continue;
    const { value, reason } = denominatorFor({ definition, recorded: undefined, sites, period });
    resolved[definition.key] = reason === undefined ? { value } : { value, reason };
  }

  return { jobId, clientId: row.client_id, reportingYear, assuredTotalTco2e, metrics, values, resolved };
}

/**
 * The denominator for one metric in one reporting year.
 *
 * A recorded value always wins — including one that deliberately overrides what the
 * platform resolved. Otherwise a site-derived metric is summed from the client's in-service
 * sites for that period (NZC-071), which refuses a partial answer rather than
 * under-counting the boundary. Anything else is simply not recorded.
 */
export function denominatorFor(input: {
  definition: IntensityMetricDefinition;
  recorded: IntensityMetricValue | undefined;
  sites: readonly ClientSiteReadModel[];
  period: ReportingPeriod | null;
}): { value: number | null; source: "recorded" | "site-floor-area" | "none"; reason?: string } {
  const { definition, recorded, sites, period } = input;
  if (recorded && recorded.value !== null) return { value: recorded.value, source: "recorded" };
  if (definition.valueSource !== "site-floor-area") return { value: null, source: "none" };
  if (!period) return { value: null, source: "none", reason: "This year has no reporting period on record, so the in-service site boundary cannot be resolved." };
  const resolved = resolveFloorAreaDenominator(sites, period);
  if (resolved.state !== "resolved") return { value: null, source: "none", reason: resolved.reason };
  if (resolved.floorAreaM2 <= 0) return { value: null, source: "none", reason: "The in-service sites for this year sum to no floor area." };
  return { value: resolved.floorAreaM2, source: "site-floor-area" };
}
