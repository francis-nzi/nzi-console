import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { getPortalSrsThread, postPortalSrsMessage, postSrsMessage, readClientSrsThread, scanMessageNotifications, withTenantRead, withTenantWorker } from "../src/index";

/**
 * SRS messaging, Phase B (0221), against a real database:
 *  1. one SRS readiness conversation per client, on the portal conversations: a client's post is recorded (id, timestamp, seq) and
 *     queues the CRM's notify-only email; the CRM's reply (srs.manage) queues the client's — consent-gated, link-only, to the readiness
 *     view and the SRS area;
 *  2. a client post may ask for a review: surfaced to the CRM until answered, and it never reopens or writes the assessment;
 *  3. NZC-110: the client reads the adviser as the firm, never a name; NZC-120: a client sees and writes only its own;
 *  4. gated (an active portal user of the client; srs.manage for staff) and audited by ids, never the text.
 */
const ORG = "srs-msg-org";
const CLIENT = "client-sm", OTHER = "client-sm-other";
const ALICE = "portal-sm-alice", BOB = "portal-sm-bob", OSCAR = "portal-sm-oscar", GONE = "portal-sm-gone";
const MANAGER = "staff-sm-manager";
const ORIGIN = "https://console.example.org";
const SECRET = "Our scope 3 evidence changed — invoice 9921";

describe("SRS messaging: the client's readiness conversation (0221)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const portal = (userId = ALICE, clientId = CLIENT): CommandContext => { keys += 1; return { organisationId: ORG, actorId: userId, principal: "portal", portal: { portalUserId: userId, clientId }, idempotencyKey: `sm-${keys}`, correlationId: `corr-sm-${keys}` }; };
  const staff = (role: StaffRole = "admin", actor = MANAGER): CommandContext => { keys += 1; return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `ss-${keys}`, correlationId: `corr-ss-${keys}`, grant: commandGrantForRole(role, ORG, actor) }; };
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const scan = () => withTenantWorker(database.pool, ORG, (tx) => scanMessageNotifications(tx, { organisationId: ORG, consoleOrigin: ORIGIN }));
  const windowPasses = () => db.query(`UPDATE nzi_console.portal_message_notifications SET due_at = now() - interval '1 minute' WHERE state = 'pending'`);
  const mails = (templateCode: string) => q<{ to_email: string; text_body: string; html_body: string; subject: string }>(`SELECT to_email, text_body, html_body, subject FROM nzi_console.email_messages WHERE template_code = $1 ORDER BY created_at, email_message_id`, [templateCode]);
  const staffThread = () => withTenantRead(database.pool, ORG, (tx) => readClientSrsThread(tx, CLIENT));
  const assessment = async () => (await q(`SELECT status, version, to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS updated_at, review_cadence FROM nzi_console.srs_assessments WHERE assessment_id = 'sm-assess'`))[0];
  /** A client's post, as the route sends it: the command runner authorises it (an active user of this client) before the handler. */
  const asPortal = (input: { body: string; reviewRequest?: boolean; clientId?: string }, context = portal()) =>
    postPortalSrsMessage(database.pool, { clientId: input.clientId ?? context.portal!.clientId, body: input.body, ...(input.reviewRequest ? { reviewRequest: true } : {}) }, context);

  before(async () => {
    database = (await createDisposableDatabase("srsmessaging"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name,email) VALUES ($1,$2,'consultant','active','Mo Manager','mo@netzero.international')`, [ORG, MANAGER]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,client_manager_user_id) VALUES ($1,$2,'Example Manufacturing Ltd','active',$4),($1,$3,'Other Co','active',$4)`, [ORG, CLIENT, OTHER, MANAGER]);
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,email_normalized,display_name,status) VALUES
      ($1,$2,$6,'alice@client.example','Alice Client','active'),($1,$3,$6,'bob@client.example','Bob Client','active'),
      ($1,$4,$7,'oscar@other.example','Oscar Other','active'),($1,$5,$6,'gone@client.example','Gone Client','disabled')`, [ORG, ALICE, BOB, OSCAR, GONE, CLIENT, OTHER]);
    // Consent by address: Alice granted; Bob has none on record.
    await db.query(`INSERT INTO nzi_console.client_contacts (organisation_id,contact_id,client_id,full_name,email,status,email_consent,created_by,updated_by) VALUES
      ($1,'k-alice',$2,'Alice Client','alice@client.example','active','granted','t','t')`, [ORG, CLIENT]);
    // A completed assessment: the thing a client's message must never reach.
    const [fw] = await q<{ framework_id: string; version: number }>(`SELECT framework_id, version FROM nzi_console.srs_frameworks WHERE organisation_id = $1 ORDER BY version DESC LIMIT 1`, [ORG]);
    await db.query(`INSERT INTO nzi_console.srs_assessments (organisation_id, assessment_id, client_id, framework_id, framework_version, status, started_on, assessed_on, assessed_by, completed_at, review_cadence, next_review_date)
      VALUES ($1,'sm-assess',$2,$3,$4,'complete','2026-01-10','2026-01-10','x',now(),'annual','2027-01-10')`, [ORG, CLIENT, fw!.framework_id, fw!.version]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("0221: the worker reads the marker column; messages stay append-only; one SRS thread per client; only a client's message asks for a review", async () => {
    const [grants] = await q<Record<string, boolean>>(`SELECT
      has_column_privilege('nzi_console_worker', 'nzi_console.portal_threads', 'srs_readiness', 'SELECT') AS marker,
      has_table_privilege('nzi_console_app', 'nzi_console.portal_messages', 'UPDATE') AS rewrite`);
    assert.deepEqual(grants, { marker: true, rewrite: false });
    await assert.rejects(q(`INSERT INTO nzi_console.portal_threads (organisation_id, thread_id, client_id, scope, job_id, subject_code, title, state, started_by_principal, started_by_id, srs_readiness)
      VALUES ($1,'bad-scope',$2,'client',NULL,'general','x','open','staff','x',true)`, [ORG, CLIENT]), /portal_threads_srs_shape/);
  });

  it("before anyone writes, both sides read an empty conversation", async () => {
    assert.deepEqual(await staffThread(), { thread: null, messages: [], openReviewRequest: null });
    assert.deepEqual(await getPortalSrsThread(database.pool, { organisationId: ORG, clientId: CLIENT, userId: ALICE } as never), { thread: null, messages: [], openReviewRequest: null });
  });

  it("a client's post is recorded — id, seq, timestamp — in the client's one SRS thread, and queues the CRM's notification", async () => {
    const before = await assessment();
    const posted = await asPortal({ body: SECRET });
    const threadId = posted.data.threadId as string;
    const [thread] = await q(`SELECT scope, subject_code, srs_readiness, state, title FROM nzi_console.portal_threads WHERE thread_id = $1`, [threadId]);
    assert.deepEqual(thread, { scope: "client", subject_code: "srs", srs_readiness: true, state: "awaiting_nzi", title: "SRS readiness" });
    const [message] = await q(`SELECT message_id, seq, author_principal, author_id, created_at, review_request FROM nzi_console.portal_messages WHERE thread_id = $1`, [threadId]);
    assert.deepEqual([message!.message_id, message!.seq, message!.author_principal, message!.author_id, message!.review_request], [posted.data.messageId, 1, "portal", ALICE, false]);
    assert.ok(message!.created_at instanceof Date);
    assert.deepEqual((await q(`SELECT audience FROM nzi_console.portal_message_notifications WHERE thread_id = $1 AND state = 'pending'`, [threadId])).map((row) => row.audience), ["staff"]);
    // A second post — from a colleague — joins the same thread.
    const again = await asPortal({ body: "Following up." }, portal(BOB));
    assert.equal(again.data.threadId, threadId);
    assert.equal((await q(`SELECT 1 FROM nzi_console.portal_threads WHERE client_id = $1 AND srs_readiness`, [CLIENT])).length, 1);
    assert.deepEqual(await assessment(), before, "the assessment is untouched");
  });

  it("is audited by ids — never the text", async () => {
    const audits = await q<{ action: string; after_json: Record<string, unknown> }>(`SELECT action, after_json FROM nzi_console.audit_events WHERE action = 'portal_srs_message_posted' ORDER BY occurred_at`);
    assert.equal(audits.length, 2);
    for (const row of audits) {
      assert.ok(!JSON.stringify(row.after_json).includes("9921") && !JSON.stringify(row.after_json).includes("Following"), "no message text in the audit");
      assert.deepEqual(Object.keys(row.after_json).sort(), ["clientId", "messageId", "previousState", "reviewRequest", "seq", "state", "threadId"]);
    }
  });

  it("a review request is surfaced to the CRM — and never reopens or writes the assessment", async () => {
    const before = await assessment();
    const posted = await asPortal({ body: "Our governance has changed — please review our assessment.", reviewRequest: true });
    assert.equal(posted.data.reviewRequest, true);
    const thread = await staffThread();
    assert.deepEqual(thread.openReviewRequest?.messageId, posted.data.messageId);
    assert.equal(thread.messages.at(-1)!.reviewRequest, true);
    assert.deepEqual(await assessment(), before, "still complete, same version, same updated_at: no auto-reopen");
    assert.equal((await q(`SELECT 1 FROM nzi_console.audit_events WHERE action LIKE 'srs_assessment_%'`)).length, 0, "no assessment command ran");
    await assert.rejects(q(`INSERT INTO nzi_console.portal_messages (organisation_id, message_id, thread_id, seq, author_principal, author_id, body, review_request)
      VALUES ($1,'staff-rr',$2,99,'staff',$3,'x',true)`, [ORG, thread.thread!.threadId, MANAGER]), /portal_messages_review_request_by_client/, "only a client's message asks for a review");
  });

  it("the CRM sees and answers it (srs.manage): the reply closes the request and queues the client's notification; a viewer cannot reply", async () => {
    await assert.rejects(postSrsMessage(database.pool, { clientId: CLIENT, body: "x" }, staff("viewer")), /srs\.manage|permission|not allowed/i);
    const reply = await postSrsMessage(database.pool, { clientId: CLIENT, body: "Thanks — we have reopened your assessment and will update it this week." }, staff());
    const thread = await staffThread();
    assert.equal(reply.data.threadId, thread.thread!.threadId);
    assert.equal(thread.openReviewRequest, null, "answered");
    assert.equal(thread.thread!.state, "awaiting_client");
    assert.equal(thread.thread!.ownerId, MANAGER, "the first adviser to reply owns it");
    assert.equal(thread.messages.at(-1)!.authorName, "Mo Manager", "staff read names");
    assert.deepEqual((await q(`SELECT audience FROM nzi_console.portal_message_notifications WHERE thread_id = $1 AND state = 'pending' ORDER BY audience`, [thread.thread!.threadId])).map((row) => row.audience), ["client", "staff"]);
  });

  it("NZC-110: the client reads the adviser as the firm — no staff name or id reaches the portal", async () => {
    const read = await getPortalSrsThread(database.pool, { organisationId: ORG, clientId: CLIENT, userId: ALICE } as never);
    assert.deepEqual(read.messages.map((message) => message.author), ["you", "colleague", "you", "adviser"]);
    const raw = JSON.stringify(read);
    assert.ok(!raw.includes("Mo Manager") && !raw.includes(MANAGER), "no staff identity in the client's read");
    assert.equal(read.thread!.ownerId, undefined);
  });

  it("NZC-120: another client's user sees none of it and cannot write into it; an inactive user is refused", async () => {
    const theirs = await getPortalSrsThread(database.pool, { organisationId: ORG, clientId: OTHER, userId: OSCAR } as never);
    assert.deepEqual(theirs, { thread: null, messages: [], openReviewRequest: null });
    await assert.rejects(asPortal({ body: "hello", clientId: CLIENT }, portal(OSCAR, OTHER)), /not on your plan/i);
    await assert.rejects(asPortal({ body: "hello" }, portal(GONE)), /not active/i);
    assert.equal((await q(`SELECT 1 FROM nzi_console.portal_threads WHERE client_id = $1`, [OTHER])).length, 0);
  });

  it("notifies through the existing consent-gated, link-only path: the CRM to the SRS area, the consenting client to the readiness view", async () => {
    await windowPasses();
    const result = await scan();
    assert.equal(result.due, 2);
    const [toStaff] = await mails("portal.message.staff-notification");
    assert.equal(toStaff!.to_email, "mo@netzero.international");
    assert.match(toStaff!.text_body, new RegExp(`${ORIGIN.replace(/\./g, "\\.")}/clients/${CLIENT}\\?area=srs`));
    const toClient = await mails("message.notification");
    assert.deepEqual(toClient.map((mail) => mail.to_email), ["alice@client.example"], "Bob has no consent on record: no email");
    assert.match(toClient[0]!.text_body, new RegExp(`${ORIGIN.replace(/\./g, "\\.")}/portal/srs`));
    for (const mail of [toStaff!, ...toClient]) {
      for (const text of [mail.text_body, mail.html_body, mail.subject]) assert.ok(!text.includes("9921") && !text.includes("governance") && !text.includes("reopened"), "no message content in the email");
    }
  });
});
