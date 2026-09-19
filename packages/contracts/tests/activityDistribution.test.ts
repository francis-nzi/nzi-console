import assert from "node:assert/strict";
import { test } from "node:test";
import { monthsBetween } from "../src/dayValues";
import {
  DISTRIBUTION_SCALE, distributeActivity, distributeEvenly, figureCountFor, monthSpansFor, totalOfSlots,
} from "../src/activityDistribution";

/**
 * Distribution, asserted as correct — not pinned as current. There is no current behaviour here;
 * every assertion below is what the mechanism is required to do (NZC-107).
 *
 * The one that matters most is the round trip. Both resolvers derive the annual quantity by summing
 * the stored months, so a figure that goes in and comes back different is a client's number changed
 * with nobody told. Every awkward value anyone could think of is therefore tried, and the test is
 * the same each time: **sum the months exactly as the resolver does, and get back what was typed.**
 */

const APRIL_TO_MARCH = monthsBetween("2025-04-01", "2026-03-31");

/** Precisely how the resolvers add a vector up: left to right, populated slots only. */
const resolverSum = (slots: Array<{ quantity: number | null }>) =>
  slots.filter((slot) => slot.quantity !== null).reduce((sum, slot) => sum + (slot.quantity ?? 0), 0);

test("a twelve-month period is twelve months, and an annual figure covers all of them", () => {
  assert.equal(APRIL_TO_MARCH.length, 12);
  assert.deepEqual(monthSpansFor("annual", APRIL_TO_MARCH), [APRIL_TO_MARCH]);
  assert.equal(figureCountFor("annual", APRIL_TO_MARCH), 1);
  assert.equal(figureCountFor("quarterly", APRIL_TO_MARCH), 4);
  assert.equal(figureCountFor("monthly", APRIL_TO_MARCH), 12);
});

test("quarters are counted from the period, so an April year starts its first quarter in April", () => {
  const quarters = monthSpansFor("quarterly", APRIL_TO_MARCH);
  assert.deepEqual(quarters[0], ["2025-04", "2025-05", "2025-06"]);
  assert.deepEqual(quarters[3], ["2026-01", "2026-02", "2026-03"]);
});

test("an annual figure divides evenly and sums back exactly", () => {
  const { slots, distributed } = distributeActivity({ frequency: "annual", figures: [1200], months: APRIL_TO_MARCH });
  assert.equal(slots.length, 12);
  assert.equal(distributed, true);
  assert.ok(slots.every((slot) => slot.quantity === 100));
  assert.equal(resolverSum(slots), 1200);
});

/** Figures that divide badly by twelve or by three, plus the edges. */
const AWKWARD = [
  120001,        // a pound that will not divide by twelve
  100 / 3,       // a figure that is already a repeating fraction
  0.01,          // a penny across a year
  999_999.99,    // pennies at scale
  1,             // one unit across twelve months
  0.000_001,     // a single minor unit
  12345.678,     // ordinary, but not divisible
  7,             // small and prime
];

test("an annual figure comes back exactly — this is the whole point", () => {
  // The requirement is not "close". One figure covering the period: the stored months, summed the
  // way the resolver sums them, equal what was typed.
  for (const figure of AWKWARD) {
    const { slots } = distributeActivity({ frequency: "annual", figures: [figure], months: APRIL_TO_MARCH });
    assert.equal(slots.length, 12);
    assert.equal(resolverSum(slots), figure, `${figure} summed back to ${resolverSum(slots)}`);
  }
});

test("each quarter's months sum back to that quarter's figure exactly", () => {
  // The invariant is per figure, and deliberately so: a quarter's months belong to that quarter and
  // must account for it exactly. Value is never moved between quarters to tidy a total.
  for (const figure of AWKWARD) {
    const { slots } = distributeActivity({
      frequency: "quarterly", figures: [figure, figure, figure, figure], months: APRIL_TO_MARCH,
    });
    const quarters = [slots.slice(0, 3), slots.slice(3, 6), slots.slice(6, 9), slots.slice(9, 12)];
    for (const [index, quarter] of quarters.entries()) {
      assert.equal(resolverSum(quarter), figure, `quarter ${index + 1} of ${figure} summed back to ${resolverSum(quarter)}`);
    }
  }
});

test("a multi-figure total loses no minor unit, which is the precision anything is stored at", () => {
  // Exactness is guaranteed *per figure*, because a quarter's months must account for that quarter
  // and value is never moved between quarters to tidy a grand total. Adding four quarters together
  // afterwards costs whatever binary addition costs — it costs the same if you add the four numbers
  // without distributing them at all.
  //
  // So the claim made here is the one that means something: across the whole vector, not a single
  // minor unit is lost or invented. Any residue is below the precision anything is stored at.
  for (const figure of AWKWARD) {
    const figures = [figure, figure, figure, figure];
    const { slots } = distributeActivity({ frequency: "quarterly", figures, months: APRIL_TO_MARCH });
    const quarterTotal = figures.reduce((sum, value) => sum + value, 0);
    assert.equal(
      Math.round(resolverSum(slots) * DISTRIBUTION_SCALE),
      Math.round(quarterTotal * DISTRIBUTION_SCALE),
      `${figure} × 4: months give ${resolverSum(slots)}, quarters give ${quarterTotal}`);
  }
});

test("the remainder is allocated to the earliest months, not dropped and not scattered", () => {
  // 1 across twelve months is 0.083333 each with four millionths spare; the first four months take
  // one each. Deterministic, so the same input always writes the same vector.
  const parts = distributeEvenly(1, 12);
  const units = parts.map((part) => Math.round(part * DISTRIBUTION_SCALE));
  assert.deepEqual(units.slice(0, 4), [83334, 83334, 83334, 83334]);
  assert.deepEqual(units.slice(4, 8), [83333, 83333, 83333, 83333]);
  // Every month differs from its neighbour by at most one minor unit.
  assert.ok(Math.max(...units) - Math.min(...units) <= 1);
  assert.equal(parts.reduce((sum, part) => sum + part, 0), 1);
});

test("a monthly figure is not distributed — it lands in its own month, untouched", () => {
  const figures = APRIL_TO_MARCH.map((_, index) => index + 1);
  const { slots, distributed } = distributeActivity({ frequency: "monthly", figures, months: APRIL_TO_MARCH });
  assert.equal(distributed, false, "a figure supplied for its own month was not derived");
  assert.deepEqual(slots.map((slot) => slot.quantity), figures);
  assert.deepEqual(slots.map((slot) => slot.month), APRIL_TO_MARCH);
});

test("a part-year period apportions only to the months it covers", () => {
  // A five-month transition period. An annual figure spreads across five months, not twelve, and
  // never past the period's end.
  const months = monthsBetween("2025-11-01", "2026-03-31");
  assert.equal(months.length, 5);
  const { slots } = distributeActivity({ frequency: "annual", figures: [500], months });
  assert.equal(slots.length, 5);
  assert.equal(slots.at(-1)!.month, "2026-03");
  assert.ok(slots.every((slot) => slot.quantity === 100));
  assert.equal(resolverSum(slots), 500);
});

test("a quarterly period whose last span is short spreads over the months it actually has", () => {
  // Fourteen months — a transition year. Four full quarters and a two-month tail: the tail's figure
  // spreads over two months rather than being given a phantom third.
  const months = monthsBetween("2025-01-01", "2026-02-28");
  assert.equal(months.length, 14);
  const spans = monthSpansFor("quarterly", months);
  assert.equal(spans.length, 5);
  assert.deepEqual(spans.at(-1), ["2026-01", "2026-02"]);

  const { slots } = distributeActivity({ frequency: "quarterly", figures: [300, 300, 300, 300, 100], months });
  assert.equal(slots.length, 14);
  assert.equal(slots.at(-1)!.quantity, 50);
  assert.equal(resolverSum(slots), 1300);
});

test("a figure that was not supplied stays unsupplied, and is not a zero", () => {
  // The distinction both resolvers already make and distribution must not erase: a quarter nobody
  // has filled in is not a quarter of no emissions.
  const { slots, distributed } = distributeActivity({
    frequency: "quarterly", figures: [300, null, null, null], months: APRIL_TO_MARCH,
  });
  assert.equal(slots.length, 12);
  assert.equal(distributed, true);
  assert.deepEqual(slots.slice(3).map((slot) => slot.quantity), Array.from({ length: 9 }, () => null));
  assert.equal(totalOfSlots(slots), 300);
});

test("no figures at all is no total, rather than a total of zero", () => {
  const { slots, distributed } = distributeActivity({
    frequency: "quarterly", figures: [null, null, null, null], months: APRIL_TO_MARCH,
  });
  assert.equal(distributed, false, "nothing was derived because nothing was supplied");
  assert.equal(totalOfSlots(slots), null);
  assert.equal(slots.length, 12);
});

test("a zero is a figure, and is not the same as nothing", () => {
  const { slots } = distributeActivity({ frequency: "annual", figures: [0], months: APRIL_TO_MARCH });
  assert.ok(slots.every((slot) => slot.quantity === 0));
  assert.equal(totalOfSlots(slots), 0);
});

test("the wrong number of figures is refused rather than padded or truncated", () => {
  assert.throws(() => distributeActivity({ frequency: "quarterly", figures: [1, 2, 3], months: APRIL_TO_MARCH }), /Expected 4/);
  assert.throws(() => distributeActivity({ frequency: "annual", figures: [1, 2], months: APRIL_TO_MARCH }), /Expected 1/);
});

test("a figure too large to distribute exactly is refused, not silently rounded", () => {
  assert.throws(() => distributeEvenly(Number.MAX_SAFE_INTEGER, 12), /too large/);
  assert.throws(() => distributeEvenly(Number.POSITIVE_INFINITY, 12), /finite/);
});

test("the vector is always the full period, in order, which is what the resolvers demand", () => {
  for (const frequency of ["annual", "quarterly", "monthly"] as const) {
    const figures = Array.from({ length: figureCountFor(frequency, APRIL_TO_MARCH) }, () => 12);
    const { slots } = distributeActivity({ frequency, figures, months: APRIL_TO_MARCH });
    assert.deepEqual(slots.map((slot) => slot.month), APRIL_TO_MARCH,
      `${frequency} must produce each reporting month once, in order`);
  }
});
