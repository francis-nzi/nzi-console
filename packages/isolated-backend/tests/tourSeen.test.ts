import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldAutoRun, type TourDefinition } from "@nzi/contracts";
import { listTourSeen, recordTourSeen } from "../src/tourSeen";

/**
 * The seen-state loop, end to end: a new person sees the tour once, does not see it again on
 * their next visit, can always replay it, and sees it again when it is materially revised.
 *
 * Driven through a fake `Queryable` that behaves like the table's actual key — including the
 * upsert — so what is asserted is the round trip, not a stub agreeing with itself.
 */

const ORG = "demo-nzi-console";
const tour: TourDefinition = {
  id: "client-workspace", version: 1, path: "/clients",
  title: "The client workspace", summary: "…",
  steps: [{ anchor: ".nz-client-head", title: "The client", body: "Who they are." }],
};

/** Stands in for the table, keyed exactly as the migration keys it. */
function fakeDb() {
  const rows = new Map<string, { user_id: string; tour_id: string; tour_version: number; dismissed: boolean; seen_at: string }>();
  return {
    rows,
    async query(sql: string, params: readonly unknown[] = []) {
      if (sql.includes("SELECT tour_id")) {
        return { rows: [...rows.values()].filter((row) => row.user_id === params[0]) };
      }
      if (sql.includes("INSERT INTO nzi_console.help_tour_seen")) {
        const [, userId, tourId, tourVersion, dismissed] = params as [string, string, string, number, boolean];
        const key = `${userId}|${tourId}|${tourVersion}`;
        const existing = rows.get(key);
        rows.set(key, {
          user_id: userId, tour_id: tourId, tour_version: tourVersion,
          // The migration's ON CONFLICT: once dismissed, always dismissed.
          dismissed: (existing?.dismissed ?? false) || dismissed,
          seen_at: new Date().toISOString(),
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("a person is taught a page once", () => {
  it("runs for a new person, then not again on their next visit", async () => {
    const db = fakeDb();
    assert.equal(shouldAutoRun(tour, await listTourSeen(db as never, "user-a")), true, "first visit");

    await recordTourSeen(db as never, { organisationId: ORG, userId: "user-a", tourId: tour.id, tourVersion: tour.version, dismissed: false });

    assert.equal(shouldAutoRun(tour, await listTourSeen(db as never, "user-a")), false, "second visit");
  });

  it("still runs for a different person — it is per user, not per page", async () => {
    const db = fakeDb();
    await recordTourSeen(db as never, { organisationId: ORG, userId: "user-a", tourId: tour.id, tourVersion: 1, dismissed: false });
    assert.equal(shouldAutoRun(tour, await listTourSeen(db as never, "user-b")), true);
  });

  it("re-surfaces when the tour is revised, for the person who saw the old one", async () => {
    // The acceptance criterion, and the reason the version is in the key.
    const db = fakeDb();
    await recordTourSeen(db as never, { organisationId: ORG, userId: "user-a", tourId: tour.id, tourVersion: 1, dismissed: false });
    const revised: TourDefinition = { ...tour, version: 2 };
    assert.equal(shouldAutoRun(revised, await listTourSeen(db as never, "user-a")), true);
  });

  it("records once per version rather than stacking a row per viewing", async () => {
    const db = fakeDb();
    for (let i = 0; i < 3; i += 1) {
      await recordTourSeen(db as never, { organisationId: ORG, userId: "user-a", tourId: tour.id, tourVersion: 1, dismissed: false });
    }
    assert.equal((await listTourSeen(db as never, "user-a")).length, 1);
  });

  it("keeps a dismissal once made — finishing it later does not re-enable it", async () => {
    // "Don't show me this again" is a preference, not a transient state. Replaying the tour
    // must not quietly opt someone back in to being taught it.
    const db = fakeDb();
    await recordTourSeen(db as never, { organisationId: ORG, userId: "user-a", tourId: tour.id, tourVersion: 1, dismissed: true });
    await recordTourSeen(db as never, { organisationId: ORG, userId: "user-a", tourId: tour.id, tourVersion: 1, dismissed: false });
    const seen = await listTourSeen(db as never, "user-a");
    assert.equal(seen[0]?.dismissed, true);
  });

  it("reads only the asking person's own records", async () => {
    const db = fakeDb();
    await recordTourSeen(db as never, { organisationId: ORG, userId: "user-b", tourId: tour.id, tourVersion: 1, dismissed: false });
    assert.deepEqual(await listTourSeen(db as never, "user-a"), []);
  });
});
