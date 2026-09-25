import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { parseFactorId } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { variantBasesRefused } from "../src/declarativeResolution";
import { listCategoryVariants } from "../src/factorCategoryVariants";

/**
 * v7 provenance is keyed by original_id (0126), and v7's suffixed ids are the console's category variants
 * (REFERENCE_DATA_DESIGN §3–4).
 *
 * The first half is the key change: two factors of one v7 definition in one dataset — the flight-class case, definition
 * 9759 — both load, where 0125's key refused the second; the same original_id in two datasets is one identity; and the
 * pair that must be unique is. The second half is the id shape: `v7-<original_id>` read against the registry the
 * migrations actually build, for an unsuffixed id, every registered suffix, and the tags that are not registered — and
 * then the base/variant rule working on those ids through the real code, not only the parser.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-v7";

describe("v7 provenance keyed by original_id, and v7 suffixes as category variants (0126)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  const dataset = (id: string, year: number) => db.query(
    `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence,source_system,source_family,legacy_dataset_id,content_sha256)
     VALUES ($1,$2,$2,$3,$4,$5,'GB','active','DESNZ','OGL v3.0','nzi-pro-v7','uk-ghg',$2,repeat('a',64))`,
    [ORG, id, String(year), `${year}-01-01`, `${year}-12-31`]);
  const factor = (datasetId: string, originalId: string, definition: string, label: string, value = 0.2, scopes = ["3"], unit = "passenger.km") => db.query(
    `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_system,legacy_original_id,legacy_factor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'nzi-pro-v7',$8,$9)`,
    [ORG, datasetId, `v7-${originalId}`, label, unit, value, scopes, originalId, definition]);

  before(async () => {
    database = (await createDisposableDatabase("v7provenance"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await dataset("uk-ghg-gb-2024", 2024);
    await dataset("uk-ghg-gb-2025", 2025);
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── The key ─────────────────────────────────────────────────────────────────────────────────────────

  it("loads several factors of one v7 definition in one dataset — the case 0125's key refused", async () => {
    for (const [cls, value] of [["economy", 0.15], ["premium", 0.24], ["business", 0.43], ["first", 0.6], ["average", 0.2]] as const) {
      await factor("uk-ghg-gb-2025", `9759-${cls}`, "9759", `Long-haul flight, ${cls}`, value);
    }
    const loaded = await db.query(`SELECT 1 FROM nzi_console.emission_factors WHERE legacy_factor_id='9759' AND dataset_id='uk-ghg-gb-2025'`);
    assert.equal(loaded.rows.length, 5);
  });

  it("holds (dataset, original_id) unique, and lets one original_id recur across datasets as one identity", async () => {
    // The same code twice in one dataset: refused by the id itself, and — under another id — by the provenance key.
    await assert.rejects(() => factor("uk-ghg-gb-2025", "9759-economy", "9759", "Again"), /emission_factors_pkey/);
    await assert.rejects(() => db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_system,legacy_original_id,legacy_factor_id)
       VALUES ($1,'uk-ghg-gb-2025','v7-renamed','x','passenger.km',0.1,ARRAY['3'],'nzi-pro-v7','9759-economy','9759')`, [ORG]),
      /(emission_factors|factor_identities)_legacy_original_key/, "a second id claiming the same source code in one dataset was accepted");
    await factor("uk-ghg-gb-2024", "9759-economy", "9759", "Long-haul flight, economy (2024 wording)", 0.16);
    const identities = await db.query<{ legacy_original_id: string; label: string }>(
      `SELECT legacy_original_id, label FROM nzi_console.factor_identities WHERE factor_id='v7-9759-economy'`);
    assert.equal(identities.rows.length, 1, "one source code became more than one identity");
    assert.equal(identities.rows[0]!.legacy_original_id, "9759-economy", "the identity does not carry the code it stands for");
  });

  it("refuses an imported identity or factor that does not say which source code it is", async () => {
    await assert.rejects(() => db.query(
      `INSERT INTO nzi_console.factor_identities (organisation_id,factor_id,label,source_label,source_system,legacy_factor_id,created_by)
       VALUES ($1,'v7-orphan','x','x','nzi-pro-v7','1','test')`, [ORG]), /factor_identity_provenance_shape/);
    await assert.rejects(() => db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_system,legacy_factor_id)
       VALUES ($1,'uk-ghg-gb-2025','v7-nocode','x','kWh',0.1,ARRAY['2'],'nzi-pro-v7','1')`, [ORG]),
      // Refused either way: the identity the trigger would create fails its own check first.
      /(emission_factor|factor_identity)_provenance_shape/);
  });

  // ── The id shape, read against the registry the migrations build ─────────────────────────────────────

  it("reads an unsuffixed v7 id as a base, and each registered suffix as its category's variant", async () => {
    const registry = await listCategoryVariants(db);
    assert.deepEqual(parseFactorId("v7-4521", registry).variant, null);
    const expected: Record<string, string> = { "-b": "3.6", "-c": "3.7", "-p": "3.1", "-u": "3.4", "-d": "3.9" };
    for (const [suffix, category] of Object.entries(expected)) {
      const parsed = parseFactorId(`v7-4521${suffix}`, registry);
      assert.equal(parsed.base, "v7-4521", `v7-4521${suffix} did not resolve to its base`);
      assert.equal(parsed.variant?.ghgCategory, category, `v7-4521${suffix} filed under the wrong category`);
    }
  });

  it("leaves unregistered tags and an upper-case suffix as plain ids, never grouped with a base", async () => {
    const registry = await listCategoryVariants(db);
    for (const id of ["v7-4521-vcp", "v7-4521-C", "v7-4521-cd"]) {
      const parsed = parseFactorId(id, registry);
      assert.equal(parsed.variant, null, `${id} was read as a variant`);
      assert.equal(parsed.base, id);
    }
  });

  it("applies the base/variant rule to v7 ids through the real code: commuting refuses the base when its -c is on offer", async () => {
    await factor("uk-ghg-gb-2025", "4521", "88", "Bus", 0.1, ["1", "3"], "km");
    await factor("uk-ghg-gb-2025", "4521-c", "88", "Bus — commuting", 0.1, ["3"], "km");
    await factor("uk-ghg-gb-2025", "4521-vcp", "88", "Bus — legacy tag", 0.1, ["3"], "km");
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'cl','Co','active')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,'job-v7','cl',1,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,'job-v7','uk-ghg-gb-2025','automatic','Fixture','test')`, [ORG]);
    const refused = await variantBasesRefused(db, ORG, "job-v7", "3.7");
    assert.deepEqual(refused.filter((pair) => pair.baseFactorId.startsWith("v7-4521")),
      [{ baseFactorId: "v7-4521", variantFactorId: "v7-4521-c" }],
      "commuting did not refuse the base in favour of its own variant — or treated the -vcp tag as one");
  });

  // ── The guard ───────────────────────────────────────────────────────────────────────────────────────

  it("refuses to run over provenance that has already been loaded", async () => {
    await assert.rejects(() => createDisposableDatabase("v7provrefuse", {
      onMigration: async (filename, client) => {
        if (!filename.startsWith("0125_")) return;
        await client.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ('org-v7-refuse','x')`);
        await client.query(`SELECT set_config('app.organisation_id', 'org-v7-refuse', false)`);
        await client.query(
          `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence,source_system,source_family,legacy_dataset_id,content_sha256)
           VALUES ('org-v7-refuse','d','d','1','2025-01-01','2025-12-31','GB','active','DESNZ','OGL','nzi-pro-v7','uk-ghg','d',repeat('a',64))`);
        await client.query(
          `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_system,legacy_original_id,legacy_factor_id)
           VALUES ('org-v7-refuse','d','v7-1','x','kWh',0.1,ARRAY['2'],'nzi-pro-v7','1','1')`);
      },
    }), /0126 expected no imported rows yet/);
  });
});
