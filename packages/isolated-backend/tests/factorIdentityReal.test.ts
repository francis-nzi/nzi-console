import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, listScopeRows, setClientFactorAlias, withTenantRead } from "../src/index";
import { listJobFactorOptions } from "../src/readModels";

/**
 * A factor's curated identity is held once and applies to every edition of it (0125, REFERENCE_DATA_DESIGN §2–4, §6).
 *
 * Two organisations each hold a 2025 and a 2026 edition of the same factors, with client aliases in every state the
 * fold has to handle — all put in place *before* 0125 runs, through the harness's hook after 0124, because a migration
 * that folds data is only proved against data that existed before it. Then, on the migrated database: curate once and
 * see it in both editions; a later edition never overwrites a curation; a calculated row keeps the wording it was
 * calculated with; an alias written against one edition names the factor in every edition; the view keeps each tenant
 * to its own rows; and an identity cannot be deleted.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORGS = ["org-fi-a", "org-fi-b"] as const;
const CLIENT = "client-fi";
const ACTOR = "admin-fi";
let sequence = 0;

/** A tenant as it stood before 0125: two editions of each factor, a job in each year, and aliases keyed by dataset. */
async function seedTenant(client: pg.Client, org: string) {
  await client.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [org]);
  await client.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
  await client.query(`SELECT set_config('app.organisation_id', $1, false)`, [org]);
  await client.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [org, CLIENT]);
  await client.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`, [org, ACTOR]);
  for (const year of [2025, 2026]) {
    const dataset = `ds-${year}`, job = `job-${year}`;
    await client.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,$2,$2,$3,$4,$5,'GB','active','Test source','OGL')`, [org, dataset, String(year), `${year}-01-01`, `${year}-12-31`]);
    for (const factor of ["f-shared", "f-both", "f-old", "f-plain"]) {
      await client.query(
        `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
         VALUES ($1,$2,$3,$4,'kWh',0.2,ARRAY['2'])`, [org, dataset, factor, `${factor} (${year} wording)`]);
    }
    sequence += 1;
    await client.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',$5,$6,$7)`, [org, job, CLIENT, sequence, year, `${year}-01-01`, `${year}-12-31`]);
    await client.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`,
      [org, job, `${year}-01-01`, `${year}-12-31`]);
    await client.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,'automatic','Fixture',$4)`,
      [org, job, dataset, ACTOR]);
    for (const factor of ["f-shared", "f-plain"]) {
      await client.query(
        `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,quality_tier,dataset_id,factor_id,factor_label,factor_version)
         VALUES ($1,$2,$3,'2','Meter','Meter','Scope 2','Electricity',1000,'kWh','measured',$4,$5,$6,$7)`,
        [org, `${factor}-${year}`, job, dataset, factor, `${factor} (${year} wording)`, String(year)]);
    }
  }
  const alias = (dataset: string, factor: string, label: string, active: boolean) => client.query(
    `INSERT INTO nzi_console.client_factor_aliases (organisation_id,client_id,dataset_id,factor_id,label,active,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [org, CLIENT, dataset, factor, label, active, ACTOR]);
  await alias("ds-2025", "f-shared", "Office power", true);            // named against 2025 only
  await alias("ds-2025", "f-both", "Site power", true);                // the same name in both editions — folds to one
  await alias("ds-2026", "f-both", "Site power", true);
  await alias("ds-2025", "f-old", "Old name", false);                  // a withdrawn name, and the name in force
  await alias("ds-2026", "f-old", "Current name", true);
}

describe("a factor's curated identity, held once for every edition (0125)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (org: string) => {
    keys += 1;
    return { organisationId: org, actorId: ACTOR, principal: "staff" as const, idempotencyKey: `fi-${keys}`,
      correlationId: `corr-fi-${keys}`, grant: commandGrantForRole("admin", org, ACTOR) };
  };
  const [A, B] = ORGS;
  const read = <T>(org: string, run: (reader: any) => Promise<T>) => withTenantRead(database.pool, org, run);
  const optionLabel = async (org: string, job: string, factor: string) =>
    ((await read(org, (reader) => listJobFactorOptions(reader, job))) as any[]).find((option) => option.factorId === factor)?.label;
  const reportLabel = async (org: string, job: string, rowId: string) =>
    ((await read(org, (reader) => listScopeRows(reader, job))) as any[]).find((row) => row.id === rowId)?.reportLabel;
  const curate = (org: string, factor: string, fields: { label?: string; reportLabel?: string }) => db.query(
    `UPDATE nzi_console.factor_identities
        SET label=coalesce($3,label), report_label=coalesce($4,report_label), version=version+1, curated_by=$5, curated_at=now()
      WHERE organisation_id=$1 AND factor_id=$2`, [org, factor, fields.label ?? null, fields.reportLabel ?? null, ACTOR]);

  before(async () => {
    database = (await createDisposableDatabase("factoridentity", {
      onMigration: async (filename, client) => {
        if (!filename.startsWith("0124_")) return;
        for (const org of ORGS) await seedTenant(client, org);
      },
    }))!;
    db = await database.admin();
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── What 0125 did to the data that was already there ─────────────────────────────────────────────────

  it("gives every existing factor exactly one identity, in every organisation, named as its latest edition names it", async () => {
    const orphans = await db.query(`SELECT 1 FROM nzi_console.emission_factors f
      WHERE NOT EXISTS (SELECT 1 FROM nzi_console.factor_identities i WHERE (i.organisation_id,i.factor_id)=(f.organisation_id,f.factor_id))`);
    assert.equal(orphans.rows.length, 0, "a factor was left without an identity");
    for (const org of ORGS) {
      const identity = (await db.query<{ label: string; source_label: string; created_by: string }>(
        `SELECT label, source_label, created_by FROM nzi_console.factor_identities WHERE organisation_id=$1 AND factor_id='f-shared'`, [org])).rows;
      assert.equal(identity.length, 1, `${org} has ${identity.length} identities for one factor`);
      assert.equal(identity[0]!.label, "f-shared (2026 wording)");
      assert.equal(identity[0]!.source_label, "f-shared (2026 wording)");
      assert.equal(identity[0]!.created_by, "migration:0125");
    }
  });

  it("folds each client's aliases to one per factor, keeping the name in force", async () => {
    for (const org of ORGS) {
      const aliases = (await db.query<{ factor_id: string; label: string; active: boolean }>(
        `SELECT factor_id, label, active FROM nzi_console.client_factor_aliases WHERE organisation_id=$1 ORDER BY factor_id`, [org])).rows;
      assert.deepEqual(aliases, [
        { factor_id: "f-both", label: "Site power", active: true },
        { factor_id: "f-old", label: "Current name", active: true },
        { factor_id: "f-shared", label: "Office power", active: true },
      ]);
    }
  });

  it("applies an alias written against 2025 to the 2026 row too — which it silently did not before", async () => {
    assert.equal(await reportLabel(A, "job-2025", "f-shared-2025"), "Office power");
    assert.equal(await reportLabel(A, "job-2026", "f-shared-2026"), "Office power", "the 2026 row lost the client's name");
  });

  // ── Curation ─────────────────────────────────────────────────────────────────────────────────────────

  it("shows a curated label in every edition once it is curated once", async () => {
    await curate(A, "f-plain", { label: "Purchased Goods and Services", reportLabel: "Purchased goods and services" });
    assert.equal(await optionLabel(A, "job-2025", "f-plain"), "Purchased Goods and Services");
    assert.equal(await optionLabel(A, "job-2026", "f-plain"), "Purchased Goods and Services");
    // The other tenant's identity is its own.
    assert.equal(await optionLabel(B, "job-2025", "f-plain"), "f-plain (2026 wording)");
  });

  it("prints the curated report wording on a row nobody renamed, in every edition, and gives way to the client's name", async () => {
    assert.equal(await reportLabel(A, "job-2025", "f-plain-2025"), "Purchased goods and services");
    assert.equal(await reportLabel(A, "job-2026", "f-plain-2026"), "Purchased goods and services");
    await curate(A, "f-shared", { reportLabel: "Electricity" });
    assert.equal(await reportLabel(A, "job-2026", "f-shared-2026"), "Office power", "the client's own name lost to NZI's wording");
  });

  it("keeps a curation when a later edition of the factor arrives with the source's own wording", async () => {
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [A]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'ds-2027','ds-2027','2027','2027-01-01','2027-12-31','GB','active','Test source','OGL')`, [A]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'ds-2027','f-plain','Purchased goods & services (2027 wording)','kWh',0.2,ARRAY['2'])`, [A]);
    const identity = (await db.query<{ label: string }>(
      `SELECT label FROM nzi_console.factor_identities WHERE organisation_id=$1 AND factor_id='f-plain'`, [A])).rows[0]!;
    assert.equal(identity.label, "Purchased Goods and Services", "a new edition overwrote NZI's curation");
    const edition = (await db.query<{ edition_label: string }>(
      `SELECT edition_label FROM nzi_console.emission_factors_display WHERE organisation_id=$1 AND dataset_id='ds-2027' AND factor_id='f-plain'`, [A])).rows[0]!;
    assert.equal(edition.edition_label, "Purchased goods & services (2027 wording)", "the source's own wording for the edition was lost");
  });

  it("gives a brand-new factor an identity of its own, so every writer keeps working", async () => {
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [A]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'ds-2027','f-new','Brand new','kWh',0.1,ARRAY['2'])`, [A]);
    const identity = (await db.query<{ label: string; created_by: string }>(
      `SELECT label, created_by FROM nzi_console.factor_identities WHERE organisation_id=$1 AND factor_id='f-new'`, [A])).rows[0]!;
    assert.deepEqual(identity, { label: "Brand new", created_by: "factor-insert" });
  });

  it("calculates with the curated label, and a later curation does not reword a calculated row", async () => {
    const row = (await db.query<{ version: number }>(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id='f-plain-2026' AND organisation_id=$1`, [A])).rows[0]!;
    await calculateScopeRow(database.pool, { jobId: "job-2026", rowId: "f-plain-2026", expectedVersion: row.version }, context(A));
    const calculated = async () => (await db.query<{ factor_label: string; calculated_tco2e: string }>(
      `SELECT factor_label, calculated_tco2e::text FROM nzi_console.job_scope_rows WHERE scope_row_id='f-plain-2026' AND organisation_id=$1`, [A])).rows[0]!;
    assert.equal((await calculated()).factor_label, "Purchased Goods and Services");
    assert.equal(Number((await calculated()).calculated_tco2e), 0.2, "the value moved — curation is wording, never measurement");
    await curate(A, "f-plain", { label: "Renamed later" });
    assert.equal((await calculated()).factor_label, "Purchased Goods and Services", "a calculated row reworded itself after the fact");
  });

  it("sets a client's name for the factor once, for every edition, through the command", async () => {
    await setClientFactorAlias(database.pool, { clientId: CLIENT, factorId: "f-plain", label: "Our supplies" }, context(A));
    assert.equal(await reportLabel(A, "job-2025", "f-plain-2025"), "Our supplies");
    assert.equal(await reportLabel(A, "job-2026", "f-plain-2026"), "Our supplies");
  });

  // ── Tenancy and permanence ───────────────────────────────────────────────────────────────────────────

  it("keeps each tenant to its own rows through the view, as the application role", async () => {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE nzi_console_app");
      await db.query(`SELECT set_config('app.organisation_id', $1, true)`, [B]);
      const seen = (await db.query<{ organisation_id: string; n: number }>(
        `SELECT organisation_id, count(*)::int AS n FROM nzi_console.emission_factors_display GROUP BY 1`)).rows;
      assert.deepEqual(seen.map((row) => row.organisation_id), [B], "the view showed another tenant's factors");
    } finally { await db.query("ROLLBACK"); }
  });

  it("cannot delete an identity — the application role holds no such grant", async () => {
    const granted = (await db.query<{ granted: boolean }>(
      `SELECT has_table_privilege('nzi_console_app','nzi_console.factor_identities','DELETE') AS granted`)).rows[0]!.granted;
    assert.equal(granted, false);
  });

  // ── Refusal: a database of its own, because a refusal stops the migration run ───────────────────────

  it("refuses to fold, naming them, when one client's names for one factor disagree between editions", async () => {
    await assert.rejects(() => createDisposableDatabase("factoridrefuse", {
      onMigration: async (filename, client) => {
        if (!filename.startsWith("0124_")) return;
        await seedTenant(client, "org-fi-refuse");
        await client.query(`UPDATE nzi_console.client_factor_aliases SET label='Other name' WHERE organisation_id='org-fi-refuse' AND dataset_id='ds-2026' AND factor_id='f-both'`);
      },
    }), /0125 cannot fold client aliases.*f-both/);
  });
});
