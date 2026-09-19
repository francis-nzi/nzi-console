import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dateOnly, monthsBetween, utcDay } from "../src/index";
import { dateOnly as fromContracts } from "@nzi/contracts";

/**
 * The day helpers are reachable from this package, and are the *same* helpers.
 *
 * What each one means, and every case it has to get right, is pinned once in
 * `@nzi/contracts/tests/dayValues.test.ts` — this file deliberately does not restate it. It
 * guards the boundary instead: `isolated-backend` re-exports the helpers so its own callers
 * keep their import, and a re-export is only worth anything if it resolves to the definition
 * rather than to a copy someone added here later (NZC-106).
 */

describe("the day helpers, as this package exposes them", () => {
  it("are the definitions from @nzi/contracts, not a second copy", () => {
    // Identity, not equivalence: two functions that behave the same today are exactly how the
    // eleven copies started. This fails the moment a local definition reappears.
    assert.equal(dateOnly, fromContracts);
  });

  it("are exported from the package root, which is how every caller reaches them", () => {
    assert.equal(typeof dateOnly, "function");
    assert.equal(typeof utcDay, "function");
    assert.equal(typeof monthsBetween, "function");
    // One live case each, as a smoke test of the wiring rather than of the semantics.
    assert.equal(dateOnly(new Date(2022, 3, 1)), "2022-04-01");
    assert.equal(utcDay(new Date("2026-03-31T23:59:59Z")), "2026-03-31");
    assert.equal(monthsBetween("2025-04-01", "2026-03-31").length, 12);
  });
});
