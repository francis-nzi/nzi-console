import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import type { V7Row } from "../src/v7ClientExtract";
import { LOOKUP_RUN_PREFIX, loadV7Lookups, normaliseLabel, planV7Lookups } from "../src/v7LookupLoad";

/**
 * The v7 lookup reconcile (admin Phase A3): identity, then normalised label (reinstating an archived match), else
 * insert; is_active and sort order carried; provenance stamped; seeded-only values reported, never archived; portfolio
 * owners linked; re-runnable under R4. Planning is pure; loading runs as the application role, one category at a time.
 */
const ORG = "lk-org-a";
const OTHER = "lk-org-b";
const rows = (list: Array<Record<string, string | null>>): V7Row[] => list;
const BASE = {
  industries_lookup: rows([
    { industry_id: "1", name: "Manufacturing", is_active: "t" },
    { industry_id: "2", name: "  RETAIL  ", is_active: "t" }, // the seeded "Retail", by normalised label
    { industry_id: "3", name: "Mining", is_active: "t" }, // the seeded, archived "mining" — reinstated
    { industry_id: "4", name: "Hospitality", is_active: "f" }, // the seeded, active "Hospitality" — carried inactive
  ]),
  portfolios_lookup: rows([
    { portfolio_id: "1", name: "Net Zero International", portfolio_owner_client_db_id: "10", is_active: "t" },
    { portfolio_id: "2", name: "Nordics", portfolio_owner_client_db_id: "99", is_active: "t" }, // owner not imported
  ]),
  uom_lookup: rows([{ uom_id: "1", name: "Hour", is_active: "t", sort_order: "20" }, { uom_id: "2", name: "Day", is_active: "t", sort_order: "10" }]),
};

describe("planning the lookup import (no database)", () => {
  it("reads each table into its category, trims and collapses labels, and carries is_active and sort order", () => {
    const plan = planV7Lookups(BASE);
    const industries = plan.categories.find((c) => c.category === "industries")!;
    assert.deepEqual(industries.values.map((v) => [v.legacyDbId, v.label, v.active]), [["1", "Manufacturing", true], ["2", "RETAIL", true], ["3", "Mining", true], ["4", "Hospitality", false]]);
    assert.deepEqual(plan.categories.find((c) => c.category === "units_of_measure")!.values.map((v) => v.sortOrder), [20, 10]);
    assert.equal(plan.categories.find((c) => c.category === "portfolios")!.values[0]!.ownerClientLegacyId, "10");
    assert.equal(plan.categories.length, 12, "every lookup table, empty or not");
  });

  it("leaves out — and names — a value it cannot place: no name, a bad sort order, a second active copy of a label", () => {
    const plan = planV7Lookups({
      positions_lookup: rows([{ position_id: "1", name: "Analyst", is_active: "t" }, { position_id: "2", name: " analyst", is_active: "t" }, { position_id: "3", name: " ", is_active: "t" }]),
      uom_lookup: rows([{ uom_id: "1", name: "Tonne", is_active: "t", sort_order: "1.5" }]),
    });
    assert.deepEqual(plan.skipped.map((s) => [s.table, s.legacyDbId]), [["positions_lookup", "2"], ["positions_lookup", "3"], ["uom_lookup", "1"]]);
    assert.match(plan.skipped[0]!.reason, /same label as v7 value 1/);
  });

  it("normalises labels the way the match does: trimmed, spaces collapsed, case ignored", () => {
    assert.equal(normaliseLabel("  Food   &  Drink "), "food & drink");
  });
});

describe("the lookup reconcile, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  const admin = async <T>(work: (db: import("pg").Client) => Promise<T>) => { const db = await database.admin(); try { return await work(db); } finally { await db.end(); } };
  const values = (category: string, org = ORG) => admin(async (db) => (await db.query(
    `SELECT value_id, label, active, sort_order, source, source_system, legacy_db_id, legacy_values, updated_by, version FROM nzi_console.reference_values
      WHERE organisation_id = $1 AND category_key = $2 ORDER BY label`, [org, category])).rows);

  before(async () => {
    database = (await createDisposableDatabase("lookupload"))!;
    await admin(async (db) => {
      for (const org of [ORG, OTHER]) {
        await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
        await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
        const seed = (id: string, label: string, sort: number, active = true) => db.query(`INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, sort_order, active, created_by, updated_by)
          VALUES ($1, 'industries', $2, $3, $4, $5, 'seed', 'seed')`, [org, id, label, sort, active]);
        await seed("industries:retail", "Retail", 10); await seed("industries:mining", "mining", 20, false);
        await seed("industries:hospitality", "Hospitality", 30); await seed("industries:education", "Education", 40);
      }
      await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, source_system, legacy_db_id) VALUES ($1, 'c10', 'Owner Co', 'active', 'nzi-pro-v7', '10')`, [ORG]);
      await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, sector, sector_value_id) VALUES ($1, 'c-retail', 'Shop', 'active', 'Retail', 'industries:retail')`, [ORG]);
    });
  });
  after(async () => { await database?.end(); });

  it("a dry run exercises every write and keeps none", async () => {
    const outcome = await loadV7Lookups(database.pool, ORG, planV7Lookups(BASE), { commit: false });
    const industries = outcome.categories.find((c) => c.category === "industries")!;
    assert.deepEqual([industries.inserted, industries.stamped, industries.reinstated, industries.deactivated], [1, 3, 1, 1]);
    assert.ok((await values("industries")).every((row) => row.source_system === null), "nothing kept");
  });

  it("commits: stamps matches by label (reinstating and carrying is_active), inserts the rest, and keeps what uses them working", async () => {
    await loadV7Lookups(database.pool, ORG, planV7Lookups(BASE), { commit: true, runId: `${LOOKUP_RUN_PREFIX}first` });
    const industries = Object.fromEntries((await values("industries")).map((row) => [row.value_id, row]));
    const retail = industries["industries:retail"];
    assert.deepEqual([retail.label, retail.active, retail.source_system, retail.legacy_db_id], ["RETAIL", true, "nzi-pro-v7", "2"], "the seeded value, stamped — its id kept, so the client stays linked");
    assert.deepEqual(retail.legacy_values, { name: "RETAIL", isActive: true, sortOrder: null });
    assert.deepEqual([industries["industries:mining"].active, industries["industries:mining"].legacy_db_id], [true, "3"], "an archived match is reinstated");
    assert.equal(industries["industries:hospitality"].active, false, "is_active is carried — deactivated, never deleted");
    assert.deepEqual([industries["industries:v7-1"].label, industries["industries:v7-1"].source], ["Manufacturing", "import"]);
    assert.equal(industries["industries:education"].source_system, null, "a seeded-only value is left exactly as it was");
    const client = await admin(async (db) => (await db.query(`SELECT sector_value_id FROM nzi_console.clients WHERE client_id = 'c-retail'`)).rows[0]);
    assert.equal(client.sector_value_id, "industries:retail");
  });

  it("reports seeded values v7 does not have — and never archives them (P6)", async () => {
    const outcome = await loadV7Lookups(database.pool, ORG, planV7Lookups(BASE), { commit: false });
    assert.deepEqual(outcome.categories.find((c) => c.category === "industries")!.seededOnly, ["Education"]);
    assert.equal((await values("industries")).find((row) => row.label === "Education").active, true);
  });

  it("carries v7's sort order where it has one", async () => {
    assert.deepEqual((await values("units_of_measure")).map((row) => [row.label, row.sort_order]), [["Day", 10], ["Hour", 20]]);
  });

  it("links a portfolio to its owner client, and reports an owner who was not imported", async () => {
    const owners = await admin(async (db) => (await db.query(`SELECT portfolio_value_id, owner_client_id, legacy_db_id FROM nzi_console.portfolio_owners WHERE organisation_id = $1`, [ORG])).rows);
    assert.deepEqual(owners, [{ portfolio_value_id: "portfolios:v7-1", owner_client_id: "c10", legacy_db_id: "1" }]);
    const outcome = await loadV7Lookups(database.pool, ORG, planV7Lookups(BASE), { commit: false });
    assert.deepEqual(outcome.categories.find((c) => c.category === "portfolios")!.owners!.ownerNotImported, ["Nordics (v7 client 99)"]);
  });

  it("is idempotent: the same extract again changes nothing, and parity holds", async () => {
    const outcome = await loadV7Lookups(database.pool, ORG, planV7Lookups(BASE), { commit: true });
    for (const category of outcome.categories) {
      assert.deepEqual([category.inserted, category.stamped, category.updated, category.conflicts.length], [0, 0, 0, 0], category.category);
      assert.deepEqual([category.parity.consoleActive, category.parity.consoleInactive], [category.parity.v7Active, category.parity.v7Inactive], category.category);
    }
    assert.equal(outcome.categories.find((c) => c.category === "portfolios")!.owners!.unchanged, 1);
  });

  it("R4: v7 wins where the value is still as the import wrote it", async () => {
    const changed = { ...BASE, industries_lookup: rows(BASE.industries_lookup.map((row) => row.industry_id === "1" ? { ...row, name: "Manufacturing & engineering" } : row)) };
    const outcome = await loadV7Lookups(database.pool, ORG, planV7Lookups(changed), { commit: true, runId: `${LOOKUP_RUN_PREFIX}second` });
    assert.equal(outcome.categories.find((c) => c.category === "industries")!.updated, 1);
    const row = (await values("industries")).find((value) => value.value_id === "industries:v7-1");
    assert.deepEqual([row.label, row.updated_by, row.version], ["Manufacturing & engineering", `${LOOKUP_RUN_PREFIX}second`, 2]);
  });

  it("R4: a console edit stands while v7 is unchanged — and changed on both sides is refused and reported", async () => {
    await admin((db) => db.query(`UPDATE nzi_console.reference_values SET label = 'Manufacturing (edited)', updated_by = 'admin-ada' WHERE organisation_id = $1 AND value_id = 'industries:v7-1'`, [ORG]));
    const current = { ...BASE, industries_lookup: rows(BASE.industries_lookup.map((row) => row.industry_id === "1" ? { ...row, name: "Manufacturing & engineering" } : row)) };
    const same = await loadV7Lookups(database.pool, ORG, planV7Lookups(current), { commit: true });
    assert.equal(same.categories.find((c) => c.category === "industries")!.unchanged, 4, "v7 unchanged: the edit stands");
    const both = { ...BASE, industries_lookup: rows(BASE.industries_lookup.map((row) => row.industry_id === "1" ? { ...row, name: "Engineering" } : row)) };
    const refused = await loadV7Lookups(database.pool, ORG, planV7Lookups(both), { commit: true });
    assert.deepEqual(refused.categories.find((c) => c.category === "industries")!.conflicts.map((c) => c.label), ["Manufacturing (edited)"]);
    assert.equal((await values("industries")).find((value) => value.value_id === "industries:v7-1").label, "Manufacturing (edited)", "nothing overwritten");
  });

  it("records one audit event per category it touched", async () => {
    const events = await admin(async (db) => (await db.query(`SELECT entity_id FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'reference.values.imported' AND correlation_id = $2 ORDER BY entity_id`, [ORG, `${LOOKUP_RUN_PREFIX}first`])).rows);
    assert.deepEqual(events.map((event) => event.entity_id), ["industries", "portfolios", "units_of_measure"]);
  });

  it("never touches another organisation's values", async () => {
    assert.ok((await values("industries", OTHER)).every((row) => row.source_system === null && row.updated_by === "seed"));
    assert.deepEqual(await admin(async (db) => (await db.query(`SELECT * FROM nzi_console.portfolio_owners WHERE organisation_id = $1`, [OTHER])).rows), []);
  });

  it("refuses a run id a re-run would not recognise", async () => {
    await assert.rejects(loadV7Lookups(database.pool, ORG, planV7Lookups(BASE), { commit: false, runId: "whatever" }), /must start v7-lookups-/);
  });
});
