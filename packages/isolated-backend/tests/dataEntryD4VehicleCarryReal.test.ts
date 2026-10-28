import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  createEmissionSource, createEmissionSourceGroup, createScopeRow, listScopeRowRollforwardPreview, readCategoryLineYears, rollforwardScopeRows,
  setVehicleRegistrationsOptOut, syncEmissionSourceGroupToScope, withTenantRead,
} from "../src/index";

/**
 * Data entry D4 (R6/R7) against Postgres: a company vehicle carried year on year by its identity — the sealed plate's digest, or
 * an opted-out client's name — structure carried, mileage zeroed, never carried twice; and the 5-year Lines drawer reading the
 * category vehicle by vehicle, roll-up members included, named by the plate (opened for staff). Factors are invented.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-d4b", NAMED_CLIENT = "client-d4b-named";
const PRIOR = "job-d4b-2025", CURRENT = "job-d4b-2026", NAMED_PRIOR = "job-d4b-named-2025", NAMED_CURRENT = "job-d4b-named-2026";
const STAFF = "staff-d4b";
const DS = "d4b-dataset";

describe("Data entry D4: vehicles carried by identity, and read vehicle by vehicle across the years", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `d4b-${keys}`, correlationId: `corr-d4b-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) };
  };
  const vehicle = (jobId: string, assetIdentifier: string | null, quantity: number) => ({
    jobId, scope: "1", categoryCode: "1.company-vehicles", sourceLabel: "Passenger vehicles - Cars (by size) - Small car - Diesel", siteId: null,
    quantity, unit: "miles", datasetId: DS, factorId: "d4b-car-mi", factorVersion: "d4b", factorLabel: "Small car diesel (test)", qualityTier: "measured", assetIdentifier,
  }) as never;
  const create = async (jobId: string, plate: string | null, quantity: number) => (await createScopeRow(database.pool, vehicle(jobId, plate, quantity), context())).data.rowId;

  before(async () => {
    database = (await createDisposableDatabase("dataentryd4b"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ($1, $2, 'admin', 'active')`, [ORG, STAFF]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Fleet Co', 'active'), ($1, $3, 'Named Co', 'active')`, [ORG, CLIENT, NAMED_CLIENT]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
      VALUES ($1, $2, 'D4B test factors', 'd4b', '2025-01-01', '2026-12-31', 'GB', 'active', 'Test', 'Test only')`, [ORG, DS]);
    await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes)
      VALUES ($1, $2, 'd4b-car-mi', 'Passenger vehicles - Cars (by size) - Small car - Diesel', 'miles', 0.2, ARRAY['1'])`, [ORG, DS]);
    for (const [index, [job, client, year]] of ([[PRIOR, CLIENT, 2025], [CURRENT, CLIENT, 2026], [NAMED_PRIOR, NAMED_CLIENT, 2025], [NAMED_CURRENT, NAMED_CLIENT, 2026]] as const).entries()) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, reporting_period_start, reporting_period_end)
        VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'Data entry', $5, make_date($5, 1, 1), make_date($5, 12, 31))`, [ORG, job, client, index + 1, year]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, make_date($3, 1, 1), make_date($3, 12, 31), 'GB')`, [ORG, job, year]);
      await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, $3, 'manual', 'D4B test', 'test')`, [ORG, job, DS]);
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  let priorIds: string[] = [];
  it("R6: carried by the plate's identity — a vehicle the year already has (written differently) is skipped; the rest carry, mileage zeroed", async () => {
    priorIds = [await create(PRIOR, "AB12 CDE", 8000), await create(PRIOR, "XY99 ZZZ", 12000)];
    await create(CURRENT, "ab12cde", 7000);
    const preview = await withTenantRead(database.pool, ORG, (tx) => listScopeRowRollforwardPreview(tx, CURRENT));
    assert.deepEqual(preview.rows.map((entry) => [entry.priorRowId, entry.alreadyRolledForward]).sort(), [[priorIds[0], true], [priorIds[1], false]].sort(),
      "the preview reads the held vehicle as already carried");
    const carried = await rollforwardScopeRows(database.pool, { jobId: CURRENT, priorJobId: PRIOR, rowIds: priorIds }, context());
    assert.deepEqual([carried.data.rolledForward, carried.data.skipped], [1, 1]);
    const next = (await db.query(`SELECT quantity, asset_identifier, asset_identifier_bidx FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [carried.data.createdRowIds[0]])).rows[0];
    const prior = (await db.query(`SELECT asset_identifier_bidx FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [priorIds[1]])).rows[0];
    assert.deepEqual([next.quantity, next.asset_identifier, next.asset_identifier_bidx], [null, null, prior.asset_identifier_bidx], "structure and identity, no mileage, no plaintext");
    const again = await rollforwardScopeRows(database.pool, { jobId: CURRENT, priorJobId: PRIOR, rowIds: priorIds }, context());
    assert.deepEqual([again.data.rolledForward, again.data.skipped], [0, 2], "never carried twice");
  });

  it("R6: an opted-out client's vehicles are carried by name — a name the year has is skipped", async () => {
    const version = (await db.query(`SELECT version FROM nzi_console.clients WHERE client_id=$1`, [NAMED_CLIENT])).rows[0].version;
    await setVehicleRegistrationsOptOut(database.pool, { clientId: NAMED_CLIENT, optOut: true, expectedVersion: version }, context());
    const ids = [await create(NAMED_PRIOR, "Van 3", 5000), await create(NAMED_PRIOR, "Van 4", 6000)];
    await create(NAMED_CURRENT, "van  3", 4000);
    const carried = await rollforwardScopeRows(database.pool, { jobId: NAMED_CURRENT, priorJobId: NAMED_PRIOR, rowIds: ids }, context());
    assert.deepEqual([carried.data.rolledForward, carried.data.skipped], [1, 1]);
    assert.equal((await db.query(`SELECT asset_identifier FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [carried.data.createdRowIds[0]])).rows[0].asset_identifier, "Van 4");
  });

  it("R7: the Lines drawer reads vehicle by vehicle across the years — matched by identity, named by the plate, roll-up members in place of the fleet row", async () => {
    await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
      VALUES ($1, 'snap-d4b-25', $2, 1, 1, $3, $4::jsonb, 'test')`, [ORG, PRIOR, `sha256:${"e".repeat(64)}`, JSON.stringify({ jobNumber: PRIOR, client: "Fleet Co", reportingYear: 2025, measurements: [] })]);
    // A pool car in a roll-up group this year: its group row is the fleet's total, so the drawer reads the member.
    const groupId = (await createEmissionSourceGroup(database.pool, { jobId: CURRENT, name: "Pool cars", datasetId: DS, factorId: "d4b-car-mi", factorLabel: "Small car diesel (test)", unit: "miles" }, context())).data.groupId;
    await createEmissionSource(database.pool, {
      jobId: CURRENT, groupId, scope: "1", sourceType: "vehicle", sourceSubtype: null, siteId: null, sourceName: "Pool car", assetIdentifier: "PQ70 RST",
      purchasedGoodsCategoryId: null, datasetId: DS, factorId: "d4b-car-mi", factorSource: "dataset", clientFactorId: null, quantity: 3000, unit: "miles",
      applyPct: 100, dataSource: "Company vehicles template import", dataConfidence: "M", monthlyActivity: [],
      detail: { kind: "vehicle", vehicleRegistration: null, make: null, model: null, fuel: "Diesel" }, notes: null,
    } as never, context());
    await syncEmissionSourceGroupToScope(database.pool, { jobId: CURRENT, groupId }, context());
    const read = (await withTenantRead(database.pool, ORG, (tx) => readCategoryLineYears(tx, CURRENT, "1.company-vehicles")))!;
    const at = (year: number) => read.years.findIndex((entry) => entry.year === year);
    const byLabel = new Map(read.lines.map((line) => [line.label, line]));
    assert.deepEqual([...byLabel.keys()].sort(), ["AB12CDE", "PQ70 RST", "XY99 ZZZ"], "one line per vehicle, named by its plate (as this year holds it); no fleet-total line");
    assert.deepEqual([byLabel.get("AB12CDE")!.values[at(2025)]?.quantity, byLabel.get("AB12CDE")!.values[at(2026)]?.quantity], [8000, 7000], "the same vehicle across the years");
    assert.deepEqual([byLabel.get("XY99 ZZZ")!.values[at(2025)]?.quantity, byLabel.get("XY99 ZZZ")!.values[at(2026)]?.quantity], [12000, null], "carried, not yet entered: null, never zero");
    assert.deepEqual([byLabel.get("PQ70 RST")!.values[at(2025)], byLabel.get("PQ70 RST")!.values[at(2026)]?.quantity], [null, 3000]);
    assert.ok(read.lines.every((line) => line.key.startsWith("reg:") && !line.key.includes("AB12")), "keyed by digest, not the plate");
  });

  it("R7: the QA trend's Scope 1 drawer (it groups Scope 1 by the scope) holds the same vehicles, vehicle by vehicle, beside Scope 1's other lines", async () => {
    await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id, scope_row_id, job_id, scope, source_label, quantity, unit, report_label, level_1, level_2, provenance_json, lineage_json, category_code)
      VALUES ($1, 'd4b-boiler', $2, '1', 'Natural gas', 50000, 'kWh', 'Boiler gas', 'Scope 1', 'Fuels', '{}', '[]', '1.stationary-combustion')`, [ORG, CURRENT]);
    const read = (await withTenantRead(database.pool, ORG, (tx) => readCategoryLineYears(tx, CURRENT, "1")))!;
    assert.deepEqual(read.lines.map((line) => line.label).sort(), ["AB12CDE", "Boiler gas", "PQ70 RST", "XY99 ZZZ"], "a coded Scope 1 row is a line; each vehicle once; no fleet-total line");
  });
});
