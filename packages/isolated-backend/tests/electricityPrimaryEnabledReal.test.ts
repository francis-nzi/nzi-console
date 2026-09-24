import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, SUPPLY_SOURCES } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, createScopeRow, previewDeclaredFactor, withTenantRead } from "../src/index";
import { readJobEmissions } from "../src/emissionsAggregation";

/**
 * Electricity's primary, switched on by 0121 — end to end, as shipped (Stop 2, slice 2b).
 *
 * Nothing here toggles a switch: this is the database the migrations leave. For both electricity categories and
 * every supply source, an entry goes in through `createScopeRow`, is calculated by `calculateScopeRow`, and is read
 * back through the headline aggregation — the location-based figure — with no transmission-and-distribution row
 * beside it, because the companion is held (NZC-160 H4). The characterisation predicted exactly this: the grid
 * factor a person would pick, so divergence-free apart from F1.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "demo-nzi-console";
const CLIENT = "client-2b";
const JOB = "job-2b";
const ACTOR = "admin-2b";
const here = dirname(fileURLToPath(import.meta.url));

describe("electricity resolves its primary declaratively, and nothing else has changed (Stop 2b)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;
  let keys = 0;
  const context = () => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff" as const, idempotencyKey: `2b-${keys}`,
      correlationId: `corr-2b-${keys}`, grant: commandGrantForRole("admin", ORG, ACTOR) };
  };
  // Typed loosely: these build command inputs, some deliberately invalid, and the command validates them.
  const entry = (category: string, over: Record<string, unknown> = {}): any => ({
    jobId: JOB, scope: "2", sourceLabel: "Meter", reportLabel: "Meter", categoryCode: category,
    quantity: 1000, unit: "kWh", datasetId: null, factorId: null, factorVersion: null, factorLabel: null,
    qualityTier: "measured", ...over,
  });
  const row = async (rowId: string) => (await db.query<{ factor_id: string | null; supply_source: string | null; version: number; provenance_json: Record<string, any> }>(
    `SELECT factor_id, supply_source, version, provenance_json FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!;
  const rowsInScope = async (scope: string) => (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND scope=$2`, [JOB, scope])).rows[0]!.n;

  before(async () => {
    database = (await createDisposableDatabase("elec2b"))!;
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
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'synthetic-gb-2026','electricity-green-demo','Green supply — test factor','kWh',0.05,ARRAY['2'])`, [ORG]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("is switched on for the two electricity primaries only, with the companion held", async () => {
    const on = await db.query<{ category_code: string; companions_enabled: boolean }>(
      `SELECT category_code, companions_enabled FROM nzi_console.input_spec_categories WHERE declarative_resolution_enabled OR companions_enabled ORDER BY 1`);
    assert.deepEqual(on.rows, [
      { category_code: "2.purchased-electricity", companions_enabled: false },
      { category_code: "2.renewable-electricity", companions_enabled: false },
    ]);
  });

  for (const category of ["2.purchased-electricity", "2.renewable-electricity"]) {
    for (const supply of [...SUPPLY_SOURCES, null]) {
      it(`${category}, ${supply ?? "supply not stated"}: the grid factor, a location-based headline figure, and no T&D row`, async () => {
        const before = await readJobEmissions(pool, { organisationId: ORG, jobId: JOB });
        const tdBefore = await rowsInScope("3.3");

        const created = await createScopeRow(pool, entry(category, { supplySource: supply }), context());
        const stored = await row(created.data.rowId);
        assert.equal(stored.factor_id, "electricity-demo", "the declared grid factor was not filled");
        assert.equal(stored.supply_source, supply, "the supply source was not stored as captured");
        assert.equal(stored.provenance_json.declarativeResolution.decision, "filled");

        await calculateScopeRow(pool, { jobId: JOB, rowId: created.data.rowId, expectedVersion: stored.version }, context());
        const after = await readJobEmissions(pool, { organisationId: ORG, jobId: JOB });
        // 1000 kWh at 0.3 kg/kWh is 0.3 t, and it lands in the headline: location-based, not market.
        assert.ok(Math.abs(after.headline.tco2e - before.headline.tco2e - 0.3) < 1e-9,
          `the headline moved by ${after.headline.tco2e - before.headline.tco2e}, not 0.3`);
        assert.equal(after.headline.marketTco2e, before.headline.marketTco2e, "the entry was counted as market-based");
        assert.equal(await rowsInScope("3.3"), tdBefore, "a T&D row was created while the companion is held");
      });
    }
  }

  it("refuses a different factor with no reason, naming the grid factor", async () => {
    await assert.rejects(() => createScopeRow(pool, entry("2.purchased-electricity", {
      datasetId: "synthetic-gb-2026", factorId: "electricity-green-demo", factorVersion: "2026 demo v1", factorLabel: "Green",
    }), context()), (error: any) => error.issues?.[0]?.code === "FACTOR_NOT_DECLARED" && /electricity-demo/.test(error.issues[0].message));
  });

  it("accepts a deliberately chosen different factor with a reason, and records the choice", async () => {
    const created = await createScopeRow(pool, entry("2.purchased-electricity", {
      datasetId: "synthetic-gb-2026", factorId: "electricity-green-demo", factorVersion: "2026 demo v1", factorLabel: "Green",
      factorOverrideReason: "Supplier-specific factor from the client's contract",
    }), context());
    const trail = (await row(created.data.rowId)).provenance_json.declarativeResolution;
    assert.equal(trail.decision, "override");
    assert.equal(trail.overrideKind, "factor-choice");
    assert.equal(trail.overrideReason, "Supplier-specific factor from the client's contract");
    assert.equal(trail.deviatedBy, ACTOR);
    assert.equal(trail.deviatedFrom, "electricity-demo");
  });

  it("still refuses a factor the row may not carry, whatever the reason", async () => {
    await assert.rejects(() => createScopeRow(pool, entry("2.purchased-electricity", {
      datasetId: "synthetic-gb-2026", factorId: "gas-demo", factorVersion: "2026 demo v1", factorLabel: "Gas",
      factorOverrideReason: "attempt",
    }), context()), (error: any) => error.issues?.[0]?.code === "FACTOR_NOT_VALID_FOR_ROW");
  });

  it("previews the grid factor and its unit for the form, and says a category that is off is off", async () => {
    const preview = await withTenantRead(pool, ORG, (read) => previewDeclaredFactor(read, ORG, JOB,
      { scope: "2", unit: null, supplySource: "grid" }, "2.purchased-electricity"));
    assert.deepEqual(preview, { enabled: true, reason: null,
      declared: { datasetId: "synthetic-gb-2026", factorId: "electricity-demo", label: "UK electricity — demonstration factor", unit: "kWh", version: "2026 demo v1" } });
    const off = await withTenantRead(pool, ORG, (read) => previewDeclaredFactor(read, ORG, JOB,
      { scope: "1", unit: "litres", supplySource: null }, "1.company-vehicles"));
    assert.deepEqual(off, { enabled: false });
  });

  it("leaves a category that is still off exactly as it was", async () => {
    const created = await createScopeRow(pool, {
      jobId: JOB, scope: "1", sourceLabel: "Gas", reportLabel: "Gas", categoryCode: "1.natural-gas", quantity: 10, unit: "kWh",
      datasetId: "synthetic-gb-2026", factorId: "gas-demo", factorVersion: "2026 demo v1", factorLabel: "Gas", qualityTier: "measured",
    } as any, context());
    const stored = await row(created.data.rowId);
    assert.equal(stored.factor_id, "gas-demo");
    assert.equal("declarativeResolution" in stored.provenance_json, false);
  });
});
