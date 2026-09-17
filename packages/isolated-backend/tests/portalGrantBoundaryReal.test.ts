import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { getGrantedPublishedCrpReport, listGrantedPortalJobs } from "../src/readModels";

/**
 * The portal grant boundary, asked of a real database (NZC-099, Tier 1).
 *
 * A portal user is a person at a **client**, not a member of the firm, and the portal's whole
 * safety property is that one client cannot reach another's reports. Two things enforce it: the
 * session supplies `portalUserId` and `clientId` — neither is addressable from the request — and
 * every read joins `portal_access_grants` to confirm this user has that job.
 *
 * The join is the part a fake cannot check. A stub returns whatever row the test configured, so a
 * read whose grant predicate was dropped, or applied to the wrong side of the join, returns the
 * canned row and passes. This puts two clients' data in one database and asks the query.
 *
 * The seed deliberately gives **both** clients a published report, so a leak returns something
 * plausible rather than nothing — a test where the other tenant has no data cannot tell a working
 * predicate from an empty table.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const CLIENT_A = "client-a";
const CLIENT_B = "client-b";
const USER_A = "portal-user-a";
const USER_B = "portal-user-b";
const JOB_A = "job-a";
const JOB_B = "job-b";
const HASH = `sha256:${"a".repeat(64)}`;

describe("a portal user reaches only the jobs granted to them", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("portalgrant"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);

    let sequence = 1;
    for (const [client, user, job] of [[CLIENT_A, USER_A, JOB_A], [CLIENT_B, USER_B, JOB_B]]) {
      await db.query(
        `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,$3,'active')`,
        [ORG, client, `Client ${client}`]);
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year)
         VALUES ($1,$2,$3,$4,'crp',$5,'open','Report & publish',2025)`,
        [ORG, job, client, sequence++, `CRP for ${client}`]);
      await db.query(
        `INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,email_normalized,display_name,status)
         VALUES ($1,$2,$3,$4,'Portal Person','active')`,
        [ORG, user, client, `${user}@example.invalid`]);
      // A published report for each, so a leak would return something rather than nothing.
      await db.query(
        `INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id,snapshot_id,job_id,snapshot_version,job_version,data_hash,payload_json,created_by)
         VALUES ($1,$2,$3,1,1,$4,$5::jsonb,'preparer')`,
        [ORG, `snap-${job}`, job, HASH,
         JSON.stringify({ jobNumber: job, client, reportingYear: 2025, measurements: [], annualComparison: [] })]);
      await db.query(
        `INSERT INTO nzi_console.report_versions (organisation_id,report_version_id,job_id,status,manifest_version,reviewed_snapshot_id,data_hash,published_at)
         VALUES ($1,$2,$3,'published',1,$4,$5,now())`,
        [ORG, `version-${job}`, job, `snap-${job}`, HASH]);
      // Each portal user is granted their own job, and only that.
      await db.query(
        `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,portal_user_id,client_id,job_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [ORG, `grant-${job}`, user, client, job]);
    }
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("lists a portal user their own job", async () => {
    const jobs = await listGrantedPortalJobs(db, { portalUserId: USER_A, clientId: CLIENT_A });
    assert.deepEqual(jobs.map((job) => job.id ?? (job as { jobId?: string }).jobId), [JOB_A]);
  });

  it("lists nothing of the other client's, even though that client has a published report", async () => {
    const jobs = await listGrantedPortalJobs(db, { portalUserId: USER_A, clientId: CLIENT_B });
    assert.deepEqual(jobs, [], "naming another client alongside your own user id returns nothing");
  });

  it("refuses the other client's report when its job id is named exactly", async () => {
    // The direct attempt: a job id from a link, an email or a guess, asked for by a user who is
    // not granted it. The grant join is the only thing standing here.
    const report = await getGrantedPublishedCrpReport(db, {
      portalUserId: USER_A, clientId: CLIENT_A, jobId: JOB_B,
    });
    assert.equal(report, null);
  });

  it("refuses when the client id is swapped to match the job", async () => {
    // The more careful attempt: name the other client *and* their job, keeping the pair
    // self-consistent, so only the portal_user_id is out of place. A predicate that joined on
    // client and job but not on the user would return the report here.
    const report = await getGrantedPublishedCrpReport(db, {
      portalUserId: USER_A, clientId: CLIENT_B, jobId: JOB_B,
    });
    assert.equal(report, null);
  });

  it("returns the report the user is actually granted", async () => {
    const report = await getGrantedPublishedCrpReport(db, {
      portalUserId: USER_A, clientId: CLIENT_A, jobId: JOB_A,
    });
    assert.ok(report, "the granted report resolves, so the refusals above are not a broken query");
    assert.equal(report!.snapshot.jobId, JOB_A);
  });

  it("stops returning it the moment the grant is revoked", async () => {
    // Revocation is a timestamp, not a delete, so the row is still there to be joined — which is
    // precisely the case where a predicate that forgot `revoked_at IS NULL` keeps working.
    await db.query(
      `UPDATE nzi_console.portal_access_grants SET revoked_at=now() WHERE grant_id=$1`, [`grant-${JOB_A}`]);
    const report = await getGrantedPublishedCrpReport(db, {
      portalUserId: USER_A, clientId: CLIENT_A, jobId: JOB_A,
    });
    assert.equal(report, null, "a revoked grant is not a grant");
    const jobs = await listGrantedPortalJobs(db, { portalUserId: USER_A, clientId: CLIENT_A });
    assert.deepEqual(jobs, [], "and the job leaves the list too");
    await db.query(
      `UPDATE nzi_console.portal_access_grants SET revoked_at=NULL WHERE grant_id=$1`, [`grant-${JOB_A}`]);
  });

  it("refuses a portal user who does not exist", async () => {
    const report = await getGrantedPublishedCrpReport(db, {
      portalUserId: "no-such-portal-user", clientId: CLIENT_A, jobId: JOB_A,
    });
    assert.equal(report, null);
  });
});
