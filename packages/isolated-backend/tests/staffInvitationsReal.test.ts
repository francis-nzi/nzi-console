import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { PERMISSION_MATRIX_VERSION, roleCapabilityGrants, staffRoles, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { AuthorizationError, completeStaffMfa, resolveStaffPrincipal, startStaffLogin, totpCode, type StaffPrincipal } from "../src/index";
import type { MailMessage } from "../src/mailer";
import { completeStaffEnrolment, issueStaffEnrolmentInvitation, StaffEnrolmentError, startStaffEnrolment } from "../src/staffEnrolment";
import { assignStaffRole, inviteStaffMember, listStaffEnrolmentRoster } from "../src/staffInvitations";

/**
 * Staff invitations from the admin (matrix v8, `staff.invite`), against a real database in net-zero-international.
 *
 * The bootstrap is proved end to end with real sign-in: a roster member (least privilege) enrols through the operator
 * path, is made Admin by the audited operator command, signs in — and the principal resolved from that session carries
 * `staff.invite` — then invites a colleague, who enrols from the link and signs in. Everything else is the permission
 * gate, the two deliveries, and the evidence that nothing here is a second enrolment path.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "net-zero-international";
const KEY = randomBytes(32).toString("base64");
const PASSWORD = "a-long-unique-passphrase";
const ORIGIN = "https://console.example.org";
const SUPPRESSED = { consoleOrigin: ORIGIN, mail: { mode: "suppress" as const, reason: "isolated" } };

describe("staff invitations from the admin (matrix v8)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let admin: StaffPrincipal;
  const member = (userId: string, email: string | null = `${userId}@example.org`) => db.query(
    `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name,email) VALUES ($1,$2,'viewer','active',$2,$3)`, [ORG, userId, email]);
  const tokenFrom = (link: string) => { const match = /\/enrol#token=([A-Za-z0-9_-]{43})$/.exec(link); assert.ok(match, `not a fragment enrolment link: ${link}`); return match[1]!; };
  const enrol = async (token: string) => {
    const setup = await startStaffEnrolment(database.pool, { token, password: PASSWORD }, KEY);
    await completeStaffEnrolment(database.pool, { token, code: totpCode(setup.totpSecret) }, KEY);
    return setup.totpSecret;
  };
  const signIn = async (email: string, secret: string) => {
    const challenge = await startStaffLogin(database.pool, { organisationId: ORG, email, password: PASSWORD });
    return completeStaffMfa(database.pool, { organisationId: ORG, challengeToken: challenge.challengeToken, code: totpCode(secret) }, KEY);
  };
  const principalAs = (role: StaffRole, userId = `someone-${role}`): StaffPrincipal => ({
    organisationId: ORG, userId, sessionId: "s", issuedAt: 1, expiresAt: 2, role, matrixVersion: PERMISSION_MATRIX_VERSION, capabilities: roleCapabilityGrants(role),
  }) as StaffPrincipal;
  const events = async (action: string) => (await db.query<{ actor_id: string; principal_type: string; entity_id: string; reason: string | null; before_json: any; after_json: any }>(
    `SELECT actor_id, principal_type, entity_id, reason, before_json, after_json FROM nzi_console.audit_events WHERE action=$1 ORDER BY occurred_at`, [action])).rows;
  const openInvitations = async (userId: string) => (await db.query(
    `SELECT 1 FROM nzi_console.staff_enrolment_invitations WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL`, [userId])).rows.length;

  before(async () => {
    database = (await createDisposableDatabase("staffinvite"))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  // ── The matrix ───────────────────────────────────────────────────────────────────────────────────────────

  it("matrix v8 grants staff.invite to Admin and to no other role", async () => {
    assert.equal(PERMISSION_MATRIX_VERSION, 8);
    const holders = await db.query<{ role_id: string; scope: string }>(
      `SELECT role_id, scope FROM nzi_console.staff_role_capabilities WHERE matrix_version = 8 AND capability = 'staff.invite'`);
    assert.deepEqual(holders.rows, [{ role_id: "admin", scope: "all" }]);
    for (const role of staffRoles) {
      assert.equal(roleCapabilityGrants(role).some((grant) => grant.capability === "staff.invite"), role === "admin", role);
    }
  });

  // ── The bootstrap, with real sign-in ─────────────────────────────────────────────────────────────────────

  it("bootstrap: a least-privilege member enrols by CLI, is made Admin by the audited command, signs in holding staff.invite", async () => {
    await member("lead");
    const issued = await issueStaffEnrolmentInvitation(database.pool, { organisationId: ORG, userId: "lead", actorId: "operator:francis" });
    const secret = await enrol(issued.token);

    const viewerSession = await signIn("lead@example.org", secret);
    const asViewer = await resolveStaffPrincipal(database.pool, viewerSession);
    assert.equal(asViewer.role, "viewer");
    await assert.rejects(() => inviteStaffMember(database.pool, asViewer, { userId: "anyone" }, SUPPRESSED), AuthorizationError,
      "a freshly enrolled member could invite before being made Admin");

    const changed = await assignStaffRole(database.pool, { organisationId: ORG, userId: "lead", role: "admin", actorId: "operator:francis", reason: "First admin for net-zero-international" });
    assert.deepEqual(changed, { from: "viewer", to: "admin" });
    const [assigned] = await events("staff.role.assign");
    assert.equal(assigned!.actor_id, "operator:francis");
    assert.equal(assigned!.principal_type, "system");
    assert.equal(assigned!.entity_id, "lead");
    assert.equal(assigned!.reason, "First admin for net-zero-international");
    assert.deepEqual([assigned!.before_json, assigned!.after_json], [{ role: "viewer" }, { role: "admin" }]);

    admin = await resolveStaffPrincipal(database.pool, await signIn("lead@example.org", secret));
    assert.equal(admin.role, "admin");
    assert.equal(admin.matrixVersion, 8, "the session did not resolve against the current matrix");
    assert.ok(admin.capabilities.some((grant) => grant.capability === "staff.invite"), "the first admin cannot invite");
  });

  it("the admin invites a colleague from the console; the link enrols them and they sign in — through the one enrolment path", async () => {
    await member("rae");
    const result = await inviteStaffMember(database.pool, admin, { userId: "rae" }, SUPPRESSED);
    assert.equal(result.delivery, "link");
    if (result.delivery !== "link") return;
    const token = tokenFrom(result.link);
    assert.ok(result.link.startsWith(`${ORIGIN}/enrol#token=`), "the token is not carried in the fragment");

    // The same table, the same hashed token, the same event — attributed to the admin, as staff.
    const stored = await db.query(`SELECT * FROM nzi_console.staff_enrolment_invitations WHERE invitation_id=$1`, [result.invitationId]);
    assert.ok(!JSON.stringify(stored.rows[0]).includes(token), "the token was stored");
    const issued = (await events("staff.enrolment.issue")).find((event) => event.entity_id === result.invitationId)!;
    assert.deepEqual([issued.actor_id, issued.principal_type, issued.after_json.userId, issued.after_json.delivery], ["lead", "staff", "rae", "admin-link"]);

    const secret = await enrol(token);
    const session = await signIn("rae@example.org", secret);
    assert.equal(session.userId, "rae");
    assert.equal((await resolveStaffPrincipal(database.pool, session)).role, "viewer", "an invitation granted more than the roster role");
    await assert.rejects(() => startStaffEnrolment(database.pool, { token, password: PASSWORD }, KEY), StaffEnrolmentError, "the link worked twice");
  });

  // ── The gate ─────────────────────────────────────────────────────────────────────────────────────────────

  it("every role but Admin is refused, and nothing is issued", async () => {
    await member("sam");
    for (const role of staffRoles.filter((role) => role !== "admin")) {
      await assert.rejects(() => inviteStaffMember(database.pool, principalAs(role), { userId: "sam" }, SUPPRESSED), AuthorizationError, role);
      await assert.rejects(() => listStaffEnrolmentRoster(database.pool, principalAs(role)), AuthorizationError, `${role} read the roster`);
    }
    assert.equal(await openInvitations("sam"), 0);
  });

  it("refuses inviting yourself, a non-member, and a member with no work address", async () => {
    await member("noaddress", null);
    await assert.rejects(() => inviteStaffMember(database.pool, admin, { userId: "lead" }, SUPPRESSED), /cannot issue your own/);
    await assert.rejects(() => inviteStaffMember(database.pool, admin, { userId: "nobody" }, SUPPRESSED), /not a member/);
    await assert.rejects(() => inviteStaffMember(database.pool, admin, { userId: "noaddress" }, SUPPRESSED), /no work address/);
  });

  it("still cannot enrol over working sign-in: an admin's link for an enrolled colleague is refused at setup", async () => {
    const result = await inviteStaffMember(database.pool, admin, { userId: "rae" }, SUPPRESSED);
    assert.equal(result.delivery, "link");
    if (result.delivery !== "link") return;
    await assert.rejects(() => startStaffEnrolment(database.pool, { token: tokenFrom(result.link), password: PASSWORD }, KEY), /already has working sign-in/);
  });

  // ── Delivery ─────────────────────────────────────────────────────────────────────────────────────────────

  it("with mail enabled, the link goes to the member's work address and the admin never holds it", async () => {
    await member("uma");
    const sent: MailMessage[] = [];
    const result = await inviteStaffMember(database.pool, admin, { userId: "uma" },
      { consoleOrigin: ORIGIN, mail: { mode: "send" }, mailer: { send: async (message) => { sent.push(message); } } });
    assert.equal(result.delivery, "email");
    assert.ok(!("link" in result) && !JSON.stringify(result).includes("#token="), "the admin was handed the link");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, "uma@example.org");
    const link = /https:\/\/\S+/.exec(sent[0]!.body)![0];
    const issued = (await events("staff.enrolment.issue")).find((event) => event.entity_id === result.invitationId)!;
    assert.equal(issued.after_json.delivery, "email");
    const secret = await enrol(tokenFrom(link));
    assert.equal((await signIn("uma@example.org", secret)).userId, "uma");
  });

  it("if the email cannot be sent, the link is withdrawn rather than left live", async () => {
    await member("vic");
    await assert.rejects(() => inviteStaffMember(database.pool, admin, { userId: "vic" },
      { consoleOrigin: ORIGIN, mail: { mode: "send" }, mailer: { send: async () => { throw new Error("SMTP refused"); } } }), /could not be sent, so the link was withdrawn/);
    assert.equal(await openInvitations("vic"), 0);
    assert.ok((await events("staff.enrolment.revoke")).some((event) => event.after_json.userId === "vic"));
  });

  // ── The picker ───────────────────────────────────────────────────────────────────────────────────────────

  it("lists the active roster with each member's latest invitation, and says what it does not know", async () => {
    await member("wes");
    await inviteStaffMember(database.pool, admin, { userId: "wes" }, SUPPRESSED);
    const roster = await listStaffEnrolmentRoster(database.pool, admin);
    const state = (userId: string) => roster.find((entry) => entry.userId === userId)?.invitation?.state ?? null;
    assert.equal(state("uma"), "enrolled");
    assert.equal(state("wes"), "open");
    assert.equal(state("vic"), "revoked");
    assert.equal(state("sam"), null, "a member never invited was given a state");
    assert.equal(roster.find((entry) => entry.userId === "wes")!.email, "wes@example.org");
  });

  // ── The operator's role command ──────────────────────────────────────────────────────────────────────────

  it("the role command refuses an unknown role, no reason, no change, and a non-member", async () => {
    const assign = (userId: string, role: string, reason = "Needs to publish reports") =>
      assignStaffRole(database.pool, { organisationId: ORG, userId, role, actorId: "operator:francis", reason });
    await assert.rejects(() => assign("sam", "superuser"), /not a staff role/);
    await assert.rejects(() => assign("sam", "reviewer", "because"), /needs a reason/);
    await assert.rejects(() => assign("lead", "admin"), /already has the admin role/);
    await assert.rejects(() => assign("nobody", "reviewer"), /not a member/);
  });
});
