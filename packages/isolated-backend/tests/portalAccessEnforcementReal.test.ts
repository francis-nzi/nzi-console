import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { encryptTotpSecret, generateTotpSecret, hashPassword, totpCode } from "../src/credentials";
import { AuthenticationError, AuthorizationError, CommandValidationError, VersionConflictError } from "../src/index";
import { resolvePortalPrincipal } from "../src/auth";
import { completePortalMfa, completeStaffMfa, InvalidLoginError, provisionStaffCredential, startPortalLogin, startStaffLogin } from "../src/login";
import { getClientPortalAccess, purgePortalLoginNetworkData, setClientPortalAccess, loginEmailHash } from "../src/index";

/**
 * The client-level portal access switch, against a real database (RULING-portal-access-model): the master switch and expiry are
 * enforced at login, at MFA completion and on every request of a live session; the refusal is the same as a bad password's; a switch-off
 * ends live sessions; another client's users and the staff are unaffected; re-enabling restores access with no re-invite; every attempt
 * is recorded, with the network data nulled after 90 days; the auth role can read only the gate.
 */
const ORG = "access-org";
const KEY = randomBytes(32).toString("base64");
const PASSWORD = "a-long-correct-passphrase";
const SECRET = generateTotpSecret();
const NET = { ip: "203.0.113.9", userAgent: "test-agent/1.0" };
const here = dirname(fileURLToPath(import.meta.url));

describe("client portal access: enforcement, the decision log and the login record", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  let keys = 0;
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const staff = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: "sam", principal: "staff", idempotencyKey: `acc-${keys}`, correlationId: `corr-acc-${keys}`, grant: commandGrantForRole("admin", ORG, "sam"), ...(reason ? { reason } : {}) };
  };
  const holder = { organisationId: ORG, userId: "sam", capabilities: commandGrantForRole("admin", ORG, "sam").capabilities };
  const setAccess = (clientId: string, expectedVersion: number | null, changes: Parameters<typeof setClientPortalAccess>[1]["changes"], note?: string) =>
    setClientPortalAccess(database.pool, { clientId, expectedVersion, changes, note }, staff());
  const start = (email: string, password = PASSWORD, now = new Date()) => startPortalLogin(database.pool, { organisationId: ORG, email, password }, now, NET);
  const signIn = async (email: string, now = new Date()) => {
    const started = await start(email, PASSWORD, now);
    return completePortalMfa(database.pool, { organisationId: ORG, challengeToken: started.challengeToken, code: totpCode(SECRET) }, KEY, now, {}, NET);
  };
  const refusal = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { return error; } throw new Error("expected a refusal"); };
  const events = (where = "TRUE") => q<{ outcome: string; portal_user_id: string | null; client_id: string | null; email_hash: string | null; ip: string | null; user_agent: string | null }>(
    `SELECT outcome,portal_user_id,client_id,email_hash,ip,user_agent FROM nzi_console.portal_login_events WHERE ${where} ORDER BY occurred_at, event_id`);
  const liveSessions = async (clientId: string) => Number((await q(`SELECT count(*) AS n FROM nzi_console.portal_sessions WHERE client_id=$1 AND revoked_at IS NULL`, [clientId]))[0]!.n);
  const asAuth = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SET LOCAL ROLE nzi_console_auth"); await client.query("SELECT set_config('app.organisation_id', $1, true)", [ORG]);
      const result = await client.query(sql, params);
      await client.query("ROLLBACK");
      return result.rows as T[];
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  };

  before(async () => {
    database = (await createDisposableDatabase("portalaccess"))!;
    admin = await database.admin();
    await q(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name,email) VALUES ($1,'sam','admin','active','Sam Staff','sam@netzero.international')`, [ORG]);
    await provisionStaffCredential(database.pool, { organisationId: ORG, userId: "sam", email: "sam@netzero.international", password: PASSWORD, totpSecret: SECRET }, KEY);
    await q(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-a','Client A','active'),($1,'client-b','Client B','active')`, [ORG]);
    const password = await hashPassword(PASSWORD), totp = encryptTotpSecret(SECRET, KEY);
    for (const [user, client, email, name] of [["grace", "client-a", "grace@a.example", "Grace A"], ["gus", "client-a", "gus@a.example", "Gus A"], ["hank", "client-b", "hank@b.example", "Hank B"]] as const) {
      await q(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,email_normalized,display_name,status) VALUES ($1,$2,$3,$4,$5,'active')`, [ORG, user, client, email, name]);
      await q(`INSERT INTO nzi_console.portal_credentials (organisation_id,portal_user_id,password_salt,password_hash,totp_ciphertext,totp_iv,totp_tag,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,true)`, [ORG, user, password.salt, password.hash, totp.ciphertext, totp.iv, totp.tag]);
    }
  });
  after(async () => { await admin?.end(); await database?.end(); });

  it("with no record every client is enabled: nothing changes on deploy", async () => {
    assert.equal(Number((await q(`SELECT count(*) AS n FROM nzi_console.client_portal_access`))[0]!.n), 0);
    const session = await signIn("grace@a.example");
    assert.equal((await resolvePortalPrincipal(database.pool, session)).userId, "grace");
    const view = await getClientPortalAccess(database.pool, holder, "client-a");
    assert.deepEqual([view.access.enabled, view.access.trained, view.access.expiresAt, view.access.userCap, view.access.paymentStatus, view.access.paymentRef, view.access.notes, view.access.version],
      [true, false, null, null, null, null, "", null], "payment is — (null), never unpaid");
    assert.equal(view.activeUsers, 2);
    assert.deepEqual((await events("outcome='success'")).map((event) => [event.portal_user_id, event.client_id, event.ip, event.user_agent]), [["grace", "client-a", NET.ip, NET.userAgent]]);
  });

  describe("switching a client off", () => {
    let graceSession: Awaited<ReturnType<typeof signIn>>, hankSession: Awaited<ReturnType<typeof signIn>>, midChallenge = "";
    before(async () => {
      graceSession = await signIn("grace@a.example");
      hankSession = await signIn("hank@b.example");
      midChallenge = (await start("gus@a.example")).challengeToken; // password done, code not yet
    });

    it("ends the client's live sessions in the same transaction, records one decision per field, and the very next request is refused", async () => {
      assert.ok((await liveSessions("client-a")) >= 2);
      const outcome = await setAccess("client-a", null, { enabled: false }, "Contract ended");
      assert.deepEqual([outcome.data.changed, outcome.data.version, outcome.data.enabled], [["enabled"], 1, false]);
      assert.ok(outcome.data.sessionsEnded >= 2);
      assert.equal(await liveSessions("client-a"), 0, "revoke_client_portal_sessions ended them");
      await assert.rejects(resolvePortalPrincipal(database.pool, graceSession), AuthenticationError);
      const decisions = await q(`SELECT field,from_json,to_json,note,changed_by FROM nzi_console.client_portal_access_decisions WHERE client_id='client-a'`);
      assert.deepEqual(decisions, [{ field: "enabled", from_json: true, to_json: false, note: "Contract ended", changed_by: "sam" }]);
    });

    it("the per-request check alone refuses a session of a switched-off client: the switch does not rely on the sweep", async () => {
      const session = await signIn("hank@b.example"); // client-b: enabled
      await q(`INSERT INTO nzi_console.client_portal_access (organisation_id,client_id,enabled,version,updated_by) VALUES ($1,'client-b',false,1,'sam')`, [ORG]); // written directly: no revoke
      await assert.rejects(resolvePortalPrincipal(database.pool, session), AuthenticationError);
      assert.equal(await liveSessions("client-b") > 0, true, "its session row is still live; the request check is what refused it");
      await q(`DELETE FROM nzi_console.client_portal_access WHERE client_id='client-b'`);
      assert.equal((await resolvePortalPrincipal(database.pool, session)).userId, "hank", "and removing the record restores it: the defaults");
    });

    it("cannot start a login with the right password, and cannot complete one begun before", async () => {
      await assert.rejects(start("grace@a.example"), InvalidLoginError);
      const before = Number((await q(`SELECT count(*) AS n FROM nzi_console.portal_sessions WHERE portal_user_id='gus'`))[0]!.n);
      await assert.rejects(completePortalMfa(database.pool, { organisationId: ORG, challengeToken: midChallenge, code: totpCode(SECRET) }, KEY, new Date(), {}, NET), InvalidLoginError);
      assert.equal(Number((await q(`SELECT count(*) AS n FROM nzi_console.portal_sessions WHERE portal_user_id='gus'`))[0]!.n), before, "no session was issued");
    });

    it("refuses exactly as it refuses a bad password or an unknown user: same error, same message, no lockout oracle", async () => {
      const off = await refusal(() => start("grace@a.example")) as Error;
      const wrong = await refusal(() => start("hank@b.example", "not-the-password")) as Error;
      const unknown = await refusal(() => start("nobody@nowhere.example")) as Error;
      for (const error of [off, wrong, unknown]) assert.ok(error instanceof InvalidLoginError);
      assert.deepEqual([off.name, off.message], [wrong.name, wrong.message]);
      assert.deepEqual([off.name, off.message], [unknown.name, unknown.message]);
      for (let attempt = 0; attempt < 8; attempt += 1) await assert.rejects(start("grace@a.example"), InvalidLoginError, "never LoginLockedError: a switched-off client's user is not counted as a failed password");
      assert.equal(Number((await q(`SELECT failed_attempts AS n FROM nzi_console.portal_credentials WHERE portal_user_id='grace'`))[0]!.n), 0);
    });

    it("leaves a different client's users untouched, and the staff", async () => {
      assert.equal((await resolvePortalPrincipal(database.pool, hankSession)).userId, "hank");
      assert.equal((await resolvePortalPrincipal(database.pool, await signIn("hank@b.example"))).clientId, "client-b");
      const started = await startStaffLogin(database.pool, { organisationId: ORG, email: "sam@netzero.international", password: PASSWORD });
      const session = await completeStaffMfa(database.pool, { organisationId: ORG, challengeToken: started.challengeToken, code: totpCode(SECRET) }, KEY);
      assert.equal(session.userId, "sam");
    });

    it("records every attempt: the reason for staff, the network data, a hash for an unknown address and never the address", async () => {
      assert.ok((await events("outcome='client_disabled' AND portal_user_id='grace'")).length >= 2, "start and mid-challenge");
      assert.ok((await events("outcome='bad_password' AND portal_user_id='hank'")).length >= 1);
      const unknown = await events("outcome='unknown_user'");
      assert.equal(unknown[0]!.email_hash, loginEmailHash("nobody@nowhere.example"));
      assert.equal(unknown[0]!.portal_user_id, null);
      assert.doesNotMatch(JSON.stringify(await q(`SELECT * FROM nzi_console.portal_login_events`)), /nobody@nowhere/);
      assert.ok((await events("TRUE")).every((event) => event.ip === NET.ip && event.user_agent === NET.userAgent));
    });

    it("re-enabling restores access with no re-invite: same user, same credential, a fresh sign-in works", async () => {
      const row = (await q(`SELECT status FROM nzi_console.portal_users WHERE portal_user_id='grace'`))[0]!;
      const outcome = await setAccess("client-a", 1, { enabled: true }, "Renewed");
      assert.deepEqual([outcome.data.changed, outcome.data.version, outcome.data.sessionsEnded], [["enabled"], 2, 0]);
      assert.deepEqual((await q(`SELECT status FROM nzi_console.portal_users WHERE portal_user_id='grace'`))[0], row);
      const session = await signIn("grace@a.example");
      assert.equal((await resolvePortalPrincipal(database.pool, session)).userId, "grace");
      await assert.rejects(resolvePortalPrincipal(database.pool, graceSession), AuthenticationError, "the old, revoked session stays dead");
    });
  });

  describe("expiry", () => {
    it("a past-dated expiry cuts the client off and ends its sessions; a future one allows sign-in until it passes", async () => {
      const live = await signIn("grace@a.example");
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const set = await setAccess("client-a", 2, { expiresAt: future });
      assert.deepEqual([set.data.changed, set.data.sessionsEnded], [["expires_at"], 0]);
      assert.equal((await resolvePortalPrincipal(database.pool, live)).userId, "grace", "not yet expired");
      assert.equal((await signIn("grace@a.example")).userId, "grace");
      // After the expiry: login refused (the login's own clock), and the request check refuses a live session (the database's).
      await assert.rejects(start("grace@a.example", PASSWORD, new Date(Date.now() + 2 * 60 * 60 * 1000)), InvalidLoginError);
      await q(`UPDATE nzi_console.client_portal_access SET expires_at = now() - interval '1 minute' WHERE client_id='client-a'`);
      await assert.rejects(resolvePortalPrincipal(database.pool, live), AuthenticationError);
      await assert.rejects(start("grace@a.example"), InvalidLoginError);
      assert.ok((await events("outcome='client_expired'")).length >= 2);
      const past = await setAccess("client-a", 3, { expiresAt: new Date(Date.now() - 1000).toISOString(), trained: true });
      assert.ok(past.data.sessionsEnded >= 1, "a past-dated expiry ends sessions in the command");
      await setAccess("client-a", 4, { expiresAt: null });
      assert.equal((await signIn("grace@a.example")).userId, "grace", "clearing the expiry restores access");
    });

    it("a switch-off between the password and the code ends the attempt (the gate is re-read at MFA completion)", async () => {
      const challenge = (await start("hank@b.example")).challengeToken;
      await setAccess("client-b", null, { enabled: false });
      await assert.rejects(completePortalMfa(database.pool, { organisationId: ORG, challengeToken: challenge, code: totpCode(SECRET) }, KEY, new Date(), {}, NET), InvalidLoginError);
      await setAccess("client-b", 1, { enabled: true });
    });
  });

  describe("the command, the log and the read", () => {
    it("is version-checked, refuses an empty save, and keeps one decision per changed field with who, from, to and why", async () => {
      await assert.rejects(setAccess("client-a", 1, { notes: "stale" }), VersionConflictError);
      await assert.rejects(setAccess("client-b", null, { notes: "first save wants version 2" }), VersionConflictError);
      const current = (await q(`SELECT version FROM nzi_console.client_portal_access WHERE client_id='client-a'`))[0]!.version as number;
      await assert.rejects(setAccess("client-a", current, { trained: true }), (error) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NO_CHANGE"));
      const saved = await setAccess("client-a", current, { paymentStatus: "paid", paymentRef: "  INV-2026-0042 ", userCap: 5, notes: " Agreed with finance " }, "Invoice raised");
      assert.deepEqual([...saved.data.changed].sort(), ["notes", "payment_ref", "payment_status", "user_cap"]);
      const view = await getClientPortalAccess(database.pool, holder, "client-a");
      assert.deepEqual([view.access.paymentStatus, view.access.paymentRef, view.access.userCap, view.access.notes], ["paid", "INV-2026-0042", 5, "Agreed with finance"]);
      const latest = view.decisions.filter((decision) => decision.note === "Invoice raised");
      assert.equal(latest.length, 4);
      assert.ok(latest.every((decision) => decision.changedBy === "sam" && decision.changedByName === "Sam Staff"));
      assert.deepEqual(latest.find((decision) => decision.field === "payment_status"), { ...latest.find((decision) => decision.field === "payment_status")!, from: null, to: "paid" });
      assert.ok(view.loginEvents.length > 0 && view.loginEvents.every((event) => event.portalUserId !== null));
      await assert.rejects(setAccess("client-a", saved.data.version, { paymentStatus: "settled" as never }), CommandValidationError);
    });

    it("is portal.admin on the client only: a portal principal cannot run it, and the decision log cannot be edited or deleted", async () => {
      const portal: CommandContext = { organisationId: ORG, actorId: "grace", principal: "portal", portal: { portalUserId: "grace", clientId: "client-a" }, idempotencyKey: "p-1", correlationId: "p-1" } as never;
      await assert.rejects(setClientPortalAccess(database.pool, { clientId: "client-a", expectedVersion: 1, changes: { enabled: false } }, portal), AuthorizationError);
      for (const sql of [`UPDATE nzi_console.client_portal_access_decisions SET note='x'`, `DELETE FROM nzi_console.client_portal_access_decisions`, `UPDATE nzi_console.portal_login_events SET outcome='success'`, `DELETE FROM nzi_console.portal_login_events`]) {
        assert.equal((await q(`SELECT has_table_privilege('nzi_console_app','nzi_console.${/decisions/.test(sql) ? "client_portal_access_decisions" : "portal_login_events"}','${sql.startsWith("UPDATE") ? "UPDATE" : "DELETE"}') AS can`))[0]!.can, false, sql);
      }
    });
  });

  describe("what the auth role can see, and the retention", () => {
    it("reads the gate (enabled, expires_at) and nothing else of a client's access: never the notes, payment or cap", async () => {
      assert.ok((await asAuth<{ enabled: boolean }>(`SELECT enabled, expires_at FROM nzi_console.client_portal_access`)).length > 0);
      for (const column of ["notes", "payment_status", "payment_ref", "user_cap", "trained"]) await assert.rejects(asAuth(`SELECT ${column} FROM nzi_console.client_portal_access`), /permission denied/, column);
      await assert.rejects(asAuth(`SELECT * FROM nzi_console.client_portal_access`), /permission denied/);
      await assert.rejects(asAuth(`SELECT * FROM nzi_console.portal_login_events`), /permission denied/, "the auth role writes events, it does not read them");
    });

    it("nulls IP and user-agent after 90 days and keeps the outcome, time and user", async () => {
      await q(`UPDATE nzi_console.portal_login_events SET occurred_at = now() - interval '100 days' WHERE event_id = (SELECT event_id FROM nzi_console.portal_login_events WHERE outcome='success' ORDER BY occurred_at LIMIT 1)`).catch(() => undefined);
      const old = (await q(`SELECT event_id FROM nzi_console.portal_login_events ORDER BY occurred_at LIMIT 1`))[0]!.event_id as string;
      await q(`UPDATE nzi_console.portal_login_events SET occurred_at = now() - interval '100 days' WHERE event_id=$1`, [old]);
      const purged = await purgePortalLoginNetworkData(database.pool, ORG, new Date());
      assert.ok(purged >= 1);
      const row = (await q(`SELECT outcome,portal_user_id,ip,user_agent FROM nzi_console.portal_login_events WHERE event_id=$1`, [old]))[0]!;
      assert.deepEqual([row.ip, row.user_agent], [null, null]);
      assert.ok(row.outcome);
      assert.ok(Number((await q(`SELECT count(*) AS n FROM nzi_console.portal_login_events WHERE ip IS NOT NULL`))[0]!.n) > 0, "recent ones keep theirs");
      assert.equal(await purgePortalLoginNetworkData(database.pool, ORG, new Date()), 0, "idempotent");
    });
  });

  describe("what does not gate", () => {
    it("the user cap and payment are read by nothing that refuses an invitation or a sign-in", () => {
      const src = join(here, "..", "src");
      const files = readdirSync(src).filter((name) => name.endsWith(".ts"));
      const mentions = files.filter((name) => /user_cap|payment_status/.test(readFileSync(resolve(src, name), "utf8")));
      assert.deepEqual(mentions, ["portalClientAccess.ts"]);
      assert.doesNotMatch(readFileSync(resolve(src, "portalInvitations.ts"), "utf8"), /client_portal_access/, "invitations are allowed to a disabled or expired client: the gate is at login");
    });
  });
});
