import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createScopeRow, updateScopeRow } from "../src/index";

/**
 * The write path consuming the declarative resolver, through the real commands (Stop 2, slice 2a).
 *
 * 2a lays the rails dark: 0120 adds a switch per category and every one starts off. So the suite proves two
 * things, and the first is the one that makes it safe to merge:
 *
 *   1. **Off means untouched.** With nothing enabled a write stores exactly what it did before — the factor it
 *      was sent, even one that is wrong, and not one provenance key more.
 *   2. **On means the F1 rule.** Switched on here, inside the test and restored after, a category fills a
 *      missing factor, accepts the declared one, refuses a different one by name, lets a deliberate override
 *      deviate from the resolver but never from what the row may carry, and lets an edit correct a bad row.
 *
 * Enabling a category for real is a migration per slice (2b, 2c). Nothing here enables anything that outlives
 * the test.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "demo-nzi-console";
const CLIENT = "client-rails";
const JOB = "job-rails";
const ACTOR = "admin-rails";
const here = dirname(fileURLToPath(import.meta.url));

describe("the write path resolves declaratively where a category is switched on, and nowhere else (Stop 2a)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;
  let keys = 0;

  const context = () => {
    keys += 1;
    return {
      organisationId: ORG, actorId: ACTOR, principal: "staff" as const,
      idempotencyKey: `rails-${keys}`, correlationId: `corr-rails-${keys}`,
      grant: commandGrantForRole("admin", ORG, ACTOR),
    };
  };

  // Typed loosely on purpose: these build command inputs, some deliberately invalid, and the command validates them.
  const electricity = (over: Record<string, unknown> = {}): any => ({
    jobId: JOB, scope: "2", sourceLabel: "Metered electricity", reportLabel: "Metered electricity",
    categoryCode: "2.purchased-electricity", quantity: 1000, unit: "kWh", supplySource: "grid",
    datasetId: null, factorId: null, factorVersion: null, factorLabel: null, qualityTier: "measured" as const,
    ...over,
  });
  const gridFactor = { datasetId: "synthetic-gb-2026", factorId: "electricity-demo", factorVersion: "2026 demo v1", factorLabel: "UK electricity — demonstration factor" };

  const stored = async (rowId: string) => (await db.query<{ factor_id: string | null; dataset_id: string | null; factor_version: string | null; provenance_json: Record<string, any>; lineage_json: Array<{ title: string }> }>(
    `SELECT factor_id, dataset_id, factor_version, provenance_json, lineage_json FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!;
  const rowCount = async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE job_id=$1`, [JOB])).rows[0]!.n;

  /** What the migrations switched on: electricity's two primaries (0121) and company vehicles (0123), no companion. */
  const BASELINE = ["1.company-vehicles", "2.purchased-electricity", "2.renewable-electricity"];
  const restoreBaseline = () => db.query(
    `UPDATE nzi_console.input_spec_categories SET companions_enabled = false, declarative_resolution_enabled = (category_code = ANY($1))`, [BASELINE]);

  /** Switch categories on for the length of one test, then back to what the migrations left — nothing outlives it. */
  const enabled = async (categories: string[], run: () => Promise<void>, companions = false) => {
    await db.query(`UPDATE nzi_console.input_spec_categories SET declarative_resolution_enabled = true, companions_enabled = $2 WHERE category_code = ANY($1)`, [categories, companions]);
    try { await run(); } finally { await restoreBaseline(); }
  };

  /** Switch categories off for one test — to write what the path wrote before they were enabled. */
  const switchedOff = async (categories: string[], run: () => Promise<void>) => {
    await db.query(`UPDATE nzi_console.input_spec_categories SET declarative_resolution_enabled = false, companions_enabled = false WHERE category_code = ANY($1)`, [categories]);
    try { await run(); } finally { await restoreBaseline(); }
  };

  before(async () => {
    database = (await createDisposableDatabase("rails"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, JOB]);
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    // A second valid Scope 2 factor, so "a different factor than the declared one" has something legitimate to be.
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'synthetic-gb-2026','electricity-green-demo','Green supply — test factor','kWh',0.05,ARRAY['2'])`, [ORG]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── The switches ─────────────────────────────────────────────────────────────────────────────────────

  it("switches on only what a migration switched on: 0120 laid them all off; 0121 and 0123 turned on three primaries", async () => {
    const on = await db.query<{ category_code: string; companions_enabled: boolean }>(
      `SELECT category_code, companions_enabled FROM nzi_console.input_spec_categories WHERE declarative_resolution_enabled OR companions_enabled ORDER BY category_code`);
    assert.deepEqual(on.rows, BASELINE.map((category_code) => ({ category_code, companions_enabled: false })));
  });

  it("refuses a companion switched on without its category's primary", async () => {
    await assert.rejects(
      () => db.query(`UPDATE nzi_console.input_spec_categories SET companions_enabled = true WHERE category_code = '1.natural-gas'`),
      /input_spec_categories_companions_need_primary/);
  });

  it("does not let the application flip a switch", async () => {
    const client = await database.admin();
    try {
      await client.query(`SET ROLE nzi_console_app`);
      await assert.rejects(
        () => client.query(`UPDATE nzi_console.input_spec_categories SET declarative_resolution_enabled = true`),
        /permission denied/);
    } finally { await client.end(); }
  });

  // ── Off: untouched ───────────────────────────────────────────────────────────────────────────────────

  it("stores exactly what it was sent while the category is off — even a factor it would refuse", async () => switchedOff(["2.purchased-electricity"], async () => {
    // The T&D factor as a Scope 2 primary is wrong, and the path before 0121 takes it. Off must mean exactly that.
    const tnd = await createScopeRow(pool, electricity({ datasetId: "synthetic-gb-2026", factorId: "electricity-td-demo", factorVersion: "2026 demo v1", factorLabel: "T&D" }), context());
    const row = await stored(tnd.data.rowId);
    assert.equal(row.factor_id, "electricity-td-demo");
    assert.equal("declarativeResolution" in row.provenance_json, false, "a provenance key was added to a row in an un-enabled category");

    const empty = await createScopeRow(pool, electricity(), context());
    assert.equal((await stored(empty.data.rowId)).factor_id, null, "a factor was filled in for an un-enabled category");
  }));

  // ── On: the F1 rule ──────────────────────────────────────────────────────────────────────────────────

  it("fills the declared factor when none was sent, and says so in the row's lineage", async () => {
    await enabled(["2.purchased-electricity"], async () => {
      const created = await createScopeRow(pool, electricity(), context());
      const row = await stored(created.data.rowId);
      assert.equal(row.factor_id, "electricity-demo");
      assert.equal(row.dataset_id, "synthetic-gb-2026");
      assert.equal(row.factor_version, "2026 demo v1");
      assert.equal(row.provenance_json.declarativeResolution.decision, "filled");
      assert.equal(row.provenance_json.declarativeResolution.ruleKey, "grid-electricity");
      assert.ok(row.lineage_json.some((step) => step.title === "Factor resolved by declared rule"),
        "a factor nobody sent has no lineage saying where it came from");
    });
  });

  it("accepts the declared factor when that is what was sent", async () => {
    await enabled(["2.purchased-electricity"], async () => {
      const created = await createScopeRow(pool, electricity(gridFactor), context());
      assert.equal((await stored(created.data.rowId)).provenance_json.declarativeResolution.decision, "matched");
    });
  });

  it("refuses a different valid factor, naming the declared one, and writes nothing", async () => {
    await enabled(["2.purchased-electricity"], async () => {
      const before = await rowCount();
      await assert.rejects(
        () => createScopeRow(pool, electricity({ ...gridFactor, factorId: "electricity-green-demo", factorLabel: "Green" }), context()),
        (error: any) => error.issues?.[0]?.code === "FACTOR_NOT_DECLARED" && /electricity-demo/.test(error.issues[0].message));
      assert.equal(await rowCount(), before, "a refused write left a row behind");
    });
  });

  it("refuses a factor the row may not carry at all — wrong scope, or a companion of the category", async () => {
    await enabled(["2.purchased-electricity"], async () => {
      // Wrong scope: caught by the scope clause.
      await assert.rejects(() => createScopeRow(pool, electricity({ ...gridFactor, factorId: "gas-demo" }), context()),
        (error: any) => error.issues?.[0]?.code === "FACTOR_NOT_VALID_FOR_ROW" && /not a Scope 2 factor/.test(error.issues[0].message));
      // The seeded T&D factor is Scope 3 only, so the scope clause catches it first. Tagged {2,3} — as a library
      // may tag it — it passes the scope clause, and the companion clause is what refuses it.
      await db.query(`UPDATE nzi_console.emission_factors SET scopes = ARRAY['2','3'] WHERE factor_id = 'electricity-td-demo'`);
      try {
        await assert.rejects(() => createScopeRow(pool, electricity({ ...gridFactor, factorId: "electricity-td-demo" }), context()),
          (error: any) => error.issues?.[0]?.code === "FACTOR_NOT_VALID_FOR_ROW" && /companion/.test(error.issues[0].message));
      } finally {
        await db.query(`UPDATE nzi_console.emission_factors SET scopes = ARRAY['3'] WHERE factor_id = 'electricity-td-demo'`);
      }
    });
  });

  it("lets a deliberate override deviate from the resolver, and records who and from what", async () => {
    await enabled(["2.purchased-electricity"], async () => {
      const created = await createScopeRow(pool, electricity({
        ...gridFactor, factorId: "electricity-green-demo", factorLabel: "Green",
        overrideTco2e: 0.05, overrideReason: "Supplier-specific evidence on file",
      }), context());
      const trail = (await stored(created.data.rowId)).provenance_json.declarativeResolution;
      assert.equal(trail.decision, "override");
      assert.equal(trail.deviatedBy, ACTOR);
      assert.equal(trail.deviatedFrom, "electricity-demo");
    });
  });

  it("never lets an override deviate from what the row may carry", async () => {
    await enabled(["2.purchased-electricity"], async () => {
      await assert.rejects(() => createScopeRow(pool, electricity({
        ...gridFactor, factorId: "electricity-td-demo", overrideTco2e: 1, overrideReason: "attempt",
      }), context()), (error: any) => error.issues?.[0]?.code === "FACTOR_NOT_VALID_FOR_ROW");
    });
  });

  it("lets an edit correct an existing bad row, and refuses the edit that would keep it bad (F2)", async () => {
    // Created while the category was off, so it holds a factor the rule would now refuse.
    let legacy!: Awaited<ReturnType<typeof createScopeRow>>;
    await switchedOff(["2.purchased-electricity"], async () => {
      legacy = await createScopeRow(pool, electricity({ ...gridFactor, factorId: "electricity-green-demo", factorLabel: "Green" }), context());
    });
    const version = async () => (await db.query<{ version: number }>(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [legacy.data.rowId])).rows[0]!.version;
    await enabled(["2.purchased-electricity"], async () => {
      const current = await version();
      await assert.rejects(() => updateScopeRow(pool, {
        ...electricity({ ...gridFactor, factorId: "electricity-green-demo", factorLabel: "Green" }),
        rowId: legacy.data.rowId, expectedVersion: current, enabled: true,
      }, context()), (error: any) => error.issues?.[0]?.code === "FACTOR_NOT_DECLARED");

      await updateScopeRow(pool, { ...electricity(gridFactor), rowId: legacy.data.rowId, expectedVersion: await version(), enabled: true }, context());
      assert.equal((await stored(legacy.data.rowId)).factor_id, "electricity-demo", "the correcting edit did not go through");
    });
  });

  // ── The vehicle flow, from asserted attributes (F3) ──────────────────────────────────────────────────

  const vehicle = (over: Record<string, unknown> = {}): any => ({
    jobId: JOB, scope: "1", sourceLabel: "Fleet", reportLabel: "Fleet", categoryCode: "1.company-vehicles",
    quantity: 400, unit: "litres", datasetId: null, factorId: null, factorVersion: null, factorLabel: null,
    qualityTier: "measured" as const, ...over,
  });
  const diesel = { assertedVehicleAttributes: { source: "stub", fuel: "diesel", vehicleClass: "van" } };

  it("fills a looked-up diesel's factor from the attributes, and marks them as asserted at capture", async () => {
    await enabled(["1.company-vehicles"], async () => {
      const created = await createScopeRow(pool, vehicle(diesel), context());
      const row = await stored(created.data.rowId);
      assert.equal(row.factor_id, "diesel-demo");
      const trail = row.provenance_json.declarativeResolution;
      assert.equal(trail.ruleKey, "dvla-diesel");
      assert.equal(trail.assertedVehicleAttributes.trust, "asserted-at-capture");
      assert.ok(!JSON.stringify(row).includes("(asserted at capture)"), "the key-field marker leaked into the row");
    });
  });

  it("refuses a different factor for that looked-up vehicle, naming the declared one", async () => {
    await enabled(["1.company-vehicles"], async () => {
      await assert.rejects(() => createScopeRow(pool, vehicle({ ...diesel,
        datasetId: "synthetic-gb-2026", factorId: "gas-demo", factorVersion: "2026 demo v1", factorLabel: "Gas" }), context()),
      (error: any) => error.issues?.[0]?.code === "FACTOR_NOT_DECLARED" && /diesel-demo/.test(error.issues[0].message));
    });
  });

  it("refuses attributes that carry anything but a source, a fuel and a class", async () => {
    await enabled(["1.company-vehicles"], async () => {
      await assert.rejects(() => createScopeRow(pool, vehicle({
        assertedVehicleAttributes: { source: "stub", fuel: "diesel", vehicleClass: "van", registration: "AB12CDE" },
      }), context()), (error: any) => error.issues?.some((issue: any) => issue.field === "assertedVehicleAttributes"));
    });
  });

  // ── Findings pinned, so the slice that changes them has to move these ─────────────────────────────────

  const travel = (over: Record<string, unknown> = {}): any => ({
    jobId: JOB, scope: "3.6", sourceLabel: "Mileage claims", reportLabel: "Mileage claims", categoryCode: "3.6",
    quantity: 400, unit: "km", datasetId: null, factorId: null, factorVersion: null, factorLabel: null,
    qualityTier: "measured" as const, ...over,
  });

  it("PINNED FINDING: business travel cannot resolve declaratively in any unit it accepts", async () => {
    // 3.6 and 3.7 accept distances only (passenger.km, passenger.mi, km, mi). The vehicle flow they reuse has
    // one factor, per litre, so its variant can never price an entry they will take: in km the unit check (D2)
    // declines it, and litres is refused by the category before resolution matters. Until the flow has a
    // per-distance rule, the sub-flow is correct and unreachable through the write path.
    await enabled(["1.company-vehicles", "3.6"], async () => {
      const created = await createScopeRow(pool, travel(diesel), context());
      const row = await stored(created.data.rowId);
      assert.equal(row.factor_id, null, "business travel resolved a factor it has no accepted unit for");
      assert.equal(row.provenance_json.declarativeResolution.decision, "search");
      await assert.rejects(() => createScopeRow(pool, travel({ ...diesel, unit: "litres" }), context()),
        (error: any) => error.issues?.some((issue: any) => issue.code === "UNIT_NOT_ACCEPTED"));
    });
  });

  it("PINNED until per-distance factors: an unplated business-travel entry can take a factor tagged Scope 1 and 3, per km", async () => {
    // D3 #1's leak in the shape the write path allows: a per-km passenger-vehicle factor tagged {1,3}, as
    // libraries tag them, passes the validity gate for a Scope 3 row and nothing declared stands in its way.
    // 2c refuses the base of a category's own variant — but this factor has no variant, so it stays open, as ruled:
    // restricting to variants before distance-priced ones exist would leave nothing to pick. It closes when the
    // per-distance business-travel and commuting factors are authored.
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'synthetic-gb-2026','car-km-test','Average car — test factor','km',0.17,ARRAY['1','3'])`, [ORG]);
    try {
      await enabled(["1.company-vehicles", "3.6"], async () => {
        const created = await createScopeRow(pool, travel({ datasetId: "synthetic-gb-2026", factorId: "car-km-test", factorVersion: "2026 demo v1", factorLabel: "Car" }), context());
        const row = await stored(created.data.rowId);
        assert.equal(row.factor_id, "car-km-test");
        assert.equal(row.provenance_json.declarativeResolution.decision, "search");
      });
    } finally {
      await db.query(`DELETE FROM nzi_console.job_scope_rows WHERE factor_id = 'car-km-test'`);
      await db.query(`DELETE FROM nzi_console.emission_factors WHERE factor_id = 'car-km-test'`);
    }
  });

  it("PINNED until H4: switching companions on creates no companion row, because 2a builds none", async () => {
    await enabled(["2.purchased-electricity"], async () => {
      const before = await rowCount();
      await createScopeRow(pool, electricity(), context());
      assert.equal(await rowCount(), before + 1, "a companion row appeared — companion creation is not part of 2a");
    }, true);
  });
});
