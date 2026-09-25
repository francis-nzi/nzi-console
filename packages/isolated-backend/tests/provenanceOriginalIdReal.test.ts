import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { parseFactorId } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { variantBasesRefused } from "../src/declarativeResolution";
import { listCategoryVariants } from "../src/factorCategoryVariants";

/**
 * v7 provenance (0126): each value row points back at its factor_lookup row, each identity is one source code within
 * one source family, and v7's ten suffixes are the console's category variants (REFERENCE_DATA_DESIGN §3–4).
 *
 * Ids are minted as `<family>-<normalised original_id>`, as the import mints them: the same code in two families is two
 * factors (ICE's bare "1" is not SWC's "1"). The first half is the keys; the second is the id shape read against the
 * registry the migrations actually build, and the base/variant rule working on those ids through the real code.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-v7";

describe("v7 provenance by factor_lookup row and source code, and v7 suffixes as category variants (0126)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let dbId = 1000;

  const dataset = (id: string, year: number, family: string, country = "GB") => db.query(
    `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence,source_system,source_family,legacy_dataset_id,content_sha256)
     VALUES ($1,$2,$2,$3,$4,$5,$7,'active','Source','Source: test.','nzi-pro-v7',$6,$2,repeat('a',64))`,
    [ORG, id, String(year), `${year}-01-01`, `${year}-12-31`, family, country]);
  /** A factor_lookup row as the import writes it: the family-prefixed id, the code verbatim, its own db_id. */
  const factor = (datasetId: string, family: string, originalId: string, label: string,
    options: { value?: number; scopes?: string[]; unit?: string; id?: string; lookupRow?: string } = {}) => db.query(
    `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_system,legacy_original_id,legacy_db_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'nzi-pro-v7',$8,$9)`,
    [ORG, datasetId, options.id ?? `${family}-${originalId}`, label, options.unit ?? "passenger.km", options.value ?? 0.2,
      options.scopes ?? ["3"], originalId, options.lookupRow ?? String(dbId++)]);
  const identity = async (factorId: string) => (await db.query<{ source_family: string; legacy_original_id: string; legacy_db_id: string }>(
    `SELECT source_family, legacy_original_id, legacy_db_id FROM nzi_console.factor_identities WHERE factor_id=$1`, [factorId])).rows;

  before(async () => {
    database = (await createDisposableDatabase("v7provenance"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await dataset("uk-ghg-gb-2024", 2024, "uk-ghg");
    await dataset("uk-ghg-gb-2025", 2025, "uk-ghg");
    await dataset("uk-ghg-ie-2025", 2025, "uk-ghg", "IE");
    await dataset("ice-global-2025", 2025, "ice", "GLOBAL");
    await dataset("swc-gb-2025", 2025, "swc");
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── The keys ────────────────────────────────────────────────────────────────────────────────────────

  it("loads several codes in one dataset, each pointing back at its own factor_lookup row", async () => {
    for (const [code, value] of [["21_316_3178_11_1", 0.14], ["21_316_3178_12_1", 0.24], ["21_316_3178_13_1", 0.43]] as const) {
      await factor("uk-ghg-gb-2025", "uk-ghg", code, `Flight ${code}`, { value });
    }
    const loaded = await db.query<{ legacy_db_id: string }>(`SELECT legacy_db_id FROM nzi_console.emission_factors WHERE dataset_id='uk-ghg-gb-2025'`);
    assert.equal(loaded.rows.length, 3);
    assert.equal(new Set(loaded.rows.map((row) => row.legacy_db_id)).size, 3, "two value rows claim the same factor_lookup row");
  });

  it("refuses a second id for one code in one dataset, and one factor_lookup row landing twice", async () => {
    await assert.rejects(() => factor("uk-ghg-gb-2025", "uk-ghg", "21_316_3178_11_1", "Renamed", { id: "uk-ghg-renamed" }),
      /(emission_factors|factor_identities)_legacy_original_key/, "a second id claiming the same code in one dataset was accepted");
    await assert.rejects(() => factor("uk-ghg-gb-2024", "uk-ghg", "21_316_3178_99_1", "Same lookup row", { lookupRow: "1000" }),
      /emission_factors_legacy_db_key/, "one factor_lookup row landed as two value rows");
  });

  it("keeps one code as one identity across the years and countries of its family", async () => {
    await factor("uk-ghg-gb-2024", "uk-ghg", "21_316_3178_11_1", "Flight (2024 wording)", { value: 0.16 });
    await factor("uk-ghg-ie-2025", "uk-ghg", "21_316_3178_11_1", "Flight (IE)", { value: 0.14 });
    const found = await identity("uk-ghg-21_316_3178_11_1");
    assert.equal(found.length, 1, "one code became more than one identity");
    assert.equal(found[0]!.source_family, "uk-ghg");
    assert.equal(found[0]!.legacy_original_id, "21_316_3178_11_1", "the identity does not carry the code, verbatim");
    assert.equal(found[0]!.legacy_db_id, "1000", "the identity does not point back at the first lookup row that carried it");
  });

  it("keeps the same code in two families as two identities — ICE's 1 is not SWC's 1", async () => {
    await factor("ice-global-2025", "ice", "1", "ICE material 1", { unit: "kg" });
    await factor("swc-gb-2025", "swc", "1", "SWC item 1", { unit: "GBP" });
    assert.deepEqual((await identity("ice-1")).map((row) => row.source_family), ["ice"]);
    assert.deepEqual((await identity("swc-1")).map((row) => row.source_family), ["swc"]);
  });

  it("refuses a factor under another family's identity, and writes nothing", async () => {
    await assert.rejects(() => factor("swc-gb-2025", "swc", "21_316_3178_11_1", "Not the same factor", { id: "uk-ghg-21_316_3178_11_1" }),
      /uk-ghg-21_316_3178_11_1 belongs to source family uk-ghg and cannot also come from swc.*one family per identity/);
    const landed = await db.query(`SELECT 1 FROM nzi_console.emission_factors WHERE dataset_id='swc-gb-2025' AND factor_id='uk-ghg-21_316_3178_11_1'`);
    assert.equal(landed.rows.length, 0, "the refused factor was written anyway");
  });

  it("refuses an imported identity or factor that does not say which code, which family and which lookup row", async () => {
    await assert.rejects(() => db.query(
      `INSERT INTO nzi_console.factor_identities (organisation_id,factor_id,label,source_label,source_system,source_family,created_by)
       VALUES ($1,'uk-ghg-orphan','x','x','nzi-pro-v7','uk-ghg','test')`, [ORG]), /factor_identity_provenance_shape/);
    await assert.rejects(() => db.query(
      `INSERT INTO nzi_console.factor_identities (organisation_id,factor_id,label,source_label,source_system,legacy_original_id,created_by)
       VALUES ($1,'uk-ghg-nofamily','x','x','nzi-pro-v7','nofamily','test')`, [ORG]), /factor_identity_provenance_shape/);
    await assert.rejects(() => db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_system,legacy_original_id)
       VALUES ($1,'uk-ghg-gb-2025','uk-ghg-norow','x','kWh',0.1,ARRAY['2'],'nzi-pro-v7','norow')`, [ORG]),
      /emission_factor_provenance_shape/);
  });

  // ── The id shape, read against the registry the migrations build ─────────────────────────────────────

  it("reads a family-prefixed id as a base, and each of v7's ten suffixes as its category's variant, across scopes", async () => {
    const registry = await listCategoryVariants(db);
    for (const id of ["uk-ghg-1_101_1011_8_1", "ice-1", "iea-puerto-rico", "uk-ghg-SPEND-SIC-49.3-5"]) {
      assert.equal(parseFactorId(id, registry).variant, null, `${id} was read as a variant`);
    }
    // Francis's authoritative map: five Scope 3 categories, four Scope 1 company-vehicle sub-types, one more 3.6.
    const expected: Record<string, string> = {
      "-b": "3.6", "-c": "3.7", "-d": "3.9", "-p": "3.1", "-u": "3.4",
      "-vcd": "1", "-vcp": "1", "-vh": "1", "-vvd": "1", "-bcp": "3.6",
    };
    for (const [suffix, category] of Object.entries(expected)) {
      const parsed = parseFactorId(`uk-ghg-1_101_1011_8_1${suffix}`, registry);
      assert.equal(parsed.base, "uk-ghg-1_101_1011_8_1", `…${suffix} did not resolve to its base`);
      assert.equal(parsed.variant?.ghgCategory, category, `…${suffix} filed under the wrong category`);
    }
    assert.equal(parseFactorId("uk-ghg-SPEND-SIC-49.3-5-u", registry).base, "uk-ghg-SPEND-SIC-49.3-5");
  });

  it("leaves an unregistered tag and an upper-case suffix as plain ids, never grouped with a base", async () => {
    const registry = await listCategoryVariants(db);
    for (const id of ["uk-ghg-4521-xyz", "uk-ghg-4521-C", "uk-ghg-4521-VCP", "uk-ghg-4521-cd"]) {
      const parsed = parseFactorId(id, registry);
      assert.equal(parsed.variant, null, `${id} was read as a variant`);
      assert.equal(parsed.base, id);
    }
  });

  it("applies the base/variant rule to v7 ids through the real code: commuting refuses the base when its -c is on offer", async () => {
    await factor("uk-ghg-gb-2025", "uk-ghg", "4521", "Bus", { value: 0.1, scopes: ["1", "3"], unit: "km" });
    await factor("uk-ghg-gb-2025", "uk-ghg", "4521-c", "Bus — commuting", { value: 0.1, unit: "km" });
    await factor("uk-ghg-gb-2025", "uk-ghg", "4521-vcp", "Bus — petrol car company vehicle", { value: 0.1, scopes: ["1"], unit: "km" });
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'cl','Co','active')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,'job-v7','cl',1,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,'job-v7','uk-ghg-gb-2025','automatic','Fixture','test')`, [ORG]);
    const refused = await variantBasesRefused(db, ORG, "job-v7", "3.7");
    assert.deepEqual(refused.filter((pair) => pair.baseFactorId.startsWith("uk-ghg-4521")),
      [{ baseFactorId: "uk-ghg-4521", variantFactorId: "uk-ghg-4521-c" }],
      "commuting did not refuse the base in favour of its own -c variant — or refused it for another category's variant");
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
        // 0125's shape: legacy_factor_id, as a load run before 0126 would have written it.
        await client.query(
          `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_system,legacy_original_id,legacy_factor_id)
           VALUES ('org-v7-refuse','d','uk-ghg-1','x','kWh',0.1,ARRAY['2'],'nzi-pro-v7','1','1')`);
      },
    }), /0126 expected no imported rows yet/);
  });
});
