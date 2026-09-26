import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { roleCapabilityGrants } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { listPortalDataEntryBuckets, setPortalDataEntryBucketGrant } from "../src/portalDataEntry";
import { createPortalDataEntryRecord, decidePortalDataEntryReview, submitPortalDataEntryRecord } from "../src/portalDataEntryRecords";
import type { PortalPrincipal, StaffPrincipal } from "../src/index";

/**
 * A portal entry's primary factor is one the scope row may actually carry — at every point, not only the first
 * (NZC-160 H1, defence in depth).
 *
 * Stop 1 reported that under byte-order collation an electricity bucket granted both electricity factors
 * defaults to T&D. That allow-list was built by hand: the grant command refuses a factor whose scopes do not
 * include the row's, so the case is not reachable directly. What *is* reachable is the back door — a bucket
 * granted legitimately on a 3.3 row whose scope is later edited to 2. The grant was checked once, when it was
 * made, and nothing after it looked again. So the same predicate is now asked at every point a factor passes
 * through: grant, listing, draft, submission, and acceptance, where the number lands on the scope row.
 *
 * The predicate: the factor is active, its scopes include the row's scope root, and it is not a companion
 * declared for the row's category. The last clause is what a library tagging T&D as `{2,3}` would otherwise
 * slip past — a companion is another row's factor, never this row's primary.
 *
 * Every refusal is paired with the legitimate path through the same five points, so a check that refused
 * everything would fail here rather than pass.
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

describe("a portal entry's primary factor is one its scope row may carry, at every point (H1)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  /** A row as it was when the grant was made, and the edit that moves it under the grant afterwards. */
  const row = async (id: string, scope: string, category: string) => db.query(
    `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code)
     VALUES ($1,$2,$3,$4,$2,$2,'Scope x','x',$5)`, [ORG, id, JOB, scope, category]);
  const moveToElectricity = (id: string) => db.query(
    `UPDATE nzi_console.job_scope_rows SET scope='2', category_code='2.purchased-electricity' WHERE scope_row_id=$1`, [id]);
  const grant = (scopeRowId: string, factorIds: string[]) => setPortalDataEntryBucketGrant(database.pool, staff, {
    portalUserId: USER, jobId: JOB, scopeRowId, entryKind: "manual_activity", factorIds, siteIds: [],
  });
  const draft = (bucketGrantId: string, factorId: string) => createPortalDataEntryRecord(database.pool, portal, JOB, {
    bucketGrantId, quantity: 1000, unit: "kWh", factorId, siteId: null, note: "",
  });
  const REFUSED = /outside the authorised bucket constraints|no longer active|not a factor this row may carry/;

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
    await row("row-elec", "2", "2.purchased-electricity");
    for (const id of ["row-td-list", "row-td-submit", "row-td-accept"]) await row(id, "3.3", "3.3");
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,status) VALUES ($1,$2,$3,'active')`, [ORG, USER, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at)
       VALUES ($1,'grant-h1',$2,$3,$4,now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, USER, JOB]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── The grant ────────────────────────────────────────────────────────────────────────────────────────

  it("refuses to grant the T&D factor on a Scope 2 row, through the command staff actually use", async () => {
    await assert.rejects(() => grant("row-elec", ["uk-ghg-7_400_4000_5_1", "uk-ghg-13_402_4000_5_1"]), /compatible with the scope row/);
  });

  it("refuses a companion factor as a primary even when its scopes claim the row's", async () => {
    // A library that tags T&D `{2,3}` passes the scope check. The companion clause is what stops it.
    await db.query(`UPDATE nzi_console.emission_factors SET scopes=ARRAY['2','3'] WHERE factor_id='uk-ghg-13_402_4000_5_1'`);
    try {
      await assert.rejects(() => grant("row-elec", ["uk-ghg-7_400_4000_5_1", "uk-ghg-13_402_4000_5_1"]), /compatible with the scope row/);
    } finally {
      await db.query(`UPDATE nzi_console.emission_factors SET scopes=ARRAY['3'] WHERE factor_id='uk-ghg-13_402_4000_5_1'`);
    }
  });

  // ── The back door: granted on 3.3, then the row is edited to Scope 2 ─────────────────────────────────

  it("stops offering the factor once the row's scope has moved under the grant", async () => {
    await grant("row-td-list", ["uk-ghg-13_402_4000_5_1"]);
    await moveToElectricity("row-td-list");
    const bucket = (await listPortalDataEntryBuckets(database.pool, portal, JOB)).find((b) => b.scopeRowId === "row-td-list");
    assert.ok(bucket, "the bucket itself should still be listed — only the ineligible factor goes");
    assert.deepEqual(bucket.factors.map((factor) => factor.id), [],
      "a Scope 2 electricity bucket still offers the T&D factor it was granted as a 3.3 row");
  });

  it("refuses a new entry against it", async () => {
    const bucket = (await listPortalDataEntryBuckets(database.pool, portal, JOB)).find((b) => b.scopeRowId === "row-td-list")!;
    await assert.rejects(() => draft(bucket.bucketGrantId, "uk-ghg-13_402_4000_5_1"), REFUSED);
  });

  it("refuses to submit a draft saved before the row moved", async () => {
    const { bucketGrantId } = await grant("row-td-submit", ["uk-ghg-13_402_4000_5_1"]);
    const saved = await draft(bucketGrantId, "uk-ghg-13_402_4000_5_1");
    await moveToElectricity("row-td-submit");
    await assert.rejects(() => submitPortalDataEntryRecord(database.pool, portal, JOB, saved.recordId, saved.version), REFUSED);
  });

  it("refuses to accept, onto the scope row, an entry submitted before the row moved", async () => {
    // Acceptance is where the number lands. Refusing here is the last line; the ones above are earlier ones.
    const { bucketGrantId } = await grant("row-td-accept", ["uk-ghg-13_402_4000_5_1"]);
    const saved = await draft(bucketGrantId, "uk-ghg-13_402_4000_5_1");
    const submitted = await submitPortalDataEntryRecord(database.pool, portal, JOB, saved.recordId, saved.version);
    await moveToElectricity("row-td-accept");
    await assert.rejects(() => decidePortalDataEntryReview(database.pool, staff, {
      queueId: submitted.queueId, expectedSubmittedVersion: submitted.version, decision: "accept", note: "",
    }), REFUSED);
    const landed = await db.query<{ factor_id: string | null }>(`SELECT factor_id FROM nzi_console.job_scope_rows WHERE scope_row_id='row-td-accept'`);
    assert.equal(landed.rows[0]!.factor_id, null, "the T&D factor reached the Scope 2 row");
  });

  // ── And the legitimate path goes all the way through ─────────────────────────────────────────────────

  it("still takes an ordinary electricity entry from grant to the scope row", async () => {
    const { bucketGrantId } = await grant("row-elec", ["uk-ghg-7_400_4000_5_1"]);
    const bucket = (await listPortalDataEntryBuckets(database.pool, portal, JOB)).find((b) => b.bucketGrantId === bucketGrantId)!;
    assert.deepEqual(bucket.factors.map((factor) => factor.id), ["uk-ghg-7_400_4000_5_1"]);
    const saved = await draft(bucketGrantId, "uk-ghg-7_400_4000_5_1");
    const submitted = await submitPortalDataEntryRecord(database.pool, portal, JOB, saved.recordId, saved.version);
    await decidePortalDataEntryReview(database.pool, staff, {
      queueId: submitted.queueId, expectedSubmittedVersion: submitted.version, decision: "accept", note: "",
    });
    const landed = await db.query<{ factor_id: string }>(`SELECT factor_id FROM nzi_console.job_scope_rows WHERE scope_row_id='row-elec'`);
    assert.equal(landed.rows[0]!.factor_id, "uk-ghg-7_400_4000_5_1");
  });
});
