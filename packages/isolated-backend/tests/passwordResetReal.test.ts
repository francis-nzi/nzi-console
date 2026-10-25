import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { encryptTotpSecret, generateTotpSecret, hashPassword, totpCode } from "../src/credentials";
import { emailDispatchFromEnv } from "../src/email";
import { completePortalMfa, completeStaffMfa, InvalidLoginError, provisionStaffCredential, startPortalLogin, startStaffLogin } from "../src/login";
import { suppressingMailer } from "../src/mailer";
import { completePasswordReset, MAX_RESET_REQUESTS_PER_HOUR, PasswordResetError, requestPasswordReset } from "../src/passwordReset";
import { withTenantWorker } from "../src/postgres";
import { drainOutbox } from "../src/strategyReminderWorker";

/**
 * Password reset by email (email programme phase 4-1; 0181), staff and portal, against a real database: the link is issued
 * only for a real, enabled, active account and says nothing either way; it is stored hashed, works once, for an hour; a
 * completed reset sets the password, clears lockout, and ends every session and half-finished sign-in; nothing secret is
 * audited; and the email goes through sendTemplatedEmail under the isolation gate.
 */

const ORG = "reset-org";
const KEY = randomBytes(32).toString("base64");
const ORIGIN = "https://console.example.test";
const OLD = "the-original-passphrase", NEW = "a-brand-new-passphrase";
const SECRET = generateTotpSecret();

describe("password reset (phase 4-1), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const request = (principal: "staff" | "portal", email: string, now = new Date()) =>
    requestPasswordReset(database.pool, { organisationId: ORG, principal, email, origin: ORIGIN }, now);
  const complete = (principal: "staff" | "portal", token: string, password = NEW, now = new Date()) =>
    completePasswordReset(database.pool, { organisationId: ORG, principal, token, password }, now);
  const emails = () => q<{ template_code: string; to_email: string; text_body: string; correlation_id: string }>(
    `SELECT template_code, to_email, text_body, correlation_id FROM nzi_console.email_messages ORDER BY created_at`);
  const tokenIn = (text: string) => /#token=([A-Za-z0-9_-]{43})/.exec(text)![1]!;
  const signInStaff = async (password: string) => {
    const started = await startStaffLogin(database.pool, { organisationId: ORG, email: "sam@netzero.international", password });
    return completeStaffMfa(database.pool, { organisationId: ORG, challengeToken: started.challengeToken, code: totpCode(SECRET) }, KEY);
  };
  const signInPortal = async (password: string) => {
    const started = await startPortalLogin(database.pool, { organisationId: ORG, email: "grace@client.example", password });
    return completePortalMfa(database.pool, { organisationId: ORG, challengeToken: started.challengeToken, code: totpCode(SECRET) }, KEY);
  };
  const resetStaffPassword = async () => provisionStaffCredential(database.pool, { organisationId: ORG, userId: "sam", email: "sam@netzero.international", password: OLD, totpSecret: SECRET }, KEY);

  before(async () => {
    database = (await createDisposableDatabase("passwordreset"))!;
    admin = await database.admin();
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email, deactivated_at, deactivated_by) VALUES
      ($1, 'sam', 'consultant', 'active', 'Sam Adviser', 'sam@netzero.international', NULL, NULL),
      ($1, 'gone', 'viewer', 'deactivated', 'Gone Person', 'gone@netzero.international', now(), 'ada')`, [ORG]);
    await resetStaffPassword();
    await provisionStaffCredential(database.pool, { organisationId: ORG, userId: "gone", email: "gone@netzero.international", password: OLD, totpSecret: SECRET }, KEY);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'client-a', 'Client A', 'active')`, [ORG]);
    await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, email_normalized, display_name, status) VALUES ($1, 'grace', 'client-a', 'grace@client.example', 'Grace Example', 'active')`, [ORG]);
    const password = await hashPassword(OLD), totp = encryptTotpSecret(SECRET, KEY);
    await q(`INSERT INTO nzi_console.portal_credentials (organisation_id, portal_user_id, password_salt, password_hash, totp_ciphertext, totp_iv, totp_tag, enabled)
      VALUES ($1, 'grace', $2, $3, $4, $5, $6, true)`, [ORG, password.salt, password.hash, totp.ciphertext, totp.iv, totp.tag]);
  });
  beforeEach(async () => {
    // Each test starts outside the rate-limit window: earlier links are closed and moved back out of the last hour.
    await q(`UPDATE nzi_console.password_reset_tokens SET revoked_at = CASE WHEN consumed_at IS NULL THEN coalesce(revoked_at, now()) END,
      created_at = now() - interval '3 hours', expires_at = now() - interval '2 hours 30 minutes'`);
    await q(`DELETE FROM nzi_console.transactional_outbox`);
    await q(`DELETE FROM nzi_console.email_messages`);
  });
  after(async () => { await admin?.end(); await database?.end(); });

  it("for a real staff account: queues password.reset.staff to its address, and stores the link only as a hash", async () => {
    assert.equal(await request("staff", "  Sam@NetZero.International "), undefined, "the caller is told nothing");
    const [email, ...more] = await emails();
    assert.equal(more.length, 0);
    assert.deepEqual([email!.template_code, email!.to_email], ["password.reset.staff", "sam@netzero.international"]);
    assert.match(email!.text_body, new RegExp(`${ORIGIN.replace(/\./g, "\\.")}/reset-password#token=[A-Za-z0-9_-]{43}`));
    assert.match(email!.text_body, /^Hello Sam Adviser,/);
    const token = tokenIn(email!.text_body);
    const [row] = await q(`SELECT * FROM nzi_console.password_reset_tokens WHERE reset_id = $1`, [email!.correlation_id]);
    assert.ok(row, "the email is correlated to its reset row");
    assert.ok(!JSON.stringify(row).includes(token), "the token itself is never stored");
    assert.equal(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime(), 60 * 60 * 1000, "an hour");
  });

  it("for an unknown address, a deactivated member, or the other sign-in's address: nothing is written, and the answer is the same", async () => {
    for (const [principal, address] of [["staff", "nobody@netzero.international"], ["staff", "gone@netzero.international"], ["portal", "sam@netzero.international"], ["staff", "grace@client.example"], ["staff", ""]] as const) {
      assert.equal(await request(principal, address), undefined, `${principal} ${address}`);
    }
    assert.equal((await emails()).length, 0);
    assert.equal((await q(`SELECT 1 FROM nzi_console.password_reset_tokens WHERE consumed_at IS NULL AND revoked_at IS NULL`)).length, 0);
  });

  it("completing sets the password, clears lockout, consumes the link, and ends every session and half-finished sign-in", async () => {
    const before = await signInStaff(OLD);
    const halfway = await startStaffLogin(database.pool, { organisationId: ORG, email: "sam@netzero.international", password: OLD });
    await q(`UPDATE nzi_console.staff_credentials SET failed_attempts = 4, locked_until = now() + interval '10 minutes' WHERE user_id = 'sam'`);

    await request("staff", "sam@netzero.international");
    const token = tokenIn((await emails())[0]!.text_body);
    const result = await complete("staff", token);
    assert.ok(result.sessionsEnded >= 1);

    const [session] = await q(`SELECT revoked_at FROM nzi_console.staff_sessions WHERE session_id = $1`, [before.sessionId]);
    assert.ok(session!.revoked_at, "the session from before the reset has ended");
    await assert.rejects(() => completeStaffMfa(database.pool, { organisationId: ORG, challengeToken: halfway.challengeToken, code: totpCode(SECRET) }, KEY),
      InvalidLoginError, "a sign-in started with the old password cannot finish");
    await assert.rejects(() => startStaffLogin(database.pool, { organisationId: ORG, email: "sam@netzero.international", password: OLD }), InvalidLoginError, "the old password is gone");
    assert.equal((await signInStaff(NEW)).userId, "sam", "the new password signs in (lockout cleared), with the same authenticator");

    await assert.rejects(() => complete("staff", token, "yet-another-passphrase"), PasswordResetError, "the link works once");
    await resetStaffPassword();
  });

  it("a newer request revokes the older link; an expired link and a link for the other sign-in are refused", async () => {
    const t0 = new Date();
    await request("staff", "sam@netzero.international", t0);
    await request("staff", "sam@netzero.international", t0);
    const [first, second] = (await emails()).map((email) => tokenIn(email.text_body));
    await assert.rejects(() => complete("staff", first!), PasswordResetError, "superseded by the newer link");
    await assert.rejects(() => complete("portal", second!), PasswordResetError, "a staff link is not a portal link");
    await assert.rejects(() => complete("staff", second!, NEW, new Date(t0.getTime() + 61 * 60 * 1000)), PasswordResetError, "after an hour");
    await assert.rejects(() => completePasswordReset(database.pool, { organisationId: "another-org", principal: "staff", token: second!, password: NEW }), PasswordResetError, "another organisation");
  });

  it("a short password is refused without using up the link", async () => {
    await request("staff", "sam@netzero.international");
    const token = tokenIn((await emails())[0]!.text_body);
    await assert.rejects(() => complete("staff", token, "short"), /at least 12 characters/);
    await complete("staff", token);
    await resetStaffPassword();
  });

  it("an account suspended after the link was sent cannot be reset by it", async () => {
    await request("staff", "sam@netzero.international");
    const token = tokenIn((await emails())[0]!.text_body);
    await q(`UPDATE nzi_console.staff_credentials SET enabled = false WHERE user_id = 'sam'`);
    try {
      await assert.rejects(() => complete("staff", token), PasswordResetError);
    } finally {
      await q(`UPDATE nzi_console.staff_credentials SET enabled = true WHERE user_id = 'sam'`);
    }
  });

  it(`sends one account at most ${MAX_RESET_REQUESTS_PER_HOUR} links an hour; the rest are recorded and send nothing`, async () => {
    const started = (await q<{ started: Date }>(`SELECT now() AS started`))[0]!.started;
    for (let attempt = 0; attempt < MAX_RESET_REQUESTS_PER_HOUR + 2; attempt += 1) await request("staff", "sam@netzero.international");
    assert.equal((await emails()).length, MAX_RESET_REQUESTS_PER_HOUR);
    const throttled = await q(`SELECT 1 FROM nzi_console.audit_events WHERE action = 'password.reset.throttled' AND entity_id = 'sam' AND occurred_at >= $1`, [started]);
    assert.equal(throttled.length, 2);
  });

  it("the portal: password.reset.portal to the portal link, and completing ends the client's sessions", async () => {
    const before = await signInPortal(OLD);
    await request("portal", "grace@client.example");
    const [email] = await emails();
    assert.deepEqual([email!.template_code, email!.to_email], ["password.reset.portal", "grace@client.example"]);
    assert.match(email!.text_body, new RegExp(`${ORIGIN.replace(/\./g, "\\.")}/portal/reset-password#token=`));
    await complete("portal", tokenIn(email!.text_body));
    const [session] = await q(`SELECT revoked_at FROM nzi_console.portal_sessions WHERE session_id = $1`, [before.sessionId]);
    assert.ok(session!.revoked_at);
    assert.equal((await signInPortal(NEW)).userId, "grace");
  });

  it("audits who and what — never the token, the password or the address", async () => {
    const events = await q<{ action: string; actor_id: string; principal_type: string; after_json: unknown }>(
      `SELECT action, actor_id, principal_type, after_json FROM nzi_console.audit_events WHERE action LIKE 'password.reset.%'`);
    assert.ok(events.some((event) => event.action === "password.reset.requested" && event.actor_id === "password-reset" && event.principal_type === "system"));
    assert.ok(events.some((event) => event.action === "password.reset.completed" && event.actor_id === "sam" && event.principal_type === "staff"));
    assert.ok(events.some((event) => event.action === "password.reset.completed" && event.actor_id === "grace" && event.principal_type === "portal"));
    const all = JSON.stringify(events);
    for (const secret of [OLD, NEW, "#token=", "netzero.international", "client.example"]) assert.ok(!all.includes(secret), `the audit holds ${secret}`);
  });

  it("the email is held by the phase-1 isolation gate: an off-domain client address is stubbed, never posted", async () => {
    await request("portal", "grace@client.example");
    let posted = 0;
    const fetchImpl = (async () => { posted += 1; return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
    await withTenantWorker(database.pool, ORG, (db) => drainOutbox(db, {
      organisationId: ORG, today: "2026-10-25", mailer: suppressingMailer(), delivery: { mode: "suppress", reason: "test" },
      email: emailDispatchFromEnv({ NZI_DATABASE_BOUNDARY: "isolated-non-production", RESEND_API_KEY: "re_test_key_0123456789", EMAIL_FROM: "no-reply@netzero.international" }, fetchImpl),
    }));
    assert.equal(posted, 0);
    assert.deepEqual((await q(`SELECT status FROM nzi_console.email_messages`)).map((row) => row.status), ["stubbed"]);
  });

  it("the table admits no long-lived link, and no role but authentication can read it", async () => {
    await assert.rejects(q(`INSERT INTO nzi_console.password_reset_tokens (organisation_id, reset_id, principal, subject_id, token_hash, expires_at)
      VALUES ($1, 'long', 'staff', 'sam', repeat('a', 64), now() + interval '2 hours')`, [ORG]), /password_reset_tokens_short_lived/);
    for (const role of ["nzi_console_app", "nzi_console_worker"]) {
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN"); await client.query(`SET LOCAL ROLE ${role}`);
        await client.query("SELECT set_config('app.organisation_id', $1, true)", [ORG]);
        await assert.rejects(client.query(`SELECT 1 FROM nzi_console.password_reset_tokens`), /permission denied/, role);
      } finally { await client.query("ROLLBACK"); client.release(); }
    }
  });
});
