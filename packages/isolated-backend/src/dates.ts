// The day helpers live in @nzi/contracts, because the console's own pages and routes need
// the same answers and cannot import a package that speaks to Postgres. Re-exported here so
// every existing caller keeps its import — one definition, reachable from both sides, rather
// than a second copy free to drift (NZC-106).
export {
  dateOnly, dateOnlyOrNull, utcDay, utcDayOrNull, todayInLondon, monthKey, monthsBetween,
  PLATFORM_TIME_ZONE,
} from "@nzi/contracts";
import { dateOnly } from "@nzi/contracts";

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
