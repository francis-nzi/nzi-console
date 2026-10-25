import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { roleCapabilityGrants } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import type { StaffPrincipal } from "../src/auth";
import { totpCode } from "../src/credentials";
import { completePortalMfa, completeStaffMfa, InvalidLoginError, startPortalLogin, startStaffLogin } from "../src/login";
import { countRecoveryCodes, RECOVERY_CODE_COUNT, RecoveryCodeError, regenerateRecoveryCodes } from "../src/mfaRecovery";
import { completePortalInvitationSetup, createPortalInvitation, PortalInvitationError, startPortalInvitationSetup } from "../src/portalInvitations";
import { completeStaffEnrolment, issueStaffEnrolmentInvitation, startStaffEnrolment } from "../src/staffEnrolment";

/**
 * Email programme phase 4-2, against a real database: MFA recovery codes for staff and portal (issued at enrolment, shown
 * once, stored hashed, accepted once each in place of the authenticator inside the sign-in's own attempt limit, regenerated
 * only with the authenticator), and the portal access invitation (emailed by default for seven days, a link to copy on
 * request, and an accept step with a code limit, an audit trail, sessions ended and recovery codes issued).
 */

const ORG = "recovery-org";
const CLIENT = "client-r";
const KEY = randomBytes(32).toString("base64");
const ORIGIN = "https://console.example.test";
const PASSWORD = "a-long-unique-passphrase";
const admin = { organisationId: ORG, userId: "ada", sessionId: "s", issuedAt: 1, expiresAt: 2, role: "admin", matrixVersion: 1, capabilities: roleCapabilityGrants("admin") } as StaffPrincipal;

describe("MFA recovery codes and portal access invitations (phase 4-2), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let staffSecret = "";
  let staffCodes: string[] = [];
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const staffSignIn = async (code: string, onRecoveryCode?: (remaining: number) => void) => {
    const started = await startStaffLogin(database.pool, { organisationId: ORG, email: "sam@netzero.international", password: PASSWORD });
    return completeStaffMfa(database.pool, { organisationId: ORG, challengeToken: started.challengeToken, code }, KEY, new Date(), { onRecoveryCode });
  };
  const tokenIn = (text: string) => /#token=([A-Za-z0-9_-]{43})/.exec(text)![1]!;

  before(async () => {
    database = (await createDisposableDatabase("mfarecovery"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Client R Ltd', 'active')`, [ORG, CLIENT]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email) VALUES
      ($1, 'ada', 'admin', 'active', 'Ada Admin', 'ada@netzero.international'),
      ($1, 'sam', 'consultant', 'active', 'Sam Adviser', 'sam@netzero.international')`, [ORG]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  describe("staff", () => {
    it("enrolment issues ten recovery codes, shown once, stored only as hashes", async () => {
      const invitation = await issueStaffEnrolmentInvitation(database.pool, { organisationId: ORG, userId: "sam", actorId: "operator:test" });
      const setup = await startStaffEnrolment(database.pool, { token: invitation.token, password: PASSWORD }, KEY);
      staffSecret = setup.totpSecret;
      const done = await completeStaffEnrolment(database.pool, { token: invitation.token, code: totpCode(staffSecret) }, KEY);
      staffCodes = done.recoveryCodes;
      assert.equal(staffCodes.length, RECOVERY_CODE_COUNT);
      assert.equal(new Set(staffCodes).size, RECOVERY_CODE_COUNT);
      for (const code of staffCodes) assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      const stored = JSON.stringify(await q(`SELECT * FROM nzi_console.mfa_recovery_codes WHERE subject_id = 'sam'`));
      for (const code of staffCodes) {
        assert.ok(!stored.includes(code) && !stored.includes(code.replace("-", "")), "a code is stored in the clear");
      }
      assert.equal(await countRecoveryCodes(database.pool, { organisationId: ORG, principal: "staff", subjectId: "sam" }), 10);
    });

    it("a recovery code signs in once in place of the authenticator, typed loosely; the count goes down", async () => {
      let remaining: number | undefined;
      const session = await staffSignIn(` ${staffCodes[0]!.toLowerCase().replace("-", " ")} `, (left) => { remaining = left; });
      assert.equal(session.userId, "sam");
      assert.equal(remaining, 9);
      await assert.rejects(() => staffSignIn(staffCodes[0]!), InvalidLoginError, "a code works once");
      let untouched: number | undefined;
      await staffSignIn(totpCode(staffSecret), (left) => { untouched = left; });
      assert.equal(untouched, undefined, "an authenticator sign-in says nothing about recovery codes");
    });

    it("a wrong recovery code counts against the sign-in's own attempt limit", async () => {
      const started = await startStaffLogin(database.pool, { organisationId: ORG, email: "sam@netzero.international", password: PASSWORD });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await assert.rejects(() => completeStaffMfa(database.pool, { organisationId: ORG, challengeToken: started.challengeToken, code: "ABCDE-FGHJK" }, KEY), InvalidLoginError);
      }
      await assert.rejects(() => completeStaffMfa(database.pool, { organisationId: ORG, challengeToken: started.challengeToken, code: staffCodes[1]! }, KEY),
        InvalidLoginError, "five misses end the challenge, even for a good code");
      assert.equal(await countRecoveryCodes(database.pool, { organisationId: ORG, principal: "staff", subjectId: "sam" }), 9, "and the good code was not spent");
    });

    it("a new set needs the authenticator, and revokes the old set's unused codes", async () => {
      const account = { organisationId: ORG, principal: "staff" as const, subjectId: "sam" };
      await assert.rejects(() => regenerateRecoveryCodes(database.pool, account, { code: "000000" }, KEY), RecoveryCodeError);
      await assert.rejects(() => regenerateRecoveryCodes(database.pool, account, { code: staffCodes[2]! }, KEY), RecoveryCodeError, "a recovery code cannot mint more");
      const fresh = await regenerateRecoveryCodes(database.pool, account, { code: totpCode(staffSecret) }, KEY);
      assert.equal(fresh.length, 10);
      await assert.rejects(() => staffSignIn(staffCodes[2]!), InvalidLoginError, "an old unused code no longer works");
      assert.equal((await staffSignIn(fresh[0]!)).userId, "sam");
      const revoked = await q(`SELECT count(*)::int AS n FROM nzi_console.mfa_recovery_codes WHERE subject_id = 'sam' AND revoked_at IS NOT NULL`);
      assert.equal(revoked[0]!.n, 9, "the first set's nine unused codes (one was spent signing in)");
    });

    it("audits generation and use by the account's id — never a code", async () => {
      const events = await q<{ action: string; actor_id: string; after_json: unknown }>(
        `SELECT action, actor_id, after_json FROM nzi_console.audit_events WHERE action LIKE 'mfa.recovery.%' AND entity_id = 'sam'`);
      assert.equal(events.filter((event) => event.action === "mfa.recovery.generated").length, 2);
      assert.ok(events.filter((event) => event.action === "mfa.recovery.used").length >= 2);
      const all = JSON.stringify(events);
      for (const code of staffCodes) assert.ok(!all.includes(code));
    });
  });

  describe("portal access invitations", () => {
    it("are emailed by default as portal.access.invite, for seven days, with the token in the fragment; the admin never holds it", async () => {
      const now = new Date();
      const invited = await createPortalInvitation(database.pool, admin, { clientId: CLIENT, email: "Grace@NetZero.International", displayName: "Grace Example", consoleOrigin: ORIGIN }, now);
      assert.equal(invited.delivery, "email");
      assert.ok(!("token" in invited) && !JSON.stringify(invited).includes("#token="));
      assert.equal(new Date(invited.expiresAt).getTime() - now.getTime(), 7 * 24 * 60 * 60 * 1000);
      const [email] = await q<{ template_code: string; to_email: string; subject: string; text_body: string; html_body: string }>(
        `SELECT template_code, to_email, subject, text_body, html_body FROM nzi_console.email_messages WHERE correlation_id = $1`, [invited.invitationId]);
      assert.deepEqual([email!.template_code, email!.to_email], ["portal.access.invite", "grace@netzero.international"]);
      assert.equal(email!.subject, "Your NZ Insights Pro client portal access for Client R Ltd");
      assert.match(email!.text_body, /^Hello Grace Example,\n\nAda Admin at Net Zero International has given you access to Client R Ltd's client portal/);
      assert.match(email!.text_body, new RegExp(`${ORIGIN.replace(/\./g, "\\.")}/portal/invite#token=[A-Za-z0-9_-]{43}`));
      const [created] = await q(`SELECT after_json FROM nzi_console.audit_events WHERE action = 'portal.invitation.create' AND entity_id = $1`, [invited.portalUserId]);
      assert.equal(created!.after_json.delivery, "email");
    });

    it("issue a link to copy only when asked, which closes the emailed one", async () => {
      const [first] = await q<{ text_body: string }>(`SELECT text_body FROM nzi_console.email_messages WHERE template_code = 'portal.access.invite' ORDER BY created_at DESC LIMIT 1`);
      const copied = await createPortalInvitation(database.pool, admin, { clientId: CLIENT, email: "grace@netzero.international", displayName: "Grace Example", delivery: "link", consoleOrigin: ORIGIN });
      assert.equal(copied.delivery, "link");
      if (copied.delivery !== "link") return;
      assert.match(copied.link, /\/portal\/invite#token=[A-Za-z0-9_-]{43}$/);
      await assert.rejects(() => startPortalInvitationSetup(database.pool, { token: tokenIn(first!.text_body), password: PASSWORD }, KEY), PortalInvitationError, "the emailed link was closed");
    });

    it("the accept step: five wrong codes end the invitation, each audited", async () => {
      const issued = await createPortalInvitation(database.pool, admin, { clientId: CLIENT, email: "grace@netzero.international", displayName: "Grace Example", delivery: "link", consoleOrigin: ORIGIN });
      if (issued.delivery !== "link") throw new Error("expected a link");
      const setup = await startPortalInvitationSetup(database.pool, { token: issued.token, password: PASSWORD }, KEY);
      assert.match(setup.otpauthUri, /^otpauth:\/\/totp\/NZ%20Insights%20Pro%3Agrace%40netzero\.international\?secret=/);
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await assert.rejects(() => completePortalInvitationSetup(database.pool, { token: issued.token, code: "000000" }, KEY), /invalid/);
      }
      await assert.rejects(() => completePortalInvitationSetup(database.pool, { token: issued.token, code: "000000" }, KEY), /Too many incorrect codes/);
      await assert.rejects(() => completePortalInvitationSetup(database.pool, { token: issued.token, code: totpCode(setup.totpSecret) }, KEY), PortalInvitationError, "a locked invitation stays locked");
      const actions = (await q<{ action: string }>(`SELECT action FROM nzi_console.audit_events WHERE entity_id = $1 ORDER BY occurred_at`, [issued.invitationId])).map((row) => row.action);
      assert.deepEqual(actions, ["portal.invitation.setup", ...Array(4).fill("portal.invitation.code_rejected"), "portal.invitation.locked"]);
    });

    it("accepting activates the client, ends old sessions, issues recovery codes — and one signs them in", async () => {
      const issued = await createPortalInvitation(database.pool, admin, { clientId: CLIENT, email: "grace@netzero.international", displayName: "Grace Example", delivery: "link", consoleOrigin: ORIGIN });
      if (issued.delivery !== "link") throw new Error("expected a link");
      await db.query(`INSERT INTO nzi_console.portal_sessions (organisation_id, session_id, portal_user_id, client_id, expires_at) VALUES ($1, 'stale', $2, $3, now() + interval '1 day')`, [ORG, issued.portalUserId, CLIENT]);
      const setup = await startPortalInvitationSetup(database.pool, { token: issued.token, password: PASSWORD }, KEY);
      const done = await completePortalInvitationSetup(database.pool, { token: issued.token, code: totpCode(setup.totpSecret) }, KEY);
      assert.equal(done.activated, true);
      assert.equal(done.recoveryCodes.length, 10);
      assert.equal((await q(`SELECT status FROM nzi_console.portal_users WHERE portal_user_id = $1`, [issued.portalUserId]))[0]!.status, "active");
      assert.ok((await q(`SELECT revoked_at FROM nzi_console.portal_sessions WHERE session_id = 'stale'`))[0]!.revoked_at, "the old session ended");
      const [accepted] = await q(`SELECT after_json FROM nzi_console.audit_events WHERE action = 'portal.invitation.accepted' AND entity_id = $1`, [issued.invitationId]);
      assert.equal(accepted!.after_json.sessionsEnded, 1);

      const started = await startPortalLogin(database.pool, { organisationId: ORG, email: "grace@netzero.international", password: PASSWORD });
      let remaining: number | undefined;
      const session = await completePortalMfa(database.pool, { organisationId: ORG, challengeToken: started.challengeToken, code: done.recoveryCodes[3]! }, KEY, new Date(), { onRecoveryCode: (left) => { remaining = left; } });
      assert.equal(session.userId, issued.portalUserId);
      assert.equal(remaining, 9);
    });

    it("if the email cannot be queued, nothing is issued — not the invitation, not the invited user", async () => {
      await db.query(`INSERT INTO nzi_console.message_templates (organisation_id, template_key, subject, body, created_by, updated_by)
        VALUES ($1, 'portal.access.invite', 'Hi', 'No link in this wording', 'test', 'test')`, [ORG]);
      try {
        await assert.rejects(() => createPortalInvitation(database.pool, admin, { clientId: CLIENT, email: "nobody@netzero.international", displayName: "No Body", consoleOrigin: ORIGIN }),
          /could not be queued, so no link was issued/);
        assert.equal((await q(`SELECT 1 FROM nzi_console.portal_users WHERE email_normalized = 'nobody@netzero.international'`)).length, 0);
      } finally {
        await db.query(`UPDATE nzi_console.message_templates SET active = false WHERE organisation_id = $1 AND template_key = 'portal.access.invite'`, [ORG]);
      }
    });
  });

  it("the recovery-code table is the authentication role's alone", async () => {
    for (const role of ["nzi_console_app", "nzi_console_worker"]) {
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN"); await client.query(`SET LOCAL ROLE ${role}`);
        await client.query("SELECT set_config('app.organisation_id', $1, true)", [ORG]);
        await assert.rejects(client.query(`SELECT 1 FROM nzi_console.mfa_recovery_codes`), /permission denied/, role);
      } finally { await client.query("ROLLBACK"); client.release(); }
    }
  });
});
