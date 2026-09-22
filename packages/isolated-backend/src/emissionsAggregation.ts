import { withTenantRead, type PoolLike } from "./postgres";

/**
 * The live emissions total, by scope and by category, as a derived read (NZC-143, NZC-144).
 *
 * This is the number at the top of the job page while somebody is entering data, and every running total
 * beside a scope band and a category title. One read answers all of them, so a tile and the band beneath
 * it cannot disagree.
 *
 * ## Derived, never stored
 *
 * The total is the sum of the rows' own resolved tCO2e, computed on every call. There is no maintained
 * total anywhere, deliberately: a stored figure would have to be updated by every path that can change a
 * row — edit, supersede, disable, roll forward, erase — and the first one that forgot would leave a
 * client's headline quietly wrong with nothing to compare it against. Recomputing is cheap and cannot
 * drift from the entries it describes.
 *
 * ## The location rule, and where it is enforced
 *
 * The headline is **location-based**. A market-based row contributes **0** to the headline, to its scope
 * band and to its category — and is still fully readable, carrying its own value so a surface can show it
 * in parentheses and tag it as not counted.
 *
 * Only an *explicit* `market` is excluded. A Scope 2 row with no method counts, which is the direction
 * 0109 chose on purpose: an unset method can only over-count the headline, never make a row disappear
 * from it.
 *
 * `show_in_report` is not consulted here at all. It governs presentation and, by 0109's constraint, can
 * only be false on a market row — which already contributes nothing. Letting it reach a total would be
 * giving a presentation toggle arithmetic consequences.
 *
 * ## What counts as an entry
 *
 * `enabled` rows only, matching what the page has always summed. Review status is deliberately *not* a
 * filter: a pending row is entered data, and a total that ignored it would read as progress not yet made
 * while somebody was looking straight at the row.
 */

export type EmissionsTotals = {
  /** The headline: location-based, market excluded. */
  tco2e: number;
  /** What the excluded market rows amount to, reported alongside and never added in. */
  marketTco2e: number;
  entries: number;
  /** Of those entries, how many are market-based — so a surface can label without a second read. */
  marketEntries: number;
};

export type EmissionsByScope = EmissionsTotals & { scope: string };
export type EmissionsByCategory = EmissionsTotals & { scope: string; categoryCode: string | null };
export type EmissionsBySite = EmissionsTotals & { siteId: string | null };

export type JobEmissions = {
  jobId: string;
  /** The site this was narrowed to, or null for all sites. */
  siteId: string | null;
  headline: EmissionsTotals;
  byScope: readonly EmissionsByScope[];
  byCategory: readonly EmissionsByCategory[];
  /** Always every site, unnarrowed, because the site tabs show their counts while one is selected. */
  bySite: readonly EmissionsBySite[];
};

/** Rows are numeric in Postgres and arrive as strings; a null sum is an empty set, which is zero. */
const asNumber = (value: string | null): number => (value === null ? 0 : Number(value));

/**
 * The shared shape of every tier.
 *
 * `market` here is the explicit-market test, spelled once so the headline, the bands and the titles cannot
 * disagree about what is excluded. An override beats a calculation, as everywhere else that reads a row's
 * emissions.
 */
const TOTALS = `
  COALESCE(SUM(CASE WHEN scope2_method = 'market' THEN 0
                    ELSE COALESCE(override_tco2e, calculated_tco2e, 0) END), 0)::text AS tco2e,
  COALESCE(SUM(CASE WHEN scope2_method = 'market'
                    THEN COALESCE(override_tco2e, calculated_tco2e, 0) ELSE 0 END), 0)::text AS market_tco2e,
  COUNT(*)::text AS entries,
  COUNT(*) FILTER (WHERE scope2_method = 'market')::text AS market_entries`;

type TotalsRow = { tco2e: string | null; market_tco2e: string | null; entries: string; market_entries: string };

const totalsOf = (row: TotalsRow | undefined): EmissionsTotals => ({
  tco2e: asNumber(row?.tco2e ?? null),
  marketTco2e: asNumber(row?.market_tco2e ?? null),
  entries: Number(row?.entries ?? 0),
  marketEntries: Number(row?.market_entries ?? 0),
});

/**
 * One job's emissions, optionally narrowed to one site.
 *
 * Tenant-scoped by `withTenantRead`, so the portal reading this reaches its own organisation's rows and
 * no others — the same confinement every other read on this surface has, rather than a filter this
 * function remembers to apply.
 */
export async function readJobEmissions(
  pool: PoolLike,
  input: { organisationId: string; jobId: string; siteId?: string | null },
): Promise<JobEmissions> {
  const siteId = input.siteId ?? null;

  return withTenantRead(pool, input.organisationId, async (db) => {
    // The site filter is applied to the three narrowed tiers and deliberately not to `bySite`: the site
    // tabs show every site's entry count while one of them is selected.
    const narrowed = siteId === null
      ? { clause: "", values: [input.organisationId, input.jobId] }
      : { clause: " AND site_id = $3", values: [input.organisationId, input.jobId, siteId] };

    const where = `WHERE organisation_id = $1 AND job_id = $2 AND enabled = true${narrowed.clause}`;

    const headline = await db.query<TotalsRow>(
      `SELECT ${TOTALS} FROM nzi_console.job_scope_rows ${where}`, narrowed.values);

    const byScope = await db.query<TotalsRow & { scope: string }>(
      `SELECT scope, ${TOTALS} FROM nzi_console.job_scope_rows ${where}
        GROUP BY scope ORDER BY scope`, narrowed.values);

    const byCategory = await db.query<TotalsRow & { scope: string; category_code: string | null }>(
      `SELECT scope, category_code, ${TOTALS} FROM nzi_console.job_scope_rows ${where}
        GROUP BY scope, category_code ORDER BY scope, category_code`, narrowed.values);

    const bySite = await db.query<TotalsRow & { site_id: string | null }>(
      `SELECT site_id, ${TOTALS} FROM nzi_console.job_scope_rows
        WHERE organisation_id = $1 AND job_id = $2 AND enabled = true
        GROUP BY site_id ORDER BY site_id NULLS FIRST`, [input.organisationId, input.jobId]);

    return {
      jobId: input.jobId,
      siteId,
      headline: totalsOf(headline.rows[0]),
      byScope: byScope.rows.map((row) => ({ scope: row.scope, ...totalsOf(row) })),
      byCategory: byCategory.rows.map((row) => ({
        scope: row.scope, categoryCode: row.category_code, ...totalsOf(row),
      })),
      bySite: bySite.rows.map((row) => ({ siteId: row.site_id, ...totalsOf(row) })),
    };
  });
}

/**
 * The headline's share per scope, for the split bar.
 *
 * Derived from the same read rather than recomputed from rows, so the bar cannot disagree with the tiles
 * above it. A zero headline yields zero shares rather than a division by zero — an empty job draws an
 * empty bar, which is the honest picture of it.
 */
export const scopeShares = (emissions: JobEmissions): ReadonlyArray<{ scope: string; share: number }> =>
  emissions.byScope.map((scope) => ({
    scope: scope.scope,
    share: emissions.headline.tco2e === 0 ? 0 : scope.tco2e / emissions.headline.tco2e,
  }));
