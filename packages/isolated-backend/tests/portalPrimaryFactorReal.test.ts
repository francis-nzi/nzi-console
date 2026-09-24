import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { roleCapabilityGrants } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { listPortalDataEntryBuckets, setPortalDataEntryBucketGrant } from "../src/portalDataEntry";
import type { PortalPrincipal, StaffPrincipal } from "../src/index";

/**
 * Whether a portal electricity bucket can carry the T&D factor at all (NZC-160 H1).
 *
 * Stop 1 reported that under byte-order collation an electricity bucket granted both electricity factors
 * defaults to T&D. That allow-list was built by hand. This asks the real grant command whether it can exist.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "demo-nzi-console";
const CLIENT = "client-h1";
const JOB = "job-h1";
const USER = "portal-h1";
const here = dirname(fileURLToPath(import.meta.url));

const staff: StaffPrincipal = {
  organisationId: ORG, userId: "staff-h1", sessionId: "s", issuedAt: 1, expiresAt: 2,
  role: "admin", matrixVersion: 1, capabilities: roleCapabilityGrants("admin"),
} as StaffPrincipal;
const portal = {
  principal: "portal", organisationId: ORG, userId: USER, clientId: CLIENT, sessionId: "p",
  issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid",
} as unknown as PortalPrincipal;

describe("the portal's electricity allow-list and the T&D factor (H1)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("portalh1"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,'staff-h1','admin','active')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, JOB]);
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    for (const [id, scope, category] of [["row-elec", "2", "2.purchased-electricity"], ["row-td", "3.3", "3.3"]]) {
      await db.query(
        `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code)
         VALUES ($1,$2,$3,$4,'Electricity','Electricity','Scope x','x',$5)`, [ORG, id, JOB, scope, category]);
    }
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,status) VALUES ($1,$2,$3,'active')`, [ORG, USER, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at)
       VALUES ($1,'grant-h1',$2,$3,$4,now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, USER, JOB]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("refuses to grant the T&D factor on a Scope 2 row, through the command staff actually use", async () => {
    await assert.rejects(
      () => setPortalDataEntryBucketGrant(database.pool, staff, {
        portalUserId: USER, jobId: JOB, scopeRowId: "row-elec", entryKind: "manual_activity",
        factorIds: ["electricity-demo", "electricity-td-demo"], siteIds: [],
      }),
      /compatible with the scope row/);
  });

  it("PINNED DEFECT: a valid grant fails at its own audit insert, so the command has never granted a bucket", async () => {
    // A legitimate grant — the T&D factor on a 3.3 row — passes every check and then dies writing its audit
    // event: `jsonb_build_object('portalUserId',$5,…)` passes parameters Postgres cannot type. The fake-pool
    // unit tests cannot see this. When the defect is fixed this assertion fails, and should be replaced by
    // the scope-edit probe it was blocking (a bucket granted on 3.3 whose row is later edited to Scope 2).
    await assert.rejects(
      () => setPortalDataEntryBucketGrant(database.pool, staff, {
        portalUserId: USER, jobId: JOB, scopeRowId: "row-td", entryKind: "manual_activity",
        factorIds: ["electricity-td-demo"], siteIds: [],
      }),
      /could not determine data type of parameter/);

    // And it rolls back whole, so nothing half-granted is left for the portal to list.
    const left = await db.query(`SELECT count(*)::int AS n FROM nzi_console.portal_data_entry_bucket_grants`);
    assert.equal(left.rows[0]!.n, 0);
    assert.deepEqual(await listPortalDataEntryBuckets(database.pool, portal, JOB), []);
  });
});
