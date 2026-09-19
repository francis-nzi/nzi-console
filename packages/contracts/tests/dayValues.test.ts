import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PLATFORM_TIME_ZONE, dateOnly, dateOnlyOrNull, monthKey, monthsBetween, todayInLondon, utcDay, utcDayOrNull,
} from "../src/dayValues";

/**
 * The day helpers, pinned — an assert-correct tripwire, not a record of current behaviour.
 *
 * These assertions are the statements NZC-096 and NZC-105 turned out to be wrong about, and
 * they are written so they fail in the zone where the defect appeared rather than only in the
 * one where it happened to be found. `npm test` runs in whatever zone the machine is in, so
 * the cases that matter construct their own offset explicitly instead of trusting `TZ`.
 *
 * The one thing no unit test here can prove is what `node-postgres` hands back for a `date`
 * column — that needs a real database, and `dateShiftGuards.test.ts` does it there.
 */

/** A Date exactly as node-postgres materialises a SQL `date`: local midnight, no zone. */
const localMidnight = (year: number, month: number, day: number) => new Date(year, month - 1, day);

test("a SQL date keeps its own day, whatever the process's offset", () => {
  // The whole defect in one line. Under Europe/London in summer this Date is
  // 2025-03-31T23:00:00Z, so reading it as an instant answers with March.
  assert.equal(dateOnly(localMidnight(2025, 4, 1)), "2025-04-01");
  assert.equal(dateOnly(localMidnight(2026, 1, 1)), "2026-01-01");
  assert.equal(dateOnly(localMidnight(2025, 12, 31)), "2025-12-31");
});

test("a day string is passed through, not reinterpreted", () => {
  // A driver configured to return strings is already giving the right answer.
  assert.equal(dateOnly("2025-04-01"), "2025-04-01");
  assert.equal(dateOnly("2025-04-01T00:00:00Z"), "2025-04-01");
});

test("the nullable forms preserve null and nothing else", () => {
  assert.equal(dateOnlyOrNull(null), null);
  assert.equal(dateOnlyOrNull(undefined), null);
  assert.equal(dateOnlyOrNull(localMidnight(2025, 4, 1)), "2025-04-01");
  assert.equal(utcDayOrNull(null), null);
  assert.equal(utcDayOrNull(new Date("2026-03-31T23:59:59Z")), "2026-03-31");
});

test("utcDay reads a UTC-anchored instant in UTC, which is the point of it", () => {
  // How a training entitlement's expiry is written: `<day>T23:59:59Z`. The day it was granted
  // for is recoverable only in UTC — locally, at +13, this instant is 1 April.
  assert.equal(utcDay(new Date("2026-03-31T23:59:59Z")), "2026-03-31");
  assert.equal(utcDay(new Date("2026-01-01T00:00:00Z")), "2026-01-01");
});

test("dateOnly and utcDay disagree, and the difference is the whole reason both exist", () => {
  // Same instant, two questions. A sweep that "unified" these would reintroduce the defect
  // from the other side: a lapsed training place would read as available for a day.
  const endOfDayUtc = new Date("2026-03-31T23:59:59Z");
  assert.equal(utcDay(endOfDayUtc), "2026-03-31");
  const localDay = dateOnly(endOfDayUtc);
  assert.match(localDay, /^\d{4}-\d{2}-\d{2}$/);
  // In a zone ahead of UTC the local day is already the next one; behind, it is the same.
  const offsetMinutes = -endOfDayUtc.getTimezoneOffset();
  assert.equal(localDay, offsetMinutes > 0 ? "2026-04-01" : "2026-03-31");
});

test("today is the platform's day, not the process's", () => {
  // 00:30 on 1 April, London — 23:30 on 31 March in UTC. The UTC answer is yesterday, and it
  // is the one that decided whether a job was overdue.
  const justAfterMidnightBst = new Date("2026-03-31T23:30:00Z");
  assert.equal(todayInLondon(justAfterMidnightBst), "2026-04-01");
  assert.equal(justAfterMidnightBst.toISOString().slice(0, 10), "2026-03-31");
  // And in winter, when London is UTC, the two agree.
  assert.equal(todayInLondon(new Date("2026-01-15T23:30:00Z")), "2026-01-15");
  assert.equal(PLATFORM_TIME_ZONE, "Europe/London");
});

test("today is stated in the platform's zone wherever the process runs", () => {
  // The same instant, asked from a server anywhere: the answer is a property of the zone the
  // business operates in, so it cannot depend on where the process happens to be.
  const instant = new Date("2026-06-30T22:30:00Z"); // 23:30 London, 1 July in Auckland
  assert.equal(todayInLondon(instant), "2026-06-30");
});

test("a month range covers both ends, in every month arithmetic can trip over", () => {
  assert.deepEqual(monthsBetween("2025-04-01", "2025-06-30"), ["2025-04", "2025-05", "2025-06"]);
  // The April–March reporting year: twelve months, not thirteen (NZC-105).
  assert.equal(monthsBetween("2025-04-01", "2026-03-31").length, 12);
  // A single month, and a period inside one month, are each one month.
  assert.deepEqual(monthsBetween("2025-04-01", "2025-04-30"), ["2025-04"]);
  assert.deepEqual(monthsBetween("2025-04-10", "2025-04-12"), ["2025-04"]);
  // Across a DST boundary in both directions, and across a year end. A cursor advanced on a
  // local-midnight date can skip or repeat a month here; a UTC one cannot.
  assert.deepEqual(monthsBetween("2025-10-01", "2026-01-31"), ["2025-10", "2025-11", "2025-12", "2026-01"]);
  assert.equal(monthsBetween("2025-01-31", "2025-03-31").length, 3);
});

test("a month range ends where it should, and caps only when asked", () => {
  assert.deepEqual(monthsBetween("2025-06-01", "2025-04-30"), []);
  assert.equal(monthsBetween("2020-01-01", "2029-12-31").length, 120);
  assert.equal(monthsBetween("2020-01-01", "2029-12-31", 24).length, 24);
  assert.deepEqual(monthsBetween("2025-04-01", "2025-12-31", 2), ["2025-04", "2025-05"]);
  // Unparseable input answers with nothing rather than looping.
  assert.deepEqual(monthsBetween("not-a-date", "2025-12-31"), []);
});

test("monthKey is the month a day belongs to", () => {
  assert.equal(monthKey("2025-04-01"), "2025-04");
  assert.equal(monthKey("2025-12-31"), "2025-12");
});
