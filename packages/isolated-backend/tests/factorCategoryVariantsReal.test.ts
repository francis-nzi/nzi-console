import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  addCategoryVariant, countVariantUse, listCategoryVariants, readCategoryVariants,
  relabelCategoryVariant, retireCategoryVariant, VariantRegistryError,
} from "../src/factorCategoryVariants";
import { availableVariants, factorBase, groupByBase, parseFactorId, variantFactorId } from "@nzi/contracts";
import { AuthorizationError, type StaffPrincipal } from "../src/auth";

/**
 * The category-variant registry, against real Postgres (NZC-145).
 *
 * Three claims carry this suite:
 *
 *   1. **A base is recovered by the registry, not by a pattern.** Every factor already seeded ends in
 *      something that looks like a suffix — `diesel-demo`, `electricity-us-demo` — so the test that matters
 *      is the negative one: those must parse as their own base with no variant. A parser that split on the
 *      last hyphen would pass every positive case in here and still be wrong about the real data.
 *   2. **A retired variant leaves new fan-outs and stays resolvable.** Two different questions, and a
 *      single flag would answer one of them wrongly.
 *   3. **The permanence guard fires.** A guard that cannot be demonstrated refusing is not a guard, and
 *      this one has to hold against the *owner* — which is the identity this suite connects as, and the one
 *      a grant would not have stopped.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-variants";
const OTHER = "org-variants-two";
const ACTOR = "admin-a";

const principal = (...held: string[]) => ({
  userId: ACTOR, organisationId: ORG, role: "admin",
  capabilities: held.map((capability) => ({ capability, scope: "all" })),
} as unknown as StaffPrincipal);

/** The registry is estate-wide, so writing to it is Admin's `factor.manage` and nobody else's. */
const admin = principal("factor.manage");

describe("the category-variant registry (NZC-145)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("factorvariants"))!;
    db = await database.admin();
    for (const organisation of [ORG, OTHER]) {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [organisation]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [organisation]);
    }
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);

    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets
         (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'ds-1','Test set','2026.1','2026-01-01','2026-12-31','GB','active','test','test')`, [ORG]);

    // A base with two variants, and — the case that matters — two factors whose ids merely end in
    // something suffix-shaped that nobody registered.
    for (const [id, label, kg] of [
      ["car-petrol", "Petrol car", 0.17],
      ["car-petrol-b", "Petrol car (business travel)", 0.17],
      ["car-petrol-c", "Petrol car (commuting)", 0.17],
      ["diesel-demo", "Diesel — demonstration factor", 2.5],
      ["electricity-us-demo", "US electricity — demonstration factor", 0.4],
    ] as const) {
      await db.query(
        `INSERT INTO nzi_console.emission_factors
           (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
         VALUES ($1,'ds-1',$2,$3,'km',$4,ARRAY['1'])`, [ORG, id, label, kg]);
    }
  });

  after(async () => { await db?.end(); await database?.end(); });

  const registry = () => listCategoryVariants(db);

  // ── The seeded vocabulary ───────────────────────────────────────────────────────────

  it("seeds the six current variants, each naming its GHG category", async () => {
    const variants = await registry();
    assert.deepEqual(
      variants.map((variant) => `${variant.suffixCode}:${variant.ghgCategory}`),
      ["-c:3.7", "-b:3.6", "-p:3.1", "-u:3.4", "-d:3.9", "-w:3.5"],
      "in the registry's own order, which is stated rather than alphabetical by suffix letter");
    for (const variant of variants) {
      assert.match(variant.suffixCode, /^-[a-z]{1,4}$/);
      assert.ok(variant.label.trim(), `${variant.suffixCode} has no label`);
      assert.ok(variant.description.trim(), `${variant.suffixCode} has no description`);
      assert.equal(variant.status, "active");
    }
  });

  it("is estate-wide: one vocabulary, not one per tenant", async () => {
    // A factor id must not mean one category for one client and another for the next, so the definition
    // tier has no organisation column — the same shape as `reference_categories`.
    const here = await readCategoryVariants(database.pool, ORG);
    const there = await readCategoryVariants(database.pool, OTHER);
    assert.deepEqual(here.map((variant) => variant.suffixCode), there.map((variant) => variant.suffixCode));

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
        WHERE table_schema='nzi_console' AND table_name='factor_category_variants'
          AND column_name='organisation_id'`);
    assert.equal(rows[0]!.count, "0", "a per-tenant registry would let two tenants define -c differently");
  });

  // ── Parsing, and the negative case that decides it ──────────────────────────────────

  it("recovers a base by splitting on the registry, never on a pattern", async () => {
    const variants = await registry();

    const business = parseFactorId("car-petrol-b", variants);
    assert.equal(business.base, "car-petrol");
    assert.equal(business.variant?.suffixCode, "-b");
    assert.equal(business.variant?.ghgCategory, "3.6");

    const commuting = parseFactorId("car-petrol-c", variants);
    assert.equal(commuting.base, "car-petrol");
    assert.equal(commuting.variant?.ghgCategory, "3.7");

    // The base itself carries no suffix.
    assert.equal(parseFactorId("car-petrol", variants).variant, null);
    assert.equal(factorBase("car-petrol", variants), "car-petrol");
  });

  it("does not invent a variant for an id that merely ends in something suffix-shaped", async () => {
    // The assertion this whole design turns on. `-demo` is not registered, so these are their own bases —
    // a parser splitting on the last hyphen would report `diesel` with a `-demo` variant, attach a category
    // nobody defined, and group two unrelated factors together.
    const variants = await registry();
    for (const id of ["diesel-demo", "electricity-us-demo", "lca-rpet-demo", "freight-demo"]) {
      const parsed = parseFactorId(id, variants);
      assert.equal(parsed.variant, null, `${id} must not parse as a variant`);
      assert.equal(parsed.base, id, `${id} is its own base`);
    }

    // And a suffix on its own is not a variant of anything.
    assert.equal(parseFactorId("-c", variants).variant, null);
    assert.equal(parseFactorId("-c", variants).base, "-c");
  });

  it("prefers the longer suffix, so a registry cannot make an id ambiguous", async () => {
    await addCategoryVariant(database.pool, admin, {
      organisationId: ORG, suffixCode: "-ud", label: "Upstream, disaggregated",
      ghgCategory: "3.4", description: "A longer suffix that ends with a registered shorter one.",
    });
    const variants = await registry();
    // `-ud` ends with `-d`, so order-of-arrival would decide this if length did not.
    const parsed = parseFactorId("pallet-ud", variants);
    assert.equal(parsed.variant?.suffixCode, "-ud");
    assert.equal(parsed.base, "pallet");
  });

  it("groups variants under one base, in the registry's order", async () => {
    const variants = await registry();
    const factors = (await db.query<{ factor_id: string }>(
      `SELECT factor_id FROM nzi_console.emission_factors WHERE organisation_id=$1 ORDER BY factor_id`, [ORG])).rows;

    const groups = groupByBase(factors, (factor) => factor.factor_id, variants);
    const car = groups.find((group) => group.base === "car-petrol")!;
    assert.equal(car.canonical?.factor_id, "car-petrol", "the unsuffixed factor is the canonical member");
    assert.deepEqual(car.variants.map((entry) => entry.variant.suffixCode), ["-c", "-b"],
      "commuting before business travel, which is the registry's stated order and not alphabetical");

    // The look-alikes are their own groups rather than variants of a shorter base.
    assert.ok(groups.some((group) => group.base === "diesel-demo"));
    assert.ok(groups.some((group) => group.base === "electricity-us-demo"));

    // All variants of a base share the value. A variant with a different number is a different factor.
    const values = (await db.query<{ kgco2e_per_unit: string }>(
      `SELECT kgco2e_per_unit FROM nzi_console.emission_factors
        WHERE organisation_id=$1 AND factor_id LIKE 'car-petrol%'`, [ORG])).rows;
    assert.equal(new Set(values.map((row) => row.kgco2e_per_unit)).size, 1,
      "the suffix records the category, never a different value");
  });

  it("builds the id a fan-out would write", async () => {
    const variants = await registry();
    const commuting = variants.find((variant) => variant.suffixCode === "-c")!;
    assert.equal(variantFactorId("car-petrol", commuting), "car-petrol-c");
    // And it round-trips, which is the property a fan-out depends on.
    assert.equal(parseFactorId(variantFactorId("car-petrol", commuting), variants).base, "car-petrol");
  });

  // ── Retirement: two different questions ─────────────────────────────────────────────

  it("withholds a retired variant from new fan-outs and still resolves the history", async () => {
    const outcome = await retireCategoryVariant(database.pool, admin, {
      organisationId: ORG, suffixCode: "-w",
      reason: "Waste moved to its own dataset, so the variant is no longer offered.",
    });
    assert.equal(outcome.variant.status, "retired");
    assert.equal(outcome.alreadyRetired, false);

    const variants = await registry();
    assert.ok(!availableVariants(variants).some((variant) => variant.suffixCode === "-w"),
      "a retired variant is not offered to a new fan-out");

    // Still parses — the factors already carrying it are history, and an id that stopped resolving would
    // take its category with it.
    const parsed = parseFactorId("skip-hire-w", variants);
    assert.equal(parsed.variant?.suffixCode, "-w");
    assert.equal(parsed.variant?.ghgCategory, "3.5");
    assert.equal(parsed.base, "skip-hire");

    // Idempotent, because the desired state is the same on a second call.
    const again = await retireCategoryVariant(database.pool, admin, {
      organisationId: ORG, suffixCode: "-w", reason: "again",
    });
    assert.equal(again.alreadyRetired, true);
  });

  it("records who retired it and why", async () => {
    const { rows } = await db.query<{ after_json: { reason: string; suffixCode: string }; actor_id: string }>(
      `SELECT after_json, actor_id FROM nzi_console.audit_events
        WHERE action='factor.variant.retired' AND entity_id='-w' ORDER BY occurred_at LIMIT 1`);
    assert.equal(rows[0]!.actor_id, ACTOR);
    assert.match(rows[0]!.after_json.reason, /own dataset/,
      "a retirement with no stated reason is a change nobody can review");
  });

  // ── The permanence guard, proved to fire ────────────────────────────────────────────

  it("refuses to rename a suffix code, even as the owner", async () => {
    // The guard has to hold against the *owner*: that is the identity applying migrations and the one this
    // suite connects as, and a REVOKE would not have stopped it. So it is a trigger, and this is the
    // assertion that it fires rather than decorating the migration.
    await assert.rejects(
      () => db.query(`UPDATE nzi_console.factor_category_variants SET suffix_code='-x' WHERE suffix_code='-c'`),
      /never renamed/,
      "renaming a suffix would silently re-categorise every factor already carrying it");

    const variants = await registry();
    assert.ok(variants.some((variant) => variant.suffixCode === "-c"), "and -c is still there");
    assert.ok(!variants.some((variant) => variant.suffixCode === "-x"));
  });

  it("refuses to delete a variant, even as the owner", async () => {
    await assert.rejects(
      () => db.query(`DELETE FROM nzi_console.factor_category_variants WHERE suffix_code='-b'`),
      /never deleted/);
    assert.ok((await registry()).some((variant) => variant.suffixCode === "-b"));
  });

  it("refuses to change what a suffix means", async () => {
    // A rename by another route: leaving `-b` in place and pointing it at another category would
    // re-categorise the same rows just as thoroughly.
    await assert.rejects(
      () => db.query(`UPDATE nzi_console.factor_category_variants SET ghg_category='3.9' WHERE suffix_code='-b'`),
      /keeps its GHG category/);
    const business = (await registry()).find((variant) => variant.suffixCode === "-b")!;
    assert.equal(business.ghgCategory, "3.6");
  });

  it("allows the label and description to be refined", async () => {
    const updated = await relabelCategoryVariant(database.pool, admin, {
      organisationId: ORG, suffixCode: "-b",
      label: "Business travel (road)", description: "Refined wording.",
    });
    assert.equal(updated.label, "Business travel (road)");
    assert.equal(updated.ghgCategory, "3.6", "and the meaning is untouched");

    const audited = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM nzi_console.audit_events WHERE action='factor.variant.relabelled'`);
    assert.ok(Number(audited.rows[0]!.count) > 0, "a refinement is still an audited act");
  });

  // ── Adding ──────────────────────────────────────────────────────────────────────────

  it("adds a variant that is usable immediately, and refuses a malformed or duplicate one", async () => {
    const added = await addCategoryVariant(database.pool, admin, {
      organisationId: ORG, suffixCode: "-fr", label: "Franchises",
      ghgCategory: "3.14", description: "The same factor used by a franchisee.", sortOrder: 70,
    });
    assert.equal(added.status, "active");
    assert.ok(availableVariants(await registry()).some((variant) => variant.suffixCode === "-fr"),
      "available to a fan-out as soon as it is added");
    assert.equal(parseFactorId("kiosk-fr", await registry()).variant?.ghgCategory, "3.14");

    for (const bad of ["c", "-C", "-toolong", "-c1", "--c", ""]) {
      await assert.rejects(
        () => addCategoryVariant(database.pool, admin, {
          organisationId: ORG, suffixCode: bad, label: "x", ghgCategory: "3.1",
        }),
        (error: unknown) => error instanceof VariantRegistryError && error.reason === "shape",
        `'${bad}' is not a suffix`);
    }

    // A duplicate is refused with its status named, because "already there" and "already there but
    // retired" call for different actions.
    await assert.rejects(
      () => addCategoryVariant(database.pool, admin, {
        organisationId: ORG, suffixCode: "-w", label: "Waste again", ghgCategory: "3.5",
      }),
      (error: unknown) => error instanceof VariantRegistryError && error.reason === "duplicate"
        && /retired/.test(error.message));
  });

  it("refuses a caller without factor.manage, on every one of the three commands", async () => {
    // The registry is estate-wide: a write reaches every tenant, so the capability is the whole of the
    // protection and a gate nobody has watched refuse is not one. `factor.manage` is Admin's alone —
    // a consultant holds `clientfactor.manage`, which is a different capability over a different thing.
    for (const held of [[], ["clientfactor.manage"], ["dataset.manage"], ["scoperow.edit"]]) {
      const caller = principal(...held);
      const naming = held.join("+") || "nothing";

      await assert.rejects(
        () => addCategoryVariant(database.pool, caller, {
          organisationId: ORG, suffixCode: "-zz", label: "Sneaked in", ghgCategory: "3.1",
        }),
        (error: unknown) => error instanceof AuthorizationError && error.permission === "factor.manage",
        `holding ${naming} must not add a variant`);

      await assert.rejects(
        () => relabelCategoryVariant(database.pool, caller, {
          organisationId: ORG, suffixCode: "-c", label: "Renamed by the unauthorised",
        }),
        (error: unknown) => error instanceof AuthorizationError && error.permission === "factor.manage",
        `holding ${naming} must not relabel a variant`);

      await assert.rejects(
        () => retireCategoryVariant(database.pool, caller, {
          organisationId: ORG, suffixCode: "-p", reason: "not theirs to retire",
        }),
        (error: unknown) => error instanceof AuthorizationError && error.permission === "factor.manage",
        `holding ${naming} must not retire a variant`);
    }

    // Nothing leaked through: the refusals happen before any write, so the registry is as it was.
    const variants = await registry();
    assert.ok(!variants.some((variant) => variant.suffixCode === "-zz"));
    assert.equal(variants.find((variant) => variant.suffixCode === "-c")!.label, "Commuting");
    assert.equal(variants.find((variant) => variant.suffixCode === "-p")!.status, "active");
  });

  it("counts use within the organisation, and says that is what it is", async () => {
    // Tenant-scoped on purpose: factors are tenant-scoped under forced RLS while the registry is not, so an
    // estate-wide total would need a definer read. The figure is information for a person and never an
    // input to the permanence rule — which is why that rule does not consult it.
    const used = await countVariantUse(db, ORG);
    assert.equal(used.get("-c"), 1, "car-petrol-c");
    assert.equal(used.get("-b"), 1, "car-petrol-b");
    assert.equal(used.get("-p"), 0);

    const otherTenant = await countVariantUse(db, OTHER);
    assert.equal(otherTenant.get("-c"), 0, "another tenant's count is its own");
  });
});
