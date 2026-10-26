import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { roleCapabilityGrants, type StaffSignatureFields } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import type { StaffPrincipal } from "../src/auth";
import { emailDispatchFromEnv } from "../src/email";
import { VersionConflictError } from "../src/errors";
import { suppressingMailer } from "../src/mailer";
import { createPortalInvitation } from "../src/portalInvitations";
import { withTenantRead, withTenantWorker, withTenantWrite } from "../src/postgres";
import { readStaffSignature, StaffSignatureError, updateOwnStaffSignature } from "../src/staffSignature";
import { drainOutbox } from "../src/strategyReminderWorker";
import { sendTemplatedEmail } from "../src/templatedEmail";

/**
 * Team-member signatures (email programme phase 5-2) against a real database: the member's signature fields (0185) on their
 * own record — defaults from it, saved only by them, versioned, sealed and audited by field name — and the personal lines on
 * an email attributed to them (the portal invitation from its adviser), never on a system email, with From, reply-to and
 * the isolation gate unchanged.
 */

const ORG = "signature-org";
const CLIENT = "client-s";
const ORIGIN = "https://console.example.test";
const KEYED = { NZI_DATABASE_BOUNDARY: "isolated-non-production", NEXT_PUBLIC_APP_ENV: "staging", RESEND_API_KEY: "re_test_0123456789abcdef", EMAIL_FROM: "Net Zero International <no-reply@netzero.international>" };
const NONE: StaffSignatureFields = { title: null, displayEmail: null, mobile: null, signOff: null };
const asAdmin = (userId: string) =>
  ({ organisationId: ORG, userId, sessionId: "s", issuedAt: 1, expiresAt: 2, role: "admin", matrixVersion: 1, capabilities: roleCapabilityGrants("admin") }) as StaffPrincipal;

describe("team-member email signatures (phase 5-2), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  let invites = 0;
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const member = (userId: string) => ({ organisationId: ORG, userId });
  const read = (userId: string) => withTenantRead(database.pool, ORG, (db) => readStaffSignature(db, userId));
  const stored = async (id: string) => (await q<{ html_body: string; text_body: string; from_address: string | null; reply_to: string | null }>(
    `SELECT html_body, text_body, from_address, reply_to FROM nzi_console.email_messages WHERE email_message_id = $1`, [id]))[0]!;
  const invite = async (by: string, email: string) => {
    invites += 1;
    const result = await createPortalInvitation(database.pool, asAdmin(by), { clientId: CLIENT, email, displayName: `Grace ${invites}`, consoleOrigin: ORIGIN });
    assert.equal(result.delivery, "email");
    return stored((result as { emailMessageId: string }).emailMessageId);
  };

  before(async () => {
    database = (await createDisposableDatabase("signatures"))!;
    admin = await database.admin();
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'Net Zero International')`, [ORG]);
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Example Manufacturing Ltd', 'active')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, active, source, created_by, updated_by)
             VALUES ($1, 'positions', 'pos-crm', 'Customer Relationship Manager', true, 'import', 'seed', 'seed')`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email, position_value_id) VALUES
      ($1, 'ada', 'admin', 'active', 'Ada Admin', 'ada@netzero.international', NULL),
      ($1, 'jen', 'admin', 'active', 'Jennie Davide', 'Jennie@netzero.international', 'pos-crm'),
      ($1, 'sam', 'admin', 'active', 'Sam Adviser', 'sam@netzero.international', NULL)`, [ORG]);
  });
  beforeEach(async () => {
    await q(`DELETE FROM nzi_console.transactional_outbox`);
    await q(`DELETE FROM nzi_console.email_messages`);
  });
  after(async () => { await admin?.end(); await database?.end(); });

  it("reads an un-edited member's defaults from their record: name, position, work email", async () => {
    assert.deepEqual(await read("jen"), {
      fields: NONE, defaults: { name: "Jennie Davide", positionTitle: "Customer Relationship Manager", workEmail: "Jennie@netzero.international" }, version: 1,
    });
  });

  it("an attributed portal invitation carries the adviser's lines above the chrome — defaults, no mobile line", async () => {
    const { html_body: html, text_body: text } = await invite("jen", "grace1@netzero.international");
    assert.ok(html.indexOf(">Kind regards</p>") < html.indexOf(">Jennie Davide</p>") && html.indexOf(">Jennie Davide</p>") < html.indexOf("font-weight:bold\">Net Zero International</p>"));
    assert.ok(html.includes(">Customer Relationship Manager</p>") && html.includes('href="mailto:jennie@netzero.international"'));
    assert.doesNotMatch(html, /Mobile UK/, "no mobile set: the line is skipped");
    assert.match(text, /--\nKind regards\n\nJennie Davide\nCustomer Relationship Manager\nNet Zero International\nWebsite: netzero\.international\nEmail: jennie@netzero\.international\n\n/);
  });

  it("the member saves their own: normalised, versioned, sealed, and audited by field name only", async () => {
    const saved = await updateOwnStaffSignature(database.pool, member("jen"), {
      title: "  Head of Client Relationships ", displayEmail: "J.Davide@NetZero.International", mobile: "+44 7700 900123", signOff: "Best wishes", expectedVersion: 1,
    });
    assert.deepEqual([saved.version, saved.changed], [2, ["title", "displayEmail", "mobile", "signOff"]]);
    const row = (await q(`SELECT signature_title, signature_email, signature_mobile, signature_sign_off, signature_title_sealed, signature_email_sealed,
                                  signature_mobile_sealed, version, updated_by FROM nzi_console.memberships WHERE user_id = 'jen'`))[0]!;
    assert.deepEqual([row.signature_title, row.signature_email, row.signature_mobile, row.signature_sign_off, row.version, row.updated_by],
      ["Head of Client Relationships", "j.davide@netzero.international", "+44 7700 900123", "Best wishes", 2, "jen"]);
    for (const column of ["signature_title_sealed", "signature_email_sealed", "signature_mobile_sealed"]) {
      assert.ok(row[column] !== null, `${column} written in the same transaction`);
      assert.ok(!JSON.stringify(row[column]).includes("7700") && !JSON.stringify(row[column]).includes("Head of"), `${column} is ciphertext`);
    }
    const audits = await q(`SELECT actor_id, action, entity_id, after_json FROM nzi_console.audit_events WHERE action = 'staff.signature.updated'`);
    assert.equal(audits.length, 1);
    assert.deepEqual([audits[0]!.actor_id, audits[0]!.entity_id, audits[0]!.after_json], ["jen", "jen", { userId: "jen", version: 2, changed: ["title", "displayEmail", "mobile", "signOff"] }]);
    assert.doesNotMatch(JSON.stringify(audits[0]!.after_json), /7700|davide|Head of|Best wishes/i, "never a value in the audit");

    // Nothing changed: nothing written, no version bump, no audit.
    const again = await updateOwnStaffSignature(database.pool, member("jen"), { ...saved.fields, expectedVersion: 2 });
    assert.deepEqual([again.version, again.changed], [2, []]);
    assert.equal((await q(`SELECT 1 FROM nzi_console.audit_events WHERE action = 'staff.signature.updated'`)).length, 1);
  });

  it("the saved lines are what the next attributed email carries", async () => {
    const { html_body: html, text_body: text } = await invite("jen", "grace2@netzero.international");
    assert.ok(html.includes(">Best wishes</p>") && html.includes(">Head of Client Relationships</p>") && html.includes("Mobile UK: +44 7700 900123"));
    assert.match(text, /--\nBest wishes\n\nJennie Davide\nHead of Client Relationships\nNet Zero International\nWebsite: netzero\.international\nEmail: j\.davide@netzero\.international\nMobile UK: \+44 7700 900123\n\n/);
  });

  it("a member edits only their own: a body naming another member still writes only the signed-in one", async () => {
    const before = await q(`SELECT signature_title, version FROM nzi_console.memberships WHERE user_id = 'sam'`);
    const smuggled = { ...NONE, title: "Forged", expectedVersion: 2, userId: "sam" } as StaffSignatureFields & { expectedVersion: number };
    const saved = await updateOwnStaffSignature(database.pool, member("jen"), smuggled);
    assert.equal(saved.fields.title, "Forged");
    assert.deepEqual(await q(`SELECT signature_title, version FROM nzi_console.memberships WHERE user_id = 'sam'`), before, "the other member is untouched");
    // Put Jennie's title back for the later tests.
    await updateOwnStaffSignature(database.pool, member("jen"), { ...saved.fields, title: "Head of Client Relationships", expectedVersion: saved.version });
  });

  it("refuses a stale version, bad values at the screen's rules, and bad values in the table", async () => {
    const current = (await read("jen"))!;
    await assert.rejects(updateOwnStaffSignature(database.pool, member("jen"), { ...current.fields, mobile: "07700 900999", expectedVersion: current.version - 1 }), VersionConflictError);
    await assert.rejects(updateOwnStaffSignature(database.pool, member("jen"), { ...current.fields, displayEmail: "nope", expectedVersion: current.version }),
      (error: StaffSignatureError) => error.issues.some((issue) => issue.field === "displayEmail" && issue.code === "INVALID"));
    await assert.rejects(q(`UPDATE nzi_console.memberships SET signature_mobile = 'call me' WHERE user_id = 'jen'`), /check constraint/);
    await assert.rejects(q(`UPDATE nzi_console.memberships SET signature_sign_off = E'Kind\\nregards' WHERE user_id = 'jen'`), /check constraint/);
    await assert.rejects(updateOwnStaffSignature(database.pool, member("nobody"), { ...NONE, expectedVersion: 1 }), StaffSignatureError);
  });

  it("a system email carries the organisation's chrome only — no personal lines", async () => {
    const queued = await withTenantWrite(database.pool, ORG, (db) => sendTemplatedEmail(db, ORG, {
      templateCode: "password.reset.staff", to: "jen@netzero.international", consoleOrigin: ORIGIN,
      vars: { displayName: "Jennie Davide", resetLink: `${ORIGIN}/reset#token=abc`, expiresAt: "17:00" },
    }));
    const { html_body: html, text_body: text } = await stored(queued.emailMessageId);
    assert.doesNotMatch(html, /Best wishes|Kind regards|Head of Client|Mobile UK|mailto:/);
    assert.doesNotMatch(text, /Best wishes|Kind regards|Mobile UK|\nEmail: /);
    assert.match(html, /font-weight:bold">Net Zero International<\/p>/);
  });

  it("a deactivated member signs nothing: an email attributed to them carries the chrome only", async () => {
    await q(`UPDATE nzi_console.memberships SET status = 'deactivated', deactivated_at = now(), deactivated_by = 'ada' WHERE user_id = 'sam'`);
    const queued = await withTenantWrite(database.pool, ORG, (db) => sendTemplatedEmail(db, ORG, {
      templateCode: "message.notification", to: "x@netzero.international", consoleOrigin: ORIGIN, attributedTo: "sam",
      vars: { displayName: "Client", clientName: "Example Ltd", threadLink: `${ORIGIN}/portal/messages` },
    }));
    assert.doesNotMatch((await stored(queued.emailMessageId)).html_body, /Kind regards|Sam Adviser/);
    await q(`UPDATE nzi_console.memberships SET status = 'active', deactivated_at = NULL, deactivated_by = NULL WHERE user_id = 'sam'`);
  });

  it("leaves From, reply-to and the isolation gate as they were: posted from EMAIL_FROM, off-domain still stubbed", async () => {
    const nzi = await invite("jen", "grace3@netzero.international");
    await invite("jen", "grace@example.com");
    assert.deepEqual([nzi.from_address, nzi.reply_to], [null, null], "the signature is body content; the sender is the deployment's");
    const posted: Array<{ from: string; to: string[]; html: string; reply_to?: string }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => { posted.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ id: `re-${posted.length}` }), { status: 200 }); }) as unknown as typeof fetch;
    const drained = await withTenantWorker(database.pool, ORG, (db) => drainOutbox(db, {
      organisationId: ORG, today: "2026-10-26", mailer: suppressingMailer(), delivery: { mode: "suppress", reason: "test" }, email: emailDispatchFromEnv(KEYED, fetchImpl), only: "email",
    }));
    assert.deepEqual(drained.emails, { sent: 1, stubbed: 1, retried: 0, failed: 0 });
    assert.equal(posted[0]!.from, KEYED.EMAIL_FROM);
    assert.equal(posted[0]!.reply_to, undefined);
    assert.ok(posted[0]!.html.includes(">Jennie Davide</p>"));
  });
});
