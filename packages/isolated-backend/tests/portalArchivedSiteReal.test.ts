import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, roleCapabilityGrants, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { listPortalDataEntryBuckets, setPortalDataEntryBucketGrant } from "../src/portalDataEntry";
import { archiveSite, createClientSite, unarchiveSite } from "../src/siteLifecycle";
import type { PortalPrincipal, StaffPrincipal } from "../src/index";

/**
 * An archived site is not offered on the client portal (ruled 6 Oct, from the #424 review), as it is not offered in the
 * staff pickers (Phase 1a): a bucket grant made before the archive stops listing the site, a grant cannot authorise an
 * archived site, and unarchiving offers it again. The grant keeps the site id, so nothing is lost.
 */
const ORG = "demo-nzi-console"; // the synthetic factor seed's organisation
const CLIENT = "client-pa";
const JOB = "job-pa";
const USER = "portal-pa";
const STAFF = "staff-pa";
const here = dirname(fileURLToPath(import.meta.url));

const staff: StaffPrincipal = {
  organisationId: ORG, userId: STAFF, sessionId: "s", issuedAt: 1, expiresAt: 2,
  role: "admin", matrixVersion: 1, capabilities: roleCapabilityGrants("admin"),
} as StaffPrincipal;
const portal = {
  principal: "portal", organisationId: ORG, userId: USER, clientId: CLIENT, sessionId: "p",
  issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid",
} as unknown as PortalPrincipal;

describe("an archived site is not offered on the portal, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `pa-${keys}`, correlationId: `corr-pa-${keys}`,
      grant: commandGrantForRole("admin", ORG, STAFF), ...(reason ? { reason } : {}) };
  };
  const grant = (siteIds: string[]) => setPortalDataEntryBucketGrant(database.pool, staff, {
    portalUserId: USER, jobId: JOB, scopeRowId: "row-gas", entryKind: "manual_activity", factorIds: ["gas-demo"], siteIds,
  });
  const offered = async () => (await listPortalDataEntryBuckets(database.pool, portal, JOB))
    .find((bucket) => bucket.scopeRowId === "row-gas")!.sites.map((site) => site.name);
  const siteVersion = async (siteId: string) => (await db.query<{ version: number }>(`SELECT version FROM nzi_console.client_sites WHERE site_id=$1`, [siteId])).rows[0]!.version;
  let office = "", depot = "";

  before(async () => {
    database = (await createDisposableDatabase("portalarchived"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Staff')`, [ORG, STAFF]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, JOB]);
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    await db.query(
      `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code)
       VALUES ($1,'row-gas',$2,'1','Gas','Gas','Scope 1','Gas','1.natural-gas')`, [ORG, JOB]);
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,status) VALUES ($1,$2,$3,'active')`, [ORG, USER, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at)
       VALUES ($1,'grant-pa',$2,$3,$4,now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, USER, JOB]);
    office = (await createClientSite(database.pool, { clientId: CLIENT, name: "Head Office", inServiceFrom: null, isRegisteredOffice: true } as never, context())).data.siteId;
    depot = (await createClientSite(database.pool, { clientId: CLIENT, name: "Depot", inServiceFrom: null } as never, context())).data.siteId;
    await grant([office, depot]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("offers both sites while both are in use", async () => {
    assert.deepEqual(await offered(), ["Depot", "Head Office"]);
  });

  it("stops offering a site archived after it was granted, and keeps it on the grant", async () => {
    await archiveSite(database.pool, { siteId: depot, expectedVersion: await siteVersion(depot) }, context("closed"));
    assert.deepEqual(await offered(), ["Head Office"]);
    const { rows: [bucket] } = await db.query<{ allowed_site_ids: string[] }>(`SELECT allowed_site_ids FROM nzi_console.portal_data_entry_bucket_grants WHERE scope_row_id='row-gas'`);
    assert.deepEqual([...bucket!.allowed_site_ids].sort(), [depot, office].sort(), "the grant is not rewritten");
  });

  it("refuses to authorise an archived site on a grant", async () => {
    await assert.rejects(() => grant([office, depot]), /archived site cannot be authorised/);
    await grant([office]);
    assert.deepEqual(await offered(), ["Head Office"]);
  });

  it("offers the site again once unarchived, and lets it be granted", async () => {
    await unarchiveSite(database.pool, { siteId: depot, expectedVersion: await siteVersion(depot) }, context());
    await grant([office, depot]);
    assert.deepEqual(await offered(), ["Depot", "Head Office"]);
  });
});
