import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSrsFramework } from "../src/srsReadinessRecords";
import type { Queryable } from "../src/postgres";

/**
 * Reading the framework must not put two queries on one connection at once.
 *
 * `getSrsFramework` is handed the **client** of an open tenant transaction, not a pool, and
 * node-postgres allows a single query in flight per client. It used to fetch standards, pillars,
 * maturity levels and requirements with `Promise.all`, which raised
 * "client.query() when the client is already executing a query" — a deprecation today, an error in
 * a future pg major, and a warning that made a completely unrelated version conflict look like a
 * race while the seed for NZC-080 was being written.
 *
 * The fake below is stricter than the driver: it refuses overlap outright rather than queueing,
 * so a `Promise.all` reintroduced here fails the test instead of printing a warning nobody reads.
 */

type Row = Record<string, unknown>;

function serialOnlyDb(): Queryable & { peakInFlight: number } {
  let inFlight = 0;
  const db = {
    peakInFlight: 0,
    async query(text: string) {
      inFlight += 1;
      db.peakInFlight = Math.max(db.peakInFlight, inFlight);
      if (inFlight > 1) {
        inFlight -= 1;
        throw new Error("two queries in flight on one client — node-postgres cannot do this");
      }
      // A turn of the event loop, so genuinely concurrent callers overlap here rather than
      // completing before the next one starts and slipping past the check.
      await new Promise((resolve) => setImmediate(resolve));
      const rows = rowsFor(text);
      inFlight -= 1;
      return { rows: rows as never };
    },
  };
  return db;
}

function rowsFor(text: string): Row[] {
  if (text.includes("FROM nzi_console.srs_frameworks")) {
    return [{ framework_id: "srs-v1", version: 1, label: "UK SRS", status: "active", effective_from: "2026-01-01", notes: "" }];
  }
  if (text.includes("FROM nzi_console.srs_standards")) {
    return [{ standard_key: "s1", label: "Climate", description: "", climate_led: true, ordering: 1 }];
  }
  if (text.includes("FROM nzi_console.srs_pillars")) {
    return [{ pillar_key: "governance", label: "Governance", description: "", ordering: 1 }];
  }
  if (text.includes("FROM nzi_console.srs_maturity_levels")) {
    return [{ level: 0, key: "none", label: "Not started", definition: "" }];
  }
  if (text.includes("FROM nzi_console.srs_requirements")) {
    return [{
      requirement_id: "req-1", standard_key: "s1", pillar_key: "governance", code: "G1",
      title: "Board oversight", help_text: "", weight: "1", source: "entered",
      nzi_source_key: null, target_maturity: 3, ordering: 1, active: true,
    }];
  }
  return [];
}

describe("the framework read stays on one query at a time", () => {
  it("never puts a second query on the connection while one is running", async () => {
    const db = serialOnlyDb();
    const framework = await getSrsFramework(db);
    assert.ok(framework, "the framework should still come back");
    assert.equal(db.peakInFlight, 1, "the whole read must be serial on a transaction client");
  });

  it("still assembles the whole framework, not just the header", async () => {
    // The serial version is only correct if it reads everything the parallel one did.
    const framework = await getSrsFramework(serialOnlyDb());
    assert.ok(framework);
    assert.equal(framework.frameworkId, "srs-v1");
    assert.equal(framework.standards.length, 1);
    assert.equal(framework.pillars.length, 1);
    assert.equal(framework.maturityLevels.length, 1);
    assert.equal(framework.requirements.length, 1);
    assert.equal(framework.requirements[0]!.targetMaturity, 3);
  });

  it("returns null when no framework is published, without reading further", async () => {
    const empty: Queryable = { async query() { return { rows: [] as never }; } };
    assert.equal(await getSrsFramework(empty), null);
  });
});
