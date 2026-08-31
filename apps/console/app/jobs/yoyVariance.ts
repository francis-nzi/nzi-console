// Year-on-year variance — advisory only (NZC-018, never blocks import or review).
// A rolled-forward spend source (B3) carries the prior year's quantity; once this
// year's quantity is entered, a large swing is worth the consultant's eye.

const LOW = 0.5; // this year <= half of last → flag
const HIGH = 2; // this year >= double last → flag

/**
 * Returns a short advisory string when the current value is materially different
 * from the prior-year value, or null when it is within [50%, 200%], either value
 * is missing, or the prior value is not positive.
 */
export function yoyVarianceNote(current: number | null, prior: number | null, unit: string | null): string | null {
  if (current == null || prior == null || !(prior > 0)) return null;
  const ratio = current / prior;
  if (ratio >= LOW && ratio <= HIGH) return null;
  const priorText = `${prior.toLocaleString("en-GB")}${unit ? ` ${unit}` : ""}`;
  const change = ratio >= 1 ? `${ratio.toFixed(1)}×` : `${Math.round(ratio * 100)}% of`;
  return `${change} last year (was ${priorText})`;
}
