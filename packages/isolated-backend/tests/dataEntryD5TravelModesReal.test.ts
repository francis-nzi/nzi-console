import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createEmissionSource, syncEmissionSourceToScope } from "../src/index";

/**
 * Data entry D5 (R2–R5) against Postgres: a business-travel source is filed with a controlled mode — free text refused — and priced
 * by its own mode's factor, a flight by its haul and cabin class; a spend trip by a spend factor; and its stored detail holds no
 * registration whatever was sent. No migration: 0057 admitted `travel`. Factors are invented, labelled as the library labels them.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-d5a", JOB = "job-d5a-2025", STAFF = "staff-d5a", DS = "d5a-dataset";

describe("Data entry D5: business travel by controlled mode", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `d5a-${keys}`, correlationId: `corr-d5a-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) };
  };
  const trip = (factorId: string, detail: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    jobId: JOB, groupId: null, scope: "3.6", sourceType: "travel", sourceSubtype: null, siteId: null, sourceName: "LHR → JFK", assetIdentifier: "BK-1",
    purchasedGoodsCategoryId: null, datasetId: DS, factorId, factorSource: "dataset", clientFactorId: null, quantity: 5540, unit: "passenger.km",
    applyPct: 100, dataSource: "Test", dataConfidence: null, monthlyActivity: [], notes: null,
    detail: { kind: "travel", origin: "LHR", destination: "JFK", carrier: null, distanceUnit: "km", passengers: 1, ...detail }, ...extra,
  }) as never;
  const refused = async (input: never): Promise<string> => {
    try { await createEmissionSource(database.pool, input, context()); } catch (error) { return JSON.stringify((error as { issues?: unknown }).issues ?? String(error)); }
    assert.fail("the trip was filed");
  };

  before(async () => {
    database = (await createDisposableDatabase("dataentryd5a"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ($1, $2, 'admin', 'active')`, [ORG, STAFF]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Travel Co', 'active')`, [ORG, CLIENT]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
      VALUES ($1, $2, 'D5A test factors', 'd5a', '2025-01-01', '2025-12-31', 'GB', 'active', 'Test', 'Test only')`, [ORG, DS]);
    for (const [id, label, unit, value] of [
      ["lh-business", "Business travel- air - Flights - Long-haul, to/from UK - Business class - With RF", "passenger.km", 0.43],
      ["lh-economy", "Business travel- air - Flights - Long-haul, to/from UK - Economy class - With RF", "passenger.km", 0.15],
      ["rail", "Business travel- land - Rail - National rail", "passenger.km", 0.035],
      ["hotel", "Hotel stay - United Kingdom", "Room per night", 10.4],
      ["car-small-diesel", "Business travel- land - Cars (by size) - Small car - Diesel", "miles", 0.22],
      ["air-spend", "Air transport services", "GBP", 0.6],
    ] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES ($1, $2, $3, $4, $5, $6, ARRAY['3'])`, [ORG, DS, id, label, unit, value]);
    }
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, reporting_period_start, reporting_period_end)
      VALUES ($1, $2, $3, 1, 'crp', 'CRP', 'open', 'Data entry', 2025, '2025-01-01', '2025-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
    await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, $3, 'manual', 'D5A test', 'test')`, [ORG, JOB, DS]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("R2/R3: files a flight priced by its haul and class's factor, and syncs it to Scope 3.6", async () => {
    const created = await createEmissionSource(database.pool, trip("lh-business", { travelMode: "air", airHaul: "long-haul", cabinClass: "business" }), context());
    const synced = await syncEmissionSourceToScope(database.pool, { jobId: JOB, sourceId: created.data.sourceId } as never, context());
    const row = (await db.query(`SELECT scope, factor_id FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [synced.data.rowId])).rows[0];
    assert.deepEqual([row.scope, row.factor_id], ["3.6", "lh-business"]);
    const stored = (await db.query(`SELECT source_type, detail_json FROM nzi_console.job_emission_sources WHERE source_id=$1`, [created.data.sourceId])).rows[0];
    assert.deepEqual([stored.source_type, stored.detail_json.travelMode, stored.detail_json.airHaul, stored.detail_json.cabinClass], ["travel", "air", "long-haul", "business"]);
  });

  it("R3: refuses a factor that is not the flight's — economy for a business-class seat, or rail for a flight", async () => {
    assert.match(await refused(trip("lh-economy", { travelMode: "air", airHaul: "long-haul", cabinClass: "business" })), /not one for Air · Long haul · Business/);
    assert.match(await refused(trip("rail", { travelMode: "air", airHaul: "long-haul", cabinClass: "economy" })), /not one for Air/);
  });

  it("R2: refuses a free-text mode, the old words included; a flight without its class", async () => {
    assert.match(await refused(trip("lh-business", { travelMode: "Flight — long haul" })), /detail\.travelMode/);
    assert.match(await refused(trip("lh-business", { travelMode: "air", airHaul: "long-haul" })), /detail\.cabinClass/);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.job_emission_sources WHERE job_id=$1`, [JOB])).rows[0].n, 1, "a refused trip left a row");
  });

  it("R4: a hotel by its nights, and a spend trip by a spend factor whatever its mode", async () => {
    const hotel = await createEmissionSource(database.pool, trip("hotel", { travelMode: "hotel", nights: 3 }, { quantity: 3, unit: "Room per night" }), context());
    assert.equal((await db.query(`SELECT detail_json->>'nights' AS nights FROM nzi_console.job_emission_sources WHERE source_id=$1`, [hotel.data.sourceId])).rows[0].nights, "3");
    await createEmissionSource(database.pool, trip("air-spend", { travelMode: "air", airHaul: "short-haul", cabinClass: "economy" }, { quantity: 420, unit: "GBP" }), context());
  });

  it("R5 (pinned): grey fleet is priced by a car factor and keeps no registration — sent in the detail or not", async () => {
    const created = await createEmissionSource(database.pool, trip("car-small-diesel", { travelMode: "grey-fleet", vehicleRegistration: "AB12 CDE" }, { quantity: 240, unit: "miles", assetIdentifier: null }), context());
    const stored = (await db.query(`SELECT asset_identifier, asset_identifier_sealed, detail_json FROM nzi_console.job_emission_sources WHERE source_id=$1`, [created.data.sourceId])).rows[0];
    assert.equal(stored.asset_identifier, null);
    assert.equal(stored.asset_identifier_sealed, null, "a travel source is no company vehicle — nothing is sealed, nothing is kept");
    assert.ok(!JSON.stringify(stored.detail_json).includes("AB12"), "the plate was stored in the detail");
    // Everything the write leaves behind that a person could read — the row, the source, the audit, the outbox.
    const anywhere = await db.query(`SELECT ((SELECT count(*) FROM nzi_console.job_scope_rows WHERE coalesce(asset_identifier,'') ILIKE '%AB12%' OR source_label ILIKE '%AB12%' OR coalesce(notes,'') ILIKE '%AB12%')
        + (SELECT count(*) FROM nzi_console.job_emission_sources WHERE coalesce(asset_identifier,'') ILIKE '%AB12%' OR source_name ILIKE '%AB12%' OR detail_json::text ILIKE '%AB12%')
        + (SELECT count(*) FROM nzi_console.audit_events WHERE coalesce(after_json::text,'') ILIKE '%AB12%' OR coalesce(before_json::text,'') ILIKE '%AB12%')
        + (SELECT count(*) FROM nzi_console.transactional_outbox WHERE payload_json::text ILIKE '%AB12%'))::int AS n`);
    assert.equal(anywhere.rows[0].n, 0, "the plate was kept somewhere");
  });
});
