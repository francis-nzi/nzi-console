import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  createEmissionSource, createScopeRow, listJobEmissionSourceRegister, listScopeRows, readJobEntryBasis, rollforwardScopeRows, sealExistingVehicleRegistrations,
  setVehicleRegistrationsOptOut, syncEmissionSourceToScope, updateScopeRow, vehicleRegistrationReader, withTenantRead,
} from "../src/index";
import { PII_COLUMNS } from "../src/piiInventory";

/**
 * Data entry D4 (R1, R2, R8) against Postgres: a company vehicle's registration is held **only sealed**, under the client's own
 * key (0196; ruled 28 Oct) — never in the clear, never in a payload — with a client opt-out that destroys every plate held and
 * names vehicles instead. Commuting stays reg-free. Factors are invented, named as such.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-d4", OTHER_CLIENT = "client-d4-other";
const JOB = "job-d4", NEXT = "job-d4-next", OTHER = "job-d4-other";
const STAFF = "staff-d4", VIEWER = "staff-d4-viewer";
const DS = "d4-dataset";
const PLATE = "AB12 CDE";

describe("Data entry D4: a vehicle registration held only sealed, with a client opt-out", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (actor = STAFF, role: StaffRole = "admin"): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `d4-${keys}`, correlationId: `corr-d4-${keys}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const issues = async (promise: Promise<unknown>) => { try { await promise; return []; } catch (error: any) { return (error.issues ?? [{ code: error.name }]).map((issue: any) => issue.code); } };
  const vehicle = (jobId: string, over: Record<string, unknown> = {}) => ({
    jobId, scope: "1", categoryCode: "1.company-vehicles", sourceLabel: "Passenger vehicles - Cars (by size) - Small car - Diesel", siteId: null,
    quantity: 8000, unit: "miles", datasetId: DS, factorId: "d4-car-small-diesel-mi", factorVersion: "d4", factorLabel: "Small car diesel (test)",
    qualityTier: "measured", assetIdentifier: PLATE, ...over,
  }) as never;
  const row = async (rowId: string) => (await db.query(`SELECT asset_identifier, asset_identifier_sealed, asset_identifier_bidx, source_label, notes FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0];
  // Everything a write leaves behind that a person could read — none of it may hold the plate.
  const plateAnywhere = async () => (await db.query<{ n: string }>(
    `SELECT ((SELECT count(*) FROM nzi_console.job_scope_rows WHERE asset_identifier ILIKE '%AB12%' OR source_label ILIKE '%AB12%' OR coalesce(notes,'') ILIKE '%AB12%' OR asset_identifier_sealed::text ILIKE '%AB12%')
           + (SELECT count(*) FROM nzi_console.job_emission_sources WHERE asset_identifier ILIKE '%AB12%' OR source_name ILIKE '%AB12%' OR detail_json::text ILIKE '%AB12%' OR asset_identifier_sealed::text ILIKE '%AB12%')
           + (SELECT count(*) FROM nzi_console.audit_events WHERE coalesce(after_json::text,'') ILIKE '%AB12%' OR coalesce(before_json::text,'') ILIKE '%AB12%')
           + (SELECT count(*) FROM nzi_console.transactional_outbox WHERE payload_json::text ILIKE '%AB12%'))::text AS n`)).rows[0]!.n;

  before(async () => {
    database = (await createDisposableDatabase("dataentryd4"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    for (const [user, role] of [[STAFF, "admin"], [VIEWER, "viewer"]]) await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ($1, $2, $3, 'active')`, [ORG, user, role]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Fleet Co', 'active'), ($1, $3, 'Other Co', 'active')`, [ORG, CLIENT, OTHER_CLIENT]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
      VALUES ($1, $2, 'D4 test factors', 'd4', '2025-01-01', '2026-12-31', 'GB', 'active', 'Test', 'Test only')`, [ORG, DS]);
    await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES
      ($1, $2, 'd4-car-small-diesel-mi', 'Passenger vehicles - Cars (by size) - Small car - Diesel', 'miles', 0.22, ARRAY['1']),
      ($1, $2, 'd4-commute-car', 'Employee commuting - car (test)', 'km', 0.17, ARRAY['3'])`, [ORG, DS]);
    for (const [index, [job, client, year]] of ([[JOB, CLIENT, 2025], [NEXT, CLIENT, 2026], [OTHER, OTHER_CLIENT, 2025]] as const).entries()) {
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, reporting_period_start, reporting_period_end)
        VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'Data entry', $5, make_date($5, 1, 1), make_date($5, 12, 31))`, [ORG, job, client, index + 1, year]);
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, make_date($3, 1, 1), make_date($3, 12, 31), 'GB')`, [ORG, job, year]);
      await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, $3, 'manual', 'D4 test', 'test')`, [ORG, job, DS]);
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  let rowId = "";
  it("R1: a company vehicle's plate is sealed by the write — no plaintext, ciphertext and a client-scoped digest — and read back for the job", async () => {
    rowId = (await createScopeRow(database.pool, vehicle(JOB), context())).data.rowId;
    const stored = await row(rowId);
    assert.equal(stored.asset_identifier, null, "no plaintext");
    assert.ok(stored.asset_identifier_sealed?.ciphertext && stored.asset_identifier_sealed.k, "ciphertext under a named key");
    assert.ok(!JSON.stringify(stored.asset_identifier_sealed).includes("AB12"));
    assert.ok(stored.asset_identifier_bidx);
    const key = (await db.query(`SELECT client_id, purpose, wrapped_key IS NOT NULL AS live FROM nzi_console.client_data_keys WHERE key_id=$1`, [stored.asset_identifier_sealed.k])).rows[0];
    assert.deepEqual(key, { client_id: CLIENT, purpose: "vehicle-registration", live: true }, "the client's own key, not a person's");
    const read = await withTenantRead(database.pool, ORG, (tx) => listScopeRows(tx, JOB));
    assert.equal(read.find((entry) => entry.id === rowId)!.assetIdentifier, PLATE);
    assert.equal(await plateAnywhere(), "0", "R2/R8: the plate is in no column, label, note, audit or outbox payload in the clear");
  });

  it("R1: the same plate keeps its identity across edits; saved with none, the seal goes too", async () => {
    const before = await row(rowId);
    const version = (await db.query(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0].version;
    await updateScopeRow(database.pool, { ...vehicle(JOB, { assetIdentifier: "ab12cde" }) as object, rowId, expectedVersion: version, enabled: true } as never, context());
    assert.equal((await row(rowId)).asset_identifier_bidx, before.asset_identifier_bidx, "the same vehicle, written differently, is the same identity");
    const next = (await db.query(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0].version;
    await updateScopeRow(database.pool, { ...vehicle(JOB, { assetIdentifier: null }) as object, rowId, expectedVersion: next, enabled: true } as never, context());
    const cleared = await row(rowId);
    assert.deepEqual([cleared.asset_identifier, cleared.asset_identifier_sealed, cleared.asset_identifier_bidx], [null, null, null]);
    const last = (await db.query(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0].version;
    await updateScopeRow(database.pool, { ...vehicle(JOB) as object, rowId, expectedVersion: last, enabled: true } as never, context());
  });

  it("R1: a client's digest cannot confirm another client's plate — the same plate, two clients, two identities", async () => {
    const other = (await createScopeRow(database.pool, vehicle(OTHER), context())).data.rowId;
    assert.notEqual((await row(other)).asset_identifier_bidx, (await row(rowId)).asset_identifier_bidx);
  });

  it("R1: commuting is not a company vehicle — nothing is sealed for it; and since D6 (R2a) its identifier (a name) is not kept at all", async () => {
    const commute = (await createScopeRow(database.pool, { ...(vehicle(JOB, { scope: "3.7", categoryCode: "3.7", factorId: "d4-commute-car", unit: "km", assetIdentifier: "Jo Bloggs", sourceLabel: "Commute" }) as object) } as never, context())).data.rowId;
    const stored = await row(commute);
    assert.deepEqual([stored.asset_identifier, stored.asset_identifier_sealed], [null, null]);
  });

  it("R1: a vehicle source (the register, the bulk grid) is sealed, its detail loses the plate, and its row carries the sealed plate", async () => {
    const source = (await createEmissionSource(database.pool, {
      jobId: JOB, groupId: null, scope: "1", sourceType: "vehicle", sourceSubtype: null, siteId: null, sourceName: "Ford Transit", assetIdentifier: "XY99 ZZZ",
      purchasedGoodsCategoryId: null, datasetId: DS, factorId: "d4-car-small-diesel-mi", factorSource: "dataset", clientFactorId: null, quantity: 1200, unit: "miles",
      applyPct: 100, dataSource: "Company vehicles bulk import", dataConfidence: "M", monthlyActivity: [],
      detail: { kind: "vehicle", vehicleRegistration: "XY99 ZZZ", make: "Ford", model: "Transit", fuel: "Diesel" }, notes: null,
    } as never, context())).data.sourceId;
    const stored = (await db.query(`SELECT asset_identifier, asset_identifier_sealed, asset_identifier_bidx, detail_json FROM nzi_console.job_emission_sources WHERE source_id=$1`, [source])).rows[0];
    assert.equal(stored.asset_identifier, null);
    assert.ok(stored.asset_identifier_sealed && stored.asset_identifier_bidx);
    assert.equal(stored.detail_json.vehicleRegistration, undefined, "the detail no longer carries it");
    const synced = (await syncEmissionSourceToScope(database.pool, { jobId: JOB, sourceId: source }, context())).data.rowId;
    const synchronised = await row(synced);
    assert.deepEqual([synchronised.asset_identifier, synchronised.asset_identifier_bidx], [null, stored.asset_identifier_bidx]);
    const register = await withTenantRead(database.pool, ORG, (tx) => listJobEmissionSourceRegister(tx, JOB));
    assert.equal(register.sources.find((entry) => entry.id === source)!.assetIdentifier, "XY99 ZZZ");
    assert.equal((await withTenantRead(database.pool, ORG, (tx) => listScopeRows(tx, JOB))).find((entry) => entry.id === synced)!.assetIdentifier, "XY99 ZZZ");
  });

  it("R1/R6: a vehicle rolled forward keeps its sealed plate and identity — no plaintext", async () => {
    const carried = await rollforwardScopeRows(database.pool, { jobId: NEXT, priorJobId: JOB, rowIds: [rowId] }, context());
    const next = await row(carried.data.createdRowIds[0]!);
    assert.deepEqual([next.asset_identifier, next.asset_identifier_bidx], [null, (await row(rowId)).asset_identifier_bidx]);
    assert.equal((await withTenantRead(database.pool, ORG, (tx) => listScopeRows(tx, NEXT)))[0]!.assetIdentifier, PLATE);
  });

  it("R1/R8: the inventory holds both columns as client-sealed — not attributable to a person, out of the subject-key sealing", () => {
    for (const table of ["job_scope_rows", "job_emission_sources"]) {
      const column = PII_COLUMNS.find((entry) => entry.table === table && entry.column === "asset_identifier")!;
      assert.equal(column.storage.kind, "client-sealed");
      assert.equal(column.stage, "sealed");
      assert.equal(column.erasure, "not-attributable");
    }
  });

  it("R1/R8: the client's opt-out — the client editor's, versioned, audited by counts — shreds the key and clears every plate; vehicles are named after", async () => {
    const version = (await db.query(`SELECT version FROM nzi_console.clients WHERE client_id=$1`, [CLIENT])).rows[0].version;
    await assert.rejects(setVehicleRegistrationsOptOut(database.pool, { clientId: CLIENT, optOut: true, expectedVersion: version }, context(VIEWER, "viewer")),
      (error: any) => /Authori[sz]ation|Forbidden|permission/i.test(`${error.name} ${error.message}`));
    const done = await setVehicleRegistrationsOptOut(database.pool, { clientId: CLIENT, optOut: true, expectedVersion: version }, context());
    assert.equal(done.data.keysShredded, 1);
    assert.ok(done.data.cleared >= 4, `every vehicle row and source of the client: ${done.data.cleared}`);
    const left = (await db.query(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows r JOIN nzi_console.jobs j USING (organisation_id, job_id)
      WHERE j.client_id=$1 AND r.category_code='1.company-vehicles' AND (r.asset_identifier_sealed IS NOT NULL OR r.asset_identifier_bidx IS NOT NULL OR r.asset_identifier IS NOT NULL)`, [CLIENT])).rows[0].n;
    assert.equal(left, 0);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.client_data_keys WHERE client_id=$1 AND wrapped_key IS NOT NULL`, [CLIENT])).rows[0].n, 0, "the key is gone");
    const audit = (await db.query(`SELECT action, after_json FROM nzi_console.audit_events WHERE audit_event_id=$1`, [done.auditEventId])).rows[0];
    assert.equal(audit.action, "client_vehicle_registrations_set");
    assert.equal(await plateAnywhere(), "0");
    // The other client's plate is untouched.
    assert.equal((await withTenantRead(database.pool, ORG, (tx) => listScopeRows(tx, OTHER)))[0]!.assetIdentifier, PLATE);
    // Opted out: the drawer is told, and what is given is a name, kept as given — not sealed.
    assert.equal((await withTenantRead(database.pool, ORG, (tx) => readJobEntryBasis(tx, ORG, JOB))).vehicleRegistrationsOptOut, true);
    const named = (await createScopeRow(database.pool, vehicle(JOB, { assetIdentifier: "Van 3" }), context())).data.rowId;
    assert.deepEqual([(await row(named)).asset_identifier, (await row(named)).asset_identifier_sealed], ["Van 3", null]);
    assert.deepEqual(await issues(setVehicleRegistrationsOptOut(database.pool, { clientId: CLIENT, optOut: true, expectedVersion: done.data.version }, context())), ["UNCHANGED"]);
    // Opting back in mints a new key on the next plate.
    const back = await setVehicleRegistrationsOptOut(database.pool, { clientId: CLIENT, optOut: false, expectedVersion: done.data.version }, context());
    const again = (await createScopeRow(database.pool, vehicle(JOB, { assetIdentifier: "CD34 EFG" }), context())).data.rowId;
    assert.ok((await row(again)).asset_identifier_sealed);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.client_data_keys WHERE client_id=$1`, [CLIENT])).rows[0].n, 2, "the shredded key stays as the record");
    void back;
  });

  it("R1: a value sealed under a since-shredded key reads as held-but-unreadable, never an error", async () => {
    const open = vehicleRegistrationReader(db, ORG);
    assert.equal(await open(CLIENT, { k: "no-such-key", ciphertext: "x", iv: "x", tag: "x" }), null);
  });

  it("R1: the one-off sealing of plates written before 0196 — a dry run writes nothing; the run seals them all", async () => {
    const legacy = (await db.query<{ scope_row_id: string }>(`INSERT INTO nzi_console.job_scope_rows (organisation_id, scope_row_id, job_id, scope, source_label, quantity, unit, report_label, level_1, level_2, provenance_json, lineage_json, category_code, asset_identifier)
      SELECT organisation_id, 'legacy-row', job_id, scope, source_label, quantity, unit, report_label, level_1, level_2, '{}', '[]', category_code, 'LG12 ACY' FROM nzi_console.job_scope_rows WHERE job_id=$1 LIMIT 1 RETURNING scope_row_id`, [OTHER])).rows[0]!.scope_row_id;
    // Two: the legacy plate, and "Van 3" — named while the client was opted out, now held (sealed) since it opted back in.
    const dry = await sealExistingVehicleRegistrations(database.pool, ORG, { commit: false });
    assert.deepEqual([dry.rows, dry.remaining], [2, 0]);
    assert.equal((await row(legacy)).asset_identifier, "LG12 ACY", "the dry run is rolled back");
    const run = await sealExistingVehicleRegistrations(database.pool, ORG, { commit: true });
    assert.deepEqual([run.rows, run.remaining], [2, 0]);
    assert.equal((await row(legacy)).asset_identifier, null);
    assert.equal((await sealExistingVehicleRegistrations(database.pool, ORG, { commit: false })).rows, 0, "nothing left to do");
  });
});
