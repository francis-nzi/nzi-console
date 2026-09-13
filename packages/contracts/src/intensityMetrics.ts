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

export const intensityDividers = [1, 10, 100, 1000, 10000, 100000, 1000000] as const;
export type IntensityDivider = (typeof intensityDividers)[number];

export type IntensityMetricDefinition = {
  key: string;
  version: number;
  label: string;
  /** The noun the denominator counts — "employee", "£m", "m²", "vehicle". */
  unitWording: string;
  divider: IntensityDivider;
  /** A key into the curated icon set, resolved at render time. Never an image or an emoji. */
  iconKey: string;
  isStandard: boolean;
  /** `site-floor-area` resolves from the client's effective-dated sites instead of being typed. */
  valueSource: "entered" | "site-floor-area";
  active: boolean;
  ordering: number;
};

/** One recorded value: this job, this reporting year, this metric. */
export type IntensityMetricValue = {
  metricKey: string;
  reportingYear: number;
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

/**
 * The unit label, with the divider spoken aloud: a divider of 1,000 against "employee"
 * reads "tCO₂e per 1,000 employees", because the number means nothing without it.
 */
export function intensityUnit(definition: Pick<IntensityMetricDefinition, "unitWording" | "divider">): string {
  if (definition.divider === 1) return `tCO₂e / ${definition.unitWording}`;
  return `tCO₂e per ${definition.divider.toLocaleString("en-GB")} ${plural(definition.unitWording)}`;
}

/** A compact form for chart axes and tooltips, where the long form will not fit. */
export function intensityUnitShort(definition: Pick<IntensityMetricDefinition, "unitWording" | "divider">): string {
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
    unit: intensityUnit(definition),
    unitShort: intensityUnitShort(definition),
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
