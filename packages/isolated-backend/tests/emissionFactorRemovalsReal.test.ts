import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * A negative emission factor is allowed only when it is marked a removal (0128).
 *
 * ICE's carbon-storage values are negative; the database takes them only with `is_removal`, so a negative that is not
 * declared stored or sequestered carbon is still refused wherever it is written from. The flag defaults to false.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "net-zero-international";

describe("emission-factor removals (0128)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const factor = (factorId: string, value: number, isRemoval?: boolean) => db.query(
    isRemoval === undefined
      ? `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
         VALUES ($1,'removals-test',$2,'x','kg',$3,ARRAY['3'])`
      : `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,is_removal)
         VALUES ($1,'removals-test',$2,'x','kg',$3,ARRAY['3'],$4)`,
    isRemoval === undefined ? [ORG, factorId, value] : [ORG, factorId, value, isRemoval]);

  before(async () => {
    database = (await createDisposableDatabase("removals"))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'removals-test','Removals test','1','2026-01-01','2026-12-31','GLOBAL','active','Test','Source: test.')`, [ORG]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("defaults is_removal to false, and still takes a zero or positive factor", async () => {
    await factor("plain", 0.5);
    await factor("zero", 0);
    const rows = await db.query(`SELECT factor_id, is_removal FROM nzi_console.emission_factors WHERE dataset_id='removals-test' ORDER BY factor_id`);
    assert.deepEqual(rows.rows, [{ factor_id: "plain", is_removal: false }, { factor_id: "zero", is_removal: false }]);
  });

  it("refuses a negative factor that is not a removal — by default or said explicitly", async () => {
    await assert.rejects(factor("negative-default", -1.03), /emission_factors_kgco2e_per_unit_check/);
    await assert.rejects(factor("negative-explicit", -1.03, false), /emission_factors_kgco2e_per_unit_check/);
  });

  it("takes a negative factor marked as a removal", async () => {
    await factor("ice-storage", -1.03089278, true);
    const row = await db.query(`SELECT kgco2e_per_unit::text AS value, is_removal FROM nzi_console.emission_factors WHERE factor_id='ice-storage'`);
    assert.deepEqual(row.rows, [{ value: "-1.03089278", is_removal: true }]);
  });

  it("refuses clearing the flag on a negative row", async () => {
    await assert.rejects(db.query(`UPDATE nzi_console.emission_factors SET is_removal=false WHERE factor_id='ice-storage'`),
      /emission_factors_kgco2e_per_unit_check/);
  });
});
