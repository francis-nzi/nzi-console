import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { resolveFactorForEntry, type CategoryVariant, type FactorRule } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { factorRulesFor } from "../src/inputSpecFactorRules";

/**
 * Sub-flow composition against the real tables and the real seeded factors (NZC-158).
 *
 * The half this suite exists for is the **rate**. An assertion that business travel resolves to
 * `diesel-demo-b` passes just as happily against a variant priced at half the base — the identity would be
 * right and the number wrong, which is the harder of the two to notice. So the seeded factor rows are read
 * back and the three rates compared.
 *
 * It matters that they are the **seeded** rows rather than rows this test inserts. A test that writes the
 * factors it then compares is asserting its own arithmetic; what needs checking is what ships.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const DEMO_ORG = "demo-nzi-console";
const here = dirname(fileURLToPath(import.meta.url));

describe("business travel and commuting reuse the vehicle flow (NZC-158)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let registry: CategoryVariant[];
  let available: Array<{ factorId: string; scopes: string[] }>;

  before(async () => {
    database = (await createDisposableDatabase("subflow"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [DEMO_ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [DEMO_ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [DEMO_ORG]);

    // The shipped factor seed, run as written. Reading it rather than restating it is the same discipline
    // the rules themselves follow: one definition, referenced.
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));

    const variants = await db.query<{ suffix_code: string; label: string; ghg_category: string; description: string; status: string; sort_order: number }>(
      `SELECT suffix_code, label, ghg_category, description, status, sort_order FROM nzi_console.factor_category_variants`);
    registry = variants.rows.map((row) => ({
      suffixCode: row.suffix_code, label: row.label, ghgCategory: row.ghg_category,
      description: row.description, status: row.status as CategoryVariant["status"], sortOrder: row.sort_order,
    }));

    const factors = await db.query<{ factor_id: string; scopes: string[] }>(
      `SELECT factor_id, scopes FROM nzi_console.emission_factors WHERE organisation_id = $1`, [DEMO_ORG]);
    available = factors.rows.map((row) => ({ factorId: row.factor_id, scopes: row.scopes }));
  });

  after(async () => { await db?.end(); await database?.end(); });

  const rulesByCategory = async (): Promise<Record<string, readonly FactorRule[]>> => ({
    "1.company-vehicles": await factorRulesFor(db, "1.company-vehicles"),
  });

  const resolveFor = async (category: string, over: { available?: typeof available; rules?: FactorRule[] } = {}) =>
    resolveFactorForEntry({
      rules: over.rules ?? await factorRulesFor(db, category),
      specGhgCategory: "3",
      entry: { unit: "litres" },
      available: over.available ?? available,
      registry,
      rulesByCategory: await rulesByCategory(),
    });

  // ── Half (a): identity is the variant, and the two categories are distinct ────────────

  it("resolves business travel to the -b variant and commuting to -c, never to the base", async () => {
    const travel = await resolveFor("3.6");
    const commute = await resolveFor("3.7");

    assert.equal(travel.kind, "resolved");
    assert.equal(commute.kind, "resolved");
    if (travel.kind !== "resolved" || commute.kind !== "resolved") return;

    assert.equal(travel.factorId, "diesel-demo-b", "business travel did not take its own variant");
    assert.equal(commute.factorId, "diesel-demo-c", "commuting did not take its own variant");
    assert.notEqual(travel.factorId, "diesel-demo", "business travel resolved to the Scope 1 base");
    assert.notEqual(commute.factorId, "diesel-demo", "commuting resolved to the Scope 1 base");
    assert.notEqual(travel.factorId, commute.factorId, "the two categories resolved to one identity");

    assert.equal(travel.scope.ghgCategory, "3.6");
    assert.equal(commute.scope.ghgCategory, "3.7");
  });

  it("reuses the vehicle flow rather than restating it", async () => {
    // Composition, not duplication: neither category declares a factor of its own. Both carry a single
    // sub-flow rule pointing at the vehicle category, so a change to how a vehicle is identified reaches
    // all three consumers — and a copy of the flow appearing in either would fail here.
    for (const category of ["3.6", "3.7"]) {
      const rules = await factorRulesFor(db, category);
      assert.equal(rules.length, 1, `${category} declares more than the sub-flow`);
      assert.equal(rules[0]!.kind, "sub-flow");
      assert.equal(rules[0]!.kind === "sub-flow" ? rules[0]!.subFlowCategory : null, "1.company-vehicles");
    }
  });

  // ── Half (b): the rate, which identity alone does not pin ────────────────────────────

  it("prices every variant of the base identically, which is the P2 invariant", async () => {
    // The combustion does not change because the journey was a commute. A variant carrying a different
    // number is not a variant, it is another factor wearing the name — and half (a) above would pass
    // against exactly that.
    const { rows } = await db.query<{ factor_id: string; kgco2e_per_unit: string; activity_unit: string }>(
      `SELECT factor_id, kgco2e_per_unit::text, activity_unit FROM nzi_console.emission_factors
        WHERE organisation_id = $1 AND factor_id IN ('diesel-demo','diesel-demo-b','diesel-demo-c')
        ORDER BY factor_id`, [DEMO_ORG]);
    assert.equal(rows.length, 3, "the base and its two variants are not all seeded");

    const rates = new Set(rows.map((row) => Number(row.kgco2e_per_unit)));
    assert.equal(rates.size, 1, `the variants are priced differently from the base: ${[...rates].join(", ")}`);

    // And the unit is inherited unchanged (NZC-146): a variant that changed unit would be a different
    // factor, and the quantity would be multiplied by a rate that does not belong to it.
    const units = new Set(rows.map((row) => row.activity_unit));
    assert.equal(units.size, 1, `the variants changed unit: ${[...units].join(", ")}`);
    assert.equal([...units][0], "litres");
  });

  // ── Addition 2: the second leak, against the real registry and dataset ───────────────

  it("STOPS when the composed variant is absent, and does not fall back to the Scope 1 base", async () => {
    // The base is present in this dataset — deliberately — so a resolver that fell back would succeed
    // here. That is what makes the assertion worth writing: it can fail.
    const withoutVariants = available.filter((factor) => !factor.factorId.startsWith("diesel-demo-"));
    assert.ok(withoutVariants.some((factor) => factor.factorId === "diesel-demo"),
      "the base must remain available, or this proves nothing");

    const outcome = await resolveFor("3.6", { available: withoutVariants });
    assert.equal(outcome.kind, "free-search", "a missing variant resolved to the Scope 1 base");
    assert.match(outcome.kind === "free-search" ? outcome.reason : "", /could not be composed/);
    assert.match(outcome.kind === "free-search" ? outcome.reason : "", /belongs to a different scope/);
  });

  it("refuses a rule that names a suffix outside the registry", async () => {
    // Asserted at the database, not only in the resolver: the foreign key means a rule cannot name a
    // category nobody registered in the first place.
    await assert.rejects(
      () => db.query(`INSERT INTO nzi_console.input_spec_factor_rules
        (category_code, rule_key, ordering, rule_kind, sub_flow_category, suffix_code, created_by, updated_by)
        VALUES ('3.6','bad-suffix',90,'sub-flow','1.company-vehicles','-zz','test','test')`),
      /factor_category_variants|foreign key/i);
  });

  it("still refuses two branches of one field claiming the same value", async () => {
    // 0116 loosened this key to a partial index, so what it was for has to be re-proved rather than
    // assumed. Two captured branches on the same field and value are still the coin toss 0112 refused.
    await db.query(`INSERT INTO nzi_console.input_spec_factor_rules
      (category_code, rule_key, ordering, rule_kind, factor_base, basis_field_key, basis_value, created_by, updated_by)
      VALUES ('3.6','branch-one',80,'basis-branch','diesel-demo','unit','litres','test','test')`);
    await assert.rejects(
      () => db.query(`INSERT INTO nzi_console.input_spec_factor_rules
        (category_code, rule_key, ordering, rule_kind, factor_base, basis_field_key, basis_value, created_by, updated_by)
        VALUES ('3.6','branch-two',81,'basis-branch','gas-demo','unit','litres','test','test')`),
      /one_branch_per_value|duplicate key/i);

    // And 0113's half: a DVLA basis and a captured basis on the same field and value still collide, which
    // is what `NULLS NOT DISTINCT` is carried through the partial index for.
    await assert.rejects(
      () => db.query(`INSERT INTO nzi_console.input_spec_factor_rules
        (category_code, rule_key, ordering, rule_kind, factor_base, enrichment_source, enrichment_key_field, basis_field_key, basis_value, created_by, updated_by)
        VALUES ('3.6','branch-three',82,'enriched','gas-demo','dvla','registrationFinder','unit','litres','test','test')`)
        .then(() => db.query(`INSERT INTO nzi_console.input_spec_factor_rules
          (category_code, rule_key, ordering, rule_kind, factor_base, enrichment_source, enrichment_key_field, basis_field_key, basis_value, created_by, updated_by)
          VALUES ('3.6','branch-four',83,'enriched','diesel-demo','dvla','registrationFinder','unit','litres','test','test')`)),
      /one_branch_per_value|duplicate key/i);

    await db.query(`DELETE FROM nzi_console.input_spec_factor_rules WHERE rule_key LIKE 'branch-%'`);
  });

  it("now allows a category to carry a sub-flow and a fallback behind it", async () => {
    // What the partial index unlocks, and the reason it was loosened: before, every rule with no basis
    // keyed as (category, NULL, NULL, NULL), so a category could hold exactly one of them. A sub-flow
    // with a lookup behind it — the ordinary additive shape, and what first-match-wins exists for — was
    // refused by the schema while the resolver supported it.
    await db.query(`INSERT INTO nzi_console.input_spec_factor_rules
      (category_code, rule_key, ordering, rule_kind, factor_base, created_by, updated_by)
      VALUES ('3.6','fallback-lookup',85,'lookup','diesel-demo-b','test','test')`);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nzi_console.input_spec_factor_rules WHERE category_code = '3.6'`);
    assert.equal(rows[0]!.n, 2, "a category still cannot hold a sub-flow and a fallback");
    await db.query(`DELETE FROM nzi_console.input_spec_factor_rules WHERE rule_key = 'fallback-lookup'`);
  });

  it("refuses a sub-flow that carries a base of its own, or names itself", async () => {
    // Two answers in one rule, and which won would be an implementation detail.
    await assert.rejects(
      () => db.query(`INSERT INTO nzi_console.input_spec_factor_rules
        (category_code, rule_key, ordering, rule_kind, sub_flow_category, suffix_code, factor_base, created_by, updated_by)
        VALUES ('3.6','two-answers',91,'sub-flow','1.company-vehicles','-b','diesel-demo','test','test')`),
      /input_spec_factor_rules_shape/);

    await assert.rejects(
      () => db.query(`INSERT INTO nzi_console.input_spec_factor_rules
        (category_code, rule_key, ordering, rule_kind, sub_flow_category, suffix_code, created_by, updated_by)
        VALUES ('3.6','itself',92,'sub-flow','3.6','-b','test','test')`),
      /no_self_reference/);
  });
});
