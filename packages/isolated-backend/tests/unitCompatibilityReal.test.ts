import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { checkUnit, isAcceptedUnit, quantityInFactorUnit, unitDimension } from "../src/unitCompatibility";
import { CommandValidationError, createScopeRow, updateScopeRow } from "../src/index";
import { listInputSpec } from "../src/inputSpecRecords";
import { MILES_PER_KM } from "../src/lcaUnits";

/**
 * Unit compatibility, against real Postgres (NZC-146).
 *
 * The claim that matters is the negative one. A check that accepts everything passes every test written
 * about the things it should accept — so the assertions that decide whether this works are the ones about
 * litres against a per-kilometre factor, and about a unit nobody has heard of.
 *
 * The positive half has to be exact, not merely "it converted something": a conversion that is wrong by a
 * factor is worse than no conversion, because it produces a plausible number instead of a refusal.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-units";

describe("a unit either reconciles with the factor or the entry is refused (NZC-146)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("unitcompat"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── The refusals, which are what make the acceptances mean anything ─────────────────

  it("refuses a unit that measures something else entirely", async () => {
    // The case this exists for: litres of diesel against a per-kilometre factor. Nothing crashes, the
    // arithmetic works, and the answer is a fiction that looks ordinary on a client's report.
    const wrong = checkUnit("litres", "kgCO2e/km");
    assert.equal(wrong.kind, "reject");
    assert.match(wrong.kind === "reject" ? wrong.reason : "", /different quantities/);

    for (const [entered, factorUnit] of [
      ["kWh", "km"], ["km", "kWh"], ["tonnes", "litres"], ["GBP", "kWh"],
      ["m²", "units"], ["passenger.km", "km"],
    ] as const) {
      assert.equal(checkUnit(entered, factorUnit).kind, "reject",
        `${entered} must not stand for ${factorUnit}`);
    }
  });

  it("treats a passenger-kilometre as its own quantity, not a kilometre", async () => {
    // Worth its own assertion because the two look alike and differ by occupancy: a factor priced per
    // passenger-km applied to vehicle-km understates a full car by however many people were in it.
    assert.equal(unitDimension("passenger.km"), "passenger-distance");
    assert.equal(unitDimension("km"), "distance");
    assert.equal(checkUnit("km", "passenger.km").kind, "reject");
    // And within the dimension it still converts.
    const converted = checkUnit("passenger.mi", "passenger.km");
    assert.equal(converted.kind, "convert");
  });

  it("refuses a unit it has never heard of rather than passing it through", async () => {
    // The tempting default — "unknown? assume it is fine" — is the shape of check whose failure looks
    // exactly like its success.
    assert.equal(checkUnit("furlongs", "km").kind, "reject");
    assert.equal(checkUnit("km", "smoots").kind, "reject");
    assert.equal(checkUnit(null, "km").kind, "reject");
    assert.equal(checkUnit("km", null).kind, "reject");
    assert.equal(checkUnit("", "km").kind, "reject");
  });

  // ── The conversions, exact ──────────────────────────────────────────────────────────

  it("converts within a dimension, to the figure and not merely to a figure", async () => {
    const miles = quantityInFactorUnit(100, "mi", "km")!;
    // 100 miles in kilometres, using lcaUnits' own constant rather than a second rounding of it.
    assert.ok(Math.abs(miles.quantity - 100 / MILES_PER_KM) < 1e-9);
    assert.ok(Math.abs(miles.quantity - 160.9344) < 1e-3, "100 miles is about 160.9 km");

    const tonnes = quantityInFactorUnit(2.5, "tonnes", "kg")!;
    assert.equal(tonnes.quantity, 2500);

    const gj = quantityInFactorUnit(1, "GJ", "kWh")!;
    assert.ok(Math.abs(gj.quantity - 277.7777) < 1e-3, "1 GJ is 277.78 kWh");

    const mwh = quantityInFactorUnit(3, "MWh", "kWh")!;
    assert.equal(mwh.quantity, 3000);

    const cubic = quantityInFactorUnit(2, "m³", "litres")!;
    assert.equal(cubic.quantity, 2000);
  });

  it("leaves an identical unit alone rather than multiplying it by one", async () => {
    const same = quantityInFactorUnit(42, "kWh", "kWh")!;
    assert.equal(same.quantity, 42);
    assert.equal(same.check.kind, "same");
    // Case and spacing are the same unit; punctuation is not guessed at.
    assert.equal(checkUnit(" KWH ", "kWh").kind, "same");
  });

  it("refuses two units of an unconvertible kind rather than defaulting to one", async () => {
    // Money, counts and area have no ratio between members. A silent 1.0 here is how "£1 = 1 night"
    // would get past a check that claimed to be doing something.
    assert.equal(checkUnit("units", "nights").kind, "reject");
    assert.equal(unitDimension("GBP"), "money");
    assert.equal(quantityInFactorUnit(10, "units", "nights"), null);
  });

  // ── The spec half ───────────────────────────────────────────────────────────────────

  it("declares accepted units per field, and the seeded ones are a narrowing", async () => {
    const spec = await listInputSpec(db);
    const unitsFor = (code: string) =>
      spec.find((category) => category.categoryCode === code)?.fields.find((field) => field.fieldKey === "unit")?.acceptedUnits ?? null;

    assert.deepEqual(unitsFor("2.purchased-electricity"), ["kWh"],
      "electricity is metered in energy — it no longer offers litres and square metres");
    assert.deepEqual(unitsFor("1.company-vehicles"), ["litres", "km", "mi"]);
    assert.deepEqual(unitsFor("3.6"), ["passenger.km", "passenger.mi", "km", "mi"]);

    // Each declaration is a subset of the list its category already carried: this migration narrows what
    // 0093 offered and does not invent a unit for a category.
    for (const code of ["2.purchased-electricity", "1.company-vehicles", "3.5", "3.6", "3.7"]) {
      const category = spec.find((entry) => entry.categoryCode === code)!;
      const accepted = unitsFor(code)!;
      for (const unit of accepted) {
        assert.ok(category.units.includes(unit),
          `${code} accepts ${unit}, which its category does not offer — that is a domain decision, not a narrowing`);
      }
    }

    // Left null on purpose, and the reason is recorded in the migration: a refrigerant charge is measured
    // in kilograms, which no category offers yet.
    assert.equal(unitsFor("1.refrigerants"), null);
  });

  it("accepts any unit where a field declares none, which is what makes this additive", async () => {
    // The claim that the 20 seeded specs keep working: an undeclared field constrains nothing.
    assert.equal(isAcceptedUnit("anything at all", []), true);
    assert.equal(isAcceptedUnit("kWh", ["kWh"]), true);
    assert.equal(isAcceptedUnit("litres", ["kWh"]), false);
    // Spelling is matched the same way the factor check matches it.
    assert.equal(isAcceptedUnit(" KWH ", ["kWh"]), true);
  });

  it("holds the whole seeded spec to units it can actually check", async () => {
    // A declared unit the checker does not recognise would refuse every entry for that field — a spec
    // that cannot be satisfied. Asserted across every category rather than the handful touched here.
    const spec = await listInputSpec(db);
    const unknown: string[] = [];
    for (const category of spec) {
      for (const field of category.fields) {
        for (const unit of field.acceptedUnits ?? []) {
          if (unitDimension(unit) === null) unknown.push(`${category.categoryCode}.${field.fieldKey}: ${unit}`);
        }
      }
    }
    assert.deepEqual(unknown, [], "a declared unit that the checker cannot recognise refuses every entry");
    assert.ok(spec.length >= 20, `only ${spec.length} categories read — the spec did not load`);
  });
});

/**
 * The same rule, reached through the commands that write rows.
 *
 * Separate from the block above on purpose, and not a duplicate of it. NZC-145 was written after a gate
 * that was asserted on its helper while the command path asked nobody: every test passed and nothing was
 * guarded. So what is proved here is not that `checkUnit` refuses — that is above — but that `createScopeRow`
 * and `updateScopeRow` **call it**, and that a convertible unit reaches the database converted rather than
 * as typed. A guard nobody has watched refuse from the outside is not a guard.
 */
describe("the write path refuses a unit its factor cannot take (NZC-146)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG2 = "org-unitpath";
  const CLIENT = "client-unitpath";
  const JOB = "job-unitpath";
  const ACTOR = "admin-unitpath";

  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  const context = (key: string) => ({
    organisationId: ORG2, actorId: ACTOR, principal: "staff" as const,
    idempotencyKey: key, correlationId: `corr-${key}`,
    grant: commandGrantForRole("admin", ORG2, ACTOR),
  });

  const row = (over: Record<string, unknown> = {}) => ({
    jobId: JOB, scope: "1", sourceLabel: "Fleet diesel", reportLabel: "Fleet diesel",
    quantity: 100, unit: "litres",
    datasetId: "ds-u", factorId: "f-diesel", factorVersion: "2025.1", factorLabel: "Diesel — LGV",
    qualityTier: "measured" as const, ...over,
  });

  const storedPair = async (rowId: string) => (await db.query<{ quantity: string | null; unit: string | null }>(
    `SELECT quantity::text, unit FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!;

  const currentVersion = async (rowId: string) => (await db.query<{ version: number }>(
    `SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!.version;

  /**
   * A rejection that counts only if it was *this* rule that rejected.
   *
   * `assert.rejects(fn, CommandValidationError)` would be satisfied by any validation failure at all —
   * a mistyped fixture, a missing field, a shape the command never accepted. That is a test which passes
   * whether or not the guard exists, so the issue code is asserted rather than the class.
   */
  const onlyBecauseOfTheUnit = (error: unknown): true => {
    assert.ok(error instanceof CommandValidationError, `expected a validation error, got ${error}`);
    const codes = error.issues.map((issue) => issue.code);
    assert.ok(codes.includes("UNIT_INCOMPATIBLE") || codes.includes("UNIT_NOT_ACCEPTED"),
      `refused for some other reason than the unit: ${codes.join(", ")}`);
    return true;
  };

  before(async () => {
    database = (await createDisposableDatabase("unitpath"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG2]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG2]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG2]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status)
       VALUES ($1,$2,'Unit Path Ltd','active')`, [ORG2, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2025,'2025-04-01','2026-03-31')`, [ORG2, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2025-04-01','2026-03-31','GB')`, [ORG2, JOB]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'ds-u','Synthetic GB','2025.1','2025-01-01','2026-12-31','GB','active','Synthetic','OGL')`, [ORG2]);
    // Priced per litre, and — the case that broke the first version of the check — one priced in a
    // compound unit, where it is the denominator the entry has to match.
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'ds-u','f-diesel','Diesel — LGV','litres',2.5,ARRAY['1']),
              ($1,'ds-u','f-van','Van — per km','kgCO2e/km',0.2,ARRAY['1'])`, [ORG2]);
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,$2,'ds-u','automatic','Fixture',$3)`, [ORG2, JOB, ACTOR]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("refuses a create whose unit measures something else, and writes no row", async () => {
    // Spend against a per-litre factor: the mismatch that produces an ordinary-looking number two orders
    // of magnitude out. The row count is asserted because a refusal that still writes is not a refusal.
    const before = (await db.query(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows`)).rows[0]!.n;
    await assert.rejects(
      () => createScopeRow(pool, row({ unit: "GBP" }), context("u-reject")),
      onlyBecauseOfTheUnit);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows`)).rows[0]!.n, before,
      "the refused create left a row behind");
  });

  it("stores a convertible unit converted, in the factor's own terms", async () => {
    // m³ of a per-litre factor is the acceptance that makes the refusal above mean something: the rule is
    // not "reject anything that differs", it is "reconcile or refuse".
    const created = await createScopeRow(pool, row({ unit: "m³", quantity: 2 }), context("u-convert"));
    const stored = await storedPair(created.data.rowId);
    assert.equal(Number(stored.quantity), 2000, "2 m³ is 2,000 litres");
    assert.equal(stored.unit, "litres", "the stored unit is the factor's, not the one typed");
  });

  it("matches the denominator of a compound factor unit, not the whole string", async () => {
    // `kgCO2e/km` is priced per kilometre. The first version of this check compared against the whole
    // string and refused every compound-priced factor in the library.
    const created = await createScopeRow(pool,
      row({ factorId: "f-van", factorLabel: "Van — per km", unit: "mi", quantity: 100 }),
      context("u-compound"));
    const stored = await storedPair(created.data.rowId);
    assert.ok(Math.abs(Number(stored.quantity) - 100 / MILES_PER_KM) < 1e-6, "100 miles stored as km");
    await assert.rejects(() => createScopeRow(pool,
      row({ factorId: "f-van", factorLabel: "Van — per km", unit: "litres" }), context("u-compound-no")),
      onlyBecauseOfTheUnit, "litres must not stand for a per-km factor");
  });

  it("refuses an update that changes the unit to an incompatible one", async () => {
    // The update path is asked separately because it is a separate call site, and one guarded call site
    // is how a row gets in through the other.
    const created = await createScopeRow(pool, row({ unit: "litres", quantity: 10 }), context("u-update-seed"));
    const version = await currentVersion(created.data.rowId);
    await assert.rejects(
      () => updateScopeRow(pool, {
        ...row({ unit: "kWh", quantity: 10 }),
        rowId: created.data.rowId, expectedVersion: version, enabled: true,
      }, context("u-update-reject")),
      onlyBecauseOfTheUnit, "the update path let an incompatible unit through");
    const stored = await storedPair(created.data.rowId);
    assert.equal(stored.unit, "litres", "the refused update changed the stored unit anyway");
    assert.equal(Number(stored.quantity), 10);
    assert.equal(await currentVersion(created.data.rowId), version, "the refused update still bumped the row");

    // And an update to a *convertible* unit goes through converted, so the refusal above is the rule
    // biting rather than the update path simply rejecting any change of unit.
    await updateScopeRow(pool, {
      ...row({ unit: "m³", quantity: 1 }),
      rowId: created.data.rowId, expectedVersion: version, enabled: true,
    }, context("u-update-accept"));
    const after = await storedPair(created.data.rowId);
    assert.equal(after.unit, "litres");
    assert.equal(Number(after.quantity), 1000, "1 m³ stored as 1,000 litres");
  });

  it("leaves a row with no factor yet alone", async () => {
    // A draft captured before anyone picks a factor has nothing to reconcile against. Refusing it would
    // stop capture rather than protect it.
    const draft = await createScopeRow(pool,
      row({ datasetId: null, factorId: null, factorVersion: null, factorLabel: null, unit: "GBP", qualityTier: "spend-based" }),
      context("u-draft"));
    const stored = await storedPair(draft.data.rowId);
    assert.equal(stored.unit, "GBP", "an unfactored draft is stored as typed");
  });
});
