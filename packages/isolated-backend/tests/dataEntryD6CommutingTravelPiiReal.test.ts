import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  clearCommutingTravelIdentifiers, createEmissionSource, createScopeRow, rollforwardScopeRows, syncEmissionSourceToScope,
} from "../src/index";

/**
 * Data entry D6 (R1, R2a, R3, R4) against Postgres — commuting and business travel hold no personal identifier (ruled 28 Oct:
 * minimise, don't seal). A commuting source keeps no name and no registration, whatever a caller sends; nor does the row it syncs
 * to, nor a year rolled forward. The one-off clears what was written before: commuting names and plates on sources and live rows,
 * and pre-D5 travel identifiers — never a figure, never migrated history, counts only in its result and its audit, and a second run
 * clears nothing. The names and plates below are invented.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-d6", PRIOR = "job-d6-2025", CURRENT = "job-d6-2026", STAFF = "staff-d6", DS = "d6-dataset";
const NAME = "Alex Example", PLATE = "AB12 CDE", TRAVELLER = "Sam Traveller", BEFORE = "2026-10-15T00:00:00Z";
const IDENTIFYING = new RegExp([NAME, PLATE, TRAVELLER, "B. Example", "C. Example", "employeeName", "vehicleRegistration"].join("|"));

describe("Data entry D6: commuting and travel hold no personal identifier — at capture, carried, and cleared once", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `d6-${keys}`, correlationId: `corr-d6-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) };
  };
  const commute = (jobId: string, factorId: string, detail: Record<string, unknown>, extra: Record<string, unknown> = {}) => createEmissionSource(database.pool, {
    jobId, groupId: null, scope: "3.7", sourceType: "commuting", sourceSubtype: null, siteId: null, sourceName: "Commuter 1 · Car — diesel", assetIdentifier: null,
    purchasedGoodsCategoryId: null, datasetId: DS, factorId, factorSource: "dataset", clientFactorId: null, quantity: 7500, unit: "km", applyPct: 100,
    dataSource: "Commuting bulk import", dataConfidence: "M", monthlyActivity: [], notes: null,
    detail: { kind: "commuting", commuteMode: "Car — diesel", distanceUnit: "km", wfhDaysPerYear: 52, wfhHoursPerDay: 7.5, ...detail }, ...extra,
  } as never, context());
  const everything = async () => JSON.stringify((await db.query(
    `SELECT s.source_name,s.asset_identifier,s.detail_json,r.source_label,r.report_label,r.asset_identifier AS row_identifier,r.provenance_json,r.lineage_json
       FROM nzi_console.job_emission_sources s LEFT JOIN nzi_console.job_scope_rows r ON (r.organisation_id,r.source_id)=(s.organisation_id,s.source_id)
      WHERE s.organisation_id=$1 AND s.source_type='commuting' ORDER BY s.source_id`, [ORG])).rows);
  const figures = async () => (await db.query(
    `SELECT scope_row_id,quantity::text,unit,factor_id,calculated_tco2e::text,override_tco2e::text,version,review_status FROM nzi_console.job_scope_rows WHERE organisation_id=$1 ORDER BY scope_row_id`, [ORG])).rows;

  before(async () => {
    database = (await createDisposableDatabase("dataentryd6"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ($1, $2, 'admin', 'active')`, [ORG, STAFF]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Commute Co', 'active')`, [ORG, CLIENT]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
      VALUES ($1, $2, 'D6 test factors', 'd6', '2025-01-01', '2026-12-31', 'GB', 'active', 'Test', 'Test only')`, [ORG, DS]);
    for (const [id, label, unit, value] of [
      ["car-diesel", "Employee commuting- land - Cars (by size) - Average car - Diesel", "km", 0.17],
      ["rail", "Business travel- land - Rail - National rail", "passenger.km", 0.035],
    ] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES ($1, $2, $3, $4, $5, $6, ARRAY['3'])`, [ORG, DS, id, label, unit, value]);
    }
    for (const [index, [job, year]] of ([[PRIOR, 2025], [CURRENT, 2026]] as const).entries()) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, reporting_period_start, reporting_period_end)
        VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'Data entry', $5, make_date($5, 1, 1), make_date($5, 12, 31))`, [ORG, job, CLIENT, index + 1, year]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, make_date($3, 1, 1), make_date($3, 12, 31), 'GB')`, [ORG, job, year]);
      await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, $3, 'manual', 'D6 test', 'test')`, [ORG, job, DS]);
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("R1, R2a: a commuting source keeps no name and no registration — not in its detail, not as its identifier — and its row neither; the mode prices it", async () => {
    // An older caller's payload: the name as the identifier, the name and a plate in the detail.
    const created = await commute(CURRENT, "car-diesel", { employeeName: NAME, vehicleRegistration: PLATE }, { assetIdentifier: NAME });
    const stored = (await db.query(`SELECT asset_identifier,detail_json,factor_id,quantity::text FROM nzi_console.job_emission_sources WHERE source_id=$1`, [created.data.sourceId])).rows[0];
    assert.equal(stored.asset_identifier, null, "no identifier");
    assert.deepEqual(stored.detail_json, { kind: "commuting", commuteMode: "Car — diesel", distanceUnit: "km", wfhDaysPerYear: 52, wfhHoursPerDay: 7.5 }, "exactly the commute — no name, no plate");
    assert.deepEqual([stored.factor_id, stored.quantity], ["car-diesel", "7500"], "the mode's factor and the distance, as sent");
    const synced = await syncEmissionSourceToScope(database.pool, { jobId: CURRENT, sourceId: created.data.sourceId }, context());
    const row = (await db.query(`SELECT asset_identifier,provenance_json,quantity::text,factor_id FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [synced.data.rowId])).rows[0];
    assert.equal(row.asset_identifier, null);
    assert.deepEqual([row.quantity, row.factor_id], ["7500", "car-diesel"], "the calculation's inputs unchanged: mode × distance");
    assert.doesNotMatch(JSON.stringify(row.provenance_json), IDENTIFYING, "the row's evidence names no one");
    assert.doesNotMatch(JSON.stringify((await db.query(`SELECT after_json FROM nzi_console.audit_events WHERE organisation_id=$1`, [ORG])).rows), IDENTIFYING, "nor its audit");
    // A 3.7 row written in the drawer, or by any caller, identifies no commuter either.
    const drawn = await createScopeRow(database.pool, { jobId: CURRENT, scope: "3.7", categoryCode: "3.7", sourceLabel: "Rail", assetIdentifier: NAME, siteId: null, quantity: 100,
      unit: "passenger.km", datasetId: DS, factorId: "rail", factorVersion: "d6", factorLabel: "National rail", qualityTier: "measured" } as never, context());
    assert.equal((await db.query(`SELECT asset_identifier FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [drawn.data.rowId])).rows[0].asset_identifier, null);
  });

  let legacySource = "", legacyRow = "", unsourcedRow = "", tripRef = "", migratedRow = "";
  it("R4: the one-off — a dry run changes nothing; the run clears commuting names and plates and pre-D5 travel identifiers, never a figure, counts only", async () => {
    // What a pre-D6 bulk import wrote: the name as label and identifier, the name and a plate in the detail — synced to its row.
    legacySource = "src-d6-legacy";
    await db.query(`INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,scope,source_type,source_name,asset_identifier,dataset_id,factor_id,factor_source,quantity,unit,apply_pct,data_source,data_confidence,monthly_activity_json,detail_json)
      VALUES ($1,$2,$3,'3.7','commuting',$4,$4,$5,'car-diesel','dataset',6400,'km',100,'Commuting bulk import','M','[]'::jsonb,$6::jsonb)`,
      [ORG, legacySource, PRIOR, NAME, DS, JSON.stringify({ kind: "commuting", commuteMode: "Car — diesel", distanceUnit: "km", wfhDaysPerYear: 10, wfhHoursPerDay: 7.5, employeeName: NAME, vehicleRegistration: PLATE })]);
    legacyRow = (await syncEmissionSourceToScope(database.pool, { jobId: PRIOR, sourceId: legacySource }, context())).data.rowId;
    // A 3.7 row with no source, labelled by the commuter's name (a year rolled forward before D6), and one labelled by its activity.
    unsourcedRow = (await createScopeRow(database.pool, { jobId: PRIOR, scope: "3.7", categoryCode: "3.7", sourceLabel: "B. Example", assetIdentifier: "B. Example", siteId: null, quantity: 3200,
      unit: "passenger.km", datasetId: DS, factorId: "rail", factorVersion: "d6", factorLabel: "National rail", qualityTier: "measured" } as never, context())).data.rowId;
    await db.query(`UPDATE nzi_console.job_scope_rows SET asset_identifier='B. Example' WHERE scope_row_id=$1`, [unsourcedRow]);
    await createScopeRow(database.pool, { jobId: PRIOR, scope: "3.7", categoryCode: "3.7", sourceLabel: "Rail, 2 WFH days", siteId: null, quantity: 900,
      unit: "passenger.km", datasetId: DS, factorId: "rail", factorVersion: "d6", factorLabel: "National rail", qualityTier: "measured" } as never, context());
    // Business travel: a pre-D5 trip with the traveller in its "Traveller / trip ref", synced; and a trip reference given since D5.
    await db.query(`INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,scope,source_type,source_name,asset_identifier,dataset_id,factor_id,factor_source,quantity,unit,apply_pct,data_source,data_confidence,monthly_activity_json,detail_json,created_at)
      VALUES ($1,'src-d6-trip-old',$2,'3.6','travel','Trip',$3,$4,'rail','dataset',400,'passenger.km',100,'Source Register','M','[]'::jsonb,$5::jsonb,'2026-10-01'),
             ($1,'src-d6-trip-new',$2,'3.6','travel','Trip','BK-1234',$4,'rail','dataset',300,'passenger.km',100,'Source Register','M','[]'::jsonb,$5::jsonb,now())`,
      [ORG, PRIOR, TRAVELLER, DS, JSON.stringify({ kind: "travel", travelMode: "rail", origin: null, destination: null, carrier: null, distanceUnit: "km", passengers: 1 })]);
    const oldTripRow = (await syncEmissionSourceToScope(database.pool, { jobId: PRIOR, sourceId: "src-d6-trip-old" }, context())).data.rowId;
    await db.query(`UPDATE nzi_console.job_scope_rows SET created_at='2026-10-01' WHERE scope_row_id=$1`, [oldTripRow]);
    tripRef = (await syncEmissionSourceToScope(database.pool, { jobId: PRIOR, sourceId: "src-d6-trip-new" }, context())).data.rowId;
    // Migrated history holding a name: refused every change but `enabled` (0133) — counted, left.
    migratedRow = "v7-d6-commute";
    await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,category_code,source_label,report_label,asset_identifier,level_1,level_2,quantity,unit,calculated_tco2e,enabled,origin,migrated_record,source_system,legacy_db_id)
      VALUES ($1,$2,$3,'3.7','3.7','C. Example','C. Example','C. Example','v7','v7',5000,'passenger.km',0.1773,true,'migrated',$4::jsonb,'nzi-pro-v7',$2)`,
      [ORG, migratedRow, PRIOR, JSON.stringify({ qty: 5000, uom: "passenger.km", factor: 0.03546, ghg_unit: "kgCO2e", original_id: "d6-1", reported_tco2e: 0.1773, data_source: "Company Data", enabled: true })]);

    const before = await figures();
    const auditsBefore = Number((await db.query(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE organisation_id=$1`, [ORG])).rows[0].n);
    const heldBefore = await everything();
    const dry = await clearCommutingTravelIdentifiers(database.pool, ORG, { commit: false, travelBefore: BEFORE });
    assert.deepEqual(dry, { commutingSources: 1, commutingRows: 2, relabelled: 1, travelSources: 1, travelRows: 1, migratedLeft: 1, remaining: 0 });
    assert.equal(await everything(), heldBefore, "a dry run is the whole run, rolled back");

    const run = await clearCommutingTravelIdentifiers(database.pool, ORG, { commit: true, travelBefore: BEFORE });
    assert.deepEqual(run, dry, "the run does what the dry run said");
    assert.doesNotMatch(await everything(), IDENTIFYING, "no commuting source or its row holds a name or a plate");
    const source = (await db.query(`SELECT source_name,asset_identifier,detail_json FROM nzi_console.job_emission_sources WHERE source_id=$1`, [legacySource])).rows[0];
    assert.deepEqual(source, { source_name: "Commuter 1 · Car — diesel", asset_identifier: null,
      detail_json: { kind: "commuting", commuteMode: "Car — diesel", distanceUnit: "km", wfhDaysPerYear: 10, wfhHoursPerDay: 7.5 } }, "the commuter by number and mode");
    const row = (await db.query(`SELECT source_label,report_label,lineage_json FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [legacyRow])).rows[0];
    assert.deepEqual([row.source_label, row.report_label], ["Commuter 1 · Car — diesel", "Commuter 1 · Car — diesel"]);
    assert.match(JSON.stringify(row.lineage_json), new RegExp(`Commuter 1 · Car — diesel · ${legacySource}`), "the lineage names the source by its new label");
    const unsourced = (await db.query(`SELECT source_label,asset_identifier FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [unsourcedRow])).rows[0];
    assert.match(unsourced.source_label, /^Commuter \d+$/, "a row labelled by its commuter's identifier is relabelled");
    assert.equal(unsourced.asset_identifier, null);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE source_label='Rail, 2 WFH days'`)).rows[0].n, 1, "an activity label stays");
    const trips = (await db.query(`SELECT source_id,asset_identifier FROM nzi_console.job_emission_sources WHERE source_type='travel' ORDER BY source_id`)).rows;
    assert.deepEqual(trips, [{ source_id: "src-d6-trip-new", asset_identifier: "BK-1234" }, { source_id: "src-d6-trip-old", asset_identifier: null }], "a pre-D5 traveller cleared; a trip reference since D5 kept");
    assert.equal((await db.query(`SELECT asset_identifier FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [tripRef])).rows[0].asset_identifier, "BK-1234");
    assert.equal((await db.query(`SELECT asset_identifier FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [migratedRow])).rows[0].asset_identifier, "C. Example", "migrated history is left, for a ruling");
    assert.deepEqual(await figures(), before, "no figure, factor, version or review moved");

    const audits = (await db.query(`SELECT action,principal_type,after_json FROM nzi_console.audit_events WHERE organisation_id=$1 ORDER BY occurred_at`, [ORG])).rows.slice(auditsBefore);
    assert.equal(audits.length, 1, "one audit event for the run");
    assert.deepEqual([audits[0].action, audits[0].principal_type], ["data_entry.identifiers_minimised", "system"]);
    assert.deepEqual(audits[0].after_json, { ...run, travelBefore: BEFORE }, "audited by counts only");
    assert.doesNotMatch(JSON.stringify(audits[0]), IDENTIFYING);

    const again = await clearCommutingTravelIdentifiers(database.pool, ORG, { commit: true, travelBefore: BEFORE });
    assert.deepEqual(again, { commutingSources: 0, commutingRows: 0, relabelled: 0, travelSources: 0, travelRows: 0, migratedLeft: 1, remaining: 0 }, "a second run clears nothing");
    assert.equal(Number((await db.query(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE organisation_id=$1`, [ORG])).rows[0].n), auditsBefore + 1, "and audits nothing");
  });

  it("R2a, R3: a commuting or travel row rolled into the next year carries no identifier — even one the clear did not reach", async () => {
    // Written after the clear ran (or by a caller round the writes): still not carried.
    await db.query(`UPDATE nzi_console.job_scope_rows SET asset_identifier='B. Example' WHERE scope_row_id=$1`, [unsourcedRow]);
    const carried = await rollforwardScopeRows(database.pool, { jobId: CURRENT, priorJobId: PRIOR, rowIds: [unsourcedRow, tripRef, migratedRow] }, context());
    assert.deepEqual([carried.data.rolledForward, carried.data.skipped], [2, 1], "migrated history never seeds a live row (§5.1)");
    const rows = (await db.query(`SELECT category_code,asset_identifier FROM nzi_console.job_scope_rows WHERE job_id=$1 AND rolled_forward_from_row_id IS NOT NULL ORDER BY category_code`, [CURRENT])).rows;
    assert.deepEqual(rows, [{ category_code: "3.6", asset_identifier: null }, { category_code: "3.7", asset_identifier: null }]);
  });
});
