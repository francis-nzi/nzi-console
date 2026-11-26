import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * 0239 (PLAN-library-2026-dataset-name, approved 26 Nov), against a real database, on staging's shape: DESNZ's and NZI's 2026 editions
 * (V7 datasets 69+70) loaded under the temp file name "tmpai4mgnde.csv". The migration names them "DESNZ GHG Conversion Factors 2026"
 * — the name only: the version, which rows' provenance cites, is untouched — and touches no other dataset; run again, nothing changes.
 */
const MIGRATION = readFileSync(new URL("../migrations/0239_library_2026_dataset_name.sql", import.meta.url), "utf8");
const ORG = "m239";
const TEMP = "tmpai4mgnde.csv";
const NAME = "DESNZ GHG Conversion Factors 2026";

describe("0239: the 2026 editions are named for what they are; their version, and every other dataset, stay as they were", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const datasets = async () => (await db.query<{ dataset_id: string; name: string; version: string; content_sha256: string }>(
    `SELECT dataset_id, name, version, content_sha256 FROM nzi_console.emission_factor_datasets WHERE organisation_id = $1 ORDER BY dataset_id`, [ORG])).rows;

  before(async () => {
    database = (await createDisposableDatabase("m239"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    // Staging's shape (read 26 Nov): the two temp-named 2026 editions; 2025 under the workbook's name; a third with the temp name
    // but another V7 dataset (never touched: the migration is for 69+70 only); and a 2026 edition already correctly named elsewhere.
    for (const [ds, name, version, legacy, family, year] of [
      ["uk-ghg-gb-2026", TEMP, TEMP, "69+70", "uk-ghg", 2026], ["nzi-gb-2026", TEMP, TEMP, "69+70", "nzi", 2026],
      ["uk-ghg-gb-2025", "DESNZ DEFRA Conversion Factors 2019-2025.xlsx", "DESNZ DEFRA Conversion Factors 2019-2025.xlsx", "1+8", "uk-ghg", 2025],
      ["uk-ghg-gb-2027", TEMP, TEMP, "71+72", "uk-ghg", 2027], ["ceda-ae-2025", "ARE_United_Arab_Emirates.csv", "ARE_United_Arab_Emirates.csv", "79", "ceda", 2025],
    ] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence,
                        source_system,source_family,legacy_dataset_id,content_sha256)
                      VALUES ($1,$2,$3,$4,$5,$6,'GB','active','Test','Source: test.','nzi-pro-v7',$7,$8,$9)`,
        [ORG, ds, name, version, `${year}-01-01`, `${year}-12-31`, family, legacy, createHash("sha256").update(ds).digest("hex")]);
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("names uk-ghg-gb-2026 and nzi-gb-2026; their version stays the temp file's, as V7 recorded it (provenance)", async () => {
    const before = await datasets();
    await db.query(MIGRATION);
    const after = await datasets();
    const byId = new Map(after.map((row) => [row.dataset_id, row]));
    assert.deepEqual([byId.get("uk-ghg-gb-2026")!.name, byId.get("uk-ghg-gb-2026")!.version], [NAME, TEMP]);
    assert.deepEqual([byId.get("nzi-gb-2026")!.name, byId.get("nzi-gb-2026")!.version], [NAME, TEMP]);
    assert.deepEqual(after.map((row) => row.content_sha256), before.map((row) => row.content_sha256), "the content hash is untouched: a re-load keeps the name");
  });

  it("touches no other dataset: another year with the temp name (not V7's 69+70), the workbook-named editions, a real CEDA file name", async () => {
    const byId = new Map((await datasets()).map((row) => [row.dataset_id, row]));
    assert.deepEqual([byId.get("uk-ghg-gb-2027")!.name, byId.get("uk-ghg-gb-2025")!.name, byId.get("ceda-ae-2025")!.name],
      [TEMP, "DESNZ DEFRA Conversion Factors 2019-2025.xlsx", "ARE_United_Arab_Emirates.csv"]);
  });

  it("run again, nothing changes: it is idempotent", async () => {
    const before = await datasets();
    await db.query(MIGRATION);
    assert.deepEqual(await datasets(), before);
  });

  it("the verify queries from the plan: the new name, the version unchanged", async () => {
    const verify = (await db.query<{ dataset_id: string; name: string; version: string }>(
      `SELECT dataset_id, name, version FROM nzi_console.emission_factor_datasets WHERE organisation_id = $1 AND dataset_id IN ('uk-ghg-gb-2026','nzi-gb-2026') ORDER BY dataset_id`, [ORG])).rows;
    assert.deepEqual(verify, [{ dataset_id: "nzi-gb-2026", name: NAME, version: TEMP }, { dataset_id: "uk-ghg-gb-2026", name: NAME, version: TEMP }]);
  });
});
