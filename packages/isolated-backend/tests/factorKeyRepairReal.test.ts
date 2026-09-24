import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * 0122 repairs scope rows the CRM quick-add stored with its option key as the factor id (NZC-162's defect).
 *
 * The form sent `dataset:<dataset>|<factor>` (or `client:<client factor>|<factor>`) as the factor id, so those rows
 * were stored and never calculated. 0122 rewrites each to the factor's own id **only** where the key agrees with
 * the row it sits on — the dataset part is the row's own dataset and the factor exists in it; the client part is
 * the row's own client factor. Anything else key-shaped is refused, and the migration stops rather than guess.
 *
 * **At cutover, an abort is the design working.** If migrated client data holds a key-shaped factor id that does
 * not agree with its own row — a dataset or client factor other than the row's, or a factor its dataset does not
 * carry — 0122 stops the deploy with a count and changes nothing. That is not a failed migration: it is the repair
 * refusing to choose a factor for somebody. Establish what each of those rows was meant to be, correct them, and
 * the repair then runs clean. (Recorded here rather than in 0122 because a migration is frozen once it is open in
 * a pull request, and 0122 was.)
 *
 * The rows are put in place *before* 0122 runs — the harness's hook after 0121 — because a repair is only proved
 * against rows that existed when it ran. Two organisations, because the table's row-level security is forced: a
 * repair that ran without a tenant context would see nothing and report success, which is the shape to rule out.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORGS = ["org-kr-a", "org-kr-b"];

/** A tenant's fixture: a dataset, two factors, a client factor, a job — enough for a row to be repairable. */
/** Job sequences are one global counter (NZC-025), so each seeded job takes the next. */
let sequence = 0;

async function seedTenant(admin: pg.Client, org: string) {
  sequence += 1;
  await admin.query(`SELECT set_config('app.organisation_id', $1, false)`, [org]);
  await admin.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [org]);
  await admin.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client','Co','active')`, [org]);
  await admin.query(
    `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage)
     VALUES ($1,'job','client',$2,'crp','CRP','open','Data entry')`, [org, sequence]);
  await admin.query(
    `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
     VALUES ($1,'ds','Synthetic','v1','2026-01-01','2026-12-31','GB','active','Test','Test')`, [org]);
  await admin.query(
    `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
     VALUES ($1,'ds','elec','Electricity','kWh',0.3,ARRAY['2']), ($1,'ds','gas','Gas','kWh',0.18,ARRAY['1'])`, [org]);
  await admin.query(
    `INSERT INTO nzi_console.client_factors (organisation_id,client_factor_id,client_id,scope,report_label,unit,kgco2e_per_unit,vintage_year,created_by)
     VALUES ($1,'cf','client','3.1','Panel EPD','m²',1.2,2025,'test')`, [org]);
}

const row = (admin: pg.Client, org: string, id: string, scope: string, factorId: string | null, over: { dataset?: string | null; source?: string; clientFactor?: string | null } = {}) =>
  admin.query(
    `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,factor_id,dataset_id,factor_source,client_factor_id,is_custom_entry)
     VALUES ($1,$2,'job',$3,'Entry','Entry','Scope x','x',$4,$5,$6,$7,$6 = 'client')`,
    [org, id, scope, factorId, over.dataset === undefined ? "ds" : over.dataset, over.source ?? "dataset", over.clientFactor ?? null]);

describe("0122 repairs factor ids stored as the form's option key, and refuses what it cannot be sure of", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("keyrepair", {
      onMigration: async (filename, client) => {
        if (!filename.startsWith("0121_")) return;
        for (const org of ORGS) {
          await seedTenant(client, org);
          await row(client, org, "keyed-dataset", "2", "dataset:ds|elec");
          await row(client, org, "keyed-client", "3.1", "client:cf|panel", { dataset: null, source: "client", clientFactor: "cf" });
          await row(client, org, "already-bare", "1", "gas");
          await row(client, org, "no-factor", "1", null, { dataset: null });
        }
      },
    }))!;
    admin = await database.admin();
  });

  after(async () => { await admin?.end(); await database?.end(); });

  const read = async (org: string, id: string) => {
    await admin.query(`SELECT set_config('app.organisation_id', $1, false)`, [org]);
    return (await admin.query<{ factor_id: string | null; version: number; calculated_tco2e: string | null; provenance_json: Record<string, any> }>(
      `SELECT factor_id, version, calculated_tco2e, provenance_json FROM nzi_console.job_scope_rows WHERE organisation_id=$1 AND scope_row_id=$2`, [org, id])).rows[0]!;
  };

  it("rewrites a dataset key to the factor's own id, in every organisation", async () => {
    for (const org of ORGS) {
      const repaired = await read(org, "keyed-dataset");
      assert.equal(repaired.factor_id, "elec", `${org}'s key was not repaired — a repair that saw no tenant would look exactly like this`);
      assert.equal(repaired.provenance_json.factorIdRepair?.was, "dataset:ds|elec", "the repair left no record of what it replaced");
      assert.equal(repaired.provenance_json.factorIdRepair?.by, "migration:0122");
      assert.equal(repaired.version, 2, "the repair did not bump the row's version");
    }
  });

  it("rewrites a client-factor key to the factor's own id", async () => {
    for (const org of ORGS) assert.equal((await read(org, "keyed-client")).factor_id, "panel");
  });

  it("calculates nothing, so no reported number moves", async () => {
    for (const org of ORGS) {
      for (const id of ["keyed-dataset", "keyed-client"]) assert.equal((await read(org, id)).calculated_tco2e, null);
    }
  });

  it("leaves rows that were never keys exactly as they were", async () => {
    for (const org of ORGS) {
      const bare = await read(org, "already-bare");
      assert.equal(bare.factor_id, "gas");
      assert.equal(bare.version, 1);
      assert.equal("factorIdRepair" in bare.provenance_json, false);
      assert.equal((await read(org, "no-factor")).factor_id, null);
    }
  });

  // ── Refusals: each in a database of its own, because a refusal stops the migration run ─────────────

  const refusedWith = async (suite: string, seed: (client: pg.Client) => Promise<unknown>) => {
    await assert.rejects(() => createDisposableDatabase(suite, {
      onMigration: async (filename, client) => {
        if (!filename.startsWith("0121_")) return;
        await seedTenant(client, "org-kr-refuse");
        await seed(client);
      },
    }), /0122/);
  };

  it("refuses a dataset key naming a dataset other than the row's own", async () => {
    await refusedWith("keyrefuseds", (client) => row(client, "org-kr-refuse", "mismatch", "2", "dataset:other|elec"));
  });

  it("refuses a dataset key naming a factor its dataset does not carry", async () => {
    await refusedWith("keyrefusefx", (client) => row(client, "org-kr-refuse", "missing", "2", "dataset:ds|nuclear"));
  });

  it("refuses a client key naming a client factor other than the row's own", async () => {
    await refusedWith("keyrefusecf", (client) => row(client, "org-kr-refuse", "wrongcf", "3.1", "client:other|panel", { dataset: null, source: "client", clientFactor: "cf" }));
  });
});
