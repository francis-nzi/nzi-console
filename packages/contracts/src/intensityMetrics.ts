/**
 * Intensity metrics — defined on the client, recorded on the job, computed in one place.
 *
 * The client defines what its emissions should be normalised against (Employees and
 * Turnover always, plus anything else that means something to that business). The job
 * records the annual value for each reporting year. This module is the only thing that
 * turns those two into an intensity, so the client's year-on-year chart, the intensity
 * detail, the portal and the report cannot drift apart.
 *
 *   intensity = emissions × divider ÷ value          ("tCO₂e per N units")
 *
 * A metric with no recorded value for a year is **unavailable** for that year — never 0,
 * and never quietly borrowed from another year or another metric.
 */

import { currencySymbol } from "./currencyDirectory";

export const intensityDividers = [1, 10, 100, 1000, 10000, 100000, 1000000] as const;
export type IntensityDivider = (typeof intensityDividers)[number];

/**
 * What the denominator counts (0143). A `text` metric counts the thing its wording names. A `currency` metric counts
 * whole units of the client's currency and stores no symbol: the symbol is derived at display from the currency, so
 * the same metric reads "per £m" for one client and "per €m" for another.
 */
export type IntensityUnitKind = "text" | "currency";
export const intensityUnitKinds: readonly IntensityUnitKind[] = ["text", "currency"];

export type IntensityMetricDefinition = {
  key: string;
  version: number;
  label: string;
  /** The noun the denominator counts — "employee", "m²", "vehicle". Informational only on a `currency` metric. */
  unitWording: string;
  unitKind: IntensityUnitKind;
  divider: IntensityDivider;
  /** A key into the curated icon set, resolved at render time. Never an image or an emoji. */
  iconKey: string;
  isStandard: boolean;
  /** `site-floor-area` resolves from the client's effective-dated sites instead of being typed. */
  valueSource: "entered" | "site-floor-area";
  active: boolean;
  ordering: number;
};

/** One recorded value: this job, this reporting period, this metric. */
export type IntensityMetricValue = {
  metricKey: string;
  /**
   * The label the value was stored under. Kept because it is what the capture screen shows and
   * what the row is keyed by within its own job — but **not** what a client-wide read matches on:
   * two of a client's jobs can share this number and mean different periods (NZC-096).
   */
  reportingYear: number;
  /**
   * The period the owning job reports on — the identity a client-wide read matches by. Null only
   * when the job records no period and none can be resolved for it, in which case the reader falls
   * back to the label.
   */
  period?: { from: string; to: string } | null;
  /** `year` today. The seam for monthly/quarterly capture, which arrives through the job. */
  periodKey: string;
  value: number | null;
  overridesResolved: boolean;
  note: string;
  version: number;
};

/** How the denominator was arrived at, so a reader can tell typed from resolved. */
export type IntensityDenominatorSource = "recorded" | "site-floor-area" | "none";

export type ResolvedIntensity =
  | {
    state: "resolved";
    metricKey: string;
    value: number;
    /** The denominator itself, in its own unit. */
    denominator: number;
    unit: string;
    unitShort: string;
    source: IntensityDenominatorSource;
  }
  | { state: "unavailable"; metricKey: string; reason: string };


/** "£m", "€k", "$", "£100", "AED m" — the money the denominator is counted in, magnitude included. */
function currencyAmount(currency: string, divider: number): string {
  const symbol = currencySymbol(currency);
  // A symbol joins its magnitude ("£m"); a code is a word and takes a space ("AED m").
  const joiner = /^[A-Z]{2,}$/.test(symbol) ? " " : "";
  if (divider === 1) return symbol;
  if (divider === 1000000) return `${symbol}${joiner}m`;
  if (divider === 1000) return `${symbol}${joiner}k`;
  return `${symbol}${joiner}${divider.toLocaleString("en-GB")}`;
}

/**
 * A text unit that already carries a magnitude — "£m", "$k", "AED m" — counts millions or thousands itself, so the
 * divider is never spoken again: "tCO₂e per 1,000,000 £m" counts the million twice.
 */
const carriesMagnitude = (wording: string) => /^([£$€]|[A-Z]{3}\s)\s*(m|k|bn)$/i.test(wording.trim());

/** Where the unit is read: the currency of the client whose figures these are (the job's client, the portal's). */
export type IntensityUnitContext = { currency: string };

/**
 * The unit label, with the divider spoken aloud: a divider of 1,000 against "employee"
 * reads "tCO₂e per 1,000 employees", because the number means nothing without it.
 * A `currency` metric reads in the client's currency: "tCO₂e per £m", "tCO₂e per €k", "tCO₂e per AED m".
 */
export function intensityUnit(definition: Pick<IntensityMetricDefinition, "unitWording" | "divider" | "unitKind">, context: IntensityUnitContext): string {
  if (definition.unitKind === "text" && definition.divider === 1) return `tCO₂e / ${definition.unitWording}`;
  return `tCO₂e per ${intensityPer(definition, context)}`;
}

/**
 * What one unit of intensity is per — "£m", "€k", "AED m", "1,000 employees", "employee" — for the places that say
 * "per …" without the tCO₂e: a selector, a chart title, "Intensity · per £m". The same rules as `intensityUnit`.
 */
export function intensityPer(definition: Pick<IntensityMetricDefinition, "unitWording" | "divider" | "unitKind">, context: IntensityUnitContext): string {
  if (definition.unitKind === "currency") return currencyAmount(context.currency, definition.divider);
  if (definition.divider === 1 || carriesMagnitude(definition.unitWording)) return definition.unitWording.trim();
  return `${definition.divider.toLocaleString("en-GB")} ${plural(definition.unitWording)}`;
}

/**
 * The denominator itself, as a reader should see it. A currency metric's value is whole units of the client's
 * currency (0143), so it reads as money — "£12,500,000", "AED 3,000,000" — never "12,500,000 £m". A text metric
 * reads as its number and its wording, plural unless the number is one — "240 employees", "1 employee" — by the same
 * rule as `intensityPer`, so a notation stays as written ("1,200 m²", "450 kWh").
 */
export function intensityDenominatorText(definition: Pick<IntensityMetricDefinition, "unitWording" | "unitKind">, value: number, context: IntensityUnitContext): string {
  const amount = value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  if (definition.unitKind !== "currency") return `${amount} ${amount === "1" ? definition.unitWording.trim() : plural(definition.unitWording)}`;
  const symbol = currencySymbol(context.currency);
  return /^[A-Z]{2,}$/.test(symbol) ? `${symbol} ${amount}` : `${symbol}${amount}`;
}

/** A compact form for chart axes and tooltips, where the long form will not fit. */
export function intensityUnitShort(definition: Pick<IntensityMetricDefinition, "unitWording" | "divider" | "unitKind">, context: IntensityUnitContext): string {
  if (definition.unitKind === "currency") return `tCO₂e/${currencyAmount(context.currency, definition.divider)}`;
  if (definition.divider !== 1 && carriesMagnitude(definition.unitWording)) return `tCO₂e/${definition.unitWording.trim()}`;
  const unit = definition.divider === 1 ? definition.unitWording : `${compactDivider(definition.divider)} ${plural(definition.unitWording)}`;
  return `tCO₂e/${unit}`;
}

const compactDivider = (divider: number) => divider >= 1000000 ? `${divider / 1000000}M` : divider >= 1000 ? `${divider / 1000}k` : String(divider);
const plural = (word: string) => {
  const trimmed = word.trim();
  // Only actual words pluralise. A unit carrying a symbol (£m, m³) or an internal capital
  // (kWh, FTE) is a notation, not a noun — and "1,000,000 £ms" is how you lose a reader.
  if (!/^[A-Za-z][a-z -]*$/.test(trimmed)) return trimmed;
  if (/(s|x|z|ch|sh)$/i.test(trimmed)) return `${trimmed}es`;
  if (/[^aeiou]y$/i.test(trimmed)) return `${trimmed.slice(0, -1)}ies`;
  return `${trimmed}s`;
};

/**
 * The one computation. `emissions` is the assured total for the year; `value` is what the
 * job recorded (or what the platform resolved for a site-derived metric).
 */
export function resolveIntensity(input: {
  definition: IntensityMetricDefinition;
  emissionsTco2e: number | null;
  value: number | null;
  source?: IntensityDenominatorSource;
  /** The client's currency, so the stamped unit of a currency metric is right at source — and frozen as such. */
  currency: string;
}): ResolvedIntensity {
  const { definition, emissionsTco2e, value } = input;
  const metricKey = definition.key;
  if (emissionsTco2e === null) {
    return { state: "unavailable", metricKey, reason: "No assured total is resolved for this year, so no intensity can be formed." };
  }
  if (value === null) {
    return {
      state: "unavailable", metricKey,
      reason: definition.valueSource === "site-floor-area"
        ? `No floor area could be resolved for this year, so ${definition.label.toLowerCase()} intensity is unavailable.`
        : `No ${definition.label.toLowerCase()} value was recorded for this year.`,
    };
  }
  if (value <= 0) {
    return { state: "unavailable", metricKey, reason: `The recorded ${definition.label.toLowerCase()} value is zero, which cannot be divided by.` };
  }
  return {
    state: "resolved", metricKey,
    value: (emissionsTco2e * definition.divider) / value,
    denominator: value,
    unit: intensityUnit(definition, { currency: input.currency }),
    unitShort: intensityUnitShort(definition, { currency: input.currency }),
    source: input.source ?? (definition.valueSource === "site-floor-area" ? "site-floor-area" : "recorded"),
  };
}

/** The active set, in the client's own order, standards first. */
export function activeMetrics(definitions: readonly IntensityMetricDefinition[]): IntensityMetricDefinition[] {
  return definitions.filter((definition) => definition.active)
    .sort((a, b) => Number(b.isStandard) - Number(a.isStandard) || a.ordering - b.ordering || a.label.localeCompare(b.label));
}

/**
 * Index a metric's series to its own first resolved year = 100, so metrics whose units
 * differ by orders of magnitude can share one axis. Returns null when fewer than two years
 * resolve — one point is not a shape, and drawing it would imply a trend that isn't there.
 */
export function indexedSeries(points: ReadonlyArray<{ year: number; intensity: ResolvedIntensity }>): Array<{ year: number; value: number; absolute: number; absoluteUnit: string }> | null {
  const resolved = points
    .filter((point): point is { year: number; intensity: Extract<ResolvedIntensity, { state: "resolved" }> } => point.intensity.state === "resolved")
    .sort((a, b) => a.year - b.year);
  const base = resolved[0];
  if (!base || resolved.length < 2) return null;
  return resolved.map((point) => ({
    year: point.year,
    value: (point.intensity.value / base.intensity.value) * 100,
    absolute: point.intensity.value,
    absoluteUnit: point.intensity.unitShort,
  }));
}

/* ── Icons ──────────────────────────────────────────────────────────────────────────── */

/**
 * The curated icon set, as KEYS. The definition stores the key, never the artwork, so the
 * print-safe set can be chosen (and changed) without a migration or a data edit — which is
 * why the report rendering can wait on that decision while everything else ships.
 */
export const intensityIconKeys = [
  "people", "currency", "building", "vehicle", "water", "package", "factory",
  "flight", "tools", "energy", "waste", "metric",
] as const;
export type IntensityIconKey = (typeof intensityIconKeys)[number];
export const isIntensityIconKey = (value: string): value is IntensityIconKey => (intensityIconKeys as readonly string[]).includes(value);

/** Fixed for the standard pair: their meaning does not change per client. */
export const standardIconKeys: Record<string, IntensityIconKey> = { employees: "people", turnover: "currency" };

const ICON_HINTS: Array<[RegExp, IntensityIconKey]> = [
  [/employ|staff|people|head|fte/i, "people"],
  [/turnover|revenue|sales|income|£|\$|€/i, "currency"],
  [/floor|area|m²|m2|site|building|property|space/i, "building"],
  [/vehicle|fleet|van|truck|car|lorr/i, "vehicle"],
  [/water|litre|liter|m³/i, "water"],
  [/packag|unit|product|item|case|pallet/i, "package"],
  [/plant|factor|manufact|line|machine/i, "factory"],
  [/flight|passenger|km|mile|travel/i, "flight"],
  [/tool|equipment|asset/i, "tools"],
  [/energ|kwh|mwh|fuel|power/i, "energy"],
  [/waste|recycl|landfill|tonnes? of waste/i, "waste"],
];

/**
 * Suggest an icon from what the metric is called. A suggestion only — the editor offers the
 * whole set and the chosen key is what gets stored.
 */
export function suggestIconKey(label: string, unitWording = ""): IntensityIconKey {
  const text = `${label} ${unitWording}`;
  for (const [pattern, key] of ICON_HINTS) if (pattern.test(text)) return key;
  return "metric";
}

/**
 * Phase 1b (0158) — a client's target for one intensity metric, as the Client shows it beside net zero: the latest
 * version, with the metric's own label and unit. Reductions are percentages of the baseline intensity (tCO₂e per unit).
 */
export type ClientIntensityTarget = {
  metricKey: string;
  metricLabel: string;
  unitWording: string;
  version: number;
  baselineYear: number;
  baselineIntensity: number;
  interimYear: number | null;
  interimReductionPct: number | null;
  targetYear: number | null;
  targetReductionPct: number | null;
  setBy: string;
  setAt: string;
};

/**
 * The standard metrics a job's CRP can report (RULING-3c3 (1)), by the client's metric key, to the report's metric name.
 * A custom metric is shown in the job's Intensity drawer but is not the reported one in v1, so the report's metric union
 * stays these three.
 */
export const REPORTED_INTENSITY_METRICS: Readonly<Record<string, "turnover" | "employee" | "floor-area">> = {
  turnover: "turnover",
  employees: "employee",
  "floor-area": "floor-area",
};

/**
 * Which metric a job's CRP reports (RULING-3c3 (1)–(2)): the first active **standard** metric, in the client's own
 * ordering, that has an active client target. The client changes it by reordering its metrics. Null when no standard
 * metric has a target — a target on a custom metric alone reports nothing in v1. One rule, read by the report's adapter and
 * the drawer alike, so the drawer's "reported in the CRP" is what the report carries.
 */
export function reportedIntensityMetric(metrics: readonly IntensityMetricDefinition[], targets: readonly Pick<ClientIntensityTarget, "metricKey">[]): IntensityMetricDefinition | null {
  const targeted = new Set(targets.map((target) => target.metricKey));
  return metrics
    .filter((metric) => metric.active && metric.key in REPORTED_INTENSITY_METRICS && targeted.has(metric.key))
    .slice()
    .sort((a, b) => a.ordering - b.ordering || a.key.localeCompare(b.key))[0] ?? null;
}
