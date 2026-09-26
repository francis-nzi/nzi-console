import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { roleCapabilityGrants } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { setPortalDataEntryWindow, setPortalJobAccess, setPortalUserEnabled } from "../src/portalAccess";
import { setPortalDataEntryBucketGrant } from "../src/portalDataEntry";
import { createPortalInvitation, createPortalRecoveryInvitation } from "../src/portalInvitations";
import { addGrantedReportComment, addStaffReportComment, approveGrantedPublishedReport } from "../src/portalReview";
import type { PortalSession, StaffPrincipal } from "../src/auth";

/**
 * Every portal write that records its audit event through `jsonb_build_object`, run against real Postgres.
 *
 * Each of these passed its unit tests, which run against a fake pool that accepts any SQL. None of them had
 * ever been executed by a database — and Postgres cannot infer a type for a parameter whose only use is as an
 * argument to `jsonb_build_object`, so it refuses the statement and the whole command rolls back. Typecheck
 * cannot see that, and neither can a fake pool: it is only visible here.
 *
 * Each test calls the real command, then reads back the audit event it wrote. The *shape* of `after_json` is
 * asserted as well as its presence — a boolean stays a boolean, an id list stays a list — because the obvious
 * repair, casting every parameter to text, would make the statement run while quietly turning `true` into
 * `"true"` in the audit trail.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-p0";
const CLIENT = "client-p0";
const JOB = "job-p0";
const STAFF = "staff-p0";
const REPORT = "report-p0";
const HASH = `sha256:${"a".repeat(64)}`;
const here = dirname(fileURLToPath(import.meta.url));

const staff = {
  organisationId: ORG, userId: STAFF, sessionId: "s", issuedAt: 1, expiresAt: 2,
  role: "admin", matrixVersion: 1, capabilities: roleCapabilityGrants("admin"),
} as StaffPrincipal;
const session = (userId: string) => ({
  organisationId: ORG, userId, clientId: CLIENT, sessionId: `session-${userId}`,
  issuedAt: 1, expiresAt: 2, displayName: `Portal ${userId}`,
}) as unknown as PortalSession & { displayName: string };

describe("portal writes that audit through jsonb_build_object, against real Postgres (P0)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  const audit = async (action: string, entityId: string) => {
    const found = await db.query<{ after_json: Record<string, unknown> }>(
      `SELECT after_json FROM nzi_console.audit_events WHERE action = $1 AND entity_id = $2`, [action, entityId]);
    assert.equal(found.rows.length, 1, `expected exactly one '${action}' audit event for ${entityId}`);
    return found.rows[0]!.after_json;
  };

  before(async () => {
    database = (await createDisposableDatabase("portalaudit"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`, [ORG, STAFF]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, JOB]);

    // The shipped factor seed, which is written for the demonstration organisation; re-pointed at this one so
    // the bucket grant has a real factor selected for the job.
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8").replaceAll("demo-nzi-console", ORG));

    await db.query(
      `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code)
       VALUES ($1,'row-elec',$2,'2','Electricity','Electricity','Scope 2','Purchased energy','2.purchased-electricity')`, [ORG, JOB]);

    for (const user of ["portal-main", "portal-toggle", "portal-recover", "portal-access"]) {
      await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,status) VALUES ($1,$2,$3,'active')`, [ORG, user, CLIENT]);
    }
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at)
       VALUES ($1,'grant-main',$2,'portal-main',$3,now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, JOB]);

    await db.query(
      `INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id,snapshot_id,job_id,snapshot_version,job_version,data_hash,payload_json,created_by)
       VALUES ($1,'snapshot-p0',$2,1,1,$3,'{}'::jsonb,$4)`, [ORG, JOB, HASH, STAFF]);
    await db.query(
      `INSERT INTO nzi_console.report_versions (organisation_id,report_version_id,job_id,status,manifest_version,reviewed_snapshot_id,data_hash)
       VALUES ($1,$2,$3,'published',1,'snapshot-p0',$4)`, [ORG, REPORT, JOB, HASH]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── Access (portalAccess.ts) ─────────────────────────────────────────────────────────────────────────

  it("setPortalJobAccess grants a job and audits it", async () => {
    const result = await setPortalJobAccess(database.pool, staff, { portalUserId: "portal-access", jobId: JOB, granted: true });
    assert.deepEqual(await audit("portal.access.grant", result.grantId), { portalUserId: "portal-access", jobId: JOB, granted: true });
  });

  it("setPortalDataEntryWindow schedules a window and audits it", async () => {
    const startsAt = "2026-02-01T00:00:00.000Z", expiresAt = "2026-03-01T00:00:00.000Z";
    await setPortalDataEntryWindow(database.pool, staff, { portalUserId: "portal-main", jobId: JOB, startsAt, expiresAt });
    const after = await audit("portal.data_entry.window.set", "grant-main");
    assert.equal(after.portalUserId, "portal-main");
    assert.equal(after.jobId, JOB);
    assert.equal(after.enabled, true, "enabled must stay a boolean in the audit trail");
    assert.equal(new Date(String(after.startsAt)).toISOString(), startsAt);
    assert.equal(new Date(String(after.expiresAt)).toISOString(), expiresAt);
    // Restore the open window the other tests rely on.
    await db.query(`UPDATE nzi_console.portal_access_grants SET data_entry_starts_at=now() - interval '1 day', data_entry_expires_at=now() + interval '30 days' WHERE grant_id='grant-main'`);
  });

  it("setPortalUserEnabled disables a user and audits it", async () => {
    await setPortalUserEnabled(database.pool, staff, { portalUserId: "portal-toggle", enabled: false });
    assert.deepEqual(await audit("portal.user.disable", "portal-toggle"), { enabled: false });
  });

  // ── Data entry (portalDataEntry.ts) ──────────────────────────────────────────────────────────────────

  it("setPortalDataEntryBucketGrant grants a bucket and audits it", async () => {
    const result = await setPortalDataEntryBucketGrant(database.pool, staff, {
      portalUserId: "portal-main", jobId: JOB, scopeRowId: "row-elec", entryKind: "manual_activity",
      factorIds: ["uk-ghg-7_400_4000_5_1"], siteIds: [],
    });
    const after = await audit("portal.data_entry.bucket.grant", result.bucketGrantId);
    assert.deepEqual(after, {
      portalUserId: "portal-main", jobId: JOB, scopeRowId: "row-elec", entryKind: "manual_activity",
      factorIds: ["uk-ghg-7_400_4000_5_1"], siteIds: [], units: ["kWh"], pgsCategoryIds: [],
    }, "the id lists must stay JSON arrays");
  });

  // ── Invitations (portalInvitations.ts) ───────────────────────────────────────────────────────────────

  it("createPortalInvitation invites a new user and audits it", async () => {
    const result = await createPortalInvitation(database.pool, staff, { clientId: CLIENT, email: "invitee@example.invalid", displayName: "Invitee" });
    const after = await audit("portal.invitation.create", result.portalUserId);
    assert.equal(after.invitationId, result.invitationId);
    assert.equal(after.clientId, CLIENT);
    assert.equal(new Date(String(after.expiresAt)).toISOString(), result.expiresAt);
  });

  it("createPortalRecoveryInvitation works as the real app role: suspends credentials, revokes sessions, audits", async () => {
    // No privileges granted here. Until P0b this command was refused on its first write, because it UPDATEd
    // portal_sessions and portal_credentials, which only nzi_console_auth may touch. It now goes through the
    // two confined functions — revoke_portal_user_sessions (0024) and suspend_portal_user_credentials (0118).
    await db.query(
      `INSERT INTO nzi_console.portal_credentials (organisation_id,portal_user_id,password_salt,password_hash,totp_ciphertext,totp_iv,totp_tag,enabled)
       VALUES ($1,'portal-recover','salt','hash','ct','iv','tag',true)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.portal_sessions (organisation_id,session_id,portal_user_id,client_id,expires_at)
       VALUES ($1,'session-recover','portal-recover',$2,now() + interval '1 day')`, [ORG, CLIENT]);

    const result = await createPortalRecoveryInvitation(database.pool, staff, { portalUserId: "portal-recover" });

    const credential = await db.query<{ enabled: boolean }>(
      `SELECT enabled FROM nzi_console.portal_credentials WHERE portal_user_id='portal-recover'`);
    assert.equal(credential.rows[0]!.enabled, false, "the credentials were not suspended");
    const sessionRow = await db.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM nzi_console.portal_sessions WHERE session_id='session-recover'`);
    assert.ok(sessionRow.rows[0]!.revoked_at, "the live session was not revoked");
    const user = await db.query<{ status: string }>(`SELECT status FROM nzi_console.portal_users WHERE portal_user_id='portal-recover'`);
    assert.equal(user.rows[0]!.status, "invited");

    const after = await audit("portal.recovery.issue", "portal-recover");
    assert.equal(after.invitationId, result.invitationId);
    assert.equal(after.clientId, CLIENT);
    assert.equal(after.sessionsRevoked, true);
    assert.equal(after.credentialsSuspended, true);
  });

  it("the app role still cannot write portal_credentials directly — the function is the only path", async () => {
    // The fix must not be "grant the app the table". Least privilege is the point of 0018, and 0118 keeps it.
    const client = await database.admin();
    try {
      await client.query(`SET ROLE nzi_console_app`);
      await assert.rejects(
        () => client.query(`UPDATE nzi_console.portal_credentials SET enabled = false`),
        /permission denied for table portal_credentials/);
    } finally {
      await client.end();
    }
  });

  it("suspend_portal_user_credentials refuses to act for a tenant other than the caller's", async () => {
    const client = await database.admin();
    try {
      await client.query(`SET ROLE nzi_console_app`);
      await client.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
      await assert.rejects(
        () => client.query(`SELECT nzi_console.suspend_portal_user_credentials('some-other-org', 'portal-recover')`),
        /Tenant context mismatch/);
    } finally {
      await client.end();
    }
  });

  // ── Report review (portalReview.ts) ──────────────────────────────────────────────────────────────────

  it("addGrantedReportComment records a client comment and audits it", async () => {
    const comment = await addGrantedReportComment(database.pool, session("portal-main"), { jobId: JOB, reportVersionId: REPORT, body: "Looks right." });
    assert.deepEqual(await audit("portal.report.comment.create", comment.commentId), { reportVersionId: REPORT, jobId: JOB });
  });

  it("addStaffReportComment records a staff reply and audits it", async () => {
    const comment = await addStaffReportComment(database.pool, staff, { jobId: JOB, reportVersionId: REPORT, body: "Thanks." });
    assert.deepEqual(await audit("portal.report.comment.reply", comment.commentId), { reportVersionId: REPORT, jobId: JOB });
  });

  it("approveGrantedPublishedReport records an approval and audits it", async () => {
    const approval = await approveGrantedPublishedReport(database.pool, session("portal-main"), { jobId: JOB, reportVersionId: REPORT });
    const after = await audit("portal.report.approve", REPORT);
    assert.equal(after.statementVersion, 1);
    assert.ok(approval.approvalId, "no approval returned");
    // It recorded the audit event's own id under this key until P0b — right shape, wrong referent, and the
    // audit trail is the thing a reviewer follows back to the approval.
    assert.equal(after.approvalId, approval.approvalId, "the audit names something other than the approval");
  });
});
