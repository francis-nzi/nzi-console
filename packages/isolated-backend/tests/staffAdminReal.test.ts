import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { clientListSpec, commandGrantForRole, defaultListQuery, staffListSpec, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { resolveStaffPrincipal } from "../src/auth";
import { listClients } from "../src/listReads";
import { CommandValidationError } from "../src/postgresCommands";
import { withTenantRead, withTenantWrite } from "../src/postgres";
import { listTeamMembers } from "../src/referenceData";
import {
  addStaff, assignStaffRole, changeStaffRole, deactivateStaff, listStaffPage, readStaffHistory, readStaffRates, reinstateStaff, setStaffRate, updateStaff,
} from "../src/staffAdmin";

/**
 * Team & access (admin Phase B, B1; ruled `phaseB-team-access-plan.md`) against a real database: 0141's shapes, the
 * never-delete revoke and the last-admin trigger; the roster commands and their guards (last admin under a lock, never
 * yourself, reasons, versions, access, tenancy); sealing; no personal data in any audit payload; deactivation ending
 * sign-in while the person still resolves; reinstatement restoring the same credential; the break-glass through the
 * command; and the append-only, finance.manage-gated rates.
 */
type Issue = { field: string; code: string; message: string };
const issue = (field: string, code?: string) => (error: unknown) =>
  error instanceof CommandValidationError && error.issues.some((item: Issue) => item.field === field && (code === undefined || item.code === code));

describe("Team & access, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "ta-org-a";
  const OTHER = "ta-org-b";
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actor = "ada", role: StaffRole = "admin", reason?: string, org = ORG, idempotencyKey?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: idempotencyKey ?? `ta-${keys}`, correlationId: `corr-ta-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, actor) };
  };
  const admin = async <T>(work: (db: import("pg").Client) => Promise<T>) => { const db = await database.admin(); try { return await work(db); } finally { await db.end(); } };
  const q = (sql: string, params: unknown[] = []) => admin(async (db) => (await db.query(sql, params)).rows);
  const member = async (userId: string) => (await q(`SELECT * FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2`, [ORG, userId]))[0];
  const version = async (userId: string) => (await member(userId)).version as number;
  const auditOf = (auditEventId: string) => q(`SELECT action, entity_type, entity_id, reason, before_json, after_json, principal_type FROM nzi_console.audit_events WHERE audit_event_id = $1`, [auditEventId]).then((rows) => rows[0]);
  const person = async (userId: string, role: StaffRole, name: string, email: string, org = ORG) => q(
    `INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email) VALUES ($1, $2, $3, 'active', $4, $5)`, [org, userId, role, name, email]);

  before(async () => {
    database = (await createDisposableDatabase("teamaccess"))!;
    for (const org of [ORG, OTHER]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await q(`SELECT nzi_console.provision_organisation($1)`, [org]);
    }
    await person("ada", "admin", "Ada Admin", "ada@example.test");
    await person("bea", "admin", "Bea Admin", "bea@example.test");
    await person("cal", "consultant", "Cal Consultant", "cal@example.test");
    await person("fin", "finance", "Fin Finance", "fin@example.test");
    await person("vic", "viewer", "Vic Viewer", "vic@example.test");
    await person("oz", "admin", "Oz Other", "oz@example.test", OTHER);
    await q(`INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, created_by, updated_by) VALUES
      ($1, 'positions', 'pos-lead', 'Lead Consultant', 's', 's'), ($1, 'positions', 'pos-old', 'Old Title', 's', 's'), ($1, 'referrals', 'ref-x', 'A referral', 's', 's')`, [ORG]);
    await q(`UPDATE nzi_console.reference_values SET active = false WHERE organisation_id = $1 AND value_id = 'pos-old'`, [ORG]);
  });
  after(async () => { await database?.end(); });

  describe("0141", () => {
    it("never deletes a membership: the application role holds no DELETE", async () => {
      await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`DELETE FROM nzi_console.memberships WHERE user_id = 'vic'`)), /permission denied/);
    });

    it("holds the status, deactivation and provenance shapes", async () => {
      await assert.rejects(q(`UPDATE nzi_console.memberships SET status = 'deactivated' WHERE organisation_id = $1 AND user_id = 'vic'`, [ORG]), /memberships_deactivation_shape/);
      await assert.rejects(q(`UPDATE nzi_console.memberships SET status = 'gone' WHERE organisation_id = $1 AND user_id = 'vic'`, [ORG]), /memberships_status_check/);
      await assert.rejects(q(`UPDATE nzi_console.memberships SET source_system = 'nzi-pro-v7' WHERE organisation_id = $1 AND user_id = 'vic'`, [ORG]), /memberships_import_provenance_shape/);
      await assert.rejects(q(`UPDATE nzi_console.memberships SET position_value_id = 'nope' WHERE organisation_id = $1 AND user_id = 'vic'`, [ORG]), /memberships_position_reference_fk/);
    });

    it("the deferred trigger refuses a raw demotion of the last active admin — and lets an organisation with no admin gain its first", async () => {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ('ta-org-c', 'c')`);
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ('ta-org-c', 'solo', 'viewer', 'active')`);
      await withTenantWrite(database.pool, "ta-org-c", (db) => db.query(`UPDATE nzi_console.memberships SET role_id = 'admin' WHERE user_id = 'solo'`));
      await assert.rejects(withTenantWrite(database.pool, "ta-org-c", (db) => db.query(`UPDATE nzi_console.memberships SET role_id = 'viewer' WHERE user_id = 'solo'`)), /LAST_ADMIN/);
      await assert.rejects(withTenantWrite(database.pool, "ta-org-c", (db) => db.query(
        `UPDATE nzi_console.memberships SET status = 'deactivated', deactivated_at = now(), deactivated_by = 'x' WHERE user_id = 'solo'`)), /LAST_ADMIN/);
      // Swapping within one transaction is fine: at commit there is still an admin.
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ('ta-org-c', 'next', 'viewer', 'active')`);
      await withTenantWrite(database.pool, "ta-org-c", async (db) => {
        await db.query(`UPDATE nzi_console.memberships SET role_id = 'viewer' WHERE user_id = 'solo'`);
        await db.query(`UPDATE nzi_console.memberships SET role_id = 'admin' WHERE user_id = 'next'`);
      });
      assert.equal((await q(`SELECT role_id FROM nzi_console.memberships WHERE organisation_id = 'ta-org-c' AND user_id = 'next'`))[0].role_id, "admin");
    });
  });

  describe("staff.add and staff.update", () => {
    it("adds a person at Viewer under an opaque id, sealed, with nothing personal in the audit", async () => {
      const added = await addStaff(database.pool, { displayName: "  Dee   Newcomer ", email: "Dee.New@Example.test", positionValueId: "pos-lead" }, context());
      assert.match(added.data.userId, /^[0-9a-f-]{36}$/);
      const row = await member(added.data.userId);
      assert.deepEqual([row.role_id, row.status, row.display_name, row.email, row.position_value_id, row.version], ["viewer", "active", "Dee Newcomer", "dee.new@example.test", "pos-lead", 1]);
      assert.ok(row.display_name_sealed && row.email_sealed && row.email_bidx, "sealed on write (NZC-119)");
      const audit = await auditOf(added.auditEventId);
      assert.equal(audit.action, "staff.added");
      const payload = JSON.stringify([audit.before_json, audit.after_json]);
      assert.ok(!/dee|newcomer|example\.test/i.test(payload), `no name or email in the audit: ${payload}`);
    });

    it("refuses a duplicate address (any case), an inactive position, a value from another lookup, and a bad address", async () => {
      await assert.rejects(addStaff(database.pool, { displayName: "Dup", email: "CAL@example.test" }, context()), issue("email", "DUPLICATE"));
      await assert.rejects(addStaff(database.pool, { displayName: "X", email: "x1@example.test", positionValueId: "pos-old" }, context()), issue("positionValueId", "INACTIVE"));
      await assert.rejects(addStaff(database.pool, { displayName: "X", email: "x2@example.test", positionValueId: "ref-x" }, context()), issue("positionValueId", "NOT_FOUND"));
      await assert.rejects(addStaff(database.pool, { displayName: "X", email: "not-an-address" }, context()), issue("email", "INVALID"));
    });

    it("edits a name (resealed) and a position under the version; no name in the audit; refuses no change and a stale version", async () => {
      const v = await version("vic");
      const sealedBefore = (await member("vic")).display_name_sealed;
      const done = await updateStaff(database.pool, { userId: "vic", expectedVersion: v, displayName: "Victoria Viewer", positionValueId: "pos-lead" }, context());
      const row = await member("vic");
      assert.deepEqual([row.display_name, row.position_value_id, row.version], ["Victoria Viewer", "pos-lead", v + 1]);
      assert.notDeepEqual(row.display_name_sealed, sealedBefore, "resealed");
      const audit = await auditOf(done.auditEventId);
      assert.deepEqual(audit.after_json.changed, ["displayName", "positionValueId"]);
      assert.ok(!/victoria|vic viewer/i.test(JSON.stringify([audit.before_json, audit.after_json])));
      await assert.rejects(updateStaff(database.pool, { userId: "vic", expectedVersion: v + 1, displayName: "Victoria Viewer", positionValueId: "pos-lead" }, context()), issue("userId", "NO_CHANGE"));
      await assert.rejects(updateStaff(database.pool, { userId: "vic", expectedVersion: v, displayName: "Other" }, context()), /version|changed/i);
    });
  });

  describe("staff.role.assign", () => {
    it("changes a role with a reason, audited as staff.role.assign with the roles before and after", async () => {
      await assert.rejects(changeStaffRole(database.pool, { userId: "cal", expectedVersion: await version("cal"), role: "reviewer" }, context()), issue("reason", "REQUIRED"));
      const done = await changeStaffRole(database.pool, { userId: "cal", expectedVersion: await version("cal"), role: "reviewer" }, context("ada", "admin", "Reviews the Q3 reports"));
      const audit = await auditOf(done.auditEventId);
      assert.deepEqual([audit.action, audit.entity_type, audit.entity_id, audit.before_json.role, audit.after_json.role, audit.reason],
        ["staff.role.assign", "membership", "cal", "consultant", "reviewer", "Reviews the Q3 reports"]);
      await assert.rejects(changeStaffRole(database.pool, { userId: "cal", expectedVersion: await version("cal"), role: "reviewer" }, context("ada", "admin", "again")), issue("role", "NO_CHANGE"));
    });

    it("never changes your own role (SELF_CHANGE)", async () => {
      await assert.rejects(changeStaffRole(database.pool, { userId: "ada", expectedVersion: await version("ada"), role: "viewer" }, context("ada", "admin", "Stepping down")), issue("userId", "SELF_CHANGE"));
    });

    it("is admin.users only, and never reaches another organisation", async () => {
      for (const role of ["consultant", "finance", "viewer"] as const) {
        await assert.rejects(changeStaffRole(database.pool, { userId: "vic", expectedVersion: await version("vic"), role: "reviewer" }, context(role === "finance" ? "fin" : role === "viewer" ? "vic" : "cal", role, "try")), /admin\.users|permission/i);
      }
      await assert.rejects(changeStaffRole(database.pool, { userId: "oz", expectedVersion: 1, role: "viewer" }, context("ada", "admin", "reach")), issue("userId", "NOT_FOUND"));
    });

    it("never demotes the last active admin — and two concurrent demotions of the last two cannot both pass", async () => {
      // Two admins, each demoting the other at once: the admin rows are locked first, so one waits and then sees one admin left.
      const [va, vb] = [await version("ada"), await version("bea")];
      const results = await Promise.allSettled([
        changeStaffRole(database.pool, { userId: "bea", expectedVersion: vb, role: "consultant" }, context("ada", "admin", "Race one")),
        changeStaffRole(database.pool, { userId: "ada", expectedVersion: va, role: "consultant" }, context("bea", "admin", "Race two")),
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
      const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      assert.ok(issue("role", "LAST_ADMIN")(refused.reason) || /LAST_ADMIN/.test(String(refused.reason)), String(refused.reason));
      const admins = await q(`SELECT user_id FROM nzi_console.memberships WHERE organisation_id = $1 AND role_id = 'admin' AND status = 'active'`, [ORG]);
      assert.equal(admins.length, 1, "exactly one admin remains");
      // Restore two admins for what follows.
      const remaining = admins[0].user_id as string, demoted = remaining === "ada" ? "bea" : "ada";
      await changeStaffRole(database.pool, { userId: demoted, expectedVersion: await version(demoted), role: "admin" }, context(remaining, "admin", "Restore"));
    });

    it("the break-glass runs the same command: the same guards and event, as the system principal", async () => {
      await assert.rejects(assignStaffRole(database.pool, { organisationId: ORG, userId: "vic", role: "superuser", actorId: "operator:francis", reason: "Break glass" }), issue("role", "INVALID"));
      await assert.rejects(assignStaffRole(database.pool, { organisationId: ORG, userId: "vic", role: "reviewer", actorId: "francis", reason: "Break glass" }), issue("actorId"));
      const changed = await assignStaffRole(database.pool, { organisationId: ORG, userId: "vic", role: "reviewer", actorId: "operator:francis", reason: "Break glass test" });
      assert.deepEqual(changed, { from: "viewer", to: "reviewer" });
      const [event] = await q(`SELECT principal_type, actor_id, action FROM nzi_console.audit_events WHERE organisation_id = $1 AND actor_id = 'operator:francis' ORDER BY occurred_at DESC LIMIT 1`, [ORG]);
      assert.deepEqual([event.principal_type, event.action], ["system", "staff.role.assign"]);
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ('ta-org-d', 'd')`);
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ('ta-org-d', 'only', 'admin', 'active')`);
      await assert.rejects(assignStaffRole(database.pool, { organisationId: "ta-org-d", userId: "only", role: "viewer", actorId: "operator:francis", reason: "Would lock out" }), issue("role", "LAST_ADMIN"));
    });
  });

  describe("deactivation and reinstatement", () => {
    const signedIn = async (userId: string) => {
      await q(`INSERT INTO nzi_console.staff_credentials (organisation_id, user_id, email_normalized, password_salt, password_hash, totp_ciphertext, totp_iv, totp_tag)
        VALUES ($1, $2, $3, 's', 'h', 'c', 'i', 't') ON CONFLICT DO NOTHING`, [ORG, userId, `${userId}-login@example.test`]);
      await q(`INSERT INTO nzi_console.staff_sessions (organisation_id, session_id, user_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') ON CONFLICT DO NOTHING`, [ORG, `session-${userId}`, userId]);
      return { sessionId: `session-${userId}`, userId, organisationId: ORG, issuedAt: 0, expiresAt: 0 };
    };

    it("deactivates with a reason: signs them out, withdraws an open invitation, drops them from pickers — and they still resolve where named", async () => {
      const session = await signedIn("fin");
      assert.equal((await resolveStaffPrincipal(database.pool, session)).role, "finance");
      await q(`INSERT INTO nzi_console.staff_enrolment_invitations (organisation_id, invitation_id, user_id, token_hash, expires_at, created_by) VALUES ($1, 'inv-fin', 'fin', repeat('a', 64), now() + interval '1 day', 'ada')`, [ORG]);
      await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, client_manager_user_id) VALUES ($1, 'c1', 'Alpha', 'active', 'fin')`, [ORG]);

      await assert.rejects(deactivateStaff(database.pool, { userId: "fin", expectedVersion: await version("fin") }, context()), issue("reason", "REQUIRED"));
      const done = await deactivateStaff(database.pool, { userId: "fin", expectedVersion: await version("fin") }, context("ada", "admin", "Left the firm"));
      assert.equal(done.data.invitationsRevoked, 1);
      const row = await member("fin");
      assert.deepEqual([row.status, row.deactivated_by, !!row.deactivated_at], ["deactivated", "ada", true]);
      assert.ok((await q(`SELECT revoked_at FROM nzi_console.staff_enrolment_invitations WHERE invitation_id = 'inv-fin'`))[0].revoked_at);
      await assert.rejects(resolveStaffPrincipal(database.pool, session), /authentication|required/i);

      const pickers = await withTenantRead(database.pool, ORG, (db) => listTeamMembers(db));
      assert.ok(!pickers.some((entry) => entry.userId === "fin"), "gone from the pickers");
      const clients = await withTenantRead(database.pool, ORG, (db) => listClients(db, defaultListQuery(clientListSpec), { today: "2026-09-30" }));
      assert.equal(clients.rows.find((client) => client.id === "c1")?.clientManager, "Fin Finance", "still named where they manage");
      const roster = await withTenantRead(database.pool, ORG, (db) => listStaffPage(db, defaultListQuery(staffListSpec)));
      assert.ok(!roster.rows.some((entry) => entry.userId === "fin"), "the roster hides deactivated people by default");
      const all = await withTenantRead(database.pool, ORG, (db) => listStaffPage(db, { ...defaultListQuery(staffListSpec), filters: { status: ["deactivated"] } }));
      assert.deepEqual(all.rows.map((entry) => entry.userId), ["fin"]);
    });

    it("reinstates with a reason, and the same credential signs in again (Q8)", async () => {
      await assert.rejects(reinstateStaff(database.pool, { userId: "fin", expectedVersion: await version("fin") }, context()), issue("reason", "REQUIRED"));
      await reinstateStaff(database.pool, { userId: "fin", expectedVersion: await version("fin") }, context("ada", "admin", "Came back"));
      const row = await member("fin");
      assert.deepEqual([row.status, row.deactivated_at, row.deactivated_by], ["active", null, null]);
      assert.equal((await resolveStaffPrincipal(database.pool, { sessionId: "session-fin", userId: "fin", organisationId: ORG, issuedAt: 0, expiresAt: 0 })).role, "finance");
      await assert.rejects(reinstateStaff(database.pool, { userId: "fin", expectedVersion: await version("fin") }, context("ada", "admin", "again")), issue("userId", "NOT_DEACTIVATED"));
    });

    it("never deactivates yourself, nor the last active admin", async () => {
      await assert.rejects(deactivateStaff(database.pool, { userId: "ada", expectedVersion: await version("ada") }, context("ada", "admin", "Leaving")), issue("userId", "SELF_CHANGE"));
      await changeStaffRole(database.pool, { userId: "bea", expectedVersion: await version("bea"), role: "consultant" }, context("ada", "admin", "Only one admin now"));
      await changeStaffRole(database.pool, { userId: "cal", expectedVersion: await version("cal"), role: "admin" }, context("ada", "admin", "Cal admins"));
      await deactivateStaff(database.pool, { userId: "cal", expectedVersion: await version("cal") }, context("ada", "admin", "Cal leaves"));
      // Ada is now the only active admin; Bea is a consultant and cannot act, so a second admin (Oz is elsewhere) is made to try.
      await q(`UPDATE nzi_console.memberships SET role_id = 'admin' WHERE organisation_id = $1 AND user_id = 'bea'`, [ORG]);
      await changeStaffRole(database.pool, { userId: "bea", expectedVersion: await version("bea"), role: "viewer" }, context("ada", "admin", "Back to one admin"));
      await assert.rejects(deactivateStaff(database.pool, { userId: "ada", expectedVersion: await version("ada") }, context("bea", "admin", "Lockout attempt")), issue("userId", "LAST_ADMIN"));
    });

    it("replays an idempotent retry without a second change", async () => {
      const v = await version("vic");
      const first = await updateStaff(database.pool, { userId: "vic", expectedVersion: v, displayName: "Vic Again" }, context("ada", "admin", undefined, ORG, "ta-same"));
      const again = await updateStaff(database.pool, { userId: "vic", expectedVersion: v, displayName: "Vic Again" }, context("ada", "admin", undefined, ORG, "ta-same"));
      assert.deepEqual([again.replayed, again.auditEventId, await version("vic")], [true, first.auditEventId, v + 1]);
    });

    it("the history lists the membership's events, newest first, with reasons", async () => {
      const history = await withTenantRead(database.pool, ORG, (db) => readStaffHistory(db, "fin"));
      assert.deepEqual(history.slice(0, 2).map((entry) => [entry.action, entry.reason]), [["staff.reinstated", "Came back"], ["staff.deactivated", "Left the firm"]]);
      assert.equal(history[0]!.actor, "Ada Admin");
    });
  });

  describe("staff rates (R9 (c))", () => {
    const holder = (role: StaffRole) => ({ capabilities: commandGrantForRole(role, ORG, "x").capabilities });

    it("are finance.manage only — Admin and Finance set and read them; Consultant (who holds finance.view) cannot", async () => {
      await assert.rejects(setStaffRate(database.pool, { userId: "vic", effectiveFrom: "2026-01-01", costPerHour: 40 }, context("cal", "consultant")), /finance\.manage|permission/i);
      await assert.rejects(withTenantRead(database.pool, ORG, (db) => readStaffRates(db, holder("consultant"), "vic", "2026-09-30")), /finance\.manage/);
      await setStaffRate(database.pool, { userId: "vic", effectiveFrom: "2026-01-01", costPerHour: 40, sellPerHour: 95 }, context("fin", "finance"));
      const rates = await withTenantRead(database.pool, ORG, (db) => readStaffRates(db, holder("admin"), "vic", "2026-09-30"));
      assert.deepEqual([rates.current?.costPerHour, rates.current?.sellPerHour, rates.current?.currency], [40, 95, "GBP"]);
    });

    it("keep history by superseding: a later date is a new row, a correction supersedes (with a reason), nothing is edited or deleted", async () => {
      await setStaffRate(database.pool, { userId: "vic", effectiveFrom: "2026-07-01", costPerHour: 45, sellPerHour: 100 }, context("fin", "finance"));
      await assert.rejects(setStaffRate(database.pool, { userId: "vic", effectiveFrom: "2026-07-01", costPerHour: 46 }, context("fin", "finance")), issue("effectiveFrom", "DUPLICATE"));
      const july = (await q(`SELECT rate_id FROM nzi_console.staff_rates WHERE organisation_id = $1 AND user_id = 'vic' AND effective_from = '2026-07-01'`, [ORG]))[0].rate_id;
      await assert.rejects(setStaffRate(database.pool, { userId: "vic", effectiveFrom: "2026-07-01", costPerHour: 46, supersedesRateId: july }, context("fin", "finance")), issue("reason", "REQUIRED"));
      await setStaffRate(database.pool, { userId: "vic", effectiveFrom: "2026-07-01", costPerHour: 46, sellPerHour: 100, supersedesRateId: july }, context("fin", "finance", "Typo in the cost"));
      await assert.rejects(setStaffRate(database.pool, { userId: "vic", effectiveFrom: "2026-07-01", costPerHour: 47, supersedesRateId: july }, context("fin", "finance", "again")), issue("supersedesRateId", "ALREADY_SUPERSEDED"));
      const rates = await withTenantRead(database.pool, ORG, (db) => readStaffRates(db, holder("finance"), "vic", "2026-09-30"));
      assert.equal(rates.rates.length, 3, "every row kept");
      assert.deepEqual([rates.current?.effectiveFrom, rates.current?.costPerHour], ["2026-07-01", 46]);
      assert.equal((await withTenantRead(database.pool, ORG, (db) => readStaffRates(db, holder("finance"), "vic", "2026-03-01"))).current?.costPerHour, 40, "the rate in force on an earlier day");
      await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`UPDATE nzi_console.staff_rates SET cost_per_hour = 1`)), /permission denied/);
      await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`DELETE FROM nzi_console.staff_rates`)), /permission denied/);
      // The database holds the one-live-row rule for any writer, not only the command.
      await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(
        `INSERT INTO nzi_console.staff_rates (organisation_id, rate_id, user_id, effective_from, cost_per_hour, recorded_by) VALUES ($1, 'raw', 'vic', '2026-01-01', 1, 'x')`, [ORG])), /already stands/);
    });

    it("are invisible to another organisation", async () => {
      assert.equal((await withTenantRead(database.pool, OTHER, (db) => db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.staff_rates`))).rows[0]?.n, 0);
    });
  });
});
