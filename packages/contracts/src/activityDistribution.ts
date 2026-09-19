/**
 * Spreading a figure across the months it covers (NZC-107).
 *
 * A consultant is given a year's electricity, or four quarterly invoices, or twelve meter reads.
 * The platform stores months either way — month grain is the storage, not the capture — so the
 * annual and quarterly cases have to be expanded before they land. That expansion is here, once,
 * because two stores need it (`job_scope_rows` 0031 and `job_emission_sources` 0036) and two
 * implementations of the same arithmetic would eventually disagree about a client's number.
 *
 * ## The rule that governs everything below: value is neither lost nor invented
 *
 * The annual quantity is *derived* from the months (0031's own words, and what both resolvers do:
 * they sum the populated slots). So a figure that is distributed and then summed back must equal
 * what was typed — exactly, not nearly. £120,001 over twelve months cannot come back as £120,000.
 *
 * Two mechanisms, because two different things go wrong:
 *
 * **Allocation.** The split is done in integer minor units at a declared precision, so the
 * remainder is *allocated* rather than dropped: each of the first `remainder` months takes one
 * extra unit. Earliest-first, so it is deterministic and the same input always produces the same
 * vector — never "spread the rounding wherever it lands".
 *
 * **Representation.** Those minor units are then divided back into JavaScript numbers, and a tenth
 * of a penny is not a binary fraction — twelve of them summed left to right need not land back on
 * the total. So the last month absorbs the residue, computed as `total − (sum of the rest)`. That
 * subtraction is exact (the two operands are within a factor of two of each other), and adding it
 * back to that same left-to-right sum therefore returns the total exactly — which is the order the
 * resolvers sum in. The correction is at the 1e-10 level; the allocation above is what a person
 * would see.
 *
 * **The guarantee is per figure, and that is deliberate.** One annual figure round-trips exactly.
 * Each quarter's three months sum back to that quarter exactly. Adding four quarters together
 * afterwards costs whatever adding four numbers costs in binary — it costs the same whether they
 * were distributed or not, and the alternative would mean moving value between quarters to tidy a
 * grand total, which is worse: a quarter has to account for itself. Across the whole vector, no
 * minor unit is lost or invented; any residue is smaller than the precision anything is stored at.
 *
 * ## Quarters are counted from the period, not from January
 *
 * A quarter here is three consecutive months of the *reporting period*, so an April–March year has
 * its quarters at Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar. This is the only reading that survives the
 * periods this platform actually has: a transition year of fourteen months, or a first year that
 * starts in February, has no calendar quarters to speak of, and clipping to calendar quarters would
 * silently hand one figure a one-month span and another a three-month one. A trailing span shorter
 * than three months is a real thing — a part-year period ends where it ends — and it spreads across
 * the months it actually covers.
 */

export type ActivityFrequency = "annual" | "quarterly" | "monthly";

export const activityFrequencies: readonly ActivityFrequency[] = ["annual", "quarterly", "monthly"] as const;

export const isActivityFrequency = (value: unknown): value is ActivityFrequency =>
  typeof value === "string" && (activityFrequencies as readonly string[]).includes(value);

/** A month of the reporting period and what was recorded against it. */
export type MonthSlot = { month: string; quantity: number | null };

/**
 * The precision the allocation works in: millionths of a unit. Small enough that no real activity
 * figure is rounded by it (a litre to six places, a penny to four), large enough to stay well
 * inside exact integer arithmetic for any quantity the platform will see.
 */
export const DISTRIBUTION_SCALE = 1_000_000;

/** How many months each supplied figure covers, in order, for a frequency over a period. */
export function monthSpansFor(frequency: ActivityFrequency, months: readonly string[]): string[][] {
  if (months.length === 0) return [];
  if (frequency === "monthly") return months.map((month) => [month]);
  if (frequency === "annual") return [[...months]];
  const spans: string[][] = [];
  for (let index = 0; index < months.length; index += 3) spans.push(months.slice(index, index + 3));
  return spans;
}

/** How many figures a surface must collect for this frequency over this period. */
export const figureCountFor = (frequency: ActivityFrequency, months: readonly string[]): number =>
  monthSpansFor(frequency, months).length;

/**
 * `value` split across `count` months so the parts sum back to `value` exactly.
 *
 * Returns an empty array for a count of zero — a figure covering no months has nowhere to go, and
 * the caller decides whether that is an error.
 */
export function distributeEvenly(value: number, count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [value];
  if (!Number.isFinite(value)) throw new RangeError("A distributed figure must be a finite number.");

  const sign = value < 0 ? -1 : 1;
  const units = Math.round(Math.abs(value) * DISTRIBUTION_SCALE);
  if (!Number.isSafeInteger(units)) {
    throw new RangeError("That figure is too large to distribute without losing precision.");
  }

  const base = Math.floor(units / count);
  const remainder = units - base * count;
  // Earliest months take the spare units, one each, so the split is deterministic.
  const parts = Array.from({ length: count }, (_, index) =>
    (sign * (base + (index < remainder ? 1 : 0))) / DISTRIBUTION_SCALE);

  // The representation correction. `sum` is built left to right because that is how the resolvers
  // add the months back up, and the last part absorbs whatever the binary representation lost.
  let sum = 0;
  for (let index = 0; index < parts.length - 1; index += 1) sum += parts[index]!;
  parts[parts.length - 1] = value - sum;
  return parts;
}

export type DistributionInput = {
  frequency: ActivityFrequency;
  /** One figure per span, in order. `null` is "not supplied", and stays unsupplied. */
  figures: readonly (number | null)[];
  /** The reporting period's months, in order — build them with `monthsBetween`. */
  months: readonly string[];
};

export type DistributionResult = {
  slots: MonthSlot[];
  /** Whether any month's figure was derived rather than supplied for that month. */
  distributed: boolean;
};

/**
 * The supplied figures, expanded to one slot per month of the reporting period.
 *
 * A monthly figure lands in its own month and is not distributed. An annual or quarterly figure
 * spreads across the months its span covers — only the months the period actually contains, so a
 * part-year period never apportions past its own end.
 */
export function distributeActivity(input: DistributionInput): DistributionResult {
  const spans = monthSpansFor(input.frequency, input.months);
  if (input.figures.length !== spans.length) {
    throw new RangeError(`Expected ${spans.length} figure(s) for a ${input.frequency} period of ${input.months.length} month(s), received ${input.figures.length}.`);
  }

  const slots: MonthSlot[] = [];
  let distributed = false;
  spans.forEach((span, index) => {
    const figure = input.figures[index] ?? null;
    if (figure === null) {
      for (const month of span) slots.push({ month, quantity: null });
      return;
    }
    if (span.length > 1) distributed = true;
    const parts = distributeEvenly(figure, span.length);
    span.forEach((month, position) => slots.push({ month, quantity: parts[position]! }));
  });

  return { slots, distributed };
}

/** What the resolvers do with a stored vector: the annual figure is the sum of what is populated. */
export const totalOfSlots = (slots: readonly MonthSlot[]): number | null => {
  const populated = slots.filter((slot) => slot.quantity !== null);
  return populated.length === 0 ? null : populated.reduce((sum, slot) => sum + (slot.quantity ?? 0), 0);
};
