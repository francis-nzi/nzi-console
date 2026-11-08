/**
 * Employee commuting (3.7): per-site sample uplift (BRIEF-commuting-uplift-lean, ruled by Francis 8 Nov).
 *
 * Commuting is captured as a sample — one row per respondent — so a site where only some staff answered under-states its commute.
 * Uplift scales that site's sampled 3.7 figure up to its eligible workforce. It is an extrapolation on top of the real rows, never
 * invented rows, and it is derived: the rows keep their own figures; only the figure that locks is scaled.
 *
 * Per site: eligible = E − C (employees less wholly-company-car staff, whose commute is already Scope 1/2); R = the site's
 * commuting rows; default uplift headcount U = max(0, eligible − R) — the not-surveyed eligible staff, which the client agrees or
 * adjusts; scale f = (R + U) / R. Off by default, per site.
 */

export type SiteUpliftInput = {
  /** E — client-entered employees at the site (null: not yet entered). */
  employees: number | null;
  /** C — client-entered wholly-company-car staff at the site (null: not yet entered, read as none). */
  companyCarUsers: number | null;
  /** R — the site's commuting rows (respondents). */
  respondents: number;
  /** The per-site toggle. Default false. */
  enabled: boolean;
  /** The headcount the client agreed; null means "take the computed default". */
  agreedHeadcount: number | null;
};

export type SiteUpliftFlag = "respondents-exceed-eligible" | "uplift-above-unsurveyed";

export type SiteUplift = {
  employees: number | null;
  companyCarUsers: number;
  respondents: number;
  /** E − C, or null while E is not entered. */
  eligible: number | null;
  /** R / eligible, or null when it cannot be stated. */
  responseRate: number | null;
  /** max(0, eligible − R), or null while E is not entered. */
  defaultHeadcount: number | null;
  /** The headcount in force: the agreed one, else the default. Null when uplift is unavailable. */
  headcount: number | null;
  enabled: boolean;
  /** False when there is nothing to scale (R = 0) or no employees entered: the toggle is disabled with a note. */
  available: boolean;
  unavailableReason: "no-respondents" | "no-employees" | null;
  /** True only when the toggle is on and uplift is available. */
  applied: boolean;
  /** (R + U) / R when applied, else 1. 1 is an explicit no-op, not "absent": check `applied`. */
  factor: number;
  flags: SiteUpliftFlag[];
};

const wholeOrNull = (value: number | null): number | null => (value === null || !Number.isFinite(value) ? null : Math.max(0, Math.floor(value)));

export function computeSiteUplift(input: SiteUpliftInput): SiteUplift {
  const employees = wholeOrNull(input.employees);
  const companyCarUsers = wholeOrNull(input.companyCarUsers) ?? 0;
  const respondents = Math.max(0, Math.floor(input.respondents));
  const eligible = employees === null ? null : Math.max(0, employees - companyCarUsers);
  const flags: SiteUpliftFlag[] = [];
  const defaultHeadcount = eligible === null ? null : Math.max(0, eligible - respondents);
  if (eligible !== null && respondents > eligible) flags.push("respondents-exceed-eligible");
  const responseRate = eligible !== null && eligible > 0 ? respondents / eligible : null;
  const unavailableReason = respondents === 0 ? "no-respondents" as const : employees === null ? "no-employees" as const : null;
  const available = unavailableReason === null;
  const agreed = wholeOrNull(input.agreedHeadcount);
  const headcount = !available ? null : agreed ?? defaultHeadcount;
  if (available && agreed !== null && defaultHeadcount !== null && agreed > defaultHeadcount) flags.push("uplift-above-unsurveyed");
  const applied = input.enabled && available;
  const factor = applied && headcount !== null ? (respondents + headcount) / respondents : 1;
  return { employees, companyCarUsers, respondents, eligible, responseRate, defaultHeadcount, headcount, enabled: input.enabled, available, unavailableReason, applied, factor, flags };
}

export const upliftFlagText = (flag: SiteUpliftFlag): string =>
  flag === "respondents-exceed-eligible"
    ? "Respondents exceed eligible headcount — check employees / company-car count."
    : "The agreed uplift is above the number of staff not yet surveyed.";

/** A site's sampled figure scaled by its factor. Only a site whose uplift is applied is touched; a factor of exactly 1 returns the figure as is. */
export const upliftedFigure = (sampled: number, uplift: Pick<SiteUplift, "applied" | "factor">): number =>
  uplift.applied && uplift.factor !== 1 ? sampled * uplift.factor : sampled;

/** The one line the report's methodology statement carries when any site is uplifted. */
export const COMMUTING_UPLIFT_METHOD_LINE =
  "Employee commuting at some sites is extrapolated from a sample of respondents to the site's eligible workforce, in proportion; this assumes respondents are representative of the site.";

/** What a locked snapshot records per uplifted site, so the figure's extrapolation can be read back. */
export type CommutingUpliftProvenance = {
  siteId: string;
  siteLabel: string | null;
  employees: number;
  companyCarUsers: number;
  respondents: number;
  eligible: number;
  responseRate: number | null;
  headcount: number;
  factor: number;
  agreedBy: string | null;
  agreedAt: string | null;
};
