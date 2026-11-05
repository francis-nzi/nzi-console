import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { emissionCategoryTaxonomy } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * 0212 (BRIEF-purchased-heat-steam-category), against a real database: the Scope 2 category it adds, the held-back family it files, and
 * that its guards refuse a second run and a drifted ground rather than overwrite it.
 */
const MIGRATION = readFileSync(new URL("../migrations/0212_purchased_heat_steam_category.sql", import.meta.url), "utf8");
const CODE = "2.purchased-heat-steam";
const withoutTransaction = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");

describe("0212: Purchased Heat & Steam files District heat and steam; Onsite stays held back", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const category = async (code: string) => (await db.query(`SELECT * FROM nzi_console.input_spec_categories WHERE category_code = $1`, [code])).rows[0] as
    { units: string[]; kind: string; name: string; scope: string; manual_entry_hint: string; declarative_resolution_enabled: boolean; companions_enabled: boolean; active: boolean } | undefined;
  const fields = async (code: string) => (await db.query(`SELECT field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants, accepted_units
    FROM nzi_console.input_spec_fields WHERE category_code = $1 AND active ORDER BY ordering`, [code])).rows;
  const heatRules = async () => (await db.query(`SELECT category_code, source_l2, source_l3, status FROM nzi_console.factor_category_membership
    WHERE lower(source_l1) = 'heat and steam' ORDER BY rule_id`)).rows as Array<{ category_code: string | null; source_l2: string | null; source_l3: string | null; status: string }>;

  before(async () => { database = (await createDisposableDatabase("heatsteam0212"))!; db = await database.admin(); });
  after(async () => { await db?.end(); await database?.end(); });

  it("the category is Scope 2, manual, in the contracts taxonomy and the database alike, after Renewable Electricity", async () => {
    const row = (await category(CODE))!;
    assert.deepEqual([row.scope, row.name, row.kind, row.active], ["2", "Purchased Heat & Steam", "manual", true]);
    const entry = emissionCategoryTaxonomy.find((c) => c.code === CODE)!;
    assert.deepEqual([entry.scope, entry.name, entry.kind], ["2", "Purchased Heat & Steam", "manual"], "the contracts registry and the spec agree");
    const scope2 = emissionCategoryTaxonomy.filter((c) => c.scope === "2").map((c) => c.code);
    assert.deepEqual(scope2, ["2.purchased-electricity", "2.renewable-electricity", CODE]);
    assert.equal(Number((await db.query(`SELECT count(*) FROM nzi_console.input_spec_categories WHERE active`)).rows[0].count), emissionCategoryTaxonomy.length, "22");
  });

  it("its form is Purchased Electricity's, field for field, without the electricity-only supply question, and it resolves by free search", async () => {
    const electricity = (await fields("2.purchased-electricity")).filter((field) => field.field_key !== "supplySource");
    assert.equal(electricity.length, 11);
    assert.deepEqual(await fields(CODE), electricity, "copied from the rows as they stand");
    assert.ok(!(await fields(CODE)).some((field) => field.field_key === "supplySource"), "no grid-or-on-site question: heat has no T&D companion to decide");
    const row = (await category(CODE))!;
    assert.equal(row.manual_entry_hint, (await category("2.purchased-electricity"))!.manual_entry_hint);
    assert.deepEqual([row.declarative_resolution_enabled, row.companions_enabled], [false, false]);
    assert.equal(Number((await db.query(`SELECT count(*) FROM nzi_console.input_spec_factor_rules WHERE category_code = $1`, [CODE])).rows[0].count), 0, "no declared rules");
  });

  it("District heat and steam alone is filed under the new category; the held-back rule stays active, so Onsite stays held back", async () => {
    assert.deepEqual(await heatRules(), [
      { category_code: null, source_l2: null, source_l3: null, status: "active" },
      { category_code: CODE, source_l2: "Heat and steam", source_l3: "District heat and steam", status: "active" },
    ]);
    const held = await db.query(`SELECT count(*) FROM nzi_console.factor_category_membership WHERE category_code IS NULL AND status = 'active'`);
    assert.equal(Number(held.rows[0].count), 1, "the held-back count is 1: the Onsite family");
    const wtt = await db.query(`SELECT category_code FROM nzi_console.factor_category_membership WHERE lower(source_l1) = 'wtt- heat and steam' AND status = 'active'`);
    assert.deepEqual(wtt.rows.map((r) => r.category_code), ["3.3"], "well-to-tank of heat stays in Fuel & Energy Related");
  });

  it("its guards refuse a second run — the category exists — and leave everything as it was", async () => {
    await assert.rejects(db.query(MIGRATION), /0212: 2\.purchased-heat-steam already exists/);
    await db.query("ROLLBACK").catch(() => undefined);
    assert.equal((await heatRules()).length, 2, "nothing applied twice");
  });

  it("its guards refuse a drifted ground rather than overwrite it", async () => {
    await db.query(`BEGIN`);
    await db.query(`DELETE FROM nzi_console.input_spec_fields WHERE category_code = $1`, [CODE]);
    await db.query(`DELETE FROM nzi_console.input_spec_categories WHERE category_code = $1`, [CODE]);
    // The held-back rule already retired by hand: the ground is no longer the one surveyed.
    await db.query(`UPDATE nzi_console.factor_category_membership SET status = 'retired', retired_at = now(), retired_by = 'drill'
                     WHERE lower(source_l1) = 'heat and steam' AND category_code IS NULL`);
    await assert.rejects(db.query(withoutTransaction(MIGRATION)), /0212: expected exactly one active held-back "Heat and steam" rule/);
    await db.query(`ROLLBACK`);
    assert.ok(await category(CODE), "the drill rolled back; the database is as 0212 left it");
  });
});
