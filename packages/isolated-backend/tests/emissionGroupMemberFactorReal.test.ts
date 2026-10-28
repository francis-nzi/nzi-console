import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createEmissionSource, createEmissionSourceGroup, syncEmissionSourceGroupToScope, updateEmissionSourceStatus } from "../src/index";

/**
 * A roll-up group prices its members' summed quantity with its one factor (quantity × factor — one report line), so a member joins
 * it only on that factor, or with none of its own. Before this, a small diesel car added to a "Pool cars" group set on a van factor was
 * priced as a van. The create refuses such a member; the roll-up refuses a group already holding one, naming it, and leaves the
 * group's row as it was. Factors are invented.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-grp", JOB = "job-grp-2025", STAFF = "staff-grp", DS = "grp-dataset", OTHER_DS = "grp-dataset-2";

describe("A roll-up group is priced with one factor: a member on another is refused", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  let groupId = "";
  const context = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `grp-${keys}`, correlationId: `corr-grp-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) };
  };
  const vehicle = (name: string, factor: { datasetId?: string | null; factorId?: string | null; factorSource?: "dataset" | "client"; clientFactorId?: string | null }, quantity = 1000) => ({
    jobId: JOB, groupId, scope: "1", sourceType: "vehicle", sourceSubtype: null, siteId: null, sourceName: name, assetIdentifier: null, purchasedGoodsCategoryId: null,
    datasetId: factor.datasetId ?? null, factorId: factor.factorId ?? null, factorSource: factor.factorSource ?? "dataset", clientFactorId: factor.clientFactorId ?? null,
    quantity, unit: "miles", applyPct: 100, dataSource: "Test", dataConfidence: null, monthlyActivity: [], notes: null,
    detail: { kind: "vehicle", vehicleRegistration: null, make: null, model: null, fuel: null },
  }) as never;
  const refusal = async (input: never): Promise<string> => {
    try { await createEmissionSource(database.pool, input, context()); } catch (error) { return JSON.stringify((error as { issues?: unknown }).issues ?? String(error)); }
    assert.fail("the member was added");
  };

  before(async () => {
    database = (await createDisposableDatabase("groupmemberfactor"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ($1, $2, 'admin', 'active')`, [ORG, STAFF]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Fleet Co', 'active')`, [ORG, CLIENT]);
    for (const dataset of [DS, OTHER_DS]) {
      await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
        VALUES ($1, $2, $2, 'v1', '2025-01-01', '2025-12-31', 'GB', 'active', 'Test', 'Test only')`, [ORG, dataset]);
      for (const [id, label, value] of [["van-mi", "Delivery vehicles - Vans - Class III (1.74 to 3.5 tonnes) - Diesel", 0.4], ["car-mi", "Passenger vehicles - Cars (by size) - Small car - Diesel", 0.2]] as const) {
        await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES ($1, $2, $3, $4, 'miles', $5, ARRAY['1'])`, [ORG, dataset, id, label, value]);
      }
    }
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, reporting_period_start, reporting_period_end)
      VALUES ($1, $2, $3, 1, 'crp', 'CRP', 'open', 'Data entry', 2025, '2025-01-01', '2025-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
    for (const dataset of [DS, OTHER_DS]) await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, $3, 'manual', 'test', 'test')`, [ORG, JOB, dataset]);
    await db.query(`INSERT INTO nzi_console.client_factors (organisation_id, client_factor_id, client_id, scope, report_label, unit, kgco2e_per_unit, vintage_year, created_by)
      VALUES ($1, 'cf-van', $2, '1', 'Our own van factor', 'miles', 0.35, 2025, 'test')`, [ORG, CLIENT]);
    groupId = (await createEmissionSourceGroup(database.pool, { jobId: JOB, name: "Vans", datasetId: DS, factorId: "van-mi", factorLabel: "Class III van · miles", unit: "miles" } as never, context())).data.groupId;
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("takes a member on the group's own factor, or with none of its own (it is priced by the group's)", async () => {
    await createEmissionSource(database.pool, vehicle("Van 1", { datasetId: DS, factorId: "van-mi" }), context());
    await createEmissionSource(database.pool, vehicle("Van 2", {}), context());
    const synced = await syncEmissionSourceGroupToScope(database.pool, { jobId: JOB, groupId } as never, context());
    assert.deepEqual([synced.data.enabledMemberCount, synced.data.summedQuantity], [2, 2000]);
  });

  it("refuses a member on another factor — another vehicle's, the same id in another dataset, or a client factor", async () => {
    assert.match(await refusal(vehicle("Pool car 2", { datasetId: DS, factorId: "car-mi" })), /FACTOR_MISMATCH.*Vans is priced with one factor \(Class III van · miles\)/);
    assert.match(await refusal(vehicle("Van 3", { datasetId: OTHER_DS, factorId: "van-mi" })), /FACTOR_MISMATCH/);
    assert.match(await refusal(vehicle("Van 4", { factorSource: "client", clientFactorId: "cf-van" })), /FACTOR_MISMATCH/);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.job_emission_sources WHERE group_id=$1`, [groupId])).rows[0].n, 2, "a refused member was added");
  });

  it("refuses to roll up a group already holding one (written before the guard), naming it — the row is left as it was", async () => {
    await db.query(`INSERT INTO nzi_console.job_emission_sources (organisation_id, source_id, job_id, group_id, scope, source_type, source_name, dataset_id, factor_id, factor_source, quantity, unit, data_source)
      VALUES ($1, 'legacy-car', $2, $3, '1', 'vehicle', 'Pool car 9', $4, 'car-mi', 'dataset', 5000, 'miles', 'Test')`, [ORG, JOB, groupId, DS]);
    const before = (await db.query(`SELECT quantity, version FROM nzi_console.job_scope_rows WHERE group_id=$1`, [groupId])).rows[0];
    await assert.rejects(syncEmissionSourceGroupToScope(database.pool, { jobId: JOB, groupId } as never, context()),
      (error: { issues?: Array<{ code: string; message: string }> }) => error.issues?.[0]?.code === "FACTOR_MISMATCH" && /This member has another: Pool car 9/.test(error.issues[0].message));
    const after = (await db.query(`SELECT quantity, version FROM nzi_console.job_scope_rows WHERE group_id=$1`, [groupId])).rows[0];
    assert.deepEqual(after, before, "the group's row was repriced with a member it does not price");
  });

  it("rolls up again once the off-factor member is archived — the way out the refusal names", async () => {
    const version = (await db.query(`SELECT version FROM nzi_console.job_emission_sources WHERE source_id='legacy-car'`)).rows[0].version;
    await updateEmissionSourceStatus(database.pool, { jobId: JOB, sourceId: "legacy-car", expectedVersion: version, enabled: false } as never, context());
    const synced = await syncEmissionSourceGroupToScope(database.pool, { jobId: JOB, groupId } as never, context());
    assert.deepEqual([synced.data.enabledMemberCount, synced.data.summedQuantity], [2, 2000]);
  });
});
