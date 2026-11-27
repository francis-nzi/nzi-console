import type { Queryable } from "./postgres";
import { siteIncludedSql } from "./siteInclusionGuard";
import { countryCodeFor } from "./v7Countries";

/**
 * Datasets by period and site (DESIGN-datasets-by-period-and-site §1, ruled 25 Nov): which countries a CRP job's datasets
 * are chosen for, and how its window divides into calendar years.
 *
 * - **The job's country** is the client's registered country, as an ISO code (R4). The register holds it in words, so it
 *   is read through the import's own country matcher, with the four UK nations added. A country that is not recorded, or
 *   cannot be matched, is **GB, assumed and flagged** (D-D) — today's behaviour, now visible.
 * - **Each included site adds its own country** (R4). A site with no country counts as the job's country, and the job says
 *   how many (R3). A site is included unless its latest decision leaves it out (`siteIncludedSql`).
 * - **GB is in scope only where the UK is:** the job's country is GB, or an included site is. Otherwise DESNZ comes in as
 *   the **international default** for activity categories only (D-A) — never for electricity or spend.
 */

/** The UK's nations, and the clients who wrote one, are the UK. */
const UK_NATIONS: Readonly<Record<string, string>> = { scotland: "GB", wales: "GB", england: "GB", "northern ireland": "GB" };

/** The ISO code for a registered country in words or as a code; null when it is not recorded or not matched. */
export function registeredCountryCode(registered: string | null | undefined): string | null {
  const text = registered?.trim();
  if (!text) return null;
  const nation = UK_NATIONS[text.toLowerCase()];
  if (nation) return nation;
  const code = countryCodeFor(text);
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}

/** The fallback for a client whose country is not recorded or not matched (D-D). */
export const ASSUMED_COUNTRY = "GB";

export type ClientCountry = { code: string; assumed: boolean; registered: string | null };

/** The client's country for its jobs' datasets: its registered country, else GB assumed. */
export async function clientCountryOf(db: Queryable, organisationId: string, clientId: string): Promise<ClientCountry> {
  const registered = (await db.query<{ registered_country: string | null }>(
    `SELECT registered_country FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [organisationId, clientId])).rows[0]?.registered_country ?? null;
  const code = registeredCountryCode(registered);
  return code ? { code, assumed: false, registered } : { code: ASSUMED_COUNTRY, assumed: true, registered };
}

export type CountryScope = {
  /** The job's own country (its config's). */
  jobCountry: string;
  /** Every country a dataset may be chosen for: the job's, each included site's, deduplicated, the job's first. */
  countries: string[];
  /** GB is in scope: the job's country is GB, or an included site is in the UK. */
  ukInScope: boolean;
  /** Included sites with no country, counted as the job's (R3). */
  sitesWithoutCountry: number;
};

/** The countries a job's datasets are chosen for — its own, and each included site's (R3, R4). */
export async function jobCountryScope(db: Queryable, organisationId: string, jobId: string, jobCountry: string): Promise<CountryScope> {
  const { rows } = await db.query<{ country: string | null }>(
    `SELECT s.country FROM nzi_console.client_sites s JOIN nzi_console.jobs j ON (j.organisation_id, j.client_id) = (s.organisation_id, s.client_id)
      WHERE j.organisation_id = $1 AND j.job_id = $2 AND ${siteIncludedSql("j.job_id", "s.site_id")}`, [organisationId, jobId]);
  const countries = [jobCountry];
  let sitesWithoutCountry = 0;
  for (const row of rows) {
    if (!row.country) { sitesWithoutCountry += 1; continue; }
    if (!countries.includes(row.country)) countries.push(row.country);
  }
  return { jobCountry, countries, ukInScope: countries.includes("GB"), sitesWithoutCountry };
}

/** A site's country for pricing: its own, else the job's (R3). */
export const siteCountry = (site: string | null | undefined, jobCountry: string): string => site?.trim() || jobCountry;

export type YearPart = { year: number; from: string; to: string };

/** The calendar years a window touches, each with its part of the window (R1). A calendar-year window is one part. */
export function windowYearParts(window: { from: string; to: string }): YearPart[] {
  const first = Number(window.from.slice(0, 4));
  const last = Number(window.to.slice(0, 4));
  const parts: YearPart[] = [];
  for (let year = first; year <= last; year += 1) {
    const from = year === first ? window.from : `${year}-01-01`;
    const to = year === last ? window.to : `${year}-12-31`;
    parts.push({ year, from, to });
  }
  return parts;
}

/** The months a window covers, as `YYYY-MM`, in order. */
export function windowMonths(window: { from: string; to: string }): string[] {
  const months: string[] = [];
  let year = Number(window.from.slice(0, 4));
  let month = Number(window.from.slice(5, 7));
  const endYear = Number(window.to.slice(0, 4));
  const endMonth = Number(window.to.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
}

/**
 * D-A: whether a DESNZ factor may serve a non-UK country as the international default — activity only. Electricity (every
 * Scope 2 factor, and the UK grid's transmission, distribution and well-to-tank lines) and spend (`SPEND-SIC`) never do.
 */
export function internationalDefaultAllows(factor: { factorId: string; label: string; scopes: string[] }): boolean {
  if (/SPEND-/i.test(factor.factorId)) return false;
  return !isGridElectricity(factor);
}

/** Electricity in DESNZ's content: every Scope 2 factor, and the UK grid's transmission, distribution and well-to-tank lines. */
export function isGridElectricity(factor: { label: string; scopes: string[] }): boolean {
  if (factor.scopes.includes("2")) return true;
  return /^(UK electricity|Transmission and distribution|WTT- UK electricity|WTT- overseas electricity)/i.test(factor.label);
}

/**
 * UAE Activity & Spend (library L-5, ruled 27 Nov): V7's own UAE series, which is DESNZ content, so it carries the UK grid's
 * lines. How AE electricity is priced waits for Francis's ruling, and the filter is switchable until then:
 * `NZI_AE_GRID_ELECTRICITY=iea` keeps the series' electricity off AE rows (they take IEA AE); unset, or anything else, keeps
 * V7's own binding — today's behaviour, under which an imported Dubai row reproduces as V7 priced it.
 */
export const UAE_SERIES = "uk-ghg-ae";
export type AeGridElectricity = "iea" | "v7";
export const aeGridElectricity = (env: Readonly<Record<string, string | undefined>> = process.env): AeGridElectricity =>
  env.NZI_AE_GRID_ELECTRICITY?.trim().toLowerCase() === "iea" ? "iea" : "v7";

/** The label a DESNZ international-default selection carries in the job and the methodology (D-A, ruled). */
export const INTERNATIONAL_DEFAULT_LABEL = "DESNZ (international default: no national factor)";

/** The series DESNZ publishes in, and the only one the international default draws on. */
export const DESNZ_SERIES = "uk-ghg-gb";

/**
 * What the job says about its countries (D-D, R3, D-A): the client's country assumed, sites counted as the job's country,
 * and DESNZ standing in as the international default. Empty for a job with nothing to flag.
 */
export async function jobCountryNotes(db: Queryable, organisationId: string, jobId: string): Promise<string[]> {
  const job = (await db.query<{ client_id: string; country_code: string | null }>(
    `SELECT j.client_id, c.country_code FROM nzi_console.jobs j LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id, c.job_id) = (j.organisation_id, j.job_id)
      WHERE j.organisation_id = $1 AND j.job_id = $2`, [organisationId, jobId])).rows[0];
  if (!job?.country_code) return [];
  const notes: string[] = [];
  const client = await clientCountryOf(db, organisationId, job.client_id);
  if (client.assumed) notes.push(`The client's country isn't recorded${client.registered ? ` as a country ("${client.registered}")` : ""}: ${ASSUMED_COUNTRY} assumed.`);
  const scope = await jobCountryScope(db, organisationId, jobId, job.country_code);
  if (scope.sitesWithoutCountry > 0) notes.push(`${scope.sitesWithoutCountry} site${scope.sitesWithoutCountry === 1 ? " has" : "s have"} no country: counted as ${job.country_code}.`);
  const international = (await db.query(
    `SELECT 1 FROM nzi_console.job_dataset_selections WHERE organisation_id = $1 AND job_id = $2 AND starts_with(reason, $3) LIMIT 1`,
    [organisationId, jobId, INTERNATIONAL_DEFAULT_LABEL])).rows.length > 0;
  if (international) notes.push(`${INTERNATIONAL_DEFAULT_LABEL}: activity rows only; electricity and spend use the country's own factors.`);
  // Library L-3 (ruled 27 Nov): as in V7, there is no rest-of-world spend fallback. A country in scope with no spend series of its
  // own — no Cornerstone (`ceda-`), and no national Activity & Spend (`uk-ghg-`, the UK's and the UAE's) — is said, not priced.
  const { rows: noSpend } = await db.query<{ country: string }>(
    `SELECT c AS country FROM unnest($2::text[]) WITH ORDINALITY AS x(c, n) WHERE NOT EXISTS (SELECT 1 FROM nzi_console.emission_factor_datasets d
        WHERE d.organisation_id = $1 AND d.country_code = x.c AND d.status = 'active' AND (d.dataset_id LIKE 'ceda-%' OR d.dataset_id LIKE 'uk-ghg-%')) ORDER BY n`,
    [organisationId, scope.countries]);
  for (const { country } of noSpend) notes.push(`${NO_NATIONAL_SPEND_LABEL} for ${country}: spend rows there aren't priced.`);
  return notes;
}

/** What a job says about a country in scope that has no spend series of its own (library L-3). */
export const NO_NATIONAL_SPEND_LABEL = "No national spend factor";
