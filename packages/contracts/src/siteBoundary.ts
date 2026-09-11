/**
 * NZC-070 / NZC-071 — effective-dated sites, the reporting boundary and the
 * per-m² denominator. Pure; the backend supplies the rows, this decides.
 *
 * Dates are ISO `YYYY-MM-DD` strings throughout, so string comparison is date
 * comparison.
 */

/** A job's reporting period — its financial year, inclusive at both ends. */
export type ReportingPeriod = { from: string; to: string };

/** One effective-dated floor-area record. `effectiveFrom` null = from the site's start. */
export type SiteFloorAreaRecord = { effectiveFrom: string | null; floorAreaM2: number; recordedAt: string; recordedBy: string };

export type ClientSiteReadModel = {
  id: string;
  name: string;
  isRegisteredOffice: boolean;
  /** null = in service from before records (open lower bound). */
  inServiceFrom: string | null;
  /** The first day OUT of service; null = not vacated. */
  vacatedEffective: string | null;
  version: number;
  floorAreas: SiteFloorAreaRecord[];
};

type BoundaryDates = Pick<ClientSiteReadModel, "inServiceFrom" | "vacatedEffective">;

/**
 * In the boundary when the site was in service on any day of the period:
 * `(in_service_from IS NULL OR in_service_from <= period_end) AND
 *  (vacated_effective IS NULL OR vacated_effective > period_start)`.
 * `vacated_effective` is the first day out, hence the strict `>`.
 */
export function siteIsInReportingBoundary(site: BoundaryDates, period: ReportingPeriod): boolean {
  return (site.inServiceFrom === null || site.inServiceFrom <= period.to)
    && (site.vacatedEffective === null || site.vacatedEffective > period.from);
}

export function resolveSiteBoundary<T extends BoundaryDates>(sites: readonly T[], period: ReportingPeriod): T[] {
  return sites.filter((site) => siteIsInReportingBoundary(site, period));
}

const pad = (value: number): string => String(value).padStart(2, "0");
const lastDayOfMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The period a new job labelled `labelYear` covers, for a client whose financial
 * year ends in `financialYearEndMonth` (1–12; null = December, the calendar year).
 * The label is the year the financial year starts: FY24 with a March year end is
 * 01/04/2024–31/03/2025.
 */
export function reportingPeriodForYear(labelYear: number, financialYearEndMonth: number | null): ReportingPeriod {
  const endMonth = financialYearEndMonth ?? 12;
  const endYear = endMonth === 12 ? labelYear : labelYear + 1;
  const startMonth = endMonth === 12 ? 1 : endMonth + 1;
  return {
    from: `${labelYear}-${pad(startMonth)}-01`,
    to: `${endYear}-${pad(endMonth)}-${pad(lastDayOfMonth(endYear, endMonth))}`,
  };
}

export type SiteLifecycleStatus =
  | { kind: "planned"; label: "Planned"; startsOn: string }
  | { kind: "in-service"; label: "In service"; vacatesOn: string | null }
  | { kind: "vacated"; label: "Vacated"; vacatedOn: string };

/** Status is derived from today against the dates — never stored. */
export function siteLifecycleStatus(site: BoundaryDates, today: string): SiteLifecycleStatus {
  if (site.vacatedEffective !== null && site.vacatedEffective <= today) return { kind: "vacated", label: "Vacated", vacatedOn: site.vacatedEffective };
  if (site.inServiceFrom !== null && site.inServiceFrom > today) return { kind: "planned", label: "Planned", startsOn: site.inServiceFrom };
  return { kind: "in-service", label: "In service", vacatesOn: site.vacatedEffective };
}

/** The floor-area record in force at the period end; null when none is. */
export function siteFloorAreaForPeriod(site: Pick<ClientSiteReadModel, "floorAreas">, period: ReportingPeriod): number | null {
  const inForce = site.floorAreas
    .filter((record) => record.effectiveFrom === null || record.effectiveFrom <= period.to)
    .sort((a, b) => (a.effectiveFrom ?? "").localeCompare(b.effectiveFrom ?? "") || a.recordedAt.localeCompare(b.recordedAt));
  return inForce[inForce.length - 1]?.floorAreaM2 ?? null;
}

export type FloorAreaDenominator =
  | { state: "resolved"; floorAreaM2: number; sites: Array<{ siteId: string; name: string; floorAreaM2: number }> }
  | { state: "unavailable"; reason: string; sites: Array<{ siteId: string; name: string; floorAreaM2: number | null }> };

/**
 * NZC-071 — the per-m² denominator: the sum of the in-boundary sites' floor area.
 * Unavailable — never a partial sum, never zero — when the boundary is empty or
 * any in-boundary site has no floor area in force.
 */
export function resolveFloorAreaDenominator(sites: readonly ClientSiteReadModel[], period: ReportingPeriod): FloorAreaDenominator {
  const inBoundary = resolveSiteBoundary(sites, period).map((site) => ({ siteId: site.id, name: site.name, floorAreaM2: siteFloorAreaForPeriod(site, period) }));
  if (inBoundary.length === 0) return { state: "unavailable", reason: "No sites are in the reporting boundary for this period.", sites: [] };
  const missing = inBoundary.filter((site) => site.floorAreaM2 === null);
  if (missing.length) {
    return { state: "unavailable", reason: `No floor area is recorded for ${missing.map((site) => site.name).join(", ")}.`, sites: inBoundary };
  }
  const resolved = inBoundary as Array<{ siteId: string; name: string; floorAreaM2: number }>;
  return { state: "resolved", floorAreaM2: resolved.reduce((sum, site) => sum + site.floorAreaM2, 0), sites: resolved };
}
