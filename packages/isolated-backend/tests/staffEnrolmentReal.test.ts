import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { completeStaffMfa, startStaffLogin, totpCode } from "../src/index";
import {
  completeStaffEnrolment, issueStaffEnrolmentInvitation, MAX_CODE_ATTEMPTS, revokeStaffEnrolmentInvitation,
  StaffEnrolmentError, startStaffEnrolment,
} from "../src/staffEnrolment";

/**
 * Staff self-enrolment (0129), against a real database with every migration, as a security stop: the operator never
 * holds either factor, the token is single-use, expiring and stored only hashed, nothing signs in before a code is
 * proved, a working account cannot be taken over, the operator's role cannot read what the person set, the auth role
 * can write only enrolment audit events, and every step is audited — ending in a real sign-in with the result.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "net-zero-international";
const KEY = randomBytes(32).toString("base64");
const PASSWORD = "a-long-unique-passphrase";

describe("staff self-enrolment (0129)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const member = (userId: string, email: string | null, status = "active") => db.query(
    `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name,email) VALUES ($1,$2,'consultant',$3,$2,$4)`,
    [ORG, userId, status, email]);
  const issue = (userId: string, now = new Date()) => issueStaffEnrolmentInvitation(database.pool, { organisationId: ORG, userId, actorId: "operator:test" }, now);
  const invitation = async (id: string) => (await db.query(`SELECT * FROM nzi_console.staff_enrolment_invitations WHERE invitation_id=$1`, [id])).rows[0]!;
  const credential = async (userId: string) => (await db.query(`SELECT * FROM nzi_console.staff_credentials WHERE organisation_id=$1 AND user_id=$2`, [ORG, userId])).rows[0];
  const audits = async (userId: string) => (await db.query<{ action: string; actor_id: string; after_json: Record<string, unknown> }>(
    `SELECT a.action, a.actor_id, a.after_json FROM nzi_console.audit_events a
      JOIN nzi_console.staff_enrolment_invitations i ON (i.organisation_id, i.invitation_id) = (a.organisation_id, a.entity_id)
     WHERE a.entity_type='staff_enrolment_invitation' AND i.user_id=$1 ORDER BY a.occurred_at, a.audit_event_id`, [userId])).rows;
  const enrol = async (token: string) => {
    const setup = await startStaffEnrolment(database.pool, { token, password: PASSWORD }, KEY);
    await completeStaffEnrolment(database.pool, { token, code: totpCode(setup.totpSecret) }, KEY);
    return setup;
  };
  const invalid = (message?: RegExp) => (error: unknown) => error instanceof StaffEnrolmentError && (!message || message.test(error.message));

  before(async () => {
    database = (await createDisposableDatabase("enrol"))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  // ── Issue ────────────────────────────────────────────────────────────────────────────────────────────────

  it("issues for an active member with a work address, storing only the token's hash, expiring in 72 hours, audited", async () => {
    await member("ada", "Ada@Example.org");
    const now = new Date();
    const issued = await issue("ada", now);
    assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/, "the token is not 32 random bytes");
    const row = await invitation(issued.invitationId);
    assert.ok(!JSON.stringify(row).includes(issued.token), "the token itself was stored");
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(new Date(row.expires_at).getTime() - now.getTime(), 72 * 60 * 60 * 1000);
    assert.equal(row.created_by, "operator:test");
    assert.deepEqual((await audits("ada")).map((event) => event.action), ["staff.enrolment.issue"]);
    assert.ok(!JSON.stringify(await audits("ada")).includes(issued.token), "the token reached the audit trail");
  });

  it("refuses a non-member, an inactive member, and a member with no work address", async () => {
    await member("gone", "gone@example.org", "suspended");
    await member("noaddress", null);
    await assert.rejects(() => issue("nobody"), invalid(/not a member/));
    await assert.rejects(() => issue("gone"), invalid(/suspended, not active/));
    await assert.rejects(() => issue("noaddress"), invalid(/no work address/));
  });

  it("issuing again revokes the open invitation, and the old link stops working", async () => {
    await member("bea", "bea@example.org");
    const first = await issue("bea");
    const second = await issue("bea");
    assert.ok((await invitation(first.invitationId)).revoked_at, "the first invitation is still open");
    await assert.rejects(() => startStaffEnrolment(database.pool, { token: first.token, password: PASSWORD }, KEY), invalid());
    await startStaffEnrolment(database.pool, { token: second.token, password: PASSWORD }, KEY);
    // The revoke and the second issue are written in one transaction, so they share a timestamp and have no order
    // between them: checked as a pair. The steps either side are separate transactions, and are checked in order.
    const actions = (await audits("bea")).map((event) => event.action);
    assert.equal(actions[0], "staff.enrolment.issue");
    assert.deepEqual(actions.slice(1, 3).sort(), ["staff.enrolment.issue", "staff.enrolment.revoke"]);
    assert.equal(actions[3], "staff.enrolment.setup");
    assert.equal(actions.length, 4);
  });

  // ── Set up: nothing can sign in yet ──────────────────────────────────────────────────────────────────────

  it("setup holds a password hash and an encrypted secret on the invitation, and writes no credential", async () => {
    await member("cy", "cy@example.org");
    const issued = await issue("cy");
    const setup = await startStaffEnrolment(database.pool, { token: issued.token, password: PASSWORD }, KEY);
    assert.equal(setup.email, "cy@example.org");
    assert.match(setup.totpSecret, /^[A-Z2-7]+$/);
    assert.ok(setup.otpauthUri.startsWith("otpauth://totp/") && setup.otpauthUri.includes(`secret=${setup.totpSecret}`));
    const row = await invitation(issued.invitationId);
    const held = JSON.stringify(row);
    assert.ok(!held.includes(PASSWORD), "the password was stored in the clear");
    assert.ok(!held.includes(setup.totpSecret), "the TOTP secret was stored in the clear");
    assert.ok(row.pending_password_hash && row.pending_totp_ciphertext && row.setup_started_at);
    assert.equal(await credential("cy"), undefined, "a credential exists before any code was confirmed");
  });

  it("refuses a short password, and a missing, unknown, expired or revoked token — without saying which", async () => {
    await member("dee", "dee@example.org");
    const issued = await issue("dee");
    await assert.rejects(() => startStaffEnrolment(database.pool, { token: issued.token, password: "short" }, KEY), invalid(/at least 12/));
    await assert.rejects(() => startStaffEnrolment(database.pool, { token: "", password: PASSWORD }, KEY), invalid(/invalid or has expired/));
    await assert.rejects(() => startStaffEnrolment(database.pool, { token: "not-a-token", password: PASSWORD }, KEY), invalid(/invalid or has expired/));
    const later = new Date(Date.now() + 73 * 60 * 60 * 1000);
    await assert.rejects(() => startStaffEnrolment(database.pool, { token: issued.token, password: PASSWORD }, KEY, later), invalid(/invalid or has expired/));
    assert.equal(await revokeStaffEnrolmentInvitation(database.pool, { organisationId: ORG, userId: "dee", actorId: "operator:test" }), true);
    await assert.rejects(() => startStaffEnrolment(database.pool, { token: issued.token, password: PASSWORD }, KEY), invalid(/invalid or has expired/));
  });

  // ── Confirm ──────────────────────────────────────────────────────────────────────────────────────────────

  it("a wrong code is counted and audited — the count survives the failure — and the fifth revokes the link", async () => {
    await member("eve", "eve@example.org");
    const issued = await issue("eve");
    const setup = await startStaffEnrolment(database.pool, { token: issued.token, password: PASSWORD }, KEY);
    const wrong = totpCode(setup.totpSecret) === "000000" ? "111111" : "000000";
    for (let attempt = 1; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      await assert.rejects(() => completeStaffEnrolment(database.pool, { token: issued.token, code: wrong }, KEY), invalid(/incorrect/));
      assert.equal((await invitation(issued.invitationId)).failed_code_attempts, attempt, "the failed attempt was rolled back with the error");
    }
    await assert.rejects(() => completeStaffEnrolment(database.pool, { token: issued.token, code: wrong }, KEY), invalid(/Too many incorrect codes/));
    const row = await invitation(issued.invitationId);
    assert.ok(row.revoked_at, "five wrong codes did not revoke the link");
    assert.equal(row.pending_password_hash, null, "a revoked invitation kept the password hash");
    assert.equal(row.pending_totp_ciphertext, null, "a revoked invitation kept the secret");
    // Even the right code is now refused, and nothing was ever written.
    await assert.rejects(() => completeStaffEnrolment(database.pool, { token: issued.token, code: totpCode(setup.totpSecret) }, KEY), invalid());
    assert.equal(await credential("eve"), undefined);
    const actions = (await audits("eve")).map((event) => event.action);
    assert.equal(actions.filter((action) => action === "staff.enrolment.code_rejected").length, MAX_CODE_ATTEMPTS - 1);
    assert.equal(actions.at(-1), "staff.enrolment.locked");
  });

  it("repeating setup issues a new secret; the old one no longer confirms, and failed codes are not forgiven", async () => {
    await member("flo", "flo@example.org");
    const issued = await issue("flo");
    const first = await startStaffEnrolment(database.pool, { token: issued.token, password: PASSWORD }, KEY);
    await assert.rejects(() => completeStaffEnrolment(database.pool, { token: issued.token, code: totpCode(first.totpSecret) === "000000" ? "111111" : "000000" }, KEY), invalid(/incorrect/));
    const second = await startStaffEnrolment(database.pool, { token: issued.token, password: PASSWORD }, KEY);
    assert.notEqual(second.totpSecret, first.totpSecret);
    assert.equal((await invitation(issued.invitationId)).failed_code_attempts, 1, "restarting setup forgave a failed code");
    if (totpCode(first.totpSecret) !== totpCode(second.totpSecret)) {
      await assert.rejects(() => completeStaffEnrolment(database.pool, { token: issued.token, code: totpCode(first.totpSecret) }, KEY), invalid(/incorrect/));
    }
    await completeStaffEnrolment(database.pool, { token: issued.token, code: totpCode(second.totpSecret) }, KEY);
    assert.equal((await audits("flo")).find((event) => event.action === "staff.enrolment.setup" && event.after_json.restarted === true) !== undefined, true);
  });

  it("the right code writes the credential at the member's address, consumes the link, clears the secrets — and signs in", async () => {
    await member("gus", "Gus@Example.org");
    const issued = await issue("gus");
    const setup = await enrol(issued.token);
    const written = await credential("gus");
    assert.equal(written.enabled, true);
    assert.equal(written.email_normalized, "gus@example.org");
    const row = await invitation(issued.invitationId);
    assert.ok(row.consumed_at);
    for (const column of ["pending_password_salt", "pending_password_hash", "pending_totp_ciphertext", "pending_totp_iv", "pending_totp_tag"]) {
      assert.equal(row[column], null, `${column} survived consumption`);
    }
    await assert.rejects(() => startStaffEnrolment(database.pool, { token: issued.token, password: PASSWORD }, KEY), invalid(), "a consumed link worked again");
    assert.deepEqual((await audits("gus")).map((event) => event.action), ["staff.enrolment.issue", "staff.enrolment.setup", "staff.enrolment.complete"]);
    assert.ok((await audits("gus")).slice(1).every((event) => event.actor_id === "gus"), "the person's own steps are not attributed to them");

    // The proof that matters: the ordinary staff sign-in accepts what the person set, and nothing else.
    const challenge = await startStaffLogin(database.pool, { organisationId: ORG, email: "gus@example.org", password: PASSWORD });
    const session = await completeStaffMfa(database.pool, { organisationId: ORG, challengeToken: challenge.challengeToken, code: totpCode(setup.totpSecret) }, KEY);
    assert.equal(session.userId, "gus");
    await assert.rejects(() => startStaffLogin(database.pool, { organisationId: ORG, email: "gus@example.org", password: "the-wrong-passphrase" }));
  });

  it("will not enrol over working sign-in — a second invitation for an enrolled person is refused at setup", async () => {
    const issued = await issue("gus");
    await assert.rejects(() => startStaffEnrolment(database.pool, { token: issued.token, password: PASSWORD }, KEY), invalid(/already has working sign-in/));
    assert.equal((await credential("gus")).enabled, true, "the working credential was disturbed");
  });

  // ── The boundaries, tried directly ───────────────────────────────────────────────────────────────────────

  it("the operator's role cannot read the token hash or anything the person set", async () => {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE nzi_console_app");
      await db.query(`SELECT set_config('app.organisation_id', $1, true)`, [ORG]);
      const allowed = await db.query(`SELECT invitation_id, user_id, expires_at, consumed_at FROM nzi_console.staff_enrolment_invitations`);
      assert.ok(allowed.rows.length > 0, "the operator's role cannot see invitations at all");
      for (const column of ["token_hash", "pending_password_hash", "pending_totp_ciphertext"]) {
        await db.query("SAVEPOINT probe");
        await assert.rejects(() => db.query(`SELECT ${column} FROM nzi_console.staff_enrolment_invitations`), /permission denied/, `the app role read ${column}`);
        await db.query("ROLLBACK TO SAVEPOINT probe");
      }
      await assert.rejects(() => db.query(`DELETE FROM nzi_console.staff_enrolment_invitations`), /permission denied/);
    } finally { await db.query("ROLLBACK"); }
  });

  it("the auth role may write enrolment audit events and nothing else to the trail — and cannot read it", async () => {
    const event = (action: string, entityType = "staff_enrolment_invitation") => db.query(
      `INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id)
       VALUES ($1,$2,'x','staff',$3,$4,'x',$2)`, [ORG, `probe-${randomBytes(4).toString("hex")}`, action, entityType]);
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE nzi_console_auth");
      await db.query(`SELECT set_config('app.organisation_id', 'authentication', true)`);
      await db.query("SAVEPOINT ok"); await event("staff.enrolment.setup"); await db.query("RELEASE SAVEPOINT ok");
      for (const [action, entityType] of [["client.delete", "staff_enrolment_invitation"], ["staff.enrolment.setup", "client"], ["staff.enrolment.issue", "staff_enrolment_invitation"]] as const) {
        await db.query("SAVEPOINT probe");
        await assert.rejects(() => event(action, entityType), /row-level security/, `the auth role wrote ${action} on ${entityType}`);
        await db.query("ROLLBACK TO SAVEPOINT probe");
      }
      await assert.rejects(() => db.query(`SELECT 1 FROM nzi_console.audit_events`), /permission denied/);
    } finally { await db.query("ROLLBACK"); }
  });

  it("a closed invitation cannot hold a secret — the database refuses it, whoever writes", async () => {
    await member("hal", "hal@example.org");
    const issued = await issue("hal");
    await startStaffEnrolment(database.pool, { token: issued.token, password: PASSWORD }, KEY);
    await assert.rejects(() => db.query(`UPDATE nzi_console.staff_enrolment_invitations SET consumed_at = now() WHERE invitation_id=$1`, [issued.invitationId]),
      /staff_enrolment_closed_holds_nothing|staff_enrolment_pending_shape/);
    await assert.rejects(() => issue("hal").then(() => db.query(
      `INSERT INTO nzi_console.staff_enrolment_invitations (organisation_id,invitation_id,user_id,token_hash,expires_at,created_by)
       VALUES ($1,'second-open','hal',repeat('a',64),now() + interval '1 hour','x')`, [ORG])), /staff_enrolment_one_open_per_person/);
  });
});
