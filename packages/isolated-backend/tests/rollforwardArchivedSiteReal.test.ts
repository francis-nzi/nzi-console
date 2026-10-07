import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createScopeRow, rollforwardScopeRows } from "../src/postgresCommands";
import { archiveSite, createClientSite } from "../src/siteLifecycle";

/**
 * The archived-site rule on roll-forward (ruled 6 Oct, from the #424 review): a rolled-forward row is a new row, so it
 * may not cite an archived site — the site is dropped to null, as a site that isn't the new job's client's already is.
 * A live site is carried forward unchanged.
 */
const ORG = "demo-nzi-console"; // the synthetic factor seed's organisation
const CLIENT = "client-rf";
const ACTOR = "ada";
const here = dirname(fileURLToPath(import.meta.url));

describe("roll-forward drops an archived site and carries a live one, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff", idempotencyKey: `rf-${keys}`, correlationId: `corr-rf-${keys}`,
      grant: commandGrantForRole("admin", ORG, ACTOR), ...(reason ? { reason } : {}) };
  };
  // Typed loosely: these build command inputs, and the command validates them.
  const entry = (over: Record<string, unknown> = {}): any => ({
    jobId: "job-2026", scope: "1", sourceLabel: "Boiler", reportLabel: "Boiler", categoryCode: "1.natural-gas",
    quantity: 10, unit: "kWh", datasetId: "synthetic-gb-2026", factorId: "gas-demo", factorVersion: "2026 demo v1", factorLabel: "Gas", qualityTier: "measured", ...over,
  });
  let depot = "", office = "", depotRow = "", officeRow = "";

  before(async () => {
    database = (await createDisposableDatabase("rfarchived"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Ada Admin')`, [ORG, ACTOR]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
    for (const [jobId, sequence, year] of [["job-2026", 1, 2026], ["job-2027", 2, 2027]] as const) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
         VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',$5,$6,$7)`, [ORG, jobId, CLIENT, sequence, year, `${year}-01-01`, `${year}-12-31`]);
      await db.query(
        `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`,
        [ORG, jobId, `${year}-01-01`, `${year}-12-31`]);
    }
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    office = (await createClientSite(database.pool, { clientId: CLIENT, name: "Head Office", inServiceFrom: null, isRegisteredOffice: true } as never, context())).data.siteId;
    depot = (await createClientSite(database.pool, { clientId: CLIENT, name: "Depot", inServiceFrom: null } as never, context())).data.siteId;
    depotRow = (await createScopeRow(database.pool, entry({ siteId: depot, sourceLabel: "Depot boiler" }), context())).data.rowId;
    officeRow = (await createScopeRow(database.pool, entry({ siteId: office, sourceLabel: "Office boiler" }), context())).data.rowId;
    const { rows: [site] } = await db.query<{ version: number }>(`SELECT version FROM nzi_console.client_sites WHERE site_id=$1`, [depot]);
    await archiveSite(database.pool, { siteId: depot, expectedVersion: site!.version }, context("closed"));
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("rolls both rows forward: the archived depot dropped to null, the live office kept; the prior year untouched", async () => {
    const done = await rollforwardScopeRows(database.pool, { jobId: "job-2027", priorJobId: "job-2026", rowIds: [depotRow, officeRow] }, context());
    assert.equal(done.data.rolledForward, 2);
    const { rows } = await db.query<{ rolled_forward_from_row_id: string; site_id: string | null }>(
      `SELECT rolled_forward_from_row_id, site_id FROM nzi_console.job_scope_rows WHERE job_id='job-2027'`);
    const siteOf = (prior: string) => rows.find((row) => row.rolled_forward_from_row_id === prior)!.site_id;
    assert.equal(siteOf(depotRow), null, "the archived depot is not carried into the new year");
    assert.equal(siteOf(officeRow), office, "a live site is carried forward");
    const { rows: prior } = await db.query<{ scope_row_id: string; site_id: string }>(`SELECT scope_row_id, site_id FROM nzi_console.job_scope_rows WHERE job_id='job-2026' ORDER BY source_label`);
    assert.deepEqual(prior.map((row) => row.site_id), [depot, office], "the prior year's rows keep their sites, archived or not");
  });
});
