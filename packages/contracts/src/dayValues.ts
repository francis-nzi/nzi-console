/**
 * Calendar days, said once (NZC-106).
 *
 * A calendar day and an instant are different kinds of value, and the platform converted
 * between them with a copy of the same one-liner in every file that needed one: thirteen for
 * days, eight more for "today", and five month-range walkers. Two of those copies shipped a
 * defect (NZC-096, NZC-105) and nine more were carrying one when they were counted. This file
 * is the single place that knows how, and each function says which kind of value it is for —
 * because picking the wrong one is exactly how the day moves.
 *
 * ## The three cases, and why each needs its own name
 *
 * **`dateOnly` — a SQL `date`.** `node-postgres` materialises a `date` as *local* midnight,
 * so `toISOString()` rolls it back a day wherever the process runs ahead of UTC. London in
 * BST is ahead of UTC, and the staging server resolves "today" in London, so this is not a
 * theoretical exposure. A `date` carries no time and no zone; it must not acquire one on the
 * way out of the database, so the local components are read back verbatim.
 *
 * **`utcDay` — an instant that was deliberately anchored to UTC.** A training place expires
 * at `${day}T23:59:59Z`: the day it was granted for is recoverable *only* by reading it in
 * UTC. Reading that value locally would move the expiry forward at a positive offset and
 * leave a lapsed place looking available. Here UTC is the correct answer, and saying so by
 * name stops a later sweep from "fixing" it into a bug.
 *
 * **`todayInLondon` — the platform's operating day.** Neither of the above: there is no
 * stored value, only a question about now. `new Date().toISOString().slice(0, 10)` answers
 * it in UTC, which is yesterday between midnight and 01:00 BST — and that answer decides
 * whether a job is overdue and whether a certificate has lapsed. NZC-105 settled that the
 * platform day is London, resolved on the server, so the zone is stated rather than
 * inherited from wherever the process happens to run.
 */

/**
 * The zone the business operates in. Named, not assumed: the correctness of every "today"
 * below depends on it, and a deployment that moved would otherwise change the answer
 * silently.
 */
export const PLATFORM_TIME_ZONE = "Europe/London";

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * The day a SQL `date` denotes.
 *
 * Accepts the string form untouched, because a driver configured to hand back strings is
 * already giving the right answer and slicing it is not a conversion.
 */
export const dateOnly = (value: Date | string): string =>
  value instanceof Date
    ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
    : String(value).slice(0, 10);

/** `dateOnly`, preserving null — for a nullable `date` column. */
export const dateOnlyOrNull = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : dateOnly(value);

/**
 * The day an instant falls on **in UTC**. Only for values written against a UTC anchor;
 * for a SQL `date`, use `dateOnly` instead.
 */
export const utcDay = (value: Date | string): string =>
  value instanceof Date
    ? `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
    : String(value).slice(0, 10);

/** `utcDay`, preserving null. */
export const utcDayOrNull = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : utcDay(value);

/**
 * Today, in the zone the platform operates in (NZC-105).
 *
 * `en-CA` is not a locale choice — it is the one built-in format that is already
 * `YYYY-MM-DD`, so no reassembly is needed and no part can be transposed.
 */
export const todayInLondon = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: PLATFORM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

/** The month a day belongs to, as `YYYY-MM`. */
export const monthKey = (day: string): string => day.slice(0, 7);

/**
 * Every month from `from` to `to` inclusive, as `YYYY-MM` keys.
 *
 * This walker existed five times over — in two read models, a command, a portal grant check
 * and the scope workspace — and it is what a reporting period's monthly entry grid, its
 * coverage checks and its distribution all count with. Five copies of the thing that decides
 * how many months a period has is how NZC-105 happened, and PR 2's distribution work is
 * about to add a sixth, so it is said once here.
 *
 * The cursor is built and read entirely in UTC. That is deliberate and not a day-value
 * question: month arithmetic on a local-midnight cursor can skip or repeat a month across a
 * DST boundary, whereas UTC months are uniform. Endpoints must already be day strings — pass
 * a `date` column through `dateOnly` first.
 *
 * `maxMonths` caps the result where a caller has a reason to (a portal grant will not draw a
 * grid of 200 months); left undefined there is no cap, so nothing is silently truncated.
 */
export function monthsBetween(from: string, to: string, maxMonths?: number): string[] {
  const months: string[] = [];
  const cursor = new Date(`${monthKey(from)}-01T00:00:00Z`);
  const end = monthKey(to);
  if (Number.isNaN(cursor.getTime())) return months;
  while (utcMonthKey(cursor) <= end && (maxMonths === undefined || months.length < maxMonths)) {
    months.push(utcMonthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

const utcMonthKey = (value: Date): string => `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}`;
