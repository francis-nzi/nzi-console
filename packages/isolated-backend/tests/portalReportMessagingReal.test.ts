import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, roleCapabilityGrants, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { CommandValidationError, validateCrpReport } from "../src/postgresCommands";
import { approveReportAsClient, CLIENT_APPROVAL_MESSAGE, finalApproveReport, postReportMessageAsClient, sendReportToClientReview } from "../src/reportReviewLoop";
import { getGrantedPortalReviewRound } from "../src/portalReportReview";
import { addStaffReportComment, listStaffReportThreads } from "../src/portalReview";
import { scanMessageNotifications } from "../src/portalMessageNotifications";
import { runWorkerTick, withTenantWorker } from "../src/index";
import { emailDispatchFromEnv } from "../src/email";
import { suppressingMailer } from "../src/mailer";
import { AuthorizationError, type StaffPrincipal } from "../src/auth";
import { VersionConflictError } from "../src/errors";
import { withTenantRead } from "../src/postgres";

/**
 * Client-review loop S5 (messaging + email + the client's Approve), against a real database, through the real commands as nzi_console_app:
 * - the client posts to the team on an `in_client_review` (or just approved) round, in the report thread the comments already use; the team reads
 *   it and replies (inbox / reply path), and the client reads both in the round;
 * - each message queues ONE notify-only email for the other side in the posting transaction (the existing queue, RULING-portal-messages M4):
 *   the worker's scan sends it - a link and never the words, consent-gated for the client; a stubbed or refused address never fails the post;
 * - authorisation: no grant, a revoked grant, another client's user and a staff principal are each refused;
 * - Approve (report.clientApprove) is pinned to the version on screen, locks the round, and tells the team (a thread entry + the email).
 */
const ORG = "prm-org", CLIENT = "prm-client", OTHER_CLIENT = "prm-other-client", JOB = "prm-job";
const ORIGIN = "https://console.example.org";
const SECRET = "Our boiler figure of 4471 tCO2e looks wrong - ring Sam on 07700 900123";

const staffPrincipal = (userId: string, role: StaffRole = "admin"): StaffPrincipal => ({
  organisationId: ORG, userId, sessionId: "s", issuedAt: 1, expiresAt: 2, role, matrixVersion: 1, capabilities: roleCapabilityGrants(role),
}) as unknown as StaffPrincipal;

describe("S5: client ↔ CRM messaging on a review round, the notify-only email, and the client's Approve, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const staff = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `prm-${count}`, correlationId: `corr-prm-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const portal = (user: string, clientId = CLIENT): CommandContext => { count += 1; return { organisationId: ORG, actorId: user, principal: "portal", portal: { portalUserId: user, clientId }, idempotencyKey: `prm-${count}`, correlationId: `corr-prm-${count}` }; };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const row = async (id: string) => (await q(`SELECT * FROM nzi_console.report_versions WHERE report_version_id = $1`, [id]))[0]!;
  const version = async (id: string) => Number((await row(id)).version);
  const post = (id: string, text: string, user = "pm-1") => postReportMessageAsClient(database.pool, { reportVersionId: id, body: text }, portal(user));
  const round = (id: string, user = "pm-1", clientId = CLIENT) => withTenantRead(database.pool, ORG, (db) => getGrantedPortalReviewRound(db, { organisationId: ORG, portalUserId: user, clientId, jobId: JOB, reportVersionId: id }));
  const pending = async (audience?: string) => await q(`SELECT * FROM nzi_console.portal_message_notifications WHERE state = 'pending' ${audience ? "AND audience = $1" : ""}`, audience ? [audience] : []);
  const windowPasses = () => q(`UPDATE nzi_console.portal_message_notifications SET due_at = now() - interval '1 minute' WHERE state = 'pending'`);
  const scan = () => withTenantWorker(database.pool, ORG, (tx) => scanMessageNotifications(tx, { organisationId: ORG, consoleOrigin: ORIGIN }));
  const mails = (templateCode?: string) => q(`SELECT to_email, template_code, subject, text_body, html_body, status FROM nzi_console.email_messages ${templateCode ? "WHERE template_code = $1" : ""} ORDER BY created_at, email_message_id`, templateCode ? [templateCode] : []);
  const comments = (id: string) => q(`SELECT author_principal, body, author_display_name FROM nzi_console.portal_report_comments WHERE report_version_id = $1 ORDER BY created_at, comment_id`, [id]);
  const refusedWith = (code: string) => (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === code);

  let snapshots = 0;
  const approvedSnapshot = async (): Promise<string> => {
    snapshots += 1;
    const snapshotId = `prm-snap-${snapshots}`;
    const payload = { jobNumber: "J009909", client: "Message Co", reportingYear: 2025,
      measurements: [
        { rowId: `r-${snapshots}`, scope: "1", scopeCode: "1", siteId: null, siteLabel: null, sourceLabel: "Gas", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
        { rowId: `g-${snapshots}`, scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, sourceLabel: "Goods", tco2e: 20, qualityTier: "estimated", factorSet: "demo",
          purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }],
      target: { baselineYear: 2023, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget: { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2023, baselineIntensity: 6,
        interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId: JOB, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ada" },
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 12 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, 'prep', 'rev', now())`, [ORG, snapshotId, JOB, snapshots, `sha256:${createHash("sha256").update(snapshotId).digest("hex")}`, JSON.stringify(payload)]);
    return snapshotId;
  };
  const validated = async () => { const snapshotId = await approvedSnapshot(); return { snapshotId, id: (await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1 }, staff("rev", "reviewer"))).data.reportVersionId }; };
  const sent = async () => { const v = await validated(); await sendReportToClientReview(database.pool, { reportVersionId: v.id, expectedStatus: "validated", expectedVersion: await version(v.id) }, staff("rev", "reviewer")); return v; };
  /** Start each test with nothing queued or sent from an earlier one. */
  const quiet = async () => { await windowPasses(); await scan(); return (await mails()).length; };
  const since = async (mark: number, templateCode: string) => (await mails()).slice(mark).filter((m) => m.template_code === templateCode);

  before(async () => {
    database = (await createDisposableDatabase("portalreportmessaging"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email) VALUES
      ($1, 'ada', 'admin', 'active', 'Ada Adviser', 'ada@netzero.international'), ($1, 'rev', 'reviewer', 'active', 'Rev', 'rev@netzero.international'), ($1, 'prep', 'admin', 'active', 'Prep', 'prep@netzero.international')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency, client_manager_user_id) VALUES ($1, $2, 'Message Co', 'active', 'GBP', 'ada'), ($1, $3, 'Other Co', 'active', 'GBP', 'ada')`, [ORG, CLIENT, OTHER_CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9909, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
    for (const [user, client, name, email] of [["pm-1", CLIENT, "Pat Portal", "pat@client.example"], ["pm-2", CLIENT, "Pia Portal", "pia@client.example"], ["pm-revoked", CLIENT, "Rex", "rex@client.example"],
      ["pm-nogrant", CLIENT, "Nia", "nia@client.example"], ["pm-other", OTHER_CLIENT, "Otto", "otto@other.example"]]) {
      await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status, display_name, email_normalized) VALUES ($1, $2, $3, 'active', $4, $5)`, [ORG, user, client, name, email]);
    }
    for (const user of ["pm-1", "pm-2"]) await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id) VALUES ($1, $2, $3, $4, $5)`, [ORG, `g-${user}`, CLIENT, user, JOB]);
    await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id, revoked_at) VALUES ($1, 'g-rev', $2, 'pm-revoked', $3, now())`, [ORG, CLIENT, JOB]);
    // Consent lives on the client's contacts, by address: Pat has granted, Pia has not said.
    await q(`INSERT INTO nzi_console.client_contacts (organisation_id, contact_id, client_id, full_name, email, status, email_consent, created_by, updated_by)
             VALUES ($1, 'k-pat', $2, 'Pat Portal', 'pat@client.example', 'active', 'granted', 't', 't')`, [ORG, CLIENT]);
  });
  after(async () => { await database?.end(); });

  it("the client's message lands in the round's thread, awaiting the team, and queues ONE notify-only email for the team - written in the post's transaction, sent by the worker as a link and never the words", async () => {
    const v = await sent();
    const result = await post(v.id, SECRET);
    assert.equal(result.data.threadId, `thr-rv-${v.id}`);
    assert.deepEqual((await comments(v.id)).map((c) => [c.author_principal, c.body, c.author_display_name]), [["portal", SECRET, "Pat Portal"]]);
    const [thread] = await q(`SELECT state, message_count, report_version_id, job_id FROM nzi_console.portal_threads WHERE thread_id = $1`, [`thr-rv-${v.id}`]);
    assert.deepEqual([thread.state, thread.message_count, thread.report_version_id, thread.job_id], ["awaiting_nzi", 1, v.id, JOB]);
    // The post queued the notification for the team in its own transaction and sent nothing.
    assert.deepEqual((await pending()).map((r) => [r.thread_id, r.audience, r.message_count]), [[`thr-rv-${v.id}`, "staff", 1]]);
    assert.equal((await mails()).length, 0, "an email was written by the request");
    // A second message in the burst joins the same row.
    await post(v.id, "And another.");
    assert.deepEqual((await pending()).map((r) => r.message_count), [2]);

    await windowPasses();
    assert.deepEqual(await scan(), { due: 1, emailed: 1, blockedNoConsent: 0, noRecipient: 0, refused: 0 });
    const emails = await mails("portal.message.staff-notification");
    assert.equal(emails.length, 1, "a burst is one email");
    assert.equal(emails[0]!.to_email, "ada@netzero.international");
    const text = [emails[0]!.text_body, emails[0]!.html_body, emails[0]!.subject].join("\n");
    assert.match(text, /\/clients\/prm-client\?area=portal/, "a link to the portal area");
    assert.ok(!/boiler|4471|tCO2e|07700|Sam|And another/.test(text), "the words, a figure or a phone number are in the email");
    // The plain-text part, minus its links and the house GDPR citation: no digit run is left - no figure of any kind.
    const figures = emails[0]!.text_body.replace(/https?:\/\/\S+/g, "").replace(/\(EU\) 2016\/679/, "");
    assert.ok(!/\d{2,}/.test(figures), `a figure outside the link: ${figures}`);
    // The audit holds ids only.
    const audit = JSON.stringify(await q(`SELECT after_json FROM nzi_console.audit_events WHERE entity_id = $1 OR correlation_id LIKE 'corr-prm-%'`, [v.id]));
    assert.ok(!/boiler|4471|07700/.test(audit), "the message text is in the audit");
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE entity_id = $1 AND action = 'portal_report_message_posted' AND principal_type = 'portal'`, [v.id]))[0].n, 2);
    assert.deepEqual(await scan(), { due: 0, emailed: 0, blockedNoConsent: 0, noRecipient: 0, refused: 0 }, "idempotent: nothing more to send");
  });

  it("the team reads the thread in the inbox and replies; the client reads both in the round, and is emailed a link (consent-gated) - never the reply", async () => {
    const mark = await quiet();
    const v = await sent();
    await post(v.id, "Can you check the second paragraph?");
    const threads = await listStaffReportThreads(database.pool, staffPrincipal("ada"));
    const mine = threads.find((thread) => thread.reportVersionId === v.id)!;
    assert.deepEqual([mine.status, mine.needsReply, mine.comments.length], ["in_client_review", true, 1], "the inbox lists the round and its message");

    const reply = await addStaffReportComment(database.pool, staffPrincipal("ada"), { jobId: JOB, reportVersionId: v.id, body: "Done - see the revised figures 123.4 in section two." });
    assert.equal(reply.authorPrincipal, "staff");
    const seen = await round(v.id);
    assert.deepEqual(seen!.messages.map((m) => [m.authorPrincipal, m.body]), [["portal", "Can you check the second paragraph?"], ["staff", "Done - see the revised figures 123.4 in section two."]]);

    // The client side is consent-gated: Pat granted, Pia not (both hold the job) - one email, to Pat, a deep link, none of the reply.
    assert.deepEqual((await pending("client")).map((r) => r.message_count), [1]);
    await windowPasses();
    const summary = await scan();
    assert.equal(summary.emailed, 2, "the team's notification for the client's message, and the client's for the reply");
    assert.equal(summary.blockedNoConsent, 1, "Pia has not consented");
    const toClient = await since(mark, "message.notification");
    assert.deepEqual(toClient.map((m) => m.to_email), ["pat@client.example"]);
    // F3: a report-review round's notification deep-links to the review page (from the thread's own report_version_id), not the Messages page.
    assert.match(toClient[0]!.text_body, /\/portal\/jobs\/prm-job\/review(?![\w?/])/);
    assert.doesNotMatch(toClient[0]!.text_body, /messages\?thread=/);
    assert.ok(!/revised figures|123\.4|section two/.test([toClient[0]!.text_body, toClient[0]!.html_body, toClient[0]!.subject].join("\n")), "the reply's words are in the email");
  });

  it("F3 (0218): the worker may read which version a thread belongs to - and still not the report itself, the thread's text, or write the thread", async () => {
    const v = await sent();
    await post(v.id, "Is the second paragraph right?");
    const seen = await withTenantWorker(database.pool, ORG, async (tx) => (await tx.query<{ report_version_id: string | null }>(`SELECT report_version_id FROM nzi_console.portal_threads WHERE report_version_id = $1`, [v.id])).rows);
    assert.deepEqual(seen.map((row) => row.report_version_id), [v.id]);
    const denied = async (sql: string) => assert.rejects(() => withTenantWorker(database.pool, ORG, (tx) => tx.query(sql)), (error: unknown) => (error as { code?: string }).code === "42501");
    await denied(`SELECT status FROM nzi_console.report_versions LIMIT 1`);
    await denied(`SELECT body FROM nzi_console.portal_report_comments LIMIT 1`);
    await denied(`UPDATE nzi_console.portal_threads SET report_version_id = NULL`);
  });

  it("a stubbed recipient never fails the post: an address the isolation gate refuses is stubbed at delivery, and the message is already posted", async () => {
    const mark = await quiet();
    const v = await sent();
    await post(v.id, "Is this the final wording?");
    await addStaffReportComment(database.pool, staffPrincipal("ada"), { jobId: JOB, reportVersionId: v.id, body: "Yes." });
    assert.equal((await comments(v.id)).length, 2);
    await windowPasses();
    await runWorkerTick(database.pool, { organisationId: ORG, today: "2026-11-03", mailer: suppressingMailer(), email: emailDispatchFromEnv({}), consoleOrigin: ORIGIN, messageNotifications: true, env: { mailMode: "suppress" } } as never);
    const next = await runWorkerTick(database.pool, { organisationId: ORG, today: "2026-11-03", mailer: suppressingMailer(), email: emailDispatchFromEnv({}), consoleOrigin: ORIGIN, messageNotifications: false, env: { mailMode: "suppress" } } as never);
    assert.ok(next.emails.ok);
    const toClient = await since(mark, "message.notification");
    assert.ok(toClient.length >= 1 && toClient.every((m) => m.status === "stubbed"), "the external address was stubbed, not sent");
    assert.equal((await comments(v.id)).length, 2, "the messages stand");
  });

  it("a round just approved can still be written about; a validated, issued or superseded one cannot - and nothing is written or queued", async () => {
    await quiet();
    const approved = await sent();
    await approveReportAsClient(database.pool, { reportVersionId: approved.id, expectedVersion: await version(approved.id) }, portal("pm-1"));
    await post(approved.id, "Please reopen the background section.");
    assert.equal((await comments(approved.id)).at(-1)!.body, "Please reopen the background section.");

    const unsent = await validated();
    await assert.rejects(post(unsent.id, "Too early."), refusedWith("PRECONDITION"));
    const replaced = await validated();
    await q(`UPDATE nzi_console.report_versions SET status = 'superseded' WHERE report_version_id = $1`, [replaced.id]);
    await assert.rejects(post(replaced.id, "Too late."), refusedWith("PRECONDITION"));
    for (const id of [unsent.id, replaced.id]) assert.equal((await comments(id)).length, 0);
    assert.equal((await q(`SELECT 1 FROM nzi_console.portal_threads WHERE report_version_id = ANY($1)`, [[unsent.id, replaced.id]])).length, 0, "no thread opened for a refused post");
  });

  it("authorisation: no grant, a revoked grant, another client's user, a staff principal and an over-long or empty message are each refused, and nothing is written", async () => {
    await quiet();
    const v = await sent();
    for (const user of ["pm-nogrant", "pm-revoked"]) await assert.rejects(post(v.id, "Hello", user), AuthorizationError);
    await assert.rejects(postReportMessageAsClient(database.pool, { reportVersionId: v.id, body: "Hello" }, portal("pm-other", OTHER_CLIENT)), AuthorizationError);
    await assert.rejects(postReportMessageAsClient(database.pool, { reportVersionId: v.id, body: "Hello" }, staff("ada", "admin")));
    await assert.rejects(post(v.id, "   "));
    await assert.rejects(post(v.id, "x".repeat(4001)));
    assert.equal((await comments(v.id)).length, 0);
    assert.equal((await pending()).length, 0, "a refused post queues nothing");
    assert.equal(await round(v.id, "pm-nogrant"), null, "no grant: no round, no thread");
    assert.equal(await round(v.id, "pm-other", OTHER_CLIENT), null);
  });

  it("Approve is pinned to the version on screen: a stale version is refused, the right one moves the round to client_approved, locks it, and tells the team (a thread entry and the notify-only email)", async () => {
    const mark = await quiet();
    const v = await sent();
    const seen = await version(v.id);
    await q(`UPDATE nzi_console.report_versions SET version = version + 1 WHERE report_version_id = $1`, [v.id]); // the round moved on after the client opened it
    await assert.rejects(approveReportAsClient(database.pool, { reportVersionId: v.id, expectedVersion: seen }, portal("pm-1")), VersionConflictError);
    assert.equal((await row(v.id)).status, "in_client_review", "a stale approval changed nothing");
    assert.equal((await comments(v.id)).length, 0, "and told the team nothing");

    const result = await approveReportAsClient(database.pool, { reportVersionId: v.id, expectedVersion: await version(v.id) }, portal("pm-1"));
    assert.equal(result.data.status, "client_approved");
    assert.equal((await row(v.id)).status, "client_approved");
    const locked = await round(v.id);
    assert.deepEqual([locked!.status, locked!.editableSections], ["client_approved", []], "the page locks");
    assert.deepEqual((await comments(v.id)).map((c) => [c.author_principal, c.body]), [["portal", CLIENT_APPROVAL_MESSAGE]], "an entry the team sees");
    assert.equal((await q(`SELECT state FROM nzi_console.portal_threads WHERE thread_id = $1`, [`thr-rv-${v.id}`]))[0].state, "awaiting_nzi");
    const threads = await listStaffReportThreads(database.pool, staffPrincipal("ada"));
    const mine = threads.find((thread) => thread.reportVersionId === v.id)!;
    assert.deepEqual([mine.status, mine.needsReply, mine.awaitingApproval], ["client_approved", true, false], "in the inbox, approved, awaiting the team");
    assert.deepEqual((await pending("staff")).map((r) => r.thread_id), [`thr-rv-${v.id}`]);
    await windowPasses();
    await scan();
    const email = (await since(mark, "portal.message.staff-notification")).at(-1)!;
    assert.equal(email.to_email, "ada@netzero.international");
    assert.ok(!/approved this report/.test([email.text_body, email.html_body, email.subject].join("\n")), "the entry's words are in the email");
    await assert.rejects(approveReportAsClient(database.pool, { reportVersionId: v.id, expectedVersion: await version(v.id) }, portal("pm-2")), refusedWith("PRECONDITION"), "a second approval is refused");
  });

  it("a reply on an issued (published) report keeps its live behaviour: it is posted, and no new email is queued for the client", async () => {
    await quiet();
    const v = await sent();
    await approveReportAsClient(database.pool, { reportVersionId: v.id, expectedVersion: await version(v.id) }, portal("pm-1"));
    await finalApproveReport(database.pool, { reportVersionId: v.id, expectedStatus: "client_approved", manifestVersion: 1, reviewedSnapshotId: v.snapshotId, expectedVersion: await version(v.id) }, staff("rev", "reviewer"));
    assert.equal((await row(v.id)).status, "published");
    await windowPasses(); await scan();
    const before = (await pending("client")).length;
    await addStaffReportComment(database.pool, staffPrincipal("ada"), { jobId: JOB, reportVersionId: v.id, body: "Thanks." });
    assert.equal((await pending("client")).length, before, "no client notification was queued for a published report's reply");
  });
});
