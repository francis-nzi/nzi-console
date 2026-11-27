import { DATASET_EDITION_SUFFIX, datasetLabelFromId, datasetSeriesKey, monthsBetween } from "@nzi/contracts";
import { DESNZ_SERIES, internationalDefaultAllows, siteCountry, windowMonths, windowYearParts } from "./datasetScope";
import type { Queryable } from "./postgres";

/**
 * Monthly pricing (DESIGN-datasets-by-period-and-site §2, ruled 25 Nov) — where in the one row calculation a row is priced
 * per month, and from which edition.
 *
 * - **A calendar-year window is priced exactly as before:** one product, `quantity × kgCO₂e ÷ 1000 × apply%`, on the
 *   row's own edition (§3: single-year jobs are unchanged by construction). Only a window touching two or more calendar
 *   years can span editions.
 * - **The months of a row** are its monthly activity where any month has a quantity. Otherwise the row is annual-only:
 *   a console-native row is **split equally over the window's months** (R1, D-B); a row imported from the previous
 *   system keeps **its one price at its own edition**, as the previous system prices it (D-B), and says so.
 * - **Each month's edition** is the row's own where that edition is valid on the month's first day; else the job's
 *   selected edition of the same series (and country) valid then; else the job's latest selected edition published by
 *   the end of that year's part of the window (the fallback, as selection has it); else the row's own.
 * - **The factor in that edition is the row's own factor id** (ids are stable across editions). Where the edition lacks
 *   it, or its unit or scope no longer fits, the month is **priced at the nearest edition that has it, and flagged** (D-C).
 * - **Row tCO₂e = Σ months (q × kgCO₂e) ÷ 1000 × apply%**. Where every month falls in the row's own edition, the row is
 *   priced as one product over its quantity — today's arithmetic, so a single span never moves in its last digit.
 */

export type PricingBasis = "monthly" | "annual-split" | "annual" | "previous-system";

export type PricingSpan = {
  /** First and last month of the run, `YYYY-MM`. */
  from: string; to: string; months: number;
  datasetId: string; factorVersion: string; kgCo2ePerUnit: string;
  /** D-C: the edition this run should have been priced from, which lacks the factor; null when it was. */
  substitutedFor: string | null;
  substitutedWhy: string | null;
  /** A client factor's run (0240): the calendar year whose value prices it. Absent on a dataset span. */
  factorYear?: number;
};

export type RowPricing = {
  /** `single`: one product over the row's quantity, on its own edition (today's arithmetic). */
  kind: "single" | "spans";
  basis: PricingBasis;
  spans: PricingSpan[];
  /** For `spans`: each month's quantity (null = the row's quantity ÷ `splitOver`, the annual split) and its kgCO₂e per unit. */
  monthQuantities: Array<string | null>;
  monthKg: string[];
  splitOver: number;
  /** The previous system's basis in its own words, where it is not the dataset one (a client factor's, D-1). */
  basisDetail?: string;
};

type Edition = { datasetId: string; validFrom: string; validTo: string; version: string; selected: boolean;
  factor: { kg: string; unit: string; scopes: string[]; active: boolean } | null };

export type PricedRow = {
  rowId: string; jobId: string; scope: string; unit: string; datasetId: string; factorId: string;
  /** Imported from the previous system: its annual-only figure keeps the previous system's basis (D-B). */
  imported: boolean;
};

const monthDay = (month: string) => `${month}-01`;
const yearOf = (date: string) => Number(date.slice(0, 4));

/** Plan a dataset-sourced row's pricing against its job's window and selected editions. */
export async function planRowPricing(db: Queryable, organisationId: string, row: PricedRow, anchor: { version: string; kg: string }): Promise<RowPricing> {
  const config = (await db.query<{ from: string; to: string }>(
    `SELECT reporting_from::text AS from, reporting_to::text AS to FROM nzi_console.job_emissions_config WHERE organisation_id = $1 AND job_id = $2`,
    [organisationId, row.jobId])).rows[0];
  const monthEntries = (await db.query<{ month: string; quantity: string | null }>(
    `SELECT m->>'month' AS month, m->>'quantity' AS quantity FROM nzi_console.job_scope_rows r, jsonb_array_elements(r.monthly_activity_json) m
      WHERE r.organisation_id = $1 AND r.scope_row_id = $2`, [organisationId, row.rowId])).rows.filter((entry) => entry.quantity !== null);
  const hasMonths = monthEntries.length > 0;
  const own = (months: string[], basis: PricingBasis): RowPricing => ({
    kind: "single", basis, monthQuantities: [], monthKg: [], splitOver: 0,
    spans: months.length ? [{ from: months[0]!, to: months[months.length - 1]!, months: months.length, datasetId: row.datasetId, factorVersion: anchor.version, kgCo2ePerUnit: anchor.kg, substitutedFor: null, substitutedWhy: null }] : [],
  });
  if (!config) return own([], hasMonths ? "monthly" : "annual");
  const window = { from: config.from, to: config.to };
  const allMonths = windowMonths(window);
  // §3: a calendar-year window is priced exactly as before.
  if (windowYearParts(window).length < 2) return own(hasMonths ? monthEntries.map((entry) => entry.month) : allMonths, hasMonths ? "monthly" : "annual");
  // D-B: an imported annual-only row keeps the previous system's one price at its own edition.
  if (!hasMonths && row.imported) return own(allMonths, "previous-system");
  const basis: PricingBasis = hasMonths ? "monthly" : "annual-split";
  const months = hasMonths ? monthEntries : allMonths.map((month) => ({ month, quantity: null as string | null }));

  const editions = await seriesEditions(db, organisationId, row);
  const anchorEdition = editions.find((edition) => edition.datasetId === row.datasetId);
  if (!anchorEdition) return own(months.map((entry) => entry.month), basis);
  const top = row.scope.split(".")[0]!;
  const fits = (edition: Edition) => edition.factor !== null && edition.factor.active && edition.factor.scopes.includes(top)
    && edition.factor.unit.trim().toLowerCase() === row.unit.trim().toLowerCase();
  const validOn = (edition: Edition, day: string) => edition.validFrom <= day && edition.validTo >= day;
  const selected = editions.filter((edition) => edition.selected);
  const partEnd = (year: number) => (year === yearOf(window.to) ? window.to : `${year}-12-31`);

  /** The edition the month should be priced from (above), before D-C. */
  const intended = (month: string): Edition => {
    const day = monthDay(month);
    if (validOn(anchorEdition, day)) return anchorEdition;
    const valid = selected.filter((edition) => validOn(edition, day)).sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
    if (valid) return valid;
    const end = partEnd(yearOf(day));
    const fallback = selected.filter((edition) => edition.validFrom <= end).sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
    return fallback ?? anchorEdition;
  };
  /** D-C: the nearest edition of the series that has the factor as the row needs it; the row's own breaks a tie. */
  const nearest = (wanted: Edition): Edition => editions.filter(fits)
    .sort((a, b) => Math.abs(yearOf(a.validFrom) - yearOf(wanted.validFrom)) - Math.abs(yearOf(b.validFrom) - yearOf(wanted.validFrom))
      || Number(b.datasetId === row.datasetId) - Number(a.datasetId === row.datasetId) || a.validFrom.localeCompare(b.validFrom))[0] ?? anchorEdition;

  const priced = months.map((entry) => {
    const wanted = intended(entry.month);
    if (fits(wanted)) return { entry, edition: wanted, substitutedFor: null as string | null, why: null as string | null };
    const why = wanted.factor === null || !wanted.factor.active ? "not in" : !wanted.factor.scopes.includes(top) ? "not for this scope in" : "unit changed in";
    return { entry, edition: nearest(wanted), substitutedFor: wanted.datasetId, why };
  });
  if (priced.every((month) => month.edition.datasetId === row.datasetId && month.substitutedFor === null)) return own(months.map((entry) => entry.month), basis);

  const spans: PricingSpan[] = [];
  for (const month of priced) {
    const last = spans[spans.length - 1];
    if (last && last.datasetId === month.edition.datasetId && last.substitutedFor === month.substitutedFor) { last.to = month.entry.month; last.months += 1; continue; }
    spans.push({ from: month.entry.month, to: month.entry.month, months: 1, datasetId: month.edition.datasetId, factorVersion: month.edition.version,
      kgCo2ePerUnit: month.edition.factor!.kg, substitutedFor: month.substitutedFor, substitutedWhy: month.why });
  }
  return { kind: "spans", basis, spans, monthQuantities: priced.map((month) => month.entry.quantity), monthKg: priced.map((month) => month.edition.factor!.kg), splitOver: allMonths.length };
}

/** Every active edition of the row's series in the same country, with the row's factor in each and whether the job selects it. */
async function seriesEditions(db: Queryable, organisationId: string, row: PricedRow): Promise<Edition[]> {
  const { rows } = await db.query<{ dataset_id: string; valid_from: string; valid_to: string; version: string; selected: boolean; kg: string | null; unit: string | null; scopes: string[] | null; active: boolean | null }>(
    `SELECT d.dataset_id, d.valid_from::text AS valid_from, d.valid_to::text AS valid_to, d.version, s.dataset_id IS NOT NULL AS selected,
            f.kgco2e_per_unit::text AS kg, f.activity_unit AS unit, f.scopes, f.active
       FROM nzi_console.emission_factor_datasets d
       JOIN nzi_console.emission_factor_datasets a ON a.organisation_id = d.organisation_id AND a.dataset_id = $2
       LEFT JOIN nzi_console.job_dataset_selections s ON (s.organisation_id, s.job_id, s.dataset_id) = (d.organisation_id, $3, d.dataset_id)
       LEFT JOIN nzi_console.emission_factors_display f ON (f.organisation_id, f.dataset_id, f.factor_id) = (d.organisation_id, d.dataset_id, $4)
      WHERE d.organisation_id = $1 AND d.country_code = a.country_code AND (d.status = 'active' OR d.dataset_id = $2)
        AND regexp_replace(d.dataset_id, '${DATASET_EDITION_SUFFIX}', '') = $5
      ORDER BY d.valid_from, d.dataset_id`,
    [organisationId, row.datasetId, row.jobId, row.factorId, datasetSeriesKey(row.datasetId)]);
  return rows.map((edition) => ({ datasetId: edition.dataset_id, validFrom: edition.valid_from, validTo: edition.valid_to, version: edition.version, selected: edition.selected,
    factor: edition.kg === null ? null : { kg: edition.kg, unit: edition.unit ?? "", scopes: edition.scopes ?? [], active: edition.active === true } }));
}

// ── A client factor's year values (0240; PLAN-v7-client-custom-factors §5, D-1) ─────────────────────────────────────────────────

/**
 * `_choose_factor_for_year` (V7, services/monthly_emissions.py), ported: the preferred year's value; else the closest earlier
 * year's; else the earliest year's. With no preferred year, the latest. None when there are no values.
 */
export function chooseFactorForYear<T>(values: ReadonlyMap<number, T>, preferred: number | null): { value: T; year: number } | null {
  if (values.size === 0) return null;
  const years = [...values.keys()].sort((a, b) => a - b);
  const pick = (year: number) => ({ value: values.get(year)!, year });
  if (preferred === null) return pick(years[years.length - 1]!);
  if (values.has(preferred)) return pick(preferred);
  const lower = years.filter((year) => year <= preferred);
  return pick(lower.length ? lower[lower.length - 1]! : years[0]!);
}

/** The factor's year values for its version: the latest set loaded at or below it (a later edit of the headline keeps them). */
export async function clientFactorYearValues(db: Queryable, organisationId: string, clientFactorId: string, version: number): Promise<Map<number, string>> {
  const { rows } = await db.query<{ year: number; kg: string }>(
    `SELECT year, kgco2e_per_unit::text AS kg FROM nzi_console.client_factor_year_values
      WHERE organisation_id = $1 AND client_factor_id = $2
        AND version = (SELECT max(version) FROM nzi_console.client_factor_year_values WHERE organisation_id = $1 AND client_factor_id = $2 AND version <= $3)
      ORDER BY year`, [organisationId, clientFactorId, version]);
  return new Map(rows.map((row) => [row.year, row.kg]));
}

export type ClientPricedRow = {
  rowId: string; jobId: string; clientFactorId: string; factorVersion: number;
  /** A V7 job-only factor (`job_custom_factors`): V7's resolver never finds it, so V7 prices it at its stored value (D-1). */
  jobOnly: boolean;
  /** Imported from the previous system: priced exactly as V7 prices it (D-1). */
  imported: boolean;
};

/**
 * Plan a client-factor row's pricing. Null — priced exactly as before, one product at the factor's headline value — where the
 * factor has no year values (every factor made here, and every factor before 0240). Otherwise each month is priced at the value
 * of its calendar year (`chooseFactorForYear`), through the same spans as a dataset row (§2):
 *   - **D-1, imported rows as V7 prices them:** a job-only factor at its stored value every month, and an annual-only row once at
 *     its stored value (V7 prices an annual row at its stored factor) — the headline, which the re-point's gate proves is V7's;
 *     a monthly row on a `custom_factors` factor month by month at its year's value, as V7's resolver does;
 *   - a console-native monthly row, month by month; a native annual row is split equally over the window's months where the
 *     window spans calendar years (R1), else priced once at its year's value.
 * Where every month takes one year's value, the row is one product at it (`single`).
 */
export async function planClientFactorPricing(db: Queryable, organisationId: string, row: ClientPricedRow, anchor: { kg: string }): Promise<RowPricing | null> {
  const values = await clientFactorYearValues(db, organisationId, row.clientFactorId, row.factorVersion);
  if (values.size === 0) return null;
  const monthEntries = (await db.query<{ month: string; quantity: string | null }>(
    `SELECT m->>'month' AS month, m->>'quantity' AS quantity FROM nzi_console.job_scope_rows r, jsonb_array_elements(r.monthly_activity_json) m
      WHERE r.organisation_id = $1 AND r.scope_row_id = $2`, [organisationId, row.rowId])).rows.filter((entry) => entry.quantity !== null);
  const hasMonths = monthEntries.length > 0;
  const stored = (basisDetail: string): RowPricing => ({ kind: "single", basis: "previous-system", spans: [], monthQuantities: [], monthKg: [], splitOver: 0, basisDetail });
  if (row.imported && row.jobOnly) return stored("A job-only factor: the previous system prices it at its stored value, every month");
  if (row.imported && !hasMonths) return stored("An annual quantity: one price, at the factor's stored value");
  const config = (await db.query<{ from: string; to: string }>(
    `SELECT reporting_from::text AS from, reporting_to::text AS to FROM nzi_console.job_emissions_config WHERE organisation_id = $1 AND job_id = $2`,
    [organisationId, row.jobId])).rows[0];
  if (!config && !hasMonths) return null;
  const allMonths = config ? windowMonths({ from: config.from, to: config.to }) : [];
  const spanning = config ? windowYearParts({ from: config.from, to: config.to }).length >= 2 : false;
  const basis: PricingBasis = hasMonths ? "monthly" : spanning ? "annual-split" : "annual";
  const months = hasMonths ? monthEntries : allMonths.map((month) => ({ month, quantity: null as string | null }));
  const priced = months.map((entry) => ({ entry, chosen: chooseFactorForYear(values, yearOf(entry.month))! }));
  const spans: PricingSpan[] = [];
  for (const month of priced) {
    const last = spans[spans.length - 1];
    if (last && last.factorYear === month.chosen.year) { last.to = month.entry.month; last.months += 1; continue; }
    spans.push({ from: month.entry.month, to: month.entry.month, months: 1, datasetId: "", factorVersion: `v${row.factorVersion}`,
      kgCo2ePerUnit: month.chosen.value, substitutedFor: null, substitutedWhy: null, factorYear: month.chosen.year });
  }
  if (spans.length === 1) return { kind: "single", basis, spans, monthQuantities: [], monthKg: [], splitOver: 0 };
  // An annual row over a calendar-year window never reaches here: one year, one span.
  return { kind: "spans", basis, spans, monthQuantities: priced.map((month) => month.entry.quantity), monthKg: priced.map((month) => month.chosen.value), splitOver: allMonths.length || months.length };
}

const kgText = (kg: string) => String(Number(kg));
const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
/** What a span is priced from: its edition, or a client factor's year value. */
const spanSource = (span: PricingSpan) => (span.factorYear !== undefined ? `${span.factorYear} value` : datasetLabelFromId(span.datasetId));

/** The lineage a priced row carries: the basis where it is not the plain one, the yearly parts, and each D-C flag. */
export function pricingLineage(pricing: RowPricing): Array<{ title: string; detail: string }> {
  const lines: Array<{ title: string; detail: string }> = [];
  const byYearValue = pricing.spans[0]?.factorYear !== undefined;
  if (pricing.basis === "annual-split" && pricing.kind === "spans")
    lines.push({ title: "Annual quantity split by month", detail: `Split equally over the period's ${pricing.splitOver} months, each priced at its year's ${byYearValue ? "value" : "edition"}` });
  if (pricing.basis === "previous-system")
    lines.push({ title: "Priced as the previous system prices it", detail: pricing.basisDetail ?? "An annual quantity: one price, at its own edition" });
  if (pricing.kind === "single" && byYearValue) {
    const span = pricing.spans[0]!;
    lines.push({ title: "Priced at its year's value", detail: `${span.months} month${span.months === 1 ? "" : "s"} @ ${spanSource(span)} (${kgText(span.kgCo2ePerUnit)})` });
  }
  if (pricing.kind === "spans") {
    lines.push({ title: "Priced by month", detail: pricing.spans.map((span, index) =>
      `${span.months}${index === 0 ? ` month${span.months === 1 ? "" : "s"}` : ""} @ ${spanSource(span)} (${kgText(span.kgCo2ePerUnit)})`).join(" · ") });
    for (const span of pricing.spans.filter((item) => item.substitutedFor)) {
      const when = span.from === span.to ? monthName(span.from) : `${monthName(span.from)}–${monthName(span.to)}`;
      lines.push({ title: "Priced at the nearest edition", detail: `${when} priced at ${datasetLabelFromId(span.datasetId)}: ${span.substitutedWhy} ${datasetLabelFromId(span.substitutedFor!)}` });
    }
  }
  return lines;
}

/** The provenance a priced row carries: the spans, and the basis. */
export const pricingProvenance = (pricing: RowPricing) => ({
  pricingBasis: pricing.basis,
  spans: pricing.spans.map((span) => span.factorYear !== undefined
    // A client factor's run names the year whose value priced it; it has no dataset.
    ? { from: span.from, to: span.to, months: span.months, factorYear: span.factorYear, factorVersion: span.factorVersion, kgCo2ePerUnit: span.kgCo2ePerUnit }
    : { from: span.from, to: span.to, months: span.months, datasetId: span.datasetId, factorVersion: span.factorVersion,
      kgCo2ePerUnit: span.kgCo2ePerUnit, ...(span.substitutedFor ? { substitutedFor: span.substitutedFor } : {}) }),
});

// ── The previous system's rows, priced by month from its own spans (Datasets Part 2, increment 2) ─────────────────────────────────

/** One edition of a candidate's series, as a span is priced from it: its factor (the candidate's id) and whether the job selects it. */
export type SpanEdition = { datasetId: string; year: number; selected: boolean; factor: { kg: number; unit: string; active: boolean } | null };

/**
 * A run of the previous system's months, as the console prices it with one candidate factor: the edition of the candidate's series
 * for the span's dataset year, its rate, the figure, V7's own figure for the span, and why it would not be brought in so (`issue`):
 *   dataset-not-on-job — the job does not select that edition (or the series has none for the year), so the chain prices those
 *                        months at another; unit — the edition prices the factor per another unit; no-match — the edition lacks the
 *                        factor; custom-factor — V7 priced the span from a client's custom value, which no edition holds.
 */
export type V7SpanPart = {
  from: string; to: string; months: number; year: number | null; datasetId: string | null; kg: number | null;
  tco2e: number | null; previous: number; agrees: boolean;
  issue: "dataset-not-on-job" | "unit" | "no-match" | "custom-factor" | null;
};

const r6 = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * One previous-system row priced with one candidate, span by span from V7's own spans (each span's dataset year → the candidate's
 * edition of that year). The row's months are V7's `month_N`, **calendar month N** (as V7's resolver and the re-ingest read them);
 * a row with no monthly figures is annual, and V7 prices it as one span, so its whole quantity goes to that span. Pure.
 *
 * An annual row over several of V7's spans (a register source, say: a hotel's 29 nights, Apr 2025 – Mar 2026) is priced as bringing
 * it in prices it, D-B: one price, at the candidate's own edition (`ownDatasetId`) — each span its share of the quantity by its months.
 *
 * Returns the parts and the row's figure (Σ parts), or a null figure when any part cannot be priced. The console's figure for a
 * part is Σ months (q × kgCO₂e) ÷ 1000 × apply%, as the one row calculation prices a spanning row (`planRowPricing`).
 *
 * Each part's issue names what is wrong, and nothing else: no-match only where the edition lacks the factor; the unit before the
 * edition's place on the job (a unit that differs is refused whatever the job holds).
 */
export function priceByV7Spans(input: {
  quantity: number | null; months: ReadonlyArray<number | null> | null; applyPct: number;
  /** The row's unit against an edition's unit for the factor, by the import's own rule (`v7UnitAgainstFactor`). */
  sameUnit: (editionUnit: string) => boolean;
  spans: ReadonlyArray<{ from: string | null; to: string | null; dataset_year: number | null; dataset_id: number | null; tco2e: number }>;
  editions: ReadonlyMap<number, SpanEdition>;
  /** The candidate's own edition: an annual row over several spans is priced once, at it (D-B). */
  ownDatasetId?: string | null;
}): { tco2e: number | null; parts: V7SpanPart[] } {
  const hasMonths = (input.months ?? []).some((value) => value !== null && value !== 0);
  const monthsOf = (span: { from: string | null; to: string | null }) => (span.from && span.to ? monthsBetween(`${span.from}-01`, `${span.to}-01`, 240) : []);
  // D-B: an annual row over several spans — one price, at the candidate's own edition; each span its months' share.
  const annualSplit = !hasMonths && input.spans.length > 1;
  const ownEdition = annualSplit ? [...input.editions.values()].find((edition) => edition.datasetId === input.ownDatasetId) : undefined;
  const allMonths = input.spans.reduce((sum, span) => sum + monthsOf(span).length, 0);
  const parts = input.spans.map((span): V7SpanPart => {
    const range = monthsOf(span);
    const base = { from: span.from ?? "", to: span.to ?? "", months: range.length, year: span.dataset_year, previous: span.tco2e };
    if (span.dataset_id === null) return { ...base, datasetId: null, kg: null, tco2e: null, agrees: false, issue: "custom-factor" };
    const edition = annualSplit ? ownEdition : span.dataset_year === null ? undefined : input.editions.get(span.dataset_year);
    if (!edition) return { ...base, datasetId: null, kg: null, tco2e: null, agrees: false, issue: "dataset-not-on-job" };
    if (!edition.factor || !edition.factor.active) return { ...base, datasetId: edition.datasetId, kg: null, tco2e: null, agrees: false, issue: "no-match" };
    const sameUnit = input.sameUnit(edition.factor.unit);
    // The span's quantity: its months' figures (calendar month N); an annual row priced as one span, the whole quantity; an annual
    // row over several, its months' share of it. A quantity it cannot be given is no figure — never "not in that edition".
    const quantity = hasMonths ? range.reduce((sum, month) => sum + (input.months![Number(month.slice(5, 7)) - 1] ?? 0), 0)
      : !annualSplit ? input.quantity : input.quantity !== null && allMonths > 0 ? input.quantity * range.length / allMonths : null;
    const issue = !sameUnit ? "unit" as const : !edition.selected ? "dataset-not-on-job" as const : null;
    if (quantity === null) return { ...base, datasetId: edition.datasetId, kg: edition.factor.kg, tco2e: null, agrees: false, issue };
    const tco2e = r6(quantity * edition.factor.kg / 1000 * (input.applyPct / 100));
    return { ...base, datasetId: edition.datasetId, kg: edition.factor.kg, tco2e, agrees: Math.abs(tco2e - span.tco2e) < 0.05 - 1e-12, issue };
  });
  const priced = parts.every((part) => part.tco2e !== null) ? r6(parts.reduce((sum, part) => sum + part.tco2e!, 0)) : null;
  return { tco2e: priced, parts };
}

/**
 * Every active edition of each candidate's series in the candidate dataset's country, keyed by its year, with the candidate's factor
 * in it and whether the job selects it: what `priceByV7Spans` prices each span from. Keyed by `datasetId|factorId`.
 */
export async function v7SpanEditions(db: Queryable, organisationId: string, jobId: string,
  candidates: ReadonlyArray<{ datasetId: string; factorId: string }>): Promise<Map<string, Map<number, SpanEdition>>> {
  const out = new Map<string, Map<number, SpanEdition>>();
  const pairs = [...new Map(candidates.map((candidate) => [`${candidate.datasetId}|${candidate.factorId}`, candidate])).values()];
  if (!pairs.length) return out;
  const { rows } = await db.query<{ anchor: string; factor_id: string; dataset_id: string; year: number; selected: boolean; kg: string | null; unit: string | null; active: boolean | null }>(
    `SELECT x.anchor, x.factor_id, d.dataset_id, extract(year FROM d.valid_from)::int AS year, s.dataset_id IS NOT NULL AS selected,
            f.kgco2e_per_unit::text AS kg, f.activity_unit AS unit, f.active
       FROM unnest($3::text[], $4::text[]) AS x(anchor, factor_id)
       JOIN nzi_console.emission_factor_datasets a ON a.organisation_id = $1 AND a.dataset_id = x.anchor
       JOIN nzi_console.emission_factor_datasets d ON d.organisation_id = a.organisation_id AND d.country_code = a.country_code AND d.status = 'active'
        AND regexp_replace(d.dataset_id, '${DATASET_EDITION_SUFFIX}', '') = regexp_replace(x.anchor, '${DATASET_EDITION_SUFFIX}', '')
       LEFT JOIN nzi_console.job_dataset_selections s ON (s.organisation_id, s.job_id, s.dataset_id) = (d.organisation_id, $2, d.dataset_id)
       LEFT JOIN nzi_console.emission_factors_display f ON (f.organisation_id, f.dataset_id, f.factor_id) = (d.organisation_id, d.dataset_id, x.factor_id)
      ORDER BY d.valid_from, d.dataset_id`,
    [organisationId, jobId, pairs.map((pair) => pair.datasetId), pairs.map((pair) => pair.factorId)]);
  for (const row of rows) {
    const key = `${row.anchor}|${row.factor_id}`;
    const byYear = out.get(key) ?? new Map<number, SpanEdition>();
    // One edition a year; a selected one wins where a series has two of a year.
    const held = byYear.get(row.year);
    if (!held || (!held.selected && row.selected)) byYear.set(row.year, { datasetId: row.dataset_id, year: row.year, selected: row.selected,
      factor: row.kg === null ? null : { kg: Number(row.kg), unit: row.unit ?? "", active: row.active === true } });
    out.set(key, byYear);
  }
  return out;
}

/**
 * Site resolution (§2): a dataset factor serves a row only for its site's country (the job's, for a row with no site or a
 * site with none, R3). GLOBAL serves any country; ROW (CEDA's rest of world) serves spend; DESNZ serves a non-UK country
 * as the international default for activity only, where that country has no activity series of its own (D-A). Never
 * another country's. Null when it may; else the refusal's words.
 */
export async function factorCountryIssue(db: Queryable, organisationId: string, row: { jobId: string; siteId: string | null; datasetId: string; factorId: string; factorLabel: string; scopes: string[] }): Promise<string | null> {
  const found = (await db.query<{ job_country: string | null; site_country: string | null; dataset_country: string }>(
    `SELECT c.country_code AS job_country, s.country AS site_country, d.country_code AS dataset_country
       FROM nzi_console.emission_factor_datasets d
       LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id, c.job_id) = (d.organisation_id, $2)
       LEFT JOIN nzi_console.client_sites s ON (s.organisation_id, s.site_id) = (d.organisation_id, $3)
      WHERE d.organisation_id = $1 AND d.dataset_id = $4`, [organisationId, row.jobId, row.siteId, row.datasetId])).rows[0];
  if (!found?.job_country) return null;
  const country = siteCountry(found.site_country, found.job_country);
  const datasetCountry = found.dataset_country;
  if (datasetCountry === country || datasetCountry === "GLOBAL") return null;
  const series = datasetSeriesKey(row.datasetId);
  if (datasetCountry === "ROW" && series.startsWith("ceda-")) return null;
  if (datasetCountry === "GB" && series === DESNZ_SERIES && internationalDefaultAllows({ factorId: row.factorId, label: row.factorLabel, scopes: row.scopes })) {
    const ownActivity = (await db.query(
      `SELECT 1 FROM nzi_console.emission_factor_datasets WHERE organisation_id = $1 AND country_code = $2 AND status = 'active'
          AND dataset_id NOT LIKE 'ceda-%' AND dataset_id NOT LIKE 'iea-%' LIMIT 1`, [organisationId, country])).rows.length > 0;
    if (!ownActivity) return null;
    return `${country} has activity factors of its own; DESNZ is the default only where a country has none.`;
  }
  return `This factor is from ${datasetLabelFromId(row.datasetId)}, but the row is for ${country}: a row is priced from its own country's factors (DESNZ only for activity where the country has none).`;
}
