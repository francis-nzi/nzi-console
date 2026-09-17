// node-postgres materialises a SQL `date` as local midnight, so toISOString() shifts it
// a day earlier wherever the server runs ahead of UTC (BST included). Read the local
// components instead — a `date` carries no time or zone and must not acquire one.
export const dateOnly = (value: Date | string) => value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
  : String(value).slice(0, 10);

export const isoTimestamp = (value: Date | string) => value instanceof Date ? value.toISOString() : String(value);

/**
 * The identity of a reporting period (NZC-096).
 *
 * A reporting year is a **label**: the start-year convention names a period by the year it begins,
 * the end-year convention by the year it ends, and one client can hold two different periods under
 * one number. Anything that groups, dedupes or looks up by reporting period keys on this instead,
 * so the two cannot be mistaken for each other.
 *
 * Both ends, deliberately. A part-year period and a full one can end on the same day.
 */
export const periodKeyOf = (from: Date | string, to: Date | string) => `${dateOnly(from)}|${dateOnly(to)}`;

/** Whether two periods are the same period. Null is not equal to anything, including null. */
export const samePeriod = (
  a: { from: string; to: string } | null | undefined,
  b: { from: string; to: string } | null | undefined,
) => a != null && b != null && a.from === b.from && a.to === b.to;
