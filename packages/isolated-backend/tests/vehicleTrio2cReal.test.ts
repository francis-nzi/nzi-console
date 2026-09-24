import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, createScopeRow, lookupVehicleByRegistration, previewDeclaredFactor, withTenantRead } from "../src/index";
import { listJobFactorOptions } from "../src/readModels";
// NZC-162: the capture path as production runs it — the console's lookup suggestion, its option builder, pick-list
// filter and draft mapping — imported across the package seam as the other capture suites do.
import * as modelModule from "../../../apps/console/app/jobs/emissionEntryModel";
import * as suggestionModule from "../../../apps/console/app/lib/vehicleSuggestion";

const form = ((modelModule as any).emissionEntryDraftToScopeRow ? modelModule : (modelModule as any).default) as typeof import("../../../apps/console/app/jobs/emissionEntryModel");
const { suggestVehicleFactor } = ((suggestionModule as any).suggestVehicleFactor ? suggestionModule : (suggestionModule as any).default) as typeof import("../../../apps/console/app/lib/vehicleSuggestion");

/**
 * The vehicle trio at Stop 2c, end to end: company vehicles switched on (0123), the ILIKE retired for them (H6), the
 * base of a variant refused in business travel and commuting, and a change to the vehicle flow reaching both.
 *
 * Each case runs as the capture surface does: a real stub lookup, the route's own suggestion, the job's real factor
 * options, the form's mapping, `createScopeRow`, and a calculated number where there is one.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "demo-nzi-console";
const JOB = "job-2c";
const ACTOR = "admin-2c";
const here = dirname(fileURLToPath(import.meta.url));
const PLATES = { diesel: "AB12CDH", petrol: "AB12CDE" } as const;
const VEHICLES = { code: "1.company-vehicles", name: "Company vehicles", scope: "1", kind: "vehicle" } as never;
const TRAVEL = { code: "3.6", name: "Business travel", scope: "3", kind: "travel" } as never;
const COMMUTING = { code: "3.7", name: "Employee commuting", scope: "3", kind: "commuting" } as never;

describe("the vehicle trio at 2c, through the capture path (Stop 2c)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = () => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff" as const, idempotencyKey: `2c-${keys}`,
      correlationId: `corr-2c-${keys}`, grant: commandGrantForRole("admin", ORG, ACTOR) };
  };
  const read = <T>(run: (reader: any) => Promise<T>) => withTenantRead(database.pool, ORG, run);
  const options = async (scope: "1" | "3", categoryCode: string) => {
    const all = form.entryFactorRefsFor((await read((reader) => listJobFactorOptions(reader, JOB))) as never).filter((o) => o.scope === scope);
    const preview = await read((reader) => previewDeclaredFactor(reader, ORG, JOB, { scope: categoryCode === "1.company-vehicles" ? "1" : categoryCode, unit: null, supplySource: null }, categoryCode));
    return form.optionsForCategory(all, preview);
  };
  const lookup = async (plate: string, categoryCode: string, scope: string) => {
    const found = await lookupVehicleByRegistration(plate, { allowStub: true });
    assert.ok(found.ok, `the stub refused ${plate}`);
    return read((reader) => suggestVehicleFactor(reader, ORG, JOB, found.vehicle, found.source, categoryCode, scope));
  };
  const draft = (over: Record<string, unknown>) => ({
    activity: "Fleet", quantity: "1000", unit: "", vatPercent: "", glCode: "", spendCategoryId: "", registration: "",
    manualMode: false, manualDetail: "", factorId: "", qualityTier: "Measured", dataConfidence: "M — Medium",
    supplySource: "", factorOverrideReason: "", note: "", monthlyOpen: false, monthly: {}, ...over,
  }) as any;
  const save = async (category: never, d: any, opts: any[]) => {
    const created = await createScopeRow(database.pool, { ...form.emissionEntryDraftToScopeRow(d, category, { id: null, label: null }, opts, []), jobId: JOB }, context());
    return (await db.query<{ scope_row_id: string; factor_id: string | null; version: number; provenance_json: Record<string, any> }>(
      `SELECT scope_row_id, factor_id, version, provenance_json FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId])).rows[0]!;
  };
  const calculate = async (row: { scope_row_id: string; version: number }) => {
    await calculateScopeRow(database.pool, { jobId: JOB, rowId: row.scope_row_id, expectedVersion: row.version }, context());
    return Number((await db.query<{ t: string }>(`SELECT calculated_tco2e::text AS t FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [row.scope_row_id])).rows[0]!.t);
  };

  before(async () => {
    database = (await createDisposableDatabase("trio2c"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-2c','Co','active')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,'client-2c',1,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, JOB]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, JOB]);
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── Company vehicles, switched on ────────────────────────────────────────────────────────────────────

  it("suggests the declared factor for a looked-up diesel, and the entry calculates at it — 2.5 t", async () => {
    const suggestion = await lookup(PLATES.diesel, "1.company-vehicles", "1");
    assert.equal(suggestion.factor?.factorId, "diesel-demo");
    assert.equal(suggestion.factor?.resolvedBy, "declared", "the suggestion did not come from the declared resolution");
    const opts = await options("1", "1.company-vehicles");
    const optionId = `dataset:${suggestion.factor!.datasetId}|${suggestion.factor!.factorId}`;
    const row = await save(VEHICLES, draft({ registration: "AB12 CDH", factorId: optionId, unit: suggestion.factor!.unit,
      assertedVehicleAttributes: suggestion.attributes }), opts);
    assert.equal(row.factor_id, "diesel-demo");
    assert.equal(row.provenance_json.declarativeResolution.decision, "matched");
    assert.equal(row.provenance_json.declarativeResolution.assertedVehicleAttributes.trust, "asserted-at-capture");
    assert.equal(await calculate(row), 2.5);
  });

  it("suggests nothing for a looked-up petrol vehicle — the ILIKE is retired here, so the entry goes to a person", async () => {
    const suggestion = await lookup(PLATES.petrol, "1.company-vehicles", "1");
    assert.equal(suggestion.factor, null, "a factor was suggested for a vehicle nothing is declared for");
    assert.equal(suggestion.attributes.fuel, "petrol");
  });

  // ── Business travel and commuting: still off, and never the base of their own variant ───────────────

  it("leaves the base of its own variant out of business travel's pick list", async () => {
    const ids = (await options("3", "3.6")).map((option) => option.factorId);
    assert.ok(!ids.includes("diesel-demo"), "business travel offers the Scope 1 base of its own variant");
    assert.ok(ids.includes("diesel-demo-b"), "business travel lost its own variant");
    assert.ok(ids.includes("electricity-td-demo") || ids.length > 1, "the list was emptied rather than filtered");
  });

  it("refuses that base at the write, naming the variant — in business travel and in commuting", async () => {
    const baseOption = form.entryFactorRefsFor((await read((reader) => listJobFactorOptions(reader, JOB))) as never)
      .find((option) => option.factorId === "diesel-demo")!;
    for (const [category, variant] of [[TRAVEL, "diesel-demo-b"], [COMMUTING, "diesel-demo-c"]] as const) {
      await assert.rejects(() => save(category, draft({ factorId: baseOption.id, unit: "km" }), [baseOption]),
        (error: any) => error.issues?.[0]?.code === "FACTOR_IS_VARIANT_BASE" && error.issues[0].message.includes(variant));
    }
  });

  it("still suggests by label for business travel, which is not switched on (H6 is for enabled categories)", async () => {
    const suggestion = await lookup(PLATES.diesel, "3.6", "3.6");
    assert.notEqual(suggestion.factor?.resolvedBy, "declared", "business travel answered from a resolution it has not been switched on for");
  });

  // ── Sub-flow propagation, through the write path ──────────────────────────────────────────────────────

  it("carries a change to the vehicle flow into business travel and commuting, through the write", async () => {
    // Today the flow's one factor is per litre, which 3.6 and 3.7 cannot take (distances only). Give the flow a
    // per-km diesel factor with its own -b and -c variants, point the vehicle rule at it, switch the two sub-flow
    // categories on for this test, and the same write that resolved nothing now files each under its own variant.
    // Restored afterwards, so nothing here outlives the test.
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES
        ($1,'synthetic-gb-2026','van-km-test','Van, diesel, per km — test','km',0.25,ARRAY['1','3']),
        ($1,'synthetic-gb-2026','van-km-test-b','Van, diesel, per km — business travel','km',0.25,ARRAY['3']),
        ($1,'synthetic-gb-2026','van-km-test-c','Van, diesel, per km — commuting','km',0.25,ARRAY['3'])`, [ORG]);
    const attributes = { source: "stub", fuel: "diesel", vehicleClass: "van" };
    const entry = (category: never) => save(category, draft({ unit: "km", assertedVehicleAttributes: attributes }), []);
    try {
      await db.query(`UPDATE nzi_console.input_spec_categories SET declarative_resolution_enabled = true WHERE category_code IN ('3.6','3.7')`);
      const beforeChange = await entry(TRAVEL);
      assert.equal(beforeChange.factor_id, null, "business travel resolved before the flow could price a distance");

      await db.query(`UPDATE nzi_console.input_spec_factor_rules SET factor_base = 'van-km-test' WHERE category_code = '1.company-vehicles' AND rule_key = 'dvla-diesel'`);
      const travel = await entry(TRAVEL);
      const commute = await entry(COMMUTING);
      assert.equal(travel.factor_id, "van-km-test-b", "the change to the vehicle flow did not reach business travel");
      assert.equal(commute.factor_id, "van-km-test-c", "the change to the vehicle flow did not reach commuting");
      assert.equal(await calculate(travel), 0.25);
    } finally {
      await db.query(`UPDATE nzi_console.input_spec_factor_rules SET factor_base = 'diesel-demo' WHERE category_code = '1.company-vehicles' AND rule_key = 'dvla-diesel'`);
      await db.query(`UPDATE nzi_console.input_spec_categories SET declarative_resolution_enabled = false WHERE category_code IN ('3.6','3.7')`);
    }
  });
});
