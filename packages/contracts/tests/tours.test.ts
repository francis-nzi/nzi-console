import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  shouldAutoRun, tourForPath, tourStatus,
  type TourDefinition, type TourSeen,
} from "../src/tours";

/**
 * The tour engine's rules. The one that matters most: a materially revised tour must
 * re-surface for the people who saw the old one, rather than being silently suppressed for
 * exactly the users who most need the new version.
 */

const tour = (over: Partial<TourDefinition> = {}): TourDefinition => ({
  id: "client-workspace", version: 1, path: "/clients",
  title: "The client workspace", summary: "Where a client's record lives.",
  steps: [{ anchor: ".nz-client-head", title: "The client", body: "Who they are." }],
  ...over,
});

const seen = (over: Partial<TourSeen> = {}): TourSeen => ({
  tourId: "client-workspace", tourVersion: 1, dismissed: false, seenAt: "2026-09-16T09:00:00Z", ...over,
});

describe("auto-run is once per person per version", () => {
  it("runs for someone who has not seen it", () => {
    assert.equal(shouldAutoRun(tour(), []), true);
  });

  it("does not run again for someone who has", () => {
    assert.equal(shouldAutoRun(tour(), [seen()]), false);
  });

  it("does not run again for someone who dismissed it", () => {
    // Both reaching the end and asking not to see it again stop the auto-run; only one of
    // them is a preference, which is why the record keeps them apart.
    assert.equal(shouldAutoRun(tour(), [seen({ dismissed: true })]), false);
  });

  it("RE-SURFACES when the tour is materially revised", () => {
    // The point of keying seen-state on the version. Keying on the tour alone would hide a
    // rewritten tour from the people already using the page.
    assert.equal(shouldAutoRun(tour({ version: 2 }), [seen({ tourVersion: 1 })]), true);
  });

  it("is not confused by another tour's record", () => {
    assert.equal(shouldAutoRun(tour(), [seen({ tourId: "jobs" })]), true);
  });
});

describe("which tour belongs to a page", () => {
  const tours = [
    tour({ id: "clients", path: "/clients", version: 1 }),
    tour({ id: "client-workspace", path: "/clients/bushy-tails", version: 1 }),
    tour({ id: "control", path: "/", version: 1 }),
  ];

  it("takes the most specific match", () => {
    assert.equal(tourForPath(tours, "/clients/bushy-tails")?.id, "client-workspace");
    assert.equal(tourForPath(tours, "/clients")?.id, "clients");
  });

  it("does not let the root tour claim every page", () => {
    // The bug this guards: "/" prefix-matching everything, so every page shows the Control
    // Room tour.
    assert.equal(tourForPath(tours, "/")?.id, "control");
    assert.equal(tourForPath(tours, "/jobs"), null);
  });

  it("returns nothing where no tour has been authored", () => {
    assert.equal(tourForPath(tours, "/datasets"), null);
  });
});

describe("what the Guide tab says", () => {
  it("distinguishes never-seen from already-done", () => {
    assert.equal(tourStatus(tour(), []).kind, "unseen");
    assert.equal(tourStatus(tour(), [seen()]).kind, "completed");
  });

  it("distinguishes dismissed from completed, because they are different acts", () => {
    const status = tourStatus(tour(), [seen({ dismissed: true })]);
    assert.equal(status.kind, "dismissed");
    assert.match(status.detail, /You can still replay it/);
  });

  it("says a tour has been updated rather than presenting it as new", () => {
    const status = tourStatus(tour({ version: 2 }), [seen({ tourVersion: 1 })]);
    assert.equal(status.kind, "revised");
    assert.match(status.detail, /updated since you last saw it/);
  });

  it("says no tour exists rather than implying you have done it", () => {
    const status = tourStatus(null, []);
    assert.equal(status.kind, "none");
    assert.match(status.detail, /authored per page/);
  });
});
