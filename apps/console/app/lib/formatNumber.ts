/**
 * Display-only number formats for the review surface (SPEC-review-surface-readiness §3). They round what is shown and remove
 * float-representation noise (10771.200000000003 → "10,771.20"); the stored value, every calculation and the reconciliation are
 * untouched. A missing or non-finite value is "—", never a zero.
 */
const QUANTITY = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** tCO₂e keeps up to six places (the precision the re-ingest reconciles at), so a small figure is never shown as 0.00. */
const TONNES = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

const usable = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/** An activity quantity: thousands separators and exactly two decimal places. */
export const formatQuantity = (value: number | null | undefined): string => (usable(value) ? QUANTITY.format(value) : "—");

/** A row's tCO₂e: thousands separators, at least two and at most six decimal places. */
export const formatTonnes = (value: number | null | undefined): string => (usable(value) ? TONNES.format(value) : "—");

const ONE_DP = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * The display format for every headline tCO₂e (and intensity) magnitude: thousands separators and exactly one decimal place.
 * Round only here, from the unrounded value, and never sum rounded figures. Counts and percentages are not tCO₂e and stay whole
 * numbers. The six-place `formatTonnes` stays for reconciliation surfaces, where a small figure must not read as zero.
 */
export const formatTco2e = (value: number | null | undefined): string => (usable(value) ? ONE_DP.format(value) : "—");
