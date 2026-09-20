import assert from "node:assert/strict";
import { test } from "node:test";
import { instantFromPlatformDateTimeLocal, platformDateTimeLocal } from "../src/dayValues";

/**
 * A portal access window keeps its hour (NZC-114).
 *
 * **Assert-correct, not pin-current.** Every assertion here was red before the fix: the input was
 * filled with UTC wall-clock while the submit read it back as *browser*-local, so the two disagreed
 * by the offset and a window moved every time it was saved.
 *
 * The round trip is what these tests are about, because that is where the defect compounded. A
 * single wrong render is an hour out; a render and a parse that disagree lose an hour **per save**,
 * so a window edited three times in summer has walked back three hours and nothing has reported an
 * error. `saveAgain` below is that sequence: show it, save it untouched, show it again.
 */

/** What the browser does: render into the input, submit it back unchanged. */
const saveAgain = (instantIso: string): string =>
  instantFromPlatformDateTimeLocal(platformDateTimeLocal(instantIso))!;

test("a summer window shows the hour the platform's clock shows, not UTC's", () => {
  // 17:00Z on 1 July is 18:00 in London. The input must say 18:00, or a consultant reads the wrong
  // window and a client is locked out an hour early.
  assert.equal(platformDateTimeLocal("2026-07-01T17:00:00.000Z"), "2026-07-01T18:00");
});

test("a winter window shows the same hour as UTC, because London is UTC then", () => {
  assert.equal(platformDateTimeLocal("2026-01-15T17:00:00.000Z"), "2026-01-15T17:00");
});

test("saving an untouched window does not move it — the defect, directly", () => {
  const window = "2026-07-01T17:00:00.000Z";
  assert.equal(saveAgain(window), window);
});

test("saving it repeatedly does not walk it backwards, which is how an hour became three", () => {
  let instant = "2026-07-01T17:00:00.000Z";
  for (let save = 0; save < 5; save += 1) instant = saveAgain(instant);
  assert.equal(instant, "2026-07-01T17:00:00.000Z", "five saves, same window");
});

test("the round trip holds in winter too", () => {
  const window = "2026-01-15T17:00:00.000Z";
  assert.equal(saveAgain(window), window);
});

test("an edit lands on the hour the consultant typed, read as the platform's clock", () => {
  // Typed "18:00" on a July evening: that is 18:00 London, which is 17:00Z. Not 18:00Z, and not
  // 18:00 wherever the consultant happens to be sitting.
  assert.equal(instantFromPlatformDateTimeLocal("2026-07-01T18:00"), "2026-07-01T17:00:00.000Z");
  assert.equal(instantFromPlatformDateTimeLocal("2026-01-15T18:00"), "2026-01-15T18:00:00.000Z");
});

test("the round trip holds every hour of the year except the one that happens twice", () => {
  // Every hour of two days either side of each transition, rather than a sampled few — the defect
  // only showed itself at particular offsets, so this walks the offsets.
  //
  // The single exception is stated rather than skipped: during the repeated hour a wall-clock
  // reading names two instants, so one of them cannot survive a round trip whichever is chosen.
  // The later one moves to the earlier one — once, never repeatedly, and in the direction that
  // closes an access window rather than extends it.
  const REPEATED_HOUR = "2026-10-25T01:00:00.000Z";
  for (const day of ["2026-03-28", "2026-03-29", "2026-03-30", "2026-10-24", "2026-10-25", "2026-10-26"]) {
    for (let hour = 0; hour < 24; hour += 1) {
      const instant = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`).toISOString();
      if (instant === REPEATED_HOUR) {
        assert.equal(saveAgain(instant), "2026-10-25T00:00:00.000Z", "the repeated hour resolves to the earlier of the two");
        // And it settles: saving again does not move it a second time.
        assert.equal(saveAgain(saveAgain(instant)), "2026-10-25T00:00:00.000Z");
        continue;
      }
      assert.equal(saveAgain(instant), instant, `${instant} moved`);
    }
  }
});

test("the hour that happens twice resolves to the earlier of them, deliberately", () => {
  // 25 October 2026, clocks go back at 02:00 BST → 01:00 GMT, so "01:30" names both 00:30Z and
  // 01:30Z. An access window must have an answer rather than a refusal, and the earlier is the safe
  // one to pick: it can only close a window sooner, never extend one past what was intended.
  assert.equal(instantFromPlatformDateTimeLocal("2026-10-25T01:30"), "2026-10-25T00:30:00.000Z");
  // Both really are the same reading — which is why one of them cannot round-trip.
  assert.equal(platformDateTimeLocal("2026-10-25T00:30:00.000Z"), "2026-10-25T01:30");
  assert.equal(platformDateTimeLocal("2026-10-25T01:30:00.000Z"), "2026-10-25T01:30");
});

test("the hour that never happens lands on a real instant rather than nothing", () => {
  // 29 March 2026, clocks go forward at 01:00 GMT → 02:00 BST, so "01:30" does not exist. It
  // resolves to the instant the clock jumps to instead of returning null, because a window with no
  // time is worse than a window an hour off, and it is pinned so it cannot change unnoticed.
  const resolved = instantFromPlatformDateTimeLocal("2026-03-29T01:30");
  assert.equal(resolved, "2026-03-29T01:30:00.000Z");
  // And it is a real instant: reading it back gives a time that exists.
  assert.equal(platformDateTimeLocal(resolved!), "2026-03-29T02:30");
});

test("an empty or malformed value is nothing, not a guess", () => {
  assert.equal(instantFromPlatformDateTimeLocal(""), null);
  assert.equal(instantFromPlatformDateTimeLocal("not a time"), null);
  assert.equal(instantFromPlatformDateTimeLocal("2026-07-01"), null, "a date with no time is not a moment");
  assert.equal(platformDateTimeLocal(""), "");
  assert.equal(platformDateTimeLocal("not a time"), "");
});

test("the answer does not depend on where the consultant is sitting", () => {
  // The property the browser-local parse broke. These run under whatever zone the suite runs in,
  // and the zone matrix in CI runs them under four — so a result that depended on the local zone
  // would disagree between runs.
  assert.equal(platformDateTimeLocal("2026-07-01T17:00:00.000Z"), "2026-07-01T18:00");
  assert.equal(instantFromPlatformDateTimeLocal("2026-07-01T18:00"), "2026-07-01T17:00:00.000Z");
});
