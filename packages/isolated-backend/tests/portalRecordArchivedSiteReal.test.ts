import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, roleCapabilityGrants, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { setPortalDataEntryBucketGrant } from "../src/portalDataEntry";
import { createPortalDataEntryRecord, decidePortalDataEntryReview, submitPortalDataEntryRecord, updatePortalDataEntryRecord } from "../src/portalDataEntryRecords";
import { archiveSite, createClientSite, unarchiveSite } from "../src/siteLifecycle";
import type { PortalPrincipal, StaffPrincipal } from "../src/index";

/**
 * RULING-portal-record-site (7 Oct), the third sibling of #424: the portal's record create, record update and staff
 * acceptance share #424's one comparison (`refuseArchivedSiteChange`). A new record may not cite an archived site; a
 * record keeps the archived site it already cites but may not move onto one; acceptance — which writes the scope row's
 * site — stands onto a row that already cites it and is refused when it would move the row onto one. Unarchiving lifts
 * each refusal.
 */
const ORG = "demo-nzi-console"; // the synthetic factor seed's organisation
const CLIENT = "client-pr";
const JOB = "job-pr";
const USER = "portal-pr";
const STAFF = "staff-pr";
const here = dirname(fileURLToPath(import.meta.url));

const staff: StaffPrincipal = {
  organisationId: ORG, userId: STAFF, sessionId: "s", issuedAt: 1, expiresAt: 2,
  role: "admin", matrixVersion: 1, capabilities: roleCapabilityGrants("admin"),
} as StaffPrincipal;
const portal = {
  principal: "portal", organisationId: ORG, userId: USER, clientId: CLIENT, sessionId: "p",
  issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid",
} as unknown as PortalPrincipal;
const archivedRefusal = /That site is archived — unarchive it to record against it\./;

describe("the portal's record writes and acceptance refuse a new citation of an archived site, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `pr-${keys}`, correlationId: `corr-pr-${keys}`,
      grant: commandGrantForRole("admin", ORG, STAFF), ...(reason ? { reason } : {}) };
  };
  const siteVersion = async (siteId: string) => (await db.query<{ version: number }>(`SELECT version FROM nzi_console.client_sites WHERE site_id=$1`, [siteId])).rows[0]!.version;
  const rowSite = async (scopeRowId: string) => (await db.query<{ site_id: string | null }>(`SELECT site_id FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [scopeRowId])).rows[0]!.site_id;
  const entry = (bucketGrantId: string, siteId: string | null) => ({ bucketGrantId, quantity: 100, unit: "kWh", factorId: "gas-demo", siteId, note: "" });
  const accept = (submitted: { queueId: string; version: number }) => decidePortalDataEntryReview(database.pool, staff, {
    queueId: submitted.queueId, expectedSubmittedVersion: submitted.version, decision: "accept", note: "" });
  let office = "", depot = "", openBucket = "", depotBucket = "";
  // Saved before the depot is archived: one on the depot, one at the office (row-open, no site); one on the depot for
  // row-depot, which already cites the depot.
  let onDepot = { recordId: "", version: 0 }, atOffice = { recordId: "", version: 0 }, forDepotRow = { recordId: "", version: 0 };

  before(async () => {
    database = (await createDisposableDatabase("portalrecordsite"))!;
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
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, JOB]);
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    office = (await createClientSite(database.pool, { clientId: CLIENT, name: "Head Office", inServiceFrom: null, isRegisteredOffice: true } as never, context())).data.siteId;
    depot = (await createClientSite(database.pool, { clientId: CLIENT, name: "Depot", inServiceFrom: null } as never, context())).data.siteId;
    for (const [id, siteId] of [["row-open", null], ["row-depot", depot]] as const) {
      await db.query(
        `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code,site_id)
         VALUES ($1,$2,$3,'1',$2,$2,'Scope 1','Gas','1.natural-gas',$4)`, [ORG, id, JOB, siteId]);
    }
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,status) VALUES ($1,$2,$3,'active')`, [ORG, USER, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at)
       VALUES ($1,'grant-pr',$2,$3,$4,now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, USER, JOB]);
    const grant = (scopeRowId: string) => setPortalDataEntryBucketGrant(database.pool, staff, {
      portalUserId: USER, jobId: JOB, scopeRowId, entryKind: "manual_activity", factorIds: ["gas-demo"], siteIds: [office, depot] });
    openBucket = (await grant("row-open")).bucketGrantId;
    depotBucket = (await grant("row-depot")).bucketGrantId;
    onDepot = await createPortalDataEntryRecord(database.pool, portal, JOB, entry(openBucket, depot));
    atOffice = await createPortalDataEntryRecord(database.pool, portal, JOB, entry(openBucket, office));
    forDepotRow = await createPortalDataEntryRecord(database.pool, portal, JOB, entry(depotBucket, depot));
    await archiveSite(database.pool, { siteId: depot, expectedVersion: await siteVersion(depot) }, context("closed"));
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("record create: refuses a new record on an archived site; a live site is still accepted", async () => {
    await assert.rejects(() => createPortalDataEntryRecord(database.pool, portal, JOB, entry(openBucket, depot)), archivedRefusal);
    assert.ok((await createPortalDataEntryRecord(database.pool, portal, JOB, entry(openBucket, office))).recordId);
  });

  it("record update: keeps an already-archived site; refuses a move onto one", async () => {
    onDepot = await updatePortalDataEntryRecord(database.pool, portal, JOB, onDepot.recordId, onDepot.version, { ...entry(openBucket, depot), quantity: 120 });
    assert.equal(onDepot.version, 2, "an edit keeping the archived depot is saved");
    await assert.rejects(() => updatePortalDataEntryRecord(database.pool, portal, JOB, atOffice.recordId, atOffice.version, entry(openBucket, depot)), archivedRefusal);
  });

  it("acceptance: stands onto a row already citing the archived site; refused when it would move a row onto it", async () => {
    await accept(await submitPortalDataEntryRecord(database.pool, portal, JOB, forDepotRow.recordId, forDepotRow.version));
    assert.equal(await rowSite("row-depot"), depot, "accepted onto the row that already cites the depot");
    const pending = await submitPortalDataEntryRecord(database.pool, portal, JOB, onDepot.recordId, onDepot.version);
    await assert.rejects(() => accept(pending), archivedRefusal);
    assert.equal(await rowSite("row-open"), null, "the row was not moved onto the archived depot");
    onDepot = { ...onDepot, ...pending };
  });

  it("unarchiving lifts each refusal", async () => {
    await unarchiveSite(database.pool, { siteId: depot, expectedVersion: await siteVersion(depot) }, context());
    assert.ok((await createPortalDataEntryRecord(database.pool, portal, JOB, entry(openBucket, depot))).recordId, "create");
    assert.equal((await updatePortalDataEntryRecord(database.pool, portal, JOB, atOffice.recordId, atOffice.version, entry(openBucket, depot))).version, 2, "update");
    const { rows: [queued] } = await db.query<{ queue_id: string; submitted_version: number }>(
      `SELECT queue_id, submitted_version FROM nzi_console.portal_data_entry_review_queue WHERE record_id=$1 AND status='pending'`, [onDepot.recordId]);
    await accept({ queueId: queued!.queue_id, version: queued!.submitted_version });
    assert.equal(await rowSite("row-open"), depot, "acceptance");
  });
});
