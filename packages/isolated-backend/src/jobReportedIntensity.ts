// Phase 3c (RULING-3c3-intensity-readers, 8 Oct 2026) — the one adapter every reader of a job's reported intensity goes
// through: the job page, the snapshot freeze, the assurance trend, the report sections editor. Before 3c each read the
// job's own row (`job_intensity_targets`, now read-only history); now the target is the client's (`client_intensity_targets`,
// 0158) and the year's Value is the job's (`job_intensity_values`, 0071).
import { intensityPer, REPORTED_INTENSITY_METRICS, reportedIntensityMetric, resolveFloorAreaDenominator, type IntensityTargetReadModel, type ReportingPeriod } from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { listClientIntensityTargets } from "./clientIntensityTargetRecords";
import { denominatorFor, listClientIntensityMetrics, listJobIntensityValues } from "./intensityMetricRecords";
import { listJobReportedSites, resolveJobReportingPeriod } from "./siteBoundary";


/**
 * The intensity a job's CRP reports, in the report's shape: the reported metric's client target, and this job's Value
 * for its reporting year — typed, or for a site-derived metric summed from the sites the job reports on (3a) — divided by
 * the metric's divider, so the report's "per £m" or "per 1,000 employees" is what the drawer shows. Null when no standard
 * metric has a target.
 */
export async function resolveJobReportedIntensity(db: Queryable, jobId: string): Promise<IntensityTargetReadModel | null> {
  const { rows: [job] } = await db.query<{ client_id: string; reporting_year: number | null; start_date: Date | string; currency: string }>(
    `SELECT j.client_id, j.reporting_year, j.start_date, cl.currency
       FROM nzi_console.jobs j JOIN nzi_console.clients cl ON (cl.organisation_id, cl.client_id) = (j.organisation_id, j.client_id)
      WHERE j.job_id = $1`, [jobId]);
  if (!job) return null;
  const [metrics, targets] = [await listClientIntensityMetrics(db, job.client_id), await listClientIntensityTargets(db, job.client_id)];
  // The one rule (contracts), shared with the drawer's "reported in the CRP".
  const definition = reportedIntensityMetric(metrics, targets);
  if (!definition) return null;
  const target = targets.find((entry) => entry.metricKey === definition.key)!;

  const reporting = await resolveJobReportingPeriod(db, jobId);
  const period: ReportingPeriod | null = reporting?.period ?? null;
  const year = job.reporting_year ?? new Date(job.start_date).getUTCFullYear();
  const recorded = (await listJobIntensityValues(db, jobId, year)).find((value) => value.metricKey === definition.key && value.periodKey === "year");
  const sites = await listJobReportedSites(db, job.client_id, jobId);
  const denominator = denominatorFor({ definition, recorded, sites, period });
  const divider = definition.divider || 1;

  let denominatorBasis: IntensityTargetReadModel["denominatorBasis"] = { kind: "typed" };
  if (definition.valueSource === "site-floor-area" && denominator.source !== "recorded") {
    const resolved = period ? resolveFloorAreaDenominator(sites, period) : null;
    denominatorBasis = { kind: "site-floor-area", state: denominator.value === null ? "unavailable" : "resolved",
      reason: denominator.value === null ? denominator.reason ?? "The floor area could not be resolved." : null, sites: resolved?.sites ?? [] };
  }

  return {
    jobId, source: "client-target", metric: REPORTED_INTENSITY_METRICS[definition.key]!, metricLabel: definition.label,
    // What one unit of intensity is per — "£m", "1,000 employees", "m²" — by the same rule the drawer and the client
    // analytics use, so the report's "tCO₂e / £m" is the drawer's; the Value is divided by the divider to match.
    denominatorUnit: intensityPer(definition, { currency: job.currency }),
    reportingDenominator: denominator.value === null ? null : denominator.value / divider,
    denominatorBasis,
    baselineYear: target.baselineYear, baselineIntensity: target.baselineIntensity,
    interimYear: target.interimYear, interimReductionPercent: target.interimReductionPct,
    targetYear: target.targetYear, targetReductionPercent: target.targetReductionPct,
    // A client intensity target has no net-zero year of its own; its end point is targetYear (addendum (i)).
    netZeroYear: null,
    version: target.version, updatedAt: target.setAt, updatedBy: target.setBy,
  };
}
