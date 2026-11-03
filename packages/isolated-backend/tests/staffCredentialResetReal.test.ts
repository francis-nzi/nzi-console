import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { PERMISSION_MATRIX_VERSION, roleCapabilityGrants, staffRoles, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { AuthorizationError, completeStaffMfa, resolveStaffPrincipal, startStaffLogin, totpCode, type StaffPrincipal } from "../src/index";
import { withAuthTransaction } from "../src/postgres";
import { issueRecoveryCodes } from "../src/mfaRecovery";
import { createHash } from "node:crypto";
import { completeStaffEnrolment, issueStaffEnrolmentInvitation, StaffEnrolmentError, startStaffEnrolment } from "../src/staffEnrolment";
import { assignStaffRole } from "../src/staffAdmin";
import { inviteStaffMember } from "../src/staffInvitations";
import { resetStaffSignIn } from "../src/staffCredentialReset";

/**
 * The Admin recovery path (matrix v11, `staff.credential.reset`; 0203, 0204), against a real database.
 *
 * Proved end to end with real sign-in: an enrolled member with no working authenticator is recovered by an Admin and signs in
 * with a fresh one; the old session, pending sign-in, password, authenticator and recovery codes all stop working; the reset is
 * one transaction (a failed email undoes it); an admin cannot reset themselves; another member and the portal are untouched.
 */

const ORG = "net-zero-international";
const KEY = randomBytes(32).toString("base64");
const OLD_PASSWORD = "the-old-long-passphrase";
const NEW_PASSWORD = "a-brand-new-long-passphrase";
const ORIGIN = "https://console.example.org";
const DEPS = { consoleOrigin: ORIGIN };

describe("an Admin resets an enrolled member's sign-in (matrix v11)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let lead: StaffPrincipal;
  let boss: StaffPrincipal;

  const member = (userId: string, role: StaffRole = "viewer", email: string | null = `${userId}@example.org`) => db.query(
    `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name,email) VALUES ($1,$2,$3,'active',$2,$4)`, [ORG, userId, role, email]);
  const tokenFrom = (link: string) => { const match = /\/enrol#token=([A-Za-z0-9_-]{43})$/.exec(link); assert.ok(match, `not an enrolment link: ${link}`); return match[1]!; };
  const enrol = async (token: string, password: string) => {
    const setup = await startStaffEnrolment(database.pool, { token, password }, KEY);
    const done = await completeStaffEnrolment(database.pool, { token, code: totpCode(setup.totpSecret) }, KEY);
    assert.deepEqual(done, { enrolled: true }, "enrolment issues no recovery codes");
    return { secret: setup.totpSecret };
  };
  const enrolByOperator = async (userId: string, password = OLD_PASSWORD) =>
    enrol((await issueStaffEnrolmentInvitation(database.pool, { organisationId: ORG, userId, actorId: "operator:francis" })).token, password);
  const signIn = async (email: string, password: string, secret: string) => {
    const challenge = await startStaffLogin(database.pool, { organisationId: ORG, email, password });
    return completeStaffMfa(database.pool, { organisationId: ORG, challengeToken: challenge.challengeToken, code: totpCode(secret) }, KEY);
  };
  const principalAs = (role: StaffRole, userId = `someone-${role}`): StaffPrincipal => ({
    organisationId: ORG, userId, sessionId: "s", issuedAt: 1, expiresAt: 2, role, matrixVersion: PERMISSION_MATRIX_VERSION, capabilities: roleCapabilityGrants(role),
  }) as StaffPrincipal;
  const events = async (action: string) => (await db.query<{ actor_id: string; principal_type: string; entity_type: string; entity_id: string; reason: string | null; after_json: any }>(
    `SELECT actor_id, principal_type, entity_type, entity_id, reason, after_json FROM nzi_console.audit_events WHERE action=$1 ORDER BY occurred_at`, [action])).rows;
  const credential = async (userId: string) => (await db.query<{ enabled: boolean }>(`SELECT enabled FROM nzi_console.staff_credentials WHERE user_id=$1`, [userId])).rows[0];
  const liveCodes = async (principal: "staff" | "portal", subject: string) => (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM nzi_console.mfa_recovery_codes WHERE principal=$1 AND subject_id=$2 AND used_at IS NULL AND revoked_at IS NULL`, [principal, subject])).rows[0]!.n;
  const reason = "Lost phone, confirmed by video call";

  let rae: { secret: string };
  let uma: { secret: string };
  let raeSession: Awaited<ReturnType<typeof signIn>>;
  let umaSession: Awaited<ReturnType<typeof signIn>>;

  before(async () => {
    database = (await createDisposableDatabase("staffcredreset"))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    // Two admins (so the last-admin rule has something to protect), signed in for real.
    await member("lead"); await member("boss");
    const leadSecret = (await enrolByOperator("lead")).secret, bossSecret = (await enrolByOperator("boss")).secret;
    for (const userId of ["lead", "boss"]) await assignStaffRole(database.pool, { organisationId: ORG, userId, role: "admin", actorId: "operator:francis", reason: "Admins for the reset suite" });
    lead = await resolveStaffPrincipal(database.pool, await signIn("lead@example.org", OLD_PASSWORD, leadSecret));
    boss = await resolveStaffPrincipal(database.pool, await signIn("boss@example.org", OLD_PASSWORD, bossSecret));
    await member("rae"); await member("uma");
    rae = await enrolByOperator("rae"); uma = await enrolByOperator("uma");
    // Staff recovery codes are no longer issued; a set stored before that change is seeded directly, so the reset is shown to revoke it.
    for (const user of ["rae", "uma"]) for (let n = 0; n < 10; n += 1) {
      await db.query(`INSERT INTO nzi_console.mfa_recovery_codes (organisation_id, code_id, principal, subject_id, batch_id, code_hash) VALUES ($1,$2,'staff',$3,'legacy',$4)`,
        [ORG, `legacy-${user}-${n}`, user, createHash("sha256").update(`${user}${n}`).digest("hex")]);
    }
    raeSession = await signIn("rae@example.org", OLD_PASSWORD, rae.secret);
    umaSession = await signIn("uma@example.org", OLD_PASSWORD, uma.secret);
    // A portal account's recovery codes, to prove the portal flow is not touched.
    await withAuthTransaction(database.pool, "write", (tx) => issueRecoveryCodes(tx, { organisationId: ORG, principal: "portal", subjectId: "portal-1" }));
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("matrix v11 grants staff.credential.reset to Admin and to no other role; staff.invite is unchanged", async () => {
    assert.ok(PERMISSION_MATRIX_VERSION >= 11);
    const holders = await db.query<{ role_id: string; scope: string }>(
      `SELECT role_id, scope FROM nzi_console.staff_role_capabilities WHERE matrix_version = 11 AND capability = 'staff.credential.reset'`);
    assert.deepEqual(holders.rows, [{ role_id: "admin", scope: "all" }]);
    for (const role of staffRoles) assert.equal(roleCapabilityGrants(role).some((grant) => grant.capability === "staff.credential.reset"), role === "admin", role);
    assert.ok(lead.capabilities.some((grant) => grant.capability === "staff.credential.reset"), "a real admin session lacks the capability");
    await assert.rejects(() => inviteStaffMember(database.pool, lead, { userId: "rae" }, DEPS), /already enrolled/, "staff.invite must still not reach an enrolled member");
  });

  it("every role but Admin is refused, and nothing changes", async () => {
    for (const role of staffRoles.filter((entry) => entry !== "admin")) {
      await assert.rejects(() => resetStaffSignIn(database.pool, principalAs(role), { userId: "rae", reason }, DEPS), AuthorizationError, role);
    }
    assert.equal((await credential("rae"))!.enabled, true);
  });

  it("refuses yourself, a non-member, a member who never enrolled, a missing reason — each leaving everything as it was", async () => {
    await member("newbie");
    await assert.rejects(() => resetStaffSignIn(database.pool, lead, { userId: "lead", reason }, DEPS), /cannot reset your own/);
    await assert.rejects(() => resetStaffSignIn(database.pool, lead, { userId: "nobody", reason }, DEPS), /not a member/);
    await assert.rejects(() => resetStaffSignIn(database.pool, lead, { userId: "newbie", reason }, DEPS), /not enrolled yet.*Invite them instead/);
    await assert.rejects(() => resetStaffSignIn(database.pool, lead, { userId: "rae", reason: "  short " }, DEPS), /Say why/);
    assert.equal((await db.query(`SELECT 1 FROM nzi_console.staff_enrolment_invitations WHERE user_id='newbie'`)).rows.length, 0, "a refused reset left an invitation behind");
    assert.equal((await credential("rae"))!.enabled, true);
    assert.equal((await resolveStaffPrincipal(database.pool, raeSession)).userId, "rae", "a refused reset ended a session");
    assert.equal((await events("staff.credential.reset")).length, 0, "a refused reset was audited as done");
  });

  it("if the email cannot be queued, nothing is reset — the reset and its way back are one transaction", async () => {
    await db.query(`INSERT INTO nzi_console.message_templates (organisation_id, template_key, subject, body, created_by, updated_by)
      VALUES ($1, 'staff.invitation', 'Join us', 'No link here', 'tester', 'tester')`, [ORG]);
    try {
      await assert.rejects(() => resetStaffSignIn(database.pool, lead, { userId: "rae", reason }, DEPS), /could not be queued, so nothing was reset/);
      assert.equal((await credential("rae"))!.enabled, true, "the credential was retired by a reset that rolled back");
      assert.equal((await resolveStaffPrincipal(database.pool, raeSession)).userId, "rae", "the session ended by a reset that rolled back");
      assert.equal(await liveCodes("staff", "rae"), 10, "recovery codes revoked by a reset that rolled back");
      assert.equal((await events("staff.credential.reset")).length, 0);
    } finally {
      await db.query(`UPDATE nzi_console.message_templates SET active = false WHERE organisation_id = $1 AND template_key = 'staff.invitation'`, [ORG]);
    }
  });

  it("recovers a member with no authenticator end to end: old sign-in ends, a fresh invitation re-enrols them, they sign in anew", async () => {
    // A sign-in waiting on its MFA code when the reset lands.
    const pending = await startStaffLogin(database.pool, { organisationId: ORG, email: "rae@example.org", password: OLD_PASSWORD });
    const portalBefore = await liveCodes("portal", "portal-1");

    const result = await resetStaffSignIn(database.pool, lead, { userId: "rae", reason }, DEPS);
    assert.equal(result.delivery, "email");
    if (result.delivery !== "email") return;
    assert.ok(!JSON.stringify(result).includes("#token="), "the admin was handed the link");
    assert.equal(result.sentTo, "rae@example.org");
    assert.ok(result.sessionsEnded >= 1 && result.challengesEnded >= 1, JSON.stringify(result));
    assert.equal(result.recoveryCodesRevoked, 10);

    // Retired, not deleted.
    assert.deepEqual(await credential("rae"), { enabled: false });
    // Everything that was theirs stops working.
    await assert.rejects(() => resolveStaffPrincipal(database.pool, raeSession), "the old session survived the reset");
    assert.equal((await completeStaffMfa(database.pool, { organisationId: ORG, challengeToken: pending.challengeToken, code: totpCode(rae.secret) }, KEY).catch(() => "refused")), "refused", "a pending sign-in survived the reset");
    await assert.rejects(() => startStaffLogin(database.pool, { organisationId: ORG, email: "rae@example.org", password: OLD_PASSWORD }), "the old password still signs in");
    assert.equal(await liveCodes("staff", "rae"), 0);

    // The audit: ids, counts and the reason — no secret, no address.
    const [event, ...more] = await events("staff.credential.reset");
    assert.equal(more.length, 0);
    assert.deepEqual([event!.actor_id, event!.principal_type, event!.entity_type, event!.entity_id, event!.reason], ["lead", "staff", "membership", "rae", reason]);
    assert.deepEqual(Object.keys(event!.after_json).sort(), ["challengesEnded", "delivery", "invitationId", "recoveryCodesRevoked", "sessionsEnded", "userId"]);
    assert.ok(!/token|@example\.org/.test(JSON.stringify(event!.after_json)));

    // The invitation: emailed, single-use, time-limited — and it is their way back.
    const [email] = (await db.query<{ template_code: string; to_email: string; text_body: string }>(
      `SELECT template_code, to_email, text_body FROM nzi_console.email_messages WHERE correlation_id = $1`, [result.invitationId])).rows;
    assert.deepEqual([email!.template_code, email!.to_email], ["staff.invitation", "rae@example.org"]);
    const token = tokenFrom(/https:\/\/\S+\/enrol#token=[A-Za-z0-9_-]{43}/.exec(email!.text_body)![0]);
    const fresh = await enrol(token, NEW_PASSWORD);
    assert.notEqual(fresh.secret, rae.secret, "the authenticator was not replaced");
    assert.deepEqual(await credential("rae"), { enabled: true });
    const session = await signIn("rae@example.org", NEW_PASSWORD, fresh.secret);
    assert.equal((await resolveStaffPrincipal(database.pool, session)).userId, "rae");
    await assert.rejects(() => startStaffLogin(database.pool, { organisationId: ORG, email: "rae@example.org", password: OLD_PASSWORD }), "the old password works after re-enrolment");
    await assert.rejects(() => startStaffEnrolment(database.pool, { token, password: NEW_PASSWORD }, KEY), StaffEnrolmentError, "the link worked twice");
    assert.equal(await liveCodes("portal", "portal-1"), portalBefore, "the portal's recovery codes were touched");
  });

  it("other members are untouched: their credential, session and recovery codes all still work", async () => {
    assert.deepEqual(await credential("uma"), { enabled: true });
    assert.equal((await resolveStaffPrincipal(database.pool, umaSession)).userId, "uma");
    assert.equal(await liveCodes("staff", "uma"), 10);
    assert.equal((await signIn("uma@example.org", OLD_PASSWORD, uma.secret)).userId, "uma");
    assert.deepEqual(await credential("boss"), { enabled: true });
  });

  it("a reset can be issued as a link to copy, returned once and never stored", async () => {
    const result = await resetStaffSignIn(database.pool, boss, { userId: "uma", reason, delivery: "link" }, DEPS);
    assert.equal(result.delivery, "link");
    if (result.delivery !== "link") return;
    const token = tokenFrom(result.link);
    assert.ok(!JSON.stringify((await db.query(`SELECT * FROM nzi_console.staff_enrolment_invitations WHERE invitation_id=$1`, [result.invitationId])).rows).includes(token), "the token was stored");
    const issued = (await events("staff.enrolment.issue")).find((event) => event.entity_id === result.invitationId)!;
    assert.deepEqual([issued.actor_id, issued.after_json.delivery], ["boss", "admin-link"]);
    const fresh = await enrol(token, NEW_PASSWORD);
    assert.equal((await signIn("uma@example.org", NEW_PASSWORD, fresh.secret)).userId, "uma");
  });

  it("the organisation is never left without an admin: resetting the only active admin is refused", async () => {
    await assignStaffRole(database.pool, { organisationId: ORG, userId: "lead", role: "viewer", actorId: "operator:francis", reason: "Leave boss as the only admin" });
    // A session that outlived its admin role still holds the capability in memory; the database is the authority.
    await assert.rejects(() => resetStaffSignIn(database.pool, principalAs("admin", "ghost"), { userId: "boss", reason }, DEPS), /only active admin/);
    assert.deepEqual(await credential("boss"), { enabled: true });
  });
});
