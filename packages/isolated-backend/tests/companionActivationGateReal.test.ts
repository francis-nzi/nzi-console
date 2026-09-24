import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * Companions cannot be switched on while the portal cannot say how electricity arrived (NZC-160 H4, hardened at 2d).
 *
 * The transmission-and-distribution companion fires on `supplySource`, and "not stated" fires nothing — the right
 * fail-safe for one entry, and a systematic under-count for a surface that cannot state it. The CRM captures supply
 * source; a portal draft records no such thing. So once companions are on, every portal grid-electricity entry would
 * produce no T&D row, silently.
 *
 * This is the gate, run against the database every migration builds: if any category has companions switched on,
 * portal records must carry a supply source. So the migration that activates companions (after the H4 double-counting
 * decision) cannot pass CI unless portal capture of supply source has landed with it or before it. A mechanical
 * precondition, not a documented intention.
 */

const DATABASE_URL = TEST_DATABASE_URL;

/** Every reason companions may not be on in this database, or none. */
async function companionGateViolations(db: pg.Client): Promise<string[]> {
  const on = (await db.query<{ category_code: string }>(
    `SELECT category_code FROM nzi_console.input_spec_categories WHERE companions_enabled ORDER BY 1`)).rows.map((row) => row.category_code);
  if (on.length === 0) return [];
  const portalCaptures = (await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'nzi_console' AND table_name = 'portal_data_entry_records' AND column_name = 'supply_source'`)).rows.length > 0;
  return portalCaptures ? [] : on.map((category) =>
    `${category} has companions switched on, but portal records capture no supply source — every portal grid entry would produce no T&D row`);
}

describe("companions stay off until the portal can state how electricity arrived (H4 gate)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => { database = (await createDisposableDatabase("companiongate"))!; db = await database.admin(); });
  after(async () => { await db?.end(); await database?.end(); });

  it("holds for the database the migrations build", async () => {
    assert.deepEqual(await companionGateViolations(db), [],
      "a migration switched companions on while the portal cannot capture supply source (NZC-160 H4)");
  });

  it("bites: switching a companion on without portal capture is reported", async () => {
    await db.query("BEGIN");
    try {
      await db.query(`UPDATE nzi_console.input_spec_categories SET companions_enabled = true WHERE category_code = '2.purchased-electricity'`);
      const violations = await companionGateViolations(db);
      assert.equal(violations.length, 1, "the gate did not report a companion switched on over a portal that cannot state supply source");
      assert.match(violations[0]!, /2\.purchased-electricity/);
    } finally { await db.query("ROLLBACK"); }
  });

  it("is satisfied once portal records capture supply source", async () => {
    await db.query("BEGIN");
    try {
      await db.query(`ALTER TABLE nzi_console.portal_data_entry_records ADD COLUMN supply_source text`);
      await db.query(`UPDATE nzi_console.input_spec_categories SET companions_enabled = true WHERE category_code = '2.purchased-electricity'`);
      assert.deepEqual(await companionGateViolations(db), []);
    } finally { await db.query("ROLLBACK"); }
  });
});
