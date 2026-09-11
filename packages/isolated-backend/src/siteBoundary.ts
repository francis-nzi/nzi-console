import { resolveFloorAreaDenominator, resolveSiteBoundary, type ClientSiteReadModel, type IntensityTargetReadModel, type ReportingPeriod } from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { dateOnly, isoTimestamp } from "./dates";

type SiteRow = { site_id: string; name: string; is_registered_office: boolean; in_service_from: Date | string | null; vacated_effective: Date | string | null; version: number };
type FloorAreaRow = { site_id: string; effective_from: Date | string | null; floor_area_m2: string; recorded_by: string; recorded_at: Date | string };

/** A client's sites with their floor-area history — the one site read (NZC-070/071). */
export async function listClientSites(db: Queryable, clientId: string): Promise<ClientSiteReadModel[]> {
  const [sites, areas] = await Promise.all([
    db.query<SiteRow>(`SELECT site_id,name,is_registered_office,in_service_from,vacated_effective,version FROM nzi_console.client_sites WHERE client_id=$1 AND archived=false ORDER BY lower(name),site_id`, [clientId]),
    db.query<FloorAreaRow>(`SELECT a.site_id,a.effective_from,a.floor_area_m2::text AS floor_area_m2,a.recorded_by,a.recorded_at FROM nzi_console.client_site_floor_areas a JOIN nzi_console.client_sites s ON (s.organisation_id,s.site_id)=(a.organisation_id,a.site_id) WHERE s.client_id=$1 ORDER BY a.effective_from NULLS FIRST,a.recorded_at`, [clientId]),
  ]);
  return sites.rows.map((row) => ({
    id: row.site_id,
    name: row.name,
    isRegisteredOffice: row.is_registered_office,
    inServiceFrom: row.in_service_from === null ? null : dateOnly(row.in_service_from),
    vacatedEffective: row.vacated_effective === null ? null : dateOnly(row.vacated_effective),
    version: row.version,
    floorAreas: areas.rows.filter((area) => area.site_id === row.site_id).map((area) => ({
      effectiveFrom: area.effective_from === null ? null : dateOnly(area.effective_from),
      floorAreaM2: Number(area.floor_area_m2),
      recordedAt: isoTimestamp(area.recorded_at),
      recordedBy: area.recorded_by,
    })),
  }));
}

/**
 * The job's reporting period (NZC-070): `job_emissions_config.reporting_from/to`,
 * falling back to the job's own dates where no emissions config exists.
 */
export async function resolveJobReportingPeriod(db: Queryable, jobId: string): Promise<{ clientId: string; period: ReportingPeriod } | null> {
  const { rows } = await db.query<{ client_id: string; reporting_from: Date | string | null; reporting_to: Date | string | null; start_date: Date | string; due_date: Date | string }>(
    `SELECT j.client_id,c.reporting_from,c.reporting_to,j.start_date,j.due_date FROM nzi_console.jobs j LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id,c.job_id)=(j.organisation_id,j.job_id) WHERE j.job_id=$1`,
    [jobId],
  );
  const row = rows[0];
  if (!row) return null;
  return { clientId: row.client_id, period: { from: dateOnly(row.reporting_from ?? row.start_date), to: dateOnly(row.reporting_to ?? row.due_date) } };
}

export type JobSiteBoundary = { clientId: string; period: ReportingPeriod; sites: ClientSiteReadModel[]; inBoundaryIds: Set<string> };

/** The one boundary resolution for a job — every roll-up reads this, so none can disagree. */
export async function resolveJobSiteBoundary(db: Queryable, jobId: string): Promise<JobSiteBoundary | null> {
  const job = await resolveJobReportingPeriod(db, jobId);
  if (!job) return null;
  const sites = await listClientSites(db, job.clientId);
  return { ...job, sites, inBoundaryIds: new Set(resolveSiteBoundary(sites, job.period).map((site) => site.id)) };
}

/** Unallocated rows (no site) are in the boundary; a row at a site outside it is not. */
export const rowIsInBoundary = (siteId: string | null | undefined, boundary: Pick<JobSiteBoundary, "inBoundaryIds">): boolean =>
  siteId == null || boundary.inBoundaryIds.has(siteId);

/**
 * NZC-071 — an intensity target with its denominator resolved. The floor-area
 * metric is always derived from the in-boundary sites' floor area (null when any
 * is missing); turnover and headcount keep the typed value.
 */
export function withResolvedDenominator(target: IntensityTargetReadModel | null, boundary: Pick<JobSiteBoundary, "sites" | "period">): IntensityTargetReadModel | null {
  if (!target) return null;
  if (target.metric !== "floor-area") return { ...target, denominatorBasis: { kind: "typed" } };
  const resolved = resolveFloorAreaDenominator(boundary.sites, boundary.period);
  return resolved.state === "resolved"
    ? { ...target, reportingDenominator: resolved.floorAreaM2, denominatorBasis: { kind: "site-floor-area", state: "resolved", reason: null, sites: resolved.sites } }
    : { ...target, reportingDenominator: null, denominatorBasis: { kind: "site-floor-area", state: "unavailable", reason: resolved.reason, sites: resolved.sites } };
}
