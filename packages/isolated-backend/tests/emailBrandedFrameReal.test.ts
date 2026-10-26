import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { emailDispatchFromEnv } from "../src/email";
import { suppressingMailer } from "../src/mailer";
import { readOrganisationProfile, updateOrganisationProfile } from "../src/organisationSettings";
import { withTenantRead, withTenantWorker, withTenantWrite } from "../src/postgres";
import { drainOutbox } from "../src/strategyReminderWorker";
import { sendTemplatedEmail } from "../src/templatedEmail";

/**
 * The house email signature (phase 5-1) on the real send path: its values read from Organisation settings (0184) through the
 * real profile command, the signature closing a templated send, the branded HTML posted to Resend for an NZI address, and an
 * off-domain address still stubbed by the phase-1 gate.
 */

const ORG = "brand-org";
const ORIGIN = "https://console.example.test";
const KEYED = { NZI_DATABASE_BOUNDARY: "isolated-non-production", NEXT_PUBLIC_APP_ENV: "staging", RESEND_API_KEY: "re_test_0123456789abcdef", EMAIL_FROM: "Net Zero International <no-reply@netzero.international>" };
const RESET = { displayName: "Sam Adviser", resetLink: "https://console.example.test/reset#token=abc", expiresAt: "17:00 (UK time)" };

describe("the house email signature on the send path (phase 5-1), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  let keys = 0;
  const context = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: "ada", principal: "staff", idempotencyKey: `brand-${keys}`, correlationId: `corr-brand-${keys}`, grant: commandGrantForRole("admin", ORG, "ada") };
  };
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  // null sends with no console origin at all (an explicit undefined would take the default).
  const send = (to: string, consoleOrigin: string | null = ORIGIN) =>
    withTenantWrite(database.pool, ORG, (db) => sendTemplatedEmail(db, ORG, { templateCode: "password.reset.staff", to, vars: RESET, consoleOrigin: consoleOrigin ?? undefined }));
  const stored = async (id: string) => (await q<{ html_body: string; text_body: string }>(`SELECT html_body, text_body FROM nzi_console.email_messages WHERE email_message_id = $1`, [id]))[0]!;

  before(async () => {
    database = (await createDisposableDatabase("brandedframe"))!;
    admin = await database.admin();
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'Net Zero International')`, [ORG]);
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin')`, [ORG]);
  });
  beforeEach(async () => {
    await q(`DELETE FROM nzi_console.transactional_outbox`);
    await q(`DELETE FROM nzi_console.email_messages`);
  });
  after(async () => { await admin?.end(); await database?.end(); });

  it("with nothing set, a templated send closes with the house standard, the NZI logo at the console's origin", async () => {
    const queued = await send("sam@netzero.international");
    const { html_body: html, text_body: text } = await stored(queued.emailMessageId);
    assert.match(html, /<img src="https:\/\/console\.example\.test\/brand\/netzero-logo\.png" width="114" height="48"/);
    assert.equal((html.match(/<img /g) ?? []).length, 1, "no badge until one is set");
    assert.match(html, /font-weight:bold">Net Zero International<\/p>/);
    assert.match(html, /Website: <a href="https:\/\/netzero\.international\/"/);
    assert.match(html, /<v:roundrect [^>]*href="https:\/\/console\.example\.test\/reset#token=abc"/);
    assert.ok(html.includes(DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE));
    assert.ok(text.endsWith(`--\nNet Zero International\nWebsite: netzero.international\n\n${DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE}`), "the text part closes with the same signature");
  });

  it("takes the signature from Organisation settings, saved through the real profile command", async () => {
    const current = (await withTenantRead(database.pool, ORG, (db) => readOrganisationProfile(db, ORG)))!;
    await updateOrganisationProfile(database.pool, {
      ...current.fields, displayName: "NZI Group", websiteUrl: "https://example.test", emailLogoUrl: "https://cdn.example.test/nzi.png",
      emailBadgeUrl: "https://cdn.example.test/cpd.png", emailConfidentialityNotice: "Confidential.", expectedVersion: current.version,
    }, context());
    const saved = (await withTenantRead(database.pool, ORG, (db) => readOrganisationProfile(db, ORG)))!;
    assert.deepEqual([saved.fields.emailLogoUrl, saved.fields.emailBadgeUrl, saved.fields.emailConfidentialityNotice],
      ["https://cdn.example.test/nzi.png", "https://cdn.example.test/cpd.png", "Confidential."]);

    const queued = await send("sam@netzero.international");
    const { html_body: html, text_body: text } = await stored(queued.emailMessageId);
    assert.ok(html.indexOf('src="https://cdn.example.test/nzi.png"') < html.indexOf('src="https://cdn.example.test/cpd.png"'), "both logos, the NZI one first");
    assert.match(html, /font-weight:bold">NZI Group<\/p>/);
    assert.ok(html.includes(">example.test</a>") && html.includes("Confidential.</p>"));
    assert.ok(text.endsWith("--\nNZI Group\nWebsite: example.test\n\nConfidential."));
  });

  it("refuses a logo address a mail app could not load, at the command and in the table", async () => {
    const current = (await withTenantRead(database.pool, ORG, (db) => readOrganisationProfile(db, ORG)))!;
    await assert.rejects(() => updateOrganisationProfile(database.pool, { ...current.fields, emailBadgeUrl: "http://insecure.example.test/cpd.png", expectedVersion: current.version }, context()),
      (error: Error & { issues?: Array<{ field: string; code: string }> }) => error.issues?.some((issue) => issue.field === "emailBadgeUrl" && issue.code === "INVALID") === true);
    await assert.rejects(q(`UPDATE nzi_console.organisation_profiles SET email_logo_url = 'http://insecure.example.test/x.png' WHERE organisation_id = $1`, [ORG]), /check constraint/);
    await assert.rejects(q(`UPDATE nzi_console.organisation_profiles SET email_badge_url = 'data:image/png;base64,AAAA' WHERE organisation_id = $1`, [ORG]), /check constraint/);
    await assert.rejects(q(`UPDATE nzi_console.organisation_profiles SET email_confidentiality_notice = '   ' WHERE organisation_id = $1`, [ORG]), /check constraint/);
  });

  it("posts the branded HTML to Resend for an NZI address, and still stubs an off-domain one", async () => {
    await send("sam@netzero.international");
    await send("client@example.com");
    const posted: Array<{ to: string[]; html: string; text: string }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => { posted.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ id: `re-${posted.length}` }), { status: 200 }); }) as unknown as typeof fetch;
    const drained = await withTenantWorker(database.pool, ORG, (db) => drainOutbox(db, {
      organisationId: ORG, today: "2026-10-26", mailer: suppressingMailer(), delivery: { mode: "suppress", reason: "test" }, email: emailDispatchFromEnv(KEYED, fetchImpl), only: "email",
    }));
    assert.deepEqual(drained.emails, { sent: 1, stubbed: 1, retried: 0, failed: 0 });
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0]!.to, ["sam@netzero.international"]);
    assert.match(posted[0]!.html, /<table role="presentation" width="600"/);
    assert.match(posted[0]!.html, /<v:roundrect /);
    assert.match(posted[0]!.html, /<img src="https:\/\/cdn\.example\.test\/cpd\.png"/);
    assert.ok(posted[0]!.text.includes("https://console.example.test/reset#token=abc") && posted[0]!.text.endsWith("Confidential."), "the plain-text part travels with it");
  });

  it("a send with no console origin and no logo set still goes, the logo left out and the company carrying the identity", async () => {
    await q(`UPDATE nzi_console.organisation_profiles SET email_logo_url = NULL, email_badge_url = NULL WHERE organisation_id = $1`, [ORG]);
    const queued = await send("sam@netzero.international", null);
    const { html_body: html } = await stored(queued.emailMessageId);
    assert.doesNotMatch(html, /<img /);
    assert.match(html, /font-weight:bold">NZI Group<\/p>/);
  });
});
