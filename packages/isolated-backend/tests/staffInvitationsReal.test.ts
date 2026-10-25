import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { parseListQuery, PERMISSION_MATRIX_VERSION, roleCapabilityGrants, staffListSpec, staffRoles, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { AuthorizationError, completeStaffMfa, resolveStaffPrincipal, startStaffLogin, totpCode, type StaffPrincipal } from "../src/index";
import { emailDispatchFromEnv } from "../src/email";
import { suppressingMailer } from "../src/mailer";
import { withTenantRead, withTenantWorker } from "../src/postgres";
import {
  completeStaffEnrolment, issueStaffEnrolmentInvitation, MAX_ADMIN_INVITES_PER_WINDOW, StaffEnrolmentError, startStaffEnrolment,
} from "../src/staffEnrolment";
import { assignStaffRole, listStaffPage } from "../src/staffAdmin";
import { drainOutbox } from "../src/strategyReminderWorker";
import { inviteStaffMember } from "../src/staffInvitations";
import { CommandValidationError } from "../src/postgresCommands";

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
const DEPS = { consoleOrigin: ORIGIN };
const LINK = { delivery: "link" as const };

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

  it("matrix v8 grants staff.invite to Admin and to no other role — and every later version keeps it so", async () => {
    // v8 introduced it; later versions (v9 added time.log / time.view) must carry it unchanged.
    assert.ok(PERMISSION_MATRIX_VERSION >= 8);
    for (const version of [8, PERMISSION_MATRIX_VERSION]) {
      const holders = await db.query<{ role_id: string; scope: string }>(
        `SELECT role_id, scope FROM nzi_console.staff_role_capabilities WHERE matrix_version = $1 AND capability = 'staff.invite'`, [version]);
      assert.deepEqual(holders.rows, [{ role_id: "admin", scope: "all" }], `matrix v${version}`);
    }
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
    await assert.rejects(() => inviteStaffMember(database.pool, asViewer, { userId: "anyone" }, DEPS), AuthorizationError,
      "a freshly enrolled member could invite before being made Admin");

    const changed = await assignStaffRole(database.pool, { organisationId: ORG, userId: "lead", role: "admin", actorId: "operator:francis", reason: "First admin for net-zero-international" });
    assert.deepEqual(changed, { from: "viewer", to: "admin" });
    const [assigned] = await events("staff.role.assign");
    assert.equal(assigned!.actor_id, "operator:francis");
    assert.equal(assigned!.principal_type, "system");
    assert.equal(assigned!.entity_id, "lead");
    assert.equal(assigned!.reason, "First admin for net-zero-international");
    // The operator path runs the console command (ruled Q9): the same event, ids and roles only.
    assert.deepEqual([assigned!.before_json.role, assigned!.after_json.role, assigned!.after_json.userId], ["viewer", "admin", "lead"]);

    admin = await resolveStaffPrincipal(database.pool, await signIn("lead@example.org", secret));
    assert.equal(admin.role, "admin");
    assert.equal(admin.matrixVersion, PERMISSION_MATRIX_VERSION, "the session did not resolve against the current matrix");
    assert.ok(admin.capabilities.some((grant) => grant.capability === "staff.invite"), "the first admin cannot invite");
  });

  it("the admin issues a colleague a link to copy; the link enrols them and they sign in — through the one enrolment path", async () => {
    await member("rae");
    const result = await inviteStaffMember(database.pool, admin, { userId: "rae", ...LINK }, DEPS);
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
      await assert.rejects(() => inviteStaffMember(database.pool, principalAs(role), { userId: "sam" }, DEPS), AuthorizationError, role);
    }
    assert.equal(await openInvitations("sam"), 0);
  });

  it("refuses inviting yourself, a non-member, and a member with no work address", async () => {
    await member("noaddress", null);
    await assert.rejects(() => inviteStaffMember(database.pool, admin, { userId: "lead" }, DEPS), /cannot issue your own/);
    await assert.rejects(() => inviteStaffMember(database.pool, admin, { userId: "nobody" }, DEPS), /not a member/);
    await assert.rejects(() => inviteStaffMember(database.pool, admin, { userId: "noaddress" }, DEPS), /no work address/);
  });

  it("an enrolled colleague is not reinvited by an admin; the operator's break-glass link still cannot enrol over working sign-in", async () => {
    for (const delivery of ["email", "link"] as const) {
      await assert.rejects(() => inviteStaffMember(database.pool, admin, { userId: "rae", delivery }, DEPS), /already enrolled/, delivery);
    }
    const operator = await issueStaffEnrolmentInvitation(database.pool, { organisationId: ORG, userId: "rae", actorId: "operator:francis" });
    await assert.rejects(() => startStaffEnrolment(database.pool, { token: operator.token, password: PASSWORD }, KEY), /already has working sign-in/);
  });

  // ── Delivery ─────────────────────────────────────────────────────────────────────────────────────────────

  const emailFor = async (invitationId: string) => (await db.query<{ template_code: string; to_email: string; subject: string; text_body: string; html_body: string; status: string }>(
    `SELECT template_code, to_email, subject, text_body, html_body, status FROM nzi_console.email_messages WHERE correlation_id = $1`, [invitationId])).rows;
  const linkIn = (text: string) => /https:\/\/\S+\/enrol#token=[A-Za-z0-9_-]{43}/.exec(text)![0];

  it("by default the invitation is emailed through sendTemplatedEmail, queued with the issue; the admin never holds the link", async () => {
    await member("uma");
    const result = await inviteStaffMember(database.pool, admin, { userId: "uma" }, DEPS);
    assert.equal(result.delivery, "email");
    if (result.delivery !== "email") return;
    assert.ok(!("link" in result) && !JSON.stringify(result).includes("#token="), "the admin was handed the link");
    assert.equal(result.sentTo, "uma@example.org");
    assert.equal(result.reinvite, false);
    const [email, ...more] = await emailFor(result.invitationId);
    assert.equal(more.length, 0, "one email per invitation");
    assert.equal(email!.template_code, "staff.invitation");
    assert.equal(email!.to_email, "uma@example.org");
    assert.equal(email!.status, "queued");
    assert.equal(email!.subject, "Set up your NZ Insights Pro sign-in", "no template of its own: the built-in wording");
    const link = linkIn(email!.text_body);
    assert.ok(email!.html_body.includes(`href="${link}"`), "the HTML part links the same link");
    assert.match(email!.text_body, /expires at \w+day, \d{1,2} \w+ 20\d\d at \d\d:\d\d \(UK time\)/, "the expiry is written for people");
    const issued = (await events("staff.enrolment.issue")).find((event) => event.entity_id === result.invitationId)!;
    assert.equal(issued.after_json.delivery, "email");
    const secret = await enrol(tokenFrom(link));
    assert.equal((await signIn("uma@example.org", secret)).userId, "uma", "the emailed link enrols them on /enrol");
  });

  it("words the invitation in the organisation's own template, with {{inviteLink}}", async () => {
    await member("una");
    await db.query(`INSERT INTO nzi_console.message_templates (organisation_id, template_key, subject, body, created_by, updated_by)
      VALUES ($1, 'staff.invitation', 'Join us', 'Start here: {{inviteLink}} (until {{expiresAt}})', 'tester', 'tester')`, [ORG]);
    try {
      const result = await inviteStaffMember(database.pool, admin, { userId: "una" }, DEPS);
      const [email] = await emailFor(result.invitationId);
      assert.equal(email!.subject, "Join us");
      assert.match(email!.text_body, new RegExp(`^Start here: ${ORIGIN.replace(/\./g, "\\.")}/enrol#token=[A-Za-z0-9_-]{43} \\(until .+ \\(UK time\\)\\)`));
    } finally {
      await db.query(`UPDATE nzi_console.message_templates SET active = false WHERE organisation_id = $1 AND template_key = 'staff.invitation'`, [ORG]);
    }
  });

  it("if the email cannot be queued, nothing is issued at all — the link and its email are one transaction", async () => {
    await member("vic");
    // Wording that has drifted outside its tokens (written past the command): the strict render refuses it.
    await db.query(`UPDATE nzi_console.message_templates SET body = 'No link here', active = true WHERE organisation_id = $1 AND template_key = 'staff.invitation'`, [ORG]);
    try {
      await assert.rejects(() => inviteStaffMember(database.pool, admin, { userId: "vic" }, DEPS), /could not be queued, so no link was issued/);
      assert.equal((await db.query(`SELECT 1 FROM nzi_console.staff_enrolment_invitations WHERE user_id = 'vic'`)).rows.length, 0, "no invitation row, live or revoked");
      assert.ok(!(await events("staff.enrolment.issue")).some((event) => event.after_json.userId === "vic"), "no issue event survives a rolled-back issue");
    } finally {
      await db.query(`UPDATE nzi_console.message_templates SET active = false WHERE organisation_id = $1 AND template_key = 'staff.invitation'`, [ORG]);
    }
  });

  // ── Reinvite (R5) ────────────────────────────────────────────────────────────────────────────────────────

  it("reinvite revokes the earlier link, emails a new one, is audited as a reinvite — and an admin may send one member three an hour", async () => {
    await member("wes");
    const first = await inviteStaffMember(database.pool, admin, { userId: "wes" }, DEPS);
    const firstLink = linkIn((await emailFor(first.invitationId))[0]!.text_body);
    const second = await inviteStaffMember(database.pool, admin, { userId: "wes" }, DEPS);
    assert.equal(second.reinvite, true);
    await assert.rejects(() => startStaffEnrolment(database.pool, { token: tokenFrom(firstLink), password: PASSWORD }, KEY), StaffEnrolmentError, "the earlier link still worked");
    const revoked = (await events("staff.enrolment.revoke")).find((event) => event.entity_id === first.invitationId)!;
    assert.deepEqual([revoked.actor_id, revoked.after_json.reason], ["lead", "superseded by a new invitation"]);
    const issued = (await events("staff.enrolment.issue")).find((event) => event.entity_id === second.invitationId)!;
    assert.deepEqual([issued.actor_id, issued.principal_type, issued.after_json.reinvite], ["lead", "staff", true]);

    // A third is allowed (three in the window); a fourth is refused, and nothing is issued or sent for it.
    const third = await inviteStaffMember(database.pool, admin, { userId: "wes", ...LINK }, DEPS);
    assert.equal(MAX_ADMIN_INVITES_PER_WINDOW, 3);
    const before = (await db.query(`SELECT count(*)::int AS n FROM nzi_console.email_messages`)).rows[0].n;
    await assert.rejects(() => inviteStaffMember(database.pool, admin, { userId: "wes" }, DEPS), /3 invitations in the last hour/);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.email_messages`)).rows[0].n, before, "a refused reinvite sent nothing");
    assert.equal((await db.query(`SELECT revoked_at FROM nzi_console.staff_enrolment_invitations WHERE invitation_id = $1`, [third.invitationId])).rows[0].revoked_at, null,
      "a refused reinvite does not withdraw the link they already have");
    // The operator's break-glass is not limited.
    await issueStaffEnrolmentInvitation(database.pool, { organisationId: ORG, userId: "wes", actorId: "operator:francis" });
  });

  // ── The roster's sign-in column ──────────────────────────────────────────────────────────────────────────

  it("Team & access shows each member's sign-in state and how their latest invitation's email resolved", async () => {
    await member("xan");
    const invited = await inviteStaffMember(database.pool, admin, { userId: "xan" }, DEPS);
    const roster = async () => (await withTenantRead(database.pool, ORG, (read) => listStaffPage(read, { ...parseListQuery({}, staffListSpec).query, pageSize: 100 }))).rows;
    const row = async (userId: string) => (await roster()).find((entry) => entry.userId === userId)!;
    assert.deepEqual([(await row("xan")).signIn, (await row("xan")).inviteEmail], ["invited", "queued"]);
    assert.deepEqual([(await row("uma")).signIn, (await row("sam")).signIn, (await row("sam")).inviteEmail], ["enrolled", "none", null]);

    // The email pipe stubs example.org on the isolated boundary, and the row says so — which is what offers the copy-a-link fallback.
    await withTenantWorker(database.pool, ORG, (worker) => drainOutbox(worker, {
      organisationId: ORG, today: "2026-10-25", mailer: suppressingMailer(), delivery: { mode: "suppress", reason: "test" },
      email: emailDispatchFromEnv({ NZI_DATABASE_BOUNDARY: "isolated-non-production", RESEND_API_KEY: "re_test_key_0123456789", EMAIL_FROM: "no-reply@netzero.international" }),
    }));
    assert.equal((await row("xan")).inviteEmail, "stubbed");
    assert.equal(invited.delivery, "email");
    // A link issued to copy carries no email, so the row stops showing the stubbed one.
    await inviteStaffMember(database.pool, admin, { userId: "xan", ...LINK }, DEPS);
    assert.deepEqual([(await row("xan")).signIn, (await row("xan")).inviteEmail], ["invited", null]);
  });

  // ── The operator's role command ──────────────────────────────────────────────────────────────────────────

  it("the role command refuses an unknown role, no reason, no change, and a non-member", async () => {
    const assign = (userId: string, role: string, reason = "Needs to publish reports") =>
      assignStaffRole(database.pool, { organisationId: ORG, userId, role, actorId: "operator:francis", reason });
    const says = (pattern: RegExp) => (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => pattern.test(issue.message));
    await assert.rejects(() => assign("sam", "superuser"), says(/not a staff role/));
    await assert.rejects(() => assign("sam", "reviewer", "because"), says(/needs a reason/));
    await assert.rejects(() => assign("lead", "admin"), says(/already has the admin role/));
    await assert.rejects(() => assign("nobody", "reviewer"), says(/not a member/));
  });
});
