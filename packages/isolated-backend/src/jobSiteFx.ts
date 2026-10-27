// Data entry D3 (R1, R7): a job's FX rates — per site, the CRM's average rate for the reporting period, from the site's currency to
// the client's. Read only to express money in the client's currency (a spend total); never by the emissions calculation, which prices
// local spend with a factor in the same currency.
import { isCurrencyUnit, type CommandContext, type CommandInputMap, type JobSiteFxRate } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { CommandValidationError, requireCrpJob, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/** A site of the job's client as the FX panel lists it: its currency (its own, or the client's), and the job's rate if it needs one. */
export type JobSiteCurrency = { siteId: string; name: string; currency: string; ownCurrency: boolean; needsRate: boolean; rate: JobSiteFxRate | null };
export type JobCurrencies = { clientCurrency: string; sites: JobSiteCurrency[] };

type SiteRow = { site_id: string; name: string; currency: string | null; client_currency: string | null };
type RateRow = { site_id: string; from_currency: string; to_currency: string; rate: string; version: number };

/** The job's client's currency, its in-use sites with theirs, and the rates the job holds. */
export async function readJobCurrencies(db: Queryable, organisationId: string, jobId: string): Promise<JobCurrencies> {
  const { rows: sites } = await db.query<SiteRow>(
    `SELECT s.site_id, s.name, s.currency, c.currency AS client_currency
       FROM nzi_console.jobs j JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
       LEFT JOIN nzi_console.client_sites s ON (s.organisation_id, s.client_id) = (j.organisation_id, j.client_id) AND s.archived = false
      WHERE j.organisation_id = $1 AND j.job_id = $2 ORDER BY lower(s.name), s.site_id`, [organisationId, jobId]);
  const { rows: rates } = await db.query<RateRow>(
    `SELECT site_id, from_currency, to_currency, rate::text AS rate, version FROM nzi_console.job_site_fx_rates WHERE organisation_id = $1 AND job_id = $2`,
    [organisationId, jobId]);
  const clientCurrency = sites[0]?.client_currency?.trim() || "GBP";
  return {
    clientCurrency,
    sites: sites.filter((row) => row.site_id !== null).map((row) => {
      const currency = row.currency?.trim() || clientCurrency;
      const held = rates.find((rate) => rate.site_id === row.site_id && rate.from_currency === currency && rate.to_currency === clientCurrency);
      return {
        siteId: row.site_id, name: row.name, currency, ownCurrency: Boolean(row.currency), needsRate: currency !== clientCurrency,
        rate: held ? { siteId: held.site_id, fromCurrency: held.from_currency, toCurrency: held.to_currency, rate: Number(held.rate), version: held.version } : null,
      };
    }),
  };
}

export type JobSiteFxResult = { siteId: string; fromCurrency: string; toCurrency: string; rate: number; version: number };

/**
 * R1/R7: set a site's FX rate for a job — from the site's currency (as it stands now) to the client's. A site in the client's currency
 * needs none, and is refused one. Versioned per job and site; the currencies are recorded with the rate, so a later change of either
 * currency leaves an old rate unused (the read matches on both) rather than re-meant.
 */
export function setJobSiteFxRate(pool: PoolLike, input: CommandInputMap["job.site.fx.set"], context: CommandContext): Promise<StoredOutcome<JobSiteFxResult>> {
  return runPostgresCommand(pool, "job.site.fx.set", input, context, async (db) => {
    await requireCrpJob(db, context.organisationId, input.jobId);
    const { rows: [site] } = await db.query<{ currency: string | null; client_currency: string | null }>(
      `SELECT s.currency, c.currency AS client_currency
         FROM nzi_console.jobs j JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
         JOIN nzi_console.client_sites s ON (s.organisation_id, s.client_id) = (j.organisation_id, j.client_id)
        WHERE j.organisation_id = $1 AND j.job_id = $2 AND s.site_id = $3`, [context.organisationId, input.jobId, input.siteId]);
    if (!site) throw new CommandValidationError([{ field: "siteId", code: "NOT_FOUND", message: "That site is not one of this job's client's." }]);
    const to = site.client_currency?.trim() || "GBP";
    const from = site.currency?.trim() || to;
    if (!isCurrencyUnit(from) || !isCurrencyUnit(to)) throw new CommandValidationError([{ field: "siteId", code: "INVALID", message: "The site's or the client's currency is not an ISO code." }]);
    if (from === to) throw new CommandValidationError([{ field: "siteId", code: "NOT_NEEDED", message: `This site spends in ${to}, the client's currency — it needs no rate.` }]);
    const { rows: [current] } = await db.query<{ rate: string; version: number; from_currency: string; to_currency: string }>(
      `SELECT rate::text AS rate, version, from_currency, to_currency FROM nzi_console.job_site_fx_rates WHERE organisation_id = $1 AND job_id = $2 AND site_id = $3 FOR UPDATE`,
      [context.organisationId, input.jobId, input.siteId]);
    const expected = input.expectedVersion ?? null;
    if (current ? expected !== current.version : expected !== null) throw new VersionConflictError(expected ?? 0, current?.version ?? 0);
    if (current && Number(current.rate) === input.rate && current.from_currency === from && current.to_currency === to) {
      throw new CommandValidationError([{ field: "rate", code: "UNCHANGED", message: "That is the rate already held." }]);
    }
    const { rows: [saved] } = await db.query<{ version: number }>(
      `INSERT INTO nzi_console.job_site_fx_rates (organisation_id, job_id, site_id, from_currency, to_currency, rate, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (organisation_id, job_id, site_id) DO UPDATE SET from_currency = EXCLUDED.from_currency, to_currency = EXCLUDED.to_currency,
         rate = EXCLUDED.rate, version = job_site_fx_rates.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING version`,
      [context.organisationId, input.jobId, input.siteId, from, to, input.rate, context.actorId]);
    return {
      data: { siteId: input.siteId, fromCurrency: from, toCurrency: to, rate: input.rate, version: saved!.version },
      entityType: "job_site_fx_rate", entityId: `${input.jobId}:${input.siteId}`, topic: "job.site.fx.set",
      ...(current ? { before: { fromCurrency: current.from_currency, toCurrency: current.to_currency, rate: Number(current.rate) } } : {}),
    };
  });
}
