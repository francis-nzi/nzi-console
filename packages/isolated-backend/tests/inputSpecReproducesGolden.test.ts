import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { renderInputSpec } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { listInputSpec } from "../src/inputSpecRecords";

/**
 * The seeded spec renders exactly what the hand-written model rendered (NZC-102).
 *
 * This is the assertion the whole migration rests on. The golden was pinned **before** anything
 * moved — 160 renders, every category, both audiences, both modes, lean and full — and it records
 * what the product does rather than what is correct. So the question here is not "is the spec
 * right" but the narrower, checkable one: **does reading it from the database produce the same
 * thing the code produced?**
 *
 * It runs against a real Postgres deliberately. The spec is rows now: seeded by a migration, read
 * through a query, with arrays and jsonb crossing the driver. A test that fed the interpreter an
 * object literal would prove the interpreter works and say nothing about whether the migration
 * seeded what it meant to, whether `text[]` survives the round trip, or whether a `when_lean` of
 * false comes back as false rather than null.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN = join(ROOT, "apps/console/tests/fixtures/entryRenderMatrix.golden.json");
const DATABASE_URL = TEST_DATABASE_URL;

type Golden = Record<string, { fields: Array<Record<string, unknown>>; units: string[]; manualHint: string }>;

describe("the governed spec reproduces the pinned renders", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let golden: Golden;

  before(async () => {
    database = (await createDisposableDatabase("inputspec"))!;
    db = await database.admin();
    golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden;
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("seeds every category the golden pins, and no others", async () => {
    const spec = await listInputSpec(db);
    const seeded = spec.map((category) => category.categoryCode).sort();
    const pinned = [...new Set(Object.keys(golden).map((key) => key.split("|")[0]!))].sort();
    assert.deepEqual(seeded, pinned, "a partial seed would mean two sources of truth for what a surface asks");
  });

  it("renders every pinned combination identically", async () => {
    const spec = await listInputSpec(db);
    const byCode = new Map(spec.map((category) => [category.categoryCode, category]));
    const mismatches: string[] = [];

    for (const [key, expected] of Object.entries(golden)) {
      const [code, audience, mode, capture] = key.split("|") as [string, "crm" | "portal", "new" | "existing", string];
      const category = byCode.get(code);
      if (!category) { mismatches.push(`${key}: category not seeded`); continue; }
      const actual = renderInputSpec(category, audience, mode, capture === "lean");
      if (JSON.stringify(actual) !== JSON.stringify(expected.fields)) {
        mismatches.push(`${key}\n    expected ${JSON.stringify(expected.fields)}\n    actual   ${JSON.stringify(actual)}`);
      }
    }

    assert.deepEqual(mismatches, [],
      `the spec renders differently from the pinned model:\n  ${mismatches.slice(0, 2).join("\n  ")}`);
    assert.equal(Object.keys(golden).length, 160, "and all 160 renders were checked, not a subset");
  });

  it("carries each category's units in order, first being the default", async () => {
    // Order is data here, not a rule in code: GBP leads for spend, passenger.km for travel and
    // commuting, kWh otherwise. A set would lose exactly the part that matters.
    const spec = await listInputSpec(db);
    for (const category of spec) {
      const pinned = golden[`${category.categoryCode}|crm|new|full`]!;
      assert.deepEqual(category.units, pinned.units, `${category.categoryCode} units`);
      assert.equal(category.manualEntryHint, pinned.manualHint, `${category.categoryCode} manual hint`);
    }
  });

  it("keeps the placeholders in the stored rows rather than 20 copies of the taxonomy", async () => {
    // The stored label says `{scopedTo}`; the render says "Scope 1 · Company Vehicles". If the
    // seed had written the literal, the spec would hold a second copy of the taxonomy and the two
    // would drift the first time a category was renamed.
    const { rows } = await db.query<{ hint: string }>(
      `SELECT hint FROM nzi_console.input_spec_fields
        WHERE category_code='1.company-vehicles' AND field_key='activity'`);
    assert.match(rows[0]!.hint, /\{scopedTo\}/, "the row holds the placeholder");
    assert.ok(!rows[0]!.hint.includes("Company Vehicles"), "not the interpolated text");

    const spec = await listInputSpec(db);
    const vehicles = spec.find((category) => category.categoryCode === "1.company-vehicles")!;
    const rendered = renderInputSpec(vehicles, "crm", "new");
    assert.equal(rendered.find((field) => field.key === "activity")!.hint,
      "Smart search — Scope 1 · Company Vehicles factors only.");
  });

  it("distinguishes a field that says nothing about optionality from one that says false", async () => {
    // The distinction the first attempt collapsed: the model emits `optional: false` on the unit
    // field and omits the property entirely elsewhere, and the golden records both. A two-valued
    // column would have quietly changed 136 renders.
    const { rows } = await db.query<{ field_key: string; optional: boolean | null }>(
      `SELECT field_key, optional FROM nzi_console.input_spec_fields
        WHERE category_code='2.purchased-electricity' AND field_key IN ('unit','quantity','monthly')
        ORDER BY field_key`);
    const byKey = new Map(rows.map((row) => [row.field_key, row.optional]));
    assert.equal(byKey.get("quantity"), null, "quantity says nothing");
    assert.equal(byKey.get("unit"), false, "unit says explicitly not optional");
    assert.equal(byKey.get("monthly"), true, "monthly is optional");
  });

  it("stores the lean variant of the factor field as data, not as a rule in code", async () => {
    // The one field whose control changes under lean capture. It is content — factor-select becomes
    // factor-review — so it lives in label_variants, keyed on the lean axis.
    const { rows } = await db.query<{ label_variants: Array<Record<string, unknown>> }>(
      `SELECT label_variants FROM nzi_console.input_spec_fields
        WHERE category_code='2.purchased-electricity' AND field_key='factor'`);
    const leanVariant = rows[0]!.label_variants.find((variant) => variant.lean === true);
    assert.ok(leanVariant, "a lean-keyed variant exists");
    assert.equal(leanVariant!.control, "factor-review");
  });

  it("is readable by the application role and writable by nobody through it", async () => {
    // A governed vocabulary is not editable by the surface that consumes it (NZC-102). Changes come
    // through a migration, or a future admin command with its own capability and audit event.
    const { rows } = await db.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='nzi_console' AND grantee='nzi_console_app'
          AND table_name IN ('input_spec_categories','input_spec_fields')
        ORDER BY privilege_type`);
    assert.deepEqual([...new Set(rows.map((row) => row.privilege_type))], ["SELECT"]);
  });

  it("hides a deactivated category rather than deleting it", async () => {
    // Deactivate-not-delete, asserted rather than assumed: the row survives, the reader stops
    // offering it, and every entry already recorded against it still resolves.
    await db.query(`UPDATE nzi_console.input_spec_categories SET active=false WHERE category_code='3.14'`);
    const spec = await listInputSpec(db);
    assert.ok(!spec.some((category) => category.categoryCode === "3.14"), "retired categories are not offered");
    const { rows } = await db.query(`SELECT 1 FROM nzi_console.input_spec_categories WHERE category_code='3.14'`);
    assert.equal(rows.length, 1, "but the row is still there");
    await db.query(`UPDATE nzi_console.input_spec_categories SET active=true WHERE category_code='3.14'`);
  });
});
