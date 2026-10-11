import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { emissionCategoryTaxonomy } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { checkUnit, isAcceptedUnit, unitDimension } from "../src/unitCompatibility";

/**
 * 0165 (RULING-v7-taxonomy-additions; NZC-168), against a real database: what the migration leaves, and that its guards refuse
 * a second run and a drifted spec rather than overwriting it.
 */
const MIGRATION = readFileSync(new URL("../migrations/0165_taxonomy_other_stationary_fuels_and_units.sql", import.meta.url), "utf8");
const BASE = ["kWh", "litres", "tonnes", "km", "mi", "m²", "units"];
const TRAVEL = ["passenger.km", "passenger.mi", ...BASE];

describe("0165: Other Stationary Fuels, GBP on 3.4/3.5/3.6/3.9, and the three native units", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const category = async (code: string) => (await db.query(`SELECT * FROM nzi_console.input_spec_categories WHERE category_code = $1`, [code])).rows[0] as
    { units: string[]; kind: string; name: string; scope: string; version: number; manual_entry_hint: string; declarative_resolution_enabled: boolean; companions_enabled: boolean; updated_by: string } | undefined;
  const unitField = async (code: string) => (await db.query(`SELECT accepted_units, version FROM nzi_console.input_spec_fields WHERE category_code = $1 AND field_key = 'unit'`, [code])).rows[0] as
    { accepted_units: string[] | null; version: number };

  before(async () => { database = (await createDisposableDatabase("taxonomy0165"))!; db = await database.admin(); });
  after(async () => { await db?.end(); await database?.end(); });

  it("T1: Other Stationary Fuels is Natural Gas's form, field for field, with its own units, resolving by free search", async () => {
    const fuels = (await category("1.other-stationary-fuels"))!;
    const gas = (await category("1.natural-gas"))!;
    assert.deepEqual([fuels.scope, fuels.name, fuels.kind], ["1", "Other Stationary Fuels", "manual"]);
    assert.deepEqual(fuels.units, ["litres", "kWh", "tonnes", "km", "mi", "m²", "units"], "litres first: the unit most of its rows carry");
    assert.equal(fuels.manual_entry_hint, gas.manual_entry_hint);
    assert.deepEqual([fuels.declarative_resolution_enabled, fuels.companions_enabled], [false, false], "free search, as Natural Gas");
    assert.equal(Number((await db.query(`SELECT count(*) FROM nzi_console.input_spec_factor_rules WHERE category_code = '1.other-stationary-fuels'`)).rows[0].count), 0, "no declared rules");
    const fields = async (code: string) => (await db.query(`SELECT field_key, ordering, control, label, hint, optional, when_audiences, when_modes, when_lean, label_variants
      FROM nzi_console.input_spec_fields WHERE category_code = $1 AND active ORDER BY ordering`, [code])).rows;
    assert.deepEqual(await fields("1.other-stationary-fuels"), await fields("1.natural-gas"), "copied from the rows as they stand");
    assert.deepEqual((await unitField("1.other-stationary-fuels")).accepted_units, ["litres", "kWh", "tonnes"]);
    assert.deepEqual((await unitField("1.natural-gas")).accepted_units, ["kWh"], "Natural Gas is not widened");
    assert.equal(Number((await db.query(`SELECT count(*) FROM nzi_console.input_spec_categories WHERE active`)).rows[0].count), emissionCategoryTaxonomy.length, "the database and the contracts taxonomy agree: 21");
  });

  it("T2 + T3: units appended — the default unchanged — accepted where a field declares, each row version-bumped and stamped", async () => {
    const expected: Record<string, { units: string[]; accepted: string[] | null }> = {
      "3.4": { units: [...BASE, "GBP", "tonne.km"], accepted: null },
      "3.5": { units: [...BASE, "GBP"], accepted: ["tonnes", "GBP"] },
      "3.6": { units: [...TRAVEL, "GBP", "nights"], accepted: ["passenger.km", "passenger.mi", "km", "mi", "GBP", "nights"] },
      "3.7": { units: [...TRAVEL, "per FTE Working Hour"], accepted: ["passenger.km", "passenger.mi", "km", "mi", "per FTE Working Hour"] },
      "3.9": { units: [...BASE, "GBP"], accepted: null },
    };
    for (const [code, want] of Object.entries(expected)) {
      const row = (await category(code))!;
      assert.deepEqual(row.units, want.units, `${code} units`);
      assert.deepEqual([row.version, row.updated_by], [2, "migration:0165"], `${code} bumped and stamped`);
      const field = await unitField(code);
      assert.deepEqual(field.accepted_units, want.accepted, `${code} accepted units`);
      if (want.accepted) assert.equal(field.version, 2, `${code} unit field bumped`);
    }
    assert.deepEqual((await category("3.1"))!.units[0], "GBP", "3.1 untouched");
  });

  it("the new units reconcile with the factors' own spellings, and with nothing else", () => {
    assert.equal(unitDimension("per FTE Working Hour"), "fte-time");
    assert.equal(checkUnit("per FTE Working Hour", "per FTE Working Hour").kind, "same");
    assert.equal(checkUnit("per FTE Working Hour", "nights").kind, "reject", "an FTE hour is not a night");
    assert.equal(checkUnit("hours", "per FTE Working Hour").kind, "reject", "nor any other hour");
    assert.equal(checkUnit("nights", "nights").kind, "same");
    assert.equal(checkUnit("room-nights", "nights").kind, "reject", "why the spelling is the factor's own");
    assert.equal(checkUnit("tonne.km", "t·km").kind, "convert", "freight spellings reconcile");
    assert.ok(isAcceptedUnit("GBP", ["passenger.km", "passenger.mi", "km", "mi", "GBP", "nights"]));
    assert.ok(!isAcceptedUnit("per fte working hours", ["per FTE Working Hour"]), "identity-only: the exact spelling, case aside");
  });

  it("its guards refuse a second run — the category exists — and leave everything as it was", async () => {
    await assert.rejects(db.query(MIGRATION), /0165: 1\.other-stationary-fuels already exists/);
    await db.query("ROLLBACK").catch(() => undefined);
    assert.equal((await category("3.4"))!.version, 2, "nothing applied twice");
  });

  it("its guards refuse a drifted spec rather than overwrite it", async () => {
    // The ground as it was before 0165, except one category whose units have drifted.
    await db.query(`BEGIN`);
    await db.query(`DELETE FROM nzi_console.input_spec_fields WHERE category_code = '1.other-stationary-fuels'`);
    await db.query(`DELETE FROM nzi_console.input_spec_categories WHERE category_code = '1.other-stationary-fuels'`);
    await db.query(`UPDATE nzi_console.input_spec_categories SET units = $2 WHERE category_code = $1`, ["3.4", [...BASE, "GBP"]]);
    await db.query(`SAVEPOINT drifted`);
    await assert.rejects(db.query(MIGRATION.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "")), /0165: the units of 3\.4\/3\.5\/3\.6\/3\.7\/3\.9 are not what was surveyed/);
    await db.query(`ROLLBACK`);
    assert.ok(await category("1.other-stationary-fuels"), "the drill rolled back; the database is as 0165 left it");
  });
});
