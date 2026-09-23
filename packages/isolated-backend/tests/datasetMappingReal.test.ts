import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { resolveFactorForEntry, type CategoryVariant } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { factorRulesFor, listFactorRules } from "../src/inputSpecFactorRules";
import { lookupVehicleByRegistration, vehicleAttributes } from "../src/vehicleLookup";

/**
 * The declared mapping, against the real tables (NZC-149).
 *
 * Two things only a real database can show, and they are the two worth the cost of one.
 *
 * The first is that the **seeded exemplars are what the resolver actually receives**. The unit suite
 * proves the resolver's behaviour against rules typed into the test; it cannot prove that the rows in
 * `0112` are shaped the way the resolver reads them, and a mapping that is right in the abstract and
 * mis-keyed in the migration resolves nothing while every unit test stays green.
 *
 * The second is that the **constraints refuse**. A CHECK constraint is satisfied by NULL, which is how
 * `false OR (NULL = 'market')` came to admit every row it was written to exclude (NZC-143). So each
 * branch of the shape constraint is given a row that should not exist, and the database is asked.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-mapping";

describe("a capture category reaches its factor by declared rule (NZC-149)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let registry: CategoryVariant[];

  /** The demonstration dataset's factors, as the resolver sees them. */
  const available = [
    { factorId: "electricity-demo", scopes: ["2"] },
    { factorId: "diesel-demo", scopes: ["1", "3"] },
    { factorId: "gas-demo", scopes: ["1"] },
  ];

  const refused = async (sql: string, values: unknown[], constraint: RegExp) => {
    await assert.rejects(() => db.query(sql, values), (error: unknown) => {
      assert.match(String((error as { message?: string }).message ?? error), constraint);
      return true;
    });
  };

  before(async () => {
    database = (await createDisposableDatabase("mapping"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    const rows = await db.query<{ suffix_code: string; label: string; ghg_category: string; description: string; status: string; sort_order: number }>(
      `SELECT suffix_code, label, ghg_category, description, status, sort_order
         FROM nzi_console.factor_category_variants ORDER BY sort_order`);
    registry = rows.rows.map((row) => ({
      suffixCode: row.suffix_code, label: row.label, ghgCategory: row.ghg_category,
      description: row.description, status: row.status as CategoryVariant["status"], sortOrder: row.sort_order,
    }));
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── The exemplars, read back and run ────────────────────────────────────────────────

  it("carries exactly the two exemplars the migration claims, and no more", async () => {
    // Asserted as an equality rather than a presence check: seeding a rule for a category whose factor
    // family nobody has agreed would be inventing domain policy in a migration, and this is what would
    // catch that happening quietly.
    const all = await listFactorRules(db);
    assert.deepEqual([...all.keys()].sort(), ["1.company-vehicles", "2.purchased-electricity"]);
  });

  it("resolves metered electricity to the grid factor, by lookup", async () => {
    const rules = await factorRulesFor(db, "2.purchased-electricity");
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.kind, "lookup");

    const outcome = resolveFactorForEntry({
      rules, specGhgCategory: "2", entry: { unit: "kWh" }, available, registry,
    });
    assert.equal(outcome.kind, "resolved");
    if (outcome.kind !== "resolved") return;
    assert.equal(outcome.factorId, "electricity-demo");
    assert.equal(outcome.scope.agreement, "agrees");
  });

  it("branches a vehicle on its unit, and leaves the distance entry to the search", async () => {
    const rules = await factorRulesFor(db, "1.company-vehicles");

    const litres = resolveFactorForEntry({ rules, specGhgCategory: "1", entry: { unit: "litres" }, available, registry });
    assert.equal(litres.kind === "resolved" ? litres.factorId : null, "diesel-demo");

    // The other half of the characterisation, and the one that proves this is additive: kilometres has
    // no factor in this dataset, so the entry keeps the search rather than being blocked or — worse —
    // resolved to the fuel factor because it was the only rule there.
    const km = resolveFactorForEntry({ rules, specGhgCategory: "1", entry: { unit: "km" }, available, registry });
    assert.equal(km.kind, "free-search");
  });

  it("leaves every other seeded category on the free search", async () => {
    // Nineteen of the twenty categories are unmapped, and must behave exactly as they did before this
    // migration. Checked against the live spec rather than a list written here.
    const categories = await db.query<{ category_code: string }>(
      `SELECT category_code FROM nzi_console.input_spec_categories WHERE active ORDER BY category_code`);
    assert.ok(categories.rows.length >= 20, `only ${categories.rows.length} categories — the spec did not load`);

    const mapped = await listFactorRules(db);
    let checked = 0;
    for (const { category_code: code } of categories.rows) {
      if (mapped.has(code)) continue;
      // Each category's *own* rules, read from the database. Passing `rules: []` here would assert
      // nothing about the database — it would re-prove the unit test that an empty list declines, and
      // pass just as happily if every one of these categories had been mapped by mistake.
      const rules = await factorRulesFor(db, code);
      assert.deepEqual(rules, [], `${code} has rules but was not in the grouped read`);
      const outcome = resolveFactorForEntry({
        rules, specGhgCategory: "1", entry: { unit: "litres" }, available, registry,
      });
      assert.equal(outcome.kind, "free-search", `${code} must still use the search`);
      checked += 1;
    }
    // And the loop has to have run. If `mapped` ever contained everything, the body would never execute
    // and this test would pass having checked nothing.
    assert.ok(checked >= 18, `only ${checked} unmapped categories checked`);
  });

  // ── The constraints, each given a row that should not exist ─────────────────────────

  const insert = `INSERT INTO nzi_console.input_spec_factor_rules
    (category_code, rule_key, ordering, rule_kind, factor_base, basis_field_key, basis_value, suffix_code, created_by, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'test','test')`;

  it("refuses a basis-branch with no basis — the case a NULL-admitting CHECK would have passed", async () => {
    // This is the exact shape that went wrong in 0109: written as `kind <> 'basis-branch' OR field IS
    // NOT NULL`, the NULL makes the whole expression NULL and the row is admitted. Enumerating each kind
    // in full is what makes the refusal real, and this is the assertion that proves it.
    await refused(insert, ["1.company-vehicles", "no-basis", 90, "basis-branch", "diesel-demo", null, null, null],
      /input_spec_factor_rules_shape/);
    await refused(insert, ["1.company-vehicles", "half-basis", 91, "basis-branch", "diesel-demo", "unit", null, null],
      /input_spec_factor_rules_shape/);
    // And an empty string is not a basis either.
    await refused(insert, ["1.company-vehicles", "blank-basis", 92, "basis-branch", "diesel-demo", "unit", "  ", null],
      /input_spec_factor_rules_shape/);
  });

  it("refuses a suffix-variant with no suffix, and a lookup carrying one", async () => {
    await refused(insert, ["1.company-vehicles", "no-suffix", 93, "suffix-variant", "car-demo", null, null, null],
      /input_spec_factor_rules_shape/);
    // A lookup with a suffix would be a suffix-variant wearing the wrong name, and which half the
    // resolver honoured would be a coin toss.
    await refused(insert, ["1.company-vehicles", "confused", 94, "lookup", "car-demo", null, null, "-c"],
      /input_spec_factor_rules_shape/);
  });

  it("refuses a suffix nobody registered", async () => {
    // The same guarantee 0110 gives factor ids, now given to the rules that build them: a rule cannot
    // name a category that does not exist.
    await refused(insert, ["1.company-vehicles", "unregistered", 95, "suffix-variant", "car-demo", null, null, "-zz"],
      /factor_category_variants|foreign key/i);
  });

  it("refuses two branches of one field claiming the same value", async () => {
    // Whichever row the ordering happened to put first would win, which is a coin toss wearing a rule's
    // clothing. `litres` is already claimed by the seeded exemplar.
    await refused(insert, ["1.company-vehicles", "duplicate-litres", 96, "basis-branch", "gas-demo", "unit", "litres", null],
      /one_branch_per_value|duplicate key/i);
  });

  it("refuses a rule for a category that does not exist", async () => {
    await refused(insert, ["9.not-a-category", "orphan", 97, "lookup", "diesel-demo", null, null, null],
      /input_spec_categories|foreign key/i);
  });

  it("does not let the application write the rules, but does let it read them", async () => {
    // Governed like the rest of the spec: a change is a migration, or a future admin command carrying
    // its own capability. A REVOKE that is never exercised is a claim about a grant rather than a fact
    // about the database, so it is asserted twice — the privilege, and the behaviour.
    const { rows } = await db.query<{ writable: boolean; readable: boolean }>(
      `SELECT has_table_privilege('nzi_console_app','nzi_console.input_spec_factor_rules','INSERT') AS writable,
              has_table_privilege('nzi_console_app','nzi_console.input_spec_factor_rules','SELECT') AS readable`);
    assert.equal(rows[0]!.writable, false, "the application holds INSERT on the mapping");
    assert.equal(rows[0]!.readable, true, "the application cannot read the mapping it has to apply");

    // And the behaviour, by becoming that role for one statement. Not by connecting as it: the runtime
    // roles are NOLOGIN, so a suite that connects catches the *connection* being refused and never
    // exercises the privilege at all.
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE nzi_console_app");
    await assert.rejects(
      () => db.query(`INSERT INTO nzi_console.input_spec_factor_rules
        (category_code, rule_key, ordering, rule_kind, factor_base, created_by, updated_by)
        VALUES ('1.company-vehicles','sneaky',99,'lookup','diesel-demo','app','app')`),
      /permission denied/i);
    await db.query("ROLLBACK");

    const read = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nzi_console.input_spec_factor_rules`);
    assert.ok(read.rows[0]!.n >= 2, "the seeded exemplars are not readable");
  });
});

describe("a vehicle resolves from what the DVLA lookup returned (NZC-151)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let registry: CategoryVariant[];

  const available = [{ factorId: "diesel-demo", scopes: ["1", "3"] }, { factorId: "gas-demo", scopes: ["1"] }];

  before(async () => {
    database = (await createDisposableDatabase("enriched"))!;
    db = await database.admin();
    const rows = await db.query<{ suffix_code: string; label: string; ghg_category: string; description: string; status: string; sort_order: number }>(
      `SELECT suffix_code, label, ghg_category, description, status, sort_order FROM nzi_console.factor_category_variants`);
    registry = rows.rows.map((row) => ({
      suffixCode: row.suffix_code, label: row.label, ghgCategory: row.ghg_category,
      description: row.description, status: row.status as CategoryVariant["status"], sortOrder: row.sort_order,
    }));
  });

  after(async () => { await db?.end(); await database?.end(); });

  const vehicleRules = () => factorRulesFor(db, "1.company-vehicles");

  it("seeds the enriched rule ahead of the coarser unit rule", async () => {
    // Ordering is the whole of the policy here: a lookup that knows what the vehicle *is* must be
    // consulted before an inference from the unit it was measured in.
    const rules = await vehicleRules();
    assert.deepEqual(rules.map((rule) => [rule.kind, rule.ruleKey]),
      [["enriched", "dvla-diesel"], ["basis-branch", "fuel-litres"]]);
  });

  it("resolves a real stub lookup through the declared rule", async () => {
    // End to end against the shipped stub rather than a hand-written attribute bag: the plate goes to
    // `lookupVehicleByRegistration`, the spec is turned into attributes by the same derivations the
    // lookup flow has always used, and the declared rule picks the factor.
    const found = await lookupVehicleByRegistration("XY34ZAB", { allowStub: true });
    assert.equal(found.ok, true);
    if (!found.ok) return;

    const attributes = vehicleAttributes(found.vehicle);
    // The stub is deterministic per plate and this suite needs a diesel one. Asserted rather than
    // assumed, which is how the first draft was caught using a plate the stub calls petrol — the
    // resolving path would have looked tested and would not have been.
    assert.equal(attributes.fuel, "diesel", "XY34ZAB is no longer a diesel in the stub");

    const outcome = resolveFactorForEntry({
      rules: await vehicleRules(), specGhgCategory: "1",
      entry: { registrationFinder: "XY34ZAB", unit: "litres" },
      available, registry, enrichment: { dvla: attributes },
    });
    assert.equal(outcome.kind, "resolved");
    if (outcome.kind !== "resolved") return;
    assert.equal(outcome.factorId, "diesel-demo");
    assert.equal(outcome.rule.ruleKey, "dvla-diesel", "the unit rule answered instead of the lookup");
  });

  it("leaves the entry unresolved when the lookup finds nothing, though the unit rule would have matched", async () => {
    // The anti-vacuity pairing. `unit: litres` means the seeded `fuel-litres` rule *would* resolve to
    // `diesel-demo` — so a resolver that treated a failed lookup as "no opinion" would return a factor
    // here, and this asserts it does not. The vehicle might have been petrol; nobody would have known.
    const outcome = resolveFactorForEntry({
      rules: await vehicleRules(), specGhgCategory: "1",
      entry: { registrationFinder: "ZZ99ZZZ", unit: "litres" },
      available, registry, enrichment: { dvla: null },
    });
    assert.equal(outcome.kind, "free-search");
    assert.match(outcome.kind === "free-search" ? outcome.reason : "", /left for a person to resolve/);
  });

  it("still resolves by unit when no registration was entered at all", async () => {
    // And the other side of it, so "stops on a failed lookup" is not mistaken for "an enriched rule
    // disables the rest of the category". A consultant who never used the finder is not blocked.
    const outcome = resolveFactorForEntry({
      rules: await vehicleRules(), specGhgCategory: "1",
      entry: { unit: "litres" }, available, registry,
    });
    assert.equal(outcome.kind === "resolved" ? outcome.rule.ruleKey : null, "fuel-litres");
  });

  it("the lookup carries no registration back, so none can reach a row", async () => {
    // NZC-103's boundary, asserted on the shipped result rather than described. The response never
    // echoes the plate, so nothing downstream of here has one to persist.
    const found = await lookupVehicleByRegistration("XY34ZAB", { allowStub: true });
    assert.ok(!JSON.stringify(found).toUpperCase().includes("XY34ZAB"), "the lookup result echoes the plate");
    assert.ok(!JSON.stringify(vehicleAttributes(found.ok ? found.vehicle : {} as never)).toUpperCase().includes("XY34ZAB"));
  });

  it("refuses an enriched rule missing its source or its key field", async () => {
    const insert = `INSERT INTO nzi_console.input_spec_factor_rules
      (category_code, rule_key, ordering, rule_kind, factor_base, enrichment_source, enrichment_key_field,
       basis_field_key, basis_value, created_by, updated_by)
      VALUES ($1,$2,$3,'enriched','diesel-demo',$4,$5,$6,$7,'test','test')`;
    const refused = async (values: unknown[]) => {
      await assert.rejects(() => db.query(insert, values), /input_spec_factor_rules_shape/);
    };
    await refused(["1.company-vehicles", "no-source", 80, null, "registrationFinder", "fuel", "petrol"]);
    await refused(["1.company-vehicles", "no-key", 81, "dvla", null, "fuel", "petrol"]);
    await refused(["1.company-vehicles", "no-basis", 82, "dvla", "registrationFinder", null, null]);
    await refused(["1.company-vehicles", "blank-source", 83, "  ", "registrationFinder", "fuel", "petrol"]);
  });

  it("lets an enriched and a captured basis coexist, and still refuses two of the same", async () => {
    // 0112's uniqueness keyed on (category, field, value); an enriched basis comes from elsewhere, so
    // `fuel=diesel` from the DVLA and `unit=litres` from the entry must both be allowed — they already
    // are, above. What must still be refused is a second rule claiming the same lookup attribute.
    await assert.rejects(
      () => db.query(`INSERT INTO nzi_console.input_spec_factor_rules
        (category_code, rule_key, ordering, rule_kind, factor_base, enrichment_source, enrichment_key_field,
         basis_field_key, basis_value, created_by, updated_by)
        VALUES ('1.company-vehicles','duplicate-dvla-diesel',84,'enriched','gas-demo','dvla','registrationFinder','fuel','diesel','test','test')`),
      /one_branch_per_value|duplicate key/i);
  });
});
