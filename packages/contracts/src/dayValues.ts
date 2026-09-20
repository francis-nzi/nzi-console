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

/**
 * An instant as the platform's clock shows it, in the form a `datetime-local` input takes
 * (`YYYY-MM-DDTHH:mm`) — and back again (NZC-114).
 *
 * A `datetime-local` value carries no zone. Whoever renders it and whoever parses it must therefore
 * agree on which clock it is, and if they disagree the value moves by the difference *every time it
 * is saved* — a drift that compounds rather than a one-off error.
 *
 * Both directions are stated here, together, for that reason: they are one contract, and splitting
 * them across two files is how they came to disagree in the first place.
 *
 * **The zone is the platform's, not the browser's.** A consultant in Madrid editing a UK client's
 * access window must not move it by an hour because of where they happened to be sitting. NZC-105
 * settled that the platform's clock is London; these follow it.
 */
const ZONE_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: PLATFORM_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** The wall-clock reading in the platform's zone, as numbers. */
function platformClockParts(instant: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = Object.fromEntries(
    ZONE_PARTS.formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return {
    year: parts.year!, month: parts.month!, day: parts.day!,
    hour: parts.hour!, minute: parts.minute!, second: parts.second!,
  };
}

/** How far ahead of UTC the platform's clock is at a given instant, in minutes. */
function platformOffsetMinutes(instant: Date): number {
  const clock = platformClockParts(instant);
  const asIfUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  return (asIfUtc - instant.getTime()) / 60_000;
}

/** An instant, written as the platform's clock shows it: `YYYY-MM-DDTHH:mm`. */
export function platformDateTimeLocal(instant: Date | string): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  const clock = platformClockParts(date);
  return `${clock.year}-${pad(clock.month)}-${pad(clock.day)}T${pad(clock.hour)}:${pad(clock.minute)}`;
}

/**
 * A `YYYY-MM-DDTHH:mm` reading of the platform's clock, as the instant it names.
 *
 * The offset depends on the answer, so two candidates are computed — one using the offset at the
 * reading taken as UTC, one using the offset at where that lands — and then checked by formatting
 * them back. On all but two days a year exactly one candidate reads back as the reading given, and
 * that is the answer.
 *
 * ## The two days a year, decided rather than left to fall out
 *
 * **The hour that happens twice** (clocks back, an autumn Sunday): both candidates read back
 * correctly, because the reading genuinely names two instants. The **earlier** is taken. That is
 * the usual convention for an overlap, and here it is also the safe one: this value is an access
 * window, and taking the earlier instant can only end access sooner or start it sooner — it can
 * never extend a window past what somebody intended.
 *
 * **The hour that never happens** (clocks forward, a spring Sunday): neither candidate reads back,
 * because the reading names no instant at all. The later candidate is taken, which is the moment
 * the clock jumps to. A window an hour from where it was typed is bad; a window with no time at all
 * is worse.
 *
 * One consequence is stated plainly because it cannot be designed away: for the single repeated
 * hour each year, an instant that is re-rendered and re-submitted moves to the earlier of the two —
 * it can shift by an hour once, in the direction that closes access rather than opens it, and never
 * repeatedly. Every other hour of the year round-trips exactly, which is pinned across both
 * transitions.
 */
export function instantFromPlatformDateTimeLocal(value: string): string | null {
  const reading = String(value ?? "");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(reading);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as unknown as number[];
  const readingAsUtc = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  if (Number.isNaN(readingAsUtc)) return null;

  // The reading as given, to compare a candidate against: already zero-padded by the pattern.
  const wanted = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`;

  // The offsets in force on either side of the reading, half a day out in each direction — far
  // enough to be clear of any transition, close enough that no other one intervenes. Sampling the
  // offset *at* the reading would find only one of them, which is exactly how an overlapping hour
  // ends up with a single candidate and the choice below never gets made.
  const HALF_DAY = 12 * 60 * 60 * 1000;
  const offsets = [
    platformOffsetMinutes(new Date(readingAsUtc - HALF_DAY)),
    platformOffsetMinutes(new Date(readingAsUtc + HALF_DAY)),
  ];
  const options = [...new Set(offsets.map((offset) => readingAsUtc - offset * 60_000))].sort((a, b) => a - b);
  const readsBack = options.filter((instant) => platformDateTimeLocal(new Date(instant)) === wanted);
  // Ambiguous: earliest, which can only close a window sooner. Impossible: the later, which is the
  // instant the clock jumps to. Ordinary: the only one that reads back.
  const chosen = readsBack.length > 0 ? readsBack[0]! : options[options.length - 1]!;
  return new Date(chosen).toISOString();
}

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
