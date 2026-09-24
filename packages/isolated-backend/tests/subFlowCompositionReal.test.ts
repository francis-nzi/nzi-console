import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { resolveFactorForEntry, type CategoryVariant, type FactorRule } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { factorRulesFor } from "../src/inputSpecFactorRules";
import { reconcileUnitForMapping } from "../src/unitCompatibility";

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
  let available: Array<{ factorId: string; scopes: string[]; unit: string }>;

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

    const factors = await db.query<{ factor_id: string; scopes: string[]; activity_unit: string }>(
      `SELECT factor_id, scopes, activity_unit FROM nzi_console.emission_factors WHERE organisation_id = $1`, [DEMO_ORG]);
    available = factors.rows.map((row) => ({ factorId: row.factor_id, scopes: row.scopes, unit: row.activity_unit }));
  });

  after(async () => { await db?.end(); await database?.end(); });

  const rulesByCategory = async (): Promise<Record<string, readonly FactorRule[]>> => ({
    "1.company-vehicles": await factorRulesFor(db, "1.company-vehicles"),
  });

  const resolveFor = async (category: string, over: { available?: typeof available; rules?: FactorRule[] } = {}) =>
    resolveFactorForEntry({ reconcileUnit: reconcileUnitForMapping,
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

  it("resolves in the declared order, not the order the rows were inserted", async () => {
    // The residual the uniqueness loosening made reachable. While a category could hold only one no-basis
    // rule, order among them never mattered. Now a sub-flow and a fallback can coexist and `ordering`
    // decides which answers — so this proves the *database* round-trip honours the declared number rather
    // than insertion or physical row order, which is where an incidental order would leak in.
    //
    // The fallback is inserted second and still loses, then the two numbers are swapped and it wins. One
    // direction alone cannot tell "the declared order was honoured" from "it came out that way".
    await db.query(`INSERT INTO nzi_console.input_spec_factor_rules
      (category_code, rule_key, ordering, rule_kind, factor_base, created_by, updated_by)
      VALUES ('3.6','order-probe-fallback',99,'lookup','diesel-demo','test','test')`);

    const subFlowFirst = await resolveFor("3.6");
    assert.equal(subFlowFirst.kind === "resolved" ? subFlowFirst.factorId : null, "diesel-demo-b",
      "the fallback answered although it was declared behind the sub-flow");

    // Swap the declared numbers. Nothing else changes — same rows, same category, same dataset.
    await db.query(`UPDATE nzi_console.input_spec_factor_rules SET ordering = 5
                     WHERE category_code = '3.6' AND rule_key = 'order-probe-fallback'`);

    const fallbackFirst = await resolveFor("3.6");
    assert.equal(fallbackFirst.kind === "resolved" ? fallbackFirst.factorId : null, "diesel-demo",
      "the declared ordering was ignored on the way back from the database");

    await db.query(`DELETE FROM nzi_console.input_spec_factor_rules WHERE rule_key = 'order-probe-fallback'`);
  });

  /**
   * A rule that resolves the very base a category's sub-flow derives its variants from.
   *
   * **Targeted, not "any lookup near a sub-flow".** The shadowing case is a rule resolving the base the
   * variants come from — `diesel-demo` in a category whose sub-flow produces `diesel-demo-b`. A rail or
   * air lookup in business travel is a different activity with a different factor entirely: it declines on
   * vehicle input and may sit anywhere in the order. Matching on "has a factor base" would refuse it, and
   * an invariant that refuses legitimate authoring gets switched off.
   *
   * **At any order, not merely ahead**, which is a tightening with a reason rather than tidiness. Ordered
   * *ahead*, such a rule answers before the sub-flow runs. Ordered *behind*, it fires whenever the
   * sub-flow declines without stopping — which is precisely the case where the referenced flow identified
   * no vehicle. Resolving the Scope 1 base for an unidentified vehicle, in business travel, is the same
   * leak reached from the other side, and the STOP cannot reach it because nothing was learned to protect.
   */
  /**
   * `EXISTS` rather than joins, so one offending rule is reported once.
   *
   * The first version joined through to the referenced category's rules, and the vehicle category declares
   * **two** rules on `diesel-demo` — the DVLA enriched rule and the unit branch — so a single shadowing
   * rule came back twice. It would still have failed on a violation, but an invariant whose output
   * multiplies by an unrelated count is one whose message nobody trusts. Caught by the probe below
   * asserting an exact count rather than merely "not empty".
   */
  const shadowedBases = () => db.query<{ category_code: string; rule_key: string; factor_base: string }>(
    `SELECT shadow.category_code, shadow.rule_key, shadow.factor_base
       FROM nzi_console.input_spec_factor_rules shadow
      WHERE shadow.active
        AND shadow.factor_base IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM nzi_console.input_spec_factor_rules flow
           WHERE flow.category_code = shadow.category_code
             AND flow.rule_kind = 'sub-flow'
             AND flow.active
             AND EXISTS (
               SELECT 1
                 FROM nzi_console.input_spec_factor_rules source
                WHERE source.category_code = flow.sub_flow_category
                  AND source.active
                  AND source.factor_base = shadow.factor_base))`);

  it("declares no rule resolving the base its own sub-flow derives variants from", async () => {
    const { rows } = await shadowedBases();
    assert.deepEqual(rows, [],
      "a rule resolves the Scope 1 base that this category's sub-flow turns into a category variant, so "
      + "the variant is bypassed and the emission is filed against the base");
  });

  it("permits an unrelated fallback in the same category, which is what makes it targeted", async () => {
    // The other half. An invariant that also refused this would be refusing legitimate authoring — a rail
    // leg in business travel is a different activity, not a shadow of the vehicle base — and an invariant
    // that refuses legitimate authoring is one somebody eventually deletes.
    await db.query(`INSERT INTO nzi_console.emission_factors
      (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
      VALUES ($1,'synthetic-gb-2026','rail-demo','Rail — demonstration factor','passenger.km',0.035,ARRAY['3'])`,
    [DEMO_ORG]);
    await db.query(`INSERT INTO nzi_console.input_spec_factor_rules
      (category_code, rule_key, ordering, rule_kind, factor_base, created_by, updated_by)
      VALUES ('3.6','rail-leg',5,'lookup','rail-demo','test','test')`);

    const { rows } = await shadowedBases();
    assert.deepEqual(rows, [], "a different-activity fallback was reported as shadowing the vehicle base");

    await db.query(`DELETE FROM nzi_console.input_spec_factor_rules WHERE rule_key = 'rail-leg'`);
  });

  it("catches the shadow wherever it is ordered, ahead of the sub-flow or behind it", async () => {
    // Watched failing in both positions, because the tightening from "not ahead" to "at all" is only worth
    // having if the behind case is actually reported.
    for (const ordering of [1, 900]) {
      await db.query(`INSERT INTO nzi_console.input_spec_factor_rules
        (category_code, rule_key, ordering, rule_kind, factor_base, created_by, updated_by)
        VALUES ('3.6','shadow-probe',$1,'lookup','diesel-demo','test','test')`, [ordering]);

      const { rows } = await shadowedBases();
      assert.equal(rows.length, 1, `a shadowing rule at ordering ${ordering} was not reported`);
      assert.equal(rows[0]!.factor_base, "diesel-demo");

      await db.query(`DELETE FROM nzi_console.input_spec_factor_rules WHERE rule_key = 'shadow-probe'`);
    }
    // And clean again afterwards, so the invariant above is not passing on a deleted row.
    assert.deepEqual((await shadowedBases()).rows, []);
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
