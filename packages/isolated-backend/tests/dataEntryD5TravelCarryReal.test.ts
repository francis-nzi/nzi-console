import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  createEmissionSource, createEmissionSourceGroup, createScopeRow, readCategoryLineYears, rollforwardScopeRows, syncEmissionSourceGroupToScope,
  syncEmissionSourceToScope, withTenantRead,
} from "../src/index";

/**
 * Data entry D5 (R7, R8) against Postgres: trips amalgamate to one Scope 3.6 row per mode and factor (ruled 28 Oct — a roll-up group
 * is one factor), composing the category's total; the year carries its travel pattern — the modes, a flight by haul and class — never
 * a trip's figures, a mode the year already holds skipped, a mode's roll-up carried as the same mode's group so this year's import
 * fills it; and the 5-year Lines drawer reads Business Travel by mode beside the prior year. Factors are invented, DESNZ-labelled.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-d5b", PRIOR = "job-d5b-2025", CURRENT = "job-d5b-2026", STAFF = "staff-d5b", DS = "d5b-dataset";
const AIR = "Business travel- air - Flights - Long-haul, to/from UK - Business class - With RF";

describe("Data entry D5: business travel amalgamated by mode, carried by its pattern, and read by mode across the years", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `d5b-${keys}`, correlationId: `corr-d5b-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) };
  };
  const factorUnit: Record<string, string> = { "lh-business": "passenger.km", rail: "passenger.km", hotel: "nights" };
  const trip = (jobId: string, groupId: string | null, factorId: string, detail: Record<string, unknown>, quantity: number) => createEmissionSource(database.pool, {
    jobId, groupId, scope: "3.6", sourceType: "travel", sourceSubtype: null, siteId: null, sourceName: "Trip", assetIdentifier: null, purchasedGoodsCategoryId: null,
    datasetId: DS, factorId, factorSource: "dataset", clientFactorId: null, quantity, unit: factorUnit[factorId]!, applyPct: 100, dataSource: "Business travel template import",
    dataConfidence: "M", monthlyActivity: [], notes: null,
    detail: { kind: "travel", origin: null, destination: null, carrier: null, distanceUnit: "km", passengers: 1, ...detail },
  } as never, context());
  const group = async (jobId: string, name: string, factorId: string, label: string) =>
    (await createEmissionSourceGroup(database.pool, { jobId, name, datasetId: DS, factorId, factorLabel: label, unit: factorUnit[factorId]! }, context())).data.groupId;
  const rows36 = async (jobId: string) => (await db.query<{ scope_row_id: string; factor_id: string; quantity: string | null; group_id: string | null; rolled_forward_from_row_id: string | null }>(
    `SELECT scope_row_id,factor_id,quantity::text,group_id,rolled_forward_from_row_id FROM nzi_console.job_scope_rows WHERE job_id=$1 AND enabled AND scope='3.6' ORDER BY factor_id`, [jobId])).rows;

  before(async () => {
    database = (await createDisposableDatabase("dataentryd5b"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ($1, $2, 'admin', 'active')`, [ORG, STAFF]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Travel Co', 'active')`, [ORG, CLIENT]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
      VALUES ($1, $2, 'D5B test factors', 'd5b', '2025-01-01', '2026-12-31', 'GB', 'active', 'Test', 'Test only')`, [ORG, DS]);
    for (const [id, label, value] of [["lh-business", AIR, 0.43], ["rail", "Business travel- land - Rail - National rail", 0.035], ["hotel", "Hotel stay - United Kingdom", 10.4]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES ($1, $2, $3, $4, $5, $6, ARRAY['3'])`, [ORG, DS, id, label, factorUnit[id], value]);
    }
    for (const [index, [job, year]] of ([[PRIOR, 2025], [CURRENT, 2026]] as const).entries()) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, reporting_period_start, reporting_period_end)
        VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'Data entry', $5, make_date($5, 1, 1), make_date($5, 12, 31))`, [ORG, job, CLIENT, index + 1, year]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, make_date($3, 1, 1), make_date($3, 12, 31), 'GB')`, [ORG, job, year]);
      await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, $3, 'manual', 'D5B test', 'test')`, [ORG, job, DS]);
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  let priorRowIds: string[] = [];
  it("R7: trips amalgamate to one 3.6 row per mode and factor — each priced by its own factor — composing the category's total", async () => {
    const air = await group(PRIOR, "Business travel · Air · Long haul · Business", "lh-business", AIR);
    const rail = await group(PRIOR, "Business travel · Rail", "rail", "National rail");
    await trip(PRIOR, air, "lh-business", { travelMode: "air", airHaul: "long-haul", cabinClass: "business" }, 5540);
    await trip(PRIOR, air, "lh-business", { travelMode: "air", airHaul: "long-haul", cabinClass: "business" }, 5540);
    await trip(PRIOR, rail, "rail", { travelMode: "rail" }, 400);
    for (const id of [air, rail]) await syncEmissionSourceGroupToScope(database.pool, { jobId: PRIOR, groupId: id }, context());
    // A hotel stay entered in the drawer: a row of its own, on its mode's factor.
    await createScopeRow(database.pool, { jobId: PRIOR, scope: "3.6", categoryCode: "3.6", sourceLabel: "Hotel stay - United Kingdom", siteId: null, quantity: 3, unit: "nights",
      datasetId: DS, factorId: "hotel", factorVersion: "d5b", factorLabel: "Hotel stay - United Kingdom", qualityTier: "measured" } as never, context());
    const rows = await rows36(PRIOR);
    assert.deepEqual(rows.map((row) => [row.factor_id, Number(row.quantity)]), [["hotel", 3], ["lh-business", 11080], ["rail", 400]], "one row per mode and factor, each its own trips' sum");
    assert.equal(rows.filter((row) => row.group_id).length, 2, "the two modes' trips are each one roll-up row");
    priorRowIds = rows.map((row) => row.scope_row_id);
  });

  it("R8: carries the pattern — the modes, a flight by haul and class — never a trip's figures; a mode the year already holds is skipped", async () => {
    // This year already has a rail trip, entered before the roll-forward.
    const rail = await trip(CURRENT, null, "rail", { travelMode: "rail" }, 300);
    await syncEmissionSourceToScope(database.pool, { jobId: CURRENT, sourceId: rail.data.sourceId }, context());
    const carried = await rollforwardScopeRows(database.pool, { jobId: CURRENT, priorJobId: PRIOR, rowIds: priorRowIds }, context());
    assert.deepEqual([carried.data.rolledForward, carried.data.skipped], [2, 1], "air and hotel carried; rail is held");
    const rows = await rows36(CURRENT);
    const air = rows.find((row) => row.factor_id === "lh-business")!, hotel = rows.find((row) => row.factor_id === "hotel")!;
    assert.deepEqual([air.quantity, hotel.quantity], [null, null], "the figures are zeroed");
    assert.ok(air.group_id && air.rolled_forward_from_row_id, "the flight's roll-up is carried as the same mode's roll-up");
    const carriedGroup = (await db.query(`SELECT name,factor_id FROM nzi_console.job_emission_groups WHERE group_id=$1`, [air.group_id])).rows[0];
    assert.deepEqual(carriedGroup, { name: "Business travel · Air · Long haul · Business", factor_id: "lh-business" });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.job_emission_sources WHERE job_id=$1`, [CURRENT])).rows[0].n, 1, "no trip was carried");
    const again = await rollforwardScopeRows(database.pool, { jobId: CURRENT, priorJobId: PRIOR, rowIds: priorRowIds }, context());
    assert.deepEqual([again.data.rolledForward, again.data.skipped], [0, 3], "never carried twice");
  });

  it("R8: this year's trips, filed in the carried mode's group, fill the carried row — the same row, not a second", async () => {
    const air = (await rows36(CURRENT)).find((row) => row.factor_id === "lh-business")!;
    await trip(CURRENT, air.group_id, "lh-business", { travelMode: "air", airHaul: "long-haul", cabinClass: "business" }, 6000);
    const synced = await syncEmissionSourceGroupToScope(database.pool, { jobId: CURRENT, groupId: air.group_id! }, context());
    assert.equal(synced.data.rowId, air.scope_row_id);
    assert.equal(Number((await rows36(CURRENT)).find((row) => row.factor_id === "lh-business")!.quantity), 6000);
    assert.equal((await rows36(CURRENT)).filter((row) => row.factor_id === "lh-business").length, 1);
  });

  it("R7: the 5-year Lines drawer reads Business Travel by mode — air, rail, hotel — beside the prior year", async () => {
    await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
      VALUES ($1, 'snap-d5b-25', $2, 1, 1, $3, $4::jsonb, 'test')`, [ORG, PRIOR, `sha256:${"d".repeat(64)}`, JSON.stringify({ jobNumber: PRIOR, client: "Travel Co", reportingYear: 2025, measurements: [] })]);
    const read = (await withTenantRead(database.pool, ORG, (tx) => readCategoryLineYears(tx, CURRENT, "3.6")))!;
    const at = (year: number) => read.years.findIndex((entry) => entry.year === year);
    const byLabel = new Map(read.lines.map((line) => [line.label, line]));
    assert.deepEqual([...byLabel.keys()].sort(), ["Air", "Hotel", "Rail"], "one line per mode — not per trip");
    assert.ok(read.lines.every((line) => line.key.startsWith("mode:")));
    assert.deepEqual([byLabel.get("Air")!.values[at(2025)]?.quantity, byLabel.get("Air")!.values[at(2026)]?.quantity], [11080, 6000]);
    assert.deepEqual([byLabel.get("Rail")!.values[at(2025)]?.quantity, byLabel.get("Rail")!.values[at(2026)]?.quantity], [400, 300]);
    assert.deepEqual([byLabel.get("Hotel")!.values[at(2025)]?.quantity, byLabel.get("Hotel")!.values[at(2026)]?.quantity], [3, null], "carried, not yet entered: null, never zero");
  });
});
