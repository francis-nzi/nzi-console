/**
 * Data entry D3 (R1): local-first currency. A spend line is recorded in its site's currency and priced by a spend factor in that same
 * currency — the country's own — so **emissions are local spend × the local factor, and no FX enters the carbon maths**. An FX rate
 * (per site, per job: the CRM's average for the reporting period) exists only to **express money in the client's currency** where a
 * total needs one. These are the pure rules for that, shared by the read and the console.
 */
import { currencySymbol } from "./currencyDirectory";
import { isCurrencyUnit } from "./entryBasis";

/** One job's rate for one site: 1 `fromCurrency` = `rate` `toCurrency`, the average over the reporting period. */
export type JobSiteFxRate = { siteId: string; fromCurrency: string; toCurrency: string; rate: number; version: number };

/** A site's currency, else the client's — what a spend line at that site is captured in (R1). */
export const siteCurrencyOf = (site: { currency?: string | null } | null | undefined, clientCurrency: string): string =>
  site?.currency?.trim() || clientCurrency;

/** What could not be expressed in the client's currency, and why: a currency at a site with no rate for this job. */
export type UnconvertedSpend = { currency: string; siteId: string | null; lines: number; amount: number };

/**
 * A set of spend lines' money, in the client's currency (R1): a line already in it counts as it is; a line in another currency counts
 * at its site's rate for the job. A line with no rate is **not** guessed at — it is reported as unconverted, by currency and site, so
 * the total says exactly what it covers. Lines not in a currency (activity entries) are not money and are ignored.
 */
export function spendInClientCurrency(
  lines: ReadonlyArray<{ unit: string | null; quantity: number | null; siteId: string | null }>,
  clientCurrency: string,
  rates: readonly JobSiteFxRate[],
): { currency: string; total: number; lines: number; converted: number; unconverted: UnconvertedSpend[] } {
  let total = 0, counted = 0, converted = 0;
  const missing = new Map<string, UnconvertedSpend>();
  for (const line of lines) {
    if (!isCurrencyUnit(line.unit) || line.quantity === null || !Number.isFinite(line.quantity)) continue;
    const currency = line.unit!.trim();
    if (currency === clientCurrency) { total += line.quantity; counted += 1; continue; }
    const rate = line.siteId ? rates.find((entry) => entry.siteId === line.siteId && entry.fromCurrency === currency && entry.toCurrency === clientCurrency) : undefined;
    if (rate) { total += line.quantity * rate.rate; counted += 1; converted += 1; continue; }
    const key = `${currency}|${line.siteId ?? ""}`;
    const held = missing.get(key) ?? { currency, siteId: line.siteId, lines: 0, amount: 0 };
    held.lines += 1; held.amount += line.quantity;
    missing.set(key, held);
  }
  return { currency: clientCurrency, total, lines: counted, converted, unconverted: [...missing.values()] };
}

/**
 * The spend value's label, following the currency it is in (R1): the spec's wording with its own "(£)" — or any trailing
 * parenthesis — replaced by the chosen currency's symbol. "Net value (£)" in EUR reads "Net value (€)".
 */
export function spendValueLabel(baseLabel: string, currency: string | null | undefined): string {
  const bare = baseLabel.replace(/\s*\([^)]*\)\s*$/, "");
  return currency ? `${bare} (${currencySymbol(currency)})` : bare;
}

export const FX_RATE_MAX = 1_000_000;
export const isFxRate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= FX_RATE_MAX;
