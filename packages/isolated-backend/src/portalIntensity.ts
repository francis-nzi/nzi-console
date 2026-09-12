import { reportingPeriodForYear, type IntensityMetricDefinition, type ReportingPeriod } from "@nzi/contracts";
import { listClientIntensityMetrics, listClientIntensityValues } from "./intensityMetricRecords";
import { getPortalAssuredDashboard } from "./portalAnalytics";
import type { Queryable } from "./postgres";
import { listGrantedPortalJobs, resolveYearDenominators, type ClientYearDenominator } from "./readModels";
import { listClientSites } from "./siteBoundary";

/**
 * The client portal's intensity read model — READ-ONLY.
 *
 * Same rules as the rest of the portal realm (§0): every figure is sourced from a
 * PUBLISHED report snapshot, or a frozen prior-year snapshot in that report's reporting
 * chain — never from live/draft scope rows. It composes the portal's own
 * `getPortalAssuredDashboard`, so the portal's intensity numerator is the *same* assured
 * total the portal dashboard and the report already show.
 *
 * Tenancy: nothing here is addressable from the request. `portalUserId` and `clientId`
 * both come from the verified portal session, and the years on offer are limited to jobs
 * with a live `portal_access_grants` row for that user and client (`listGrantedPortalJobs`
 * → `getPortalAssuredDashboard` → `getGrantedPublishedCrpReport`, which re-checks the
 * grant). The caller wraps this in `withTenantRead(pool, organisationId, …)`.
 *
 * The intensity itself is NOT computed here: this returns the assured total and the
 * denominator per metric per year, and `resolveIntensity` in `@nzi/contracts` turns them
 * into an intensity — one computation for the console, the portal and the report.
 */

export type PortalIntensityYear = {
  year: number;
  /** The assured total for the year — the numerator. Never null: an unresolved year is omitted. */
  totalTco2e: number;
  /** `published` = this year's own published report; `prior` = a frozen earlier year in its chain. */
  basis: "published" | "prior";
  /** One denominator per metric the client has defined. A metric with nothing recorded says so. */
  denominators: Record<string, ClientYearDenominator>;
};

export type PortalIntensityReadModel = {
  clientName: string | null;
  /** The latest published reporting year, or null when nothing is published to this user. */
  reportingYear: number | null;
  /** Evidence identity of the latest published report the figures rest on. */
  publishedAt: string | null;
  dataHash: string | null;
  /** Every metric this client has defined, active or not — the page shows the active set. */
  metrics: IntensityMetricDefinition[];
  /** Assured years, oldest first. Empty = nothing assured yet, which the page says plainly. */
  years: PortalIntensityYear[];
};

type ClientRow = { name: string; financial_year_end_month: number | null };
type PeriodRow = { reporting_year: number | null; reporting_from: Date | string | null; reporting_to: Date | string | null };

const dateOnly = (value: Date | string) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);

export async function getPortalClientIntensity(
  db: Queryable,
  input: { portalUserId: string; clientId: string },
): Promise<PortalIntensityReadModel> {
  const [clientRows, metrics, values, sites, grantedJobs, periodRows] = await Promise.all([
    db.query<ClientRow>(`SELECT name,financial_year_end_month FROM nzi_console.clients WHERE client_id=$1`, [input.clientId]),
    listClientIntensityMetrics(db, input.clientId),
    listClientIntensityValues(db, input.clientId),
    listClientSites(db, input.clientId),
    listGrantedPortalJobs(db, input),
    // The reporting period of each GRANTED job, so a site-derived denominator resolves on
    // the same boundary the console uses. Grant-joined: a job this user cannot see cannot
    // contribute a period.
    db.query<PeriodRow>(
      `SELECT j.reporting_year,c.reporting_from,c.reporting_to
       FROM nzi_console.portal_access_grants g
       JOIN nzi_console.jobs j ON (j.organisation_id,j.job_id,j.client_id)=(g.organisation_id,g.job_id,g.client_id)
       LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id,c.job_id)=(j.organisation_id,j.job_id)
       WHERE g.portal_user_id=$1 AND g.client_id=$2 AND g.revoked_at IS NULL`,
      [input.portalUserId, input.clientId],
    ),
  ]);

  const client = clientRows.rows[0] ?? null;
  const base: PortalIntensityReadModel = {
    clientName: client?.name ?? null, reportingYear: null, publishedAt: null, dataHash: null, metrics, years: [],
  };

  const published = grantedJobs.filter((job) => job.hasPublishedReport);
  if (published.length === 0) return base;

  const dashboards = (await Promise.all(
    published.map((job) => getPortalAssuredDashboard(db, { ...input, jobId: job.id })),
  )).filter((dashboard): dashboard is Extract<typeof dashboard, { published: true }> => dashboard.published);
  if (dashboards.length === 0) return base;

  // The latest published year is the page's headline, and the evidence the figures rest on.
  const latest = dashboards.reduce((newest, dashboard) => dashboard.reportingYear > newest.reportingYear ? dashboard : newest);

  // One entry per year. A year published to this user wins over the same year read from
  // another job's chain; a year with no assured total is left out rather than shown as 0.
  const totals = new Map<number, { total: number; basis: "published" | "prior" }>();
  for (const dashboard of dashboards) {
    for (const entry of dashboard.trend) {
      if (entry.total === null) continue;
      const basis = entry.kind === "current" ? "published" as const : "prior" as const;
      const held = totals.get(entry.year);
      if (held && (held.basis === "published" || basis === "prior")) continue;
      totals.set(entry.year, { total: entry.total, basis });
    }
  }

  const periods = new Map<number, ReportingPeriod>();
  for (const row of periodRows.rows) {
    if (row.reporting_year === null || row.reporting_from === null || row.reporting_to === null) continue;
    periods.set(row.reporting_year, { from: dateOnly(row.reporting_from), to: dateOnly(row.reporting_to) });
  }

  const years: PortalIntensityYear[] = [...totals.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, { total, basis }]) => ({
      year, totalTco2e: total, basis,
      denominators: resolveYearDenominators({
        definitions: metrics, values, reportingYear: year, sites,
        // What the job recorded, else the period the client's financial year end implies
        // for that year (NZC-067) — the same fallback the client workspace uses.
        period: periods.get(year)
          ?? (client?.financial_year_end_month ? reportingPeriodForYear(year, client.financial_year_end_month) : null),
      }),
    }));

  return {
    clientName: client?.name ?? null,
    reportingYear: latest.reportingYear,
    publishedAt: latest.publishedAt,
    dataHash: latest.dataHash,
    metrics,
    years,
  };
}
