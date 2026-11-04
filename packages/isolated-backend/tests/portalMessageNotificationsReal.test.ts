import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { postClientMessage, postPortalMessage, runWorkerTick, scanMessageNotifications, startClientThread, startPortalThread, withTenantWorker, MESSAGE_NOTIFY_WINDOW_MINUTES } from "../src/index";
import { emailDispatchFromEnv } from "../src/email";
import { suppressingMailer } from "../src/mailer";

/**
 * Message notifications, against a real database (RULING-portal-messages, M4): notify-only email for conversation messages.
 *  1. a message queues - never sends; a burst of messages is ONE pending row and, after the window, ONE email;
 *  2. the client side is consent-gated (NZC-076), read fresh at send time: consented -> one email with a deep link and no content;
 *     unknown or declined -> none; someone who cannot see the thread -> none; withdrawn before the send -> none; granted before it -> sent;
 *  3. the staff side is internal and not consent-gated: the thread's owner, else the client's manager;
 *  4. it goes through sendTemplatedEmail and the existing outbox - nothing is sent from a request, nothing here is a new mailer;
 *  5. a row that cannot be rendered stays pending and is retried; nobody to tell is recorded, not silently dropped;
 *  6. the ledger and the audit hold ids and counts only; the worker part is off unless the deployment turns it on.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-mn";
const JOB = "job-mn", JOB_B = "job-mn-b";
const ALICE = "portal-mn-alice", BOB = "portal-mn-bob", CARA = "portal-mn-cara", DAN = "portal-mn-dan";
const OWNER = "staff-mn-owner", MANAGER = "staff-mn-manager";
const ORIGIN = "https://console.example.org";
const SECRET_BODY = "Our boiler emissions look odd - see invoice 4471";

describe("message notifications: debounced, consent-gated, notify-only", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const portal = (userId = ALICE): CommandContext => { keys += 1; return { organisationId: ORG, actorId: userId, principal: "portal", portal: { portalUserId: userId, clientId: CLIENT }, idempotencyKey: `mn-${keys}`, correlationId: `corr-mn-${keys}` }; };
  const staff = (actor = OWNER): CommandContext => { keys += 1; return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `ms-${keys}`, correlationId: `corr-ms-${keys}`, grant: commandGrantForRole("admin", ORG, actor) }; };
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const scan = (consoleOrigin: string | undefined = ORIGIN) => withTenantWorker(database.pool, ORG, (tx) => scanMessageNotifications(tx, { organisationId: ORG, consoleOrigin }));
  /** Move the open windows into the past: the scan only takes what is due. */
  const windowPasses = () => db.query(`UPDATE nzi_console.portal_message_notifications SET due_at = now() - interval '1 minute' WHERE state = 'pending'`);
  const mails = async (templateCode?: string) => await q<{ to_email: string; template_code: string; subject: string; text_body: string; html_body: string; status: string; correlation_id: string }>(
    `SELECT to_email, template_code, subject, text_body, html_body, status, correlation_id FROM nzi_console.email_messages ${templateCode ? "WHERE template_code = $1" : ""} ORDER BY created_at, email_message_id`, templateCode ? [templateCode] : []);
  const pending = async (audience?: string) => await q(`SELECT * FROM nzi_console.portal_message_notifications WHERE state = 'pending' ${audience ? "AND audience = $1" : ""}`, audience ? [audience] : []);
  const setConsent = (email: string, state: "granted" | "declined" | "unknown") => db.query(`UPDATE nzi_console.client_contacts SET email_consent = $2 WHERE lower(email) = $1`, [email, state]);
  const startJobThread = async () => (await startPortalThread(database.pool, { clientId: CLIENT, jobId: JOB, subjectCode: "data", title: "Gas bills", body: SECRET_BODY }, portal(ALICE))).data.threadId as string;

  before(async () => {
    database = (await createDisposableDatabase("msgnotify"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name,email) VALUES ($1,$2,'admin','active','Olive Owner','olive@netzero.international'),($1,$3,'admin','active','Mo Manager','mo@netzero.international')`, [ORG, OWNER, MANAGER]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,client_manager_user_id) VALUES ($1,$2,'Example Manufacturing Ltd','active',$3)`, [ORG, CLIENT, MANAGER]);
    for (const job of [JOB, JOB_B]) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
         VALUES ($1,$2,$3,(SELECT coalesce(max(sequence),0)+1 FROM nzi_console.jobs),'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, job, CLIENT]);
    }
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,email_normalized,display_name,status) VALUES
      ($1,$2,$6,'alice@client.example','Alice Client','active'),($1,$3,$6,'bob@client.example','Bob Client','active'),($1,$4,$6,'cara@client.example','Cara Client','active'),($1,$5,$6,'dan@client.example','Dan Client','active')`,
      [ORG, ALICE, BOB, CARA, DAN, CLIENT]);
    // Alice, Bob and Cara hold JOB; Dan holds only JOB_B.
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at,revoked_at)
       VALUES ($1,'g1',$2,$3,$4,NULL,NULL,NULL),($1,'g2',$2,$5,$4,NULL,NULL,NULL),($1,'g3',$2,$6,$4,NULL,NULL,NULL),($1,'g4',$2,$7,$8,NULL,NULL,NULL)`,
      [ORG, CLIENT, ALICE, JOB, BOB, CARA, DAN, JOB_B]);
    // Consent lives on the client's contacts, by address: Alice granted, Cara declined, Dan granted, Bob has no contact at all.
    await db.query(`INSERT INTO nzi_console.client_contacts (organisation_id,contact_id,client_id,full_name,email,status,email_consent,created_by,updated_by) VALUES
      ($1,'k-alice',$2,'Alice Client','alice@client.example','active','granted','t','t'),($1,'k-cara',$2,'Cara Client','cara@client.example','active','declined','t','t'),($1,'k-dan',$2,'Dan Client','dan@client.example','active','granted','t','t')`, [ORG, CLIENT]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("a message only queues: one pending row for the other side, nothing sent from the request", async () => {
    const threadId = await startJobThread();
    const rows = await pending();
    assert.deepEqual(rows.map((r) => [r.thread_id, r.audience, r.message_count]), [[threadId, "staff", 1]]);
    assert.equal((await mails()).length, 0, "an email was written by the request");
    assert.equal(MESSAGE_NOTIFY_WINDOW_MINUTES, 10);
    const due = new Date(rows[0]!.due_at).getTime() - Date.now();
    assert.ok(due > 8 * 60_000 && due <= 10 * 60_000, "the window is ten minutes from the first message");
  });

  it("a burst of messages is one pending row and, once the window passes, ONE internal email to the thread's adviser - with a link and no content", async () => {
    const threadId = (await pending("staff"))[0]!.thread_id as string;
    for (let n = 0; n < 4; n += 1) await postPortalMessage(database.pool, { clientId: CLIENT, threadId, body: `${SECRET_BODY} (${n})` }, portal(ALICE));
    assert.deepEqual((await pending("staff")).map((r) => r.message_count), [5], "five messages, one row");
    // Not due yet: the scan sends nothing and leaves it pending.
    assert.deepEqual(await scan(), { due: 0, emailed: 0, blockedNoConsent: 0, noRecipient: 0, refused: 0 });
    assert.equal((await mails()).length, 0);

    await windowPasses();
    const done = await scan();
    assert.deepEqual(done, { due: 1, emailed: 1, blockedNoConsent: 0, noRecipient: 0, refused: 0 });
    // No thread owner yet, so the client's manager (the CRM, as a reopen request is routed) - staff mail, not consent-gated.
    const [email, ...more] = await mails("portal.message.staff-notification");
    assert.equal(more.length, 0, "a burst of five messages sent more than one email");
    assert.deepEqual([email!.to_email, email!.status], ["mo@netzero.international", "queued"]);
    assert.match(email!.text_body, /Hello Mo,/);
    assert.match(email!.text_body, /Example Manufacturing Ltd has written to you/);
    assert.match(email!.text_body, new RegExp(`${ORIGIN.replace(/\./g, "\\.")}/clients/${CLIENT}\\?area=portal`));
    for (const text of [email!.text_body, email!.html_body, email!.subject]) assert.ok(!text.includes("boiler") && !text.includes("4471") && !text.includes("Gas bills"), "message content in the email");
    // It rides the existing outbox as an email.send row for the existing drain - the one pipe.
    assert.equal((await q(`SELECT 1 FROM nzi_console.transactional_outbox WHERE topic = 'email.send' AND payload_json->>'emailMessageId' IS NOT NULL`)).length, 1);
    // Closed, with counts; a second scan finds nothing.
    assert.deepEqual((await q(`SELECT state, emailed, blocked_no_consent, no_recipient, message_count FROM nzi_console.portal_message_notifications WHERE audience = 'staff'`))[0], { state: "done", emailed: 1, blocked_no_consent: 0, no_recipient: false, message_count: 5 });
    assert.deepEqual(await scan(), { due: 0, emailed: 0, blockedNoConsent: 0, noRecipient: 0, refused: 0 });
    assert.equal((await mails()).length, 1);
  });

  it("a client is emailed only if they have consented: a burst of replies sends the consenting reader one notify-only email with a deep link; unknown, declined and anyone who cannot see the thread get none", async () => {
    const threadId = (await q(`SELECT thread_id FROM nzi_console.portal_threads LIMIT 1`))[0]!.thread_id as string;
    await postClientMessage(database.pool, { clientId: CLIENT, threadId, body: "We have reviewed it. Details inside the portal." }, staff(OWNER));
    await postClientMessage(database.pool, { clientId: CLIENT, threadId, body: "One more thing." }, staff(OWNER));
    await postClientMessage(database.pool, { clientId: CLIENT, threadId, body: "And another." }, staff(OWNER));
    assert.deepEqual((await pending("client")).map((r) => r.message_count), [3]);
    assert.equal((await mails("message.notification")).length, 0, "an email was written by the request");

    await windowPasses();
    // Alice (granted), Bob (no contact -> unknown), Cara (declined) can see the job thread; Dan (granted) holds another job and cannot.
    assert.deepEqual(await scan(), { due: 1, emailed: 1, blockedNoConsent: 2, noRecipient: 0, refused: 0 });
    const [email, ...more] = await mails("message.notification");
    assert.equal(more.length, 0, "three replies sent more than one email");
    assert.equal(email!.to_email, "alice@client.example");
    assert.match(email!.text_body, /Hello Alice,/, "greeted by first name (0207), not the full name");
    assert.doesNotMatch(email!.text_body, /Alice Client/);
    assert.match(email!.text_body, /new message for Example Manufacturing Ltd/);
    assert.match(email!.text_body, new RegExp(`${ORIGIN.replace(/\./g, "\\.")}/portal/jobs/${JOB}/messages\\?thread=${threadId}`), "a deep link to the conversation");
    for (const text of [email!.text_body, email!.html_body, email!.subject]) assert.ok(!/reviewed|Details inside|another|One more/.test(text), "message content in the email");
    assert.ok(!(await mails()).some((m) => ["bob@client.example", "cara@client.example", "dan@client.example"].includes(m.to_email)), "an email went to someone who had not consented or could not see the thread");
    const [event] = await q(`SELECT actor_id, principal_type, after_json FROM nzi_console.audit_events WHERE action = 'portal_message_notified' AND after_json->>'audience' = 'client'`);
    assert.deepEqual([event!.actor_id, event!.principal_type, event!.after_json.emailed, event!.after_json.blockedNoConsent, event!.after_json.messages], ["worker:message-notifications", "system", 1, 2, 3]);
    assert.ok(!JSON.stringify(event!.after_json).includes("@"), "an address in the audit");
  });

  it("consent is read at send time: withdrawn before the send -> no email; granted before the send -> an email", async () => {
    const threadId = (await q(`SELECT thread_id FROM nzi_console.portal_threads LIMIT 1`))[0]!.thread_id as string;
    const before = (await mails("message.notification")).length;
    await postClientMessage(database.pool, { clientId: CLIENT, threadId, body: "Later." }, staff(OWNER));
    await setConsent("alice@client.example", "declined");
    await setConsent("bob@client.example", "granted"); // Bob has no contact record, so this changes nothing - a missing contact is not consent
    await windowPasses();
    assert.deepEqual(await scan(), { due: 1, emailed: 0, blockedNoConsent: 3, noRecipient: 0, refused: 0 });
    assert.equal((await mails("message.notification")).length, before);

    await db.query(`INSERT INTO nzi_console.client_contacts (organisation_id,contact_id,client_id,full_name,email,status,email_consent,created_by,updated_by) VALUES ($1,'k-bob',$2,'Bob Client','bob@client.example','active','unknown','t','t')`, [ORG, CLIENT]);
    await postClientMessage(database.pool, { clientId: CLIENT, threadId, body: "Again." }, staff(OWNER));
    await setConsent("bob@client.example", "granted");
    await windowPasses();
    assert.deepEqual(await scan(), { due: 1, emailed: 1, blockedNoConsent: 2, noRecipient: 0, refused: 0 });
    assert.equal((await mails("message.notification")).at(-1)!.to_email, "bob@client.example");
    await setConsent("alice@client.example", "granted");
  });

  it("people are greeted by the first name they are held under (0207): a contact's first name beats the first word of the portal name; the adviser's own first name beats the first word of theirs", async () => {
    const threadId = (await q(`SELECT thread_id FROM nzi_console.portal_threads LIMIT 1`))[0]!.thread_id as string;
    await db.query(`UPDATE nzi_console.client_contacts SET first_name = 'Ally' WHERE contact_id = 'k-alice'`);
    await db.query(`UPDATE nzi_console.memberships SET first_name = 'Olly' WHERE user_id = $1`, [OWNER]);
    try {
      await postClientMessage(database.pool, { clientId: CLIENT, threadId, body: "Greeting check." }, staff(OWNER));
      await windowPasses();
      await scan();
      const toAlice = (await mails("message.notification")).filter((m) => m.to_email === "alice@client.example").at(-1)!;
      assert.match(toAlice.text_body, /^Hello Ally,/);
      assert.match(toAlice.html_body, />Hello Ally,</, "the HTML part greets the same way");
      assert.ok(![toAlice.text_body, toAlice.html_body, toAlice.subject].some((text) => text.includes("Alice")), "the full name is not used to address her");
      await postPortalMessage(database.pool, { clientId: CLIENT, threadId, body: "Reply for the adviser." }, portal(ALICE));
      await windowPasses();
      await scan();
      const toAdviser = (await mails("portal.message.staff-notification")).at(-1)!;
      assert.equal(toAdviser.to_email, "olive@netzero.international", "the thread's owner");
      assert.match(toAdviser.text_body, /^Hello Olly,/);
      assert.doesNotMatch(toAdviser.text_body, /Olive/);
    } finally {
      await db.query(`UPDATE nzi_console.client_contacts SET first_name = NULL WHERE contact_id = 'k-alice'`);
      await db.query(`UPDATE nzi_console.memberships SET first_name = NULL WHERE user_id = $1`, [OWNER]);
    }
  });

  it("a new burst after the window is a new notification: one more email, not a trickle", async () => {
    const threadId = (await q(`SELECT thread_id FROM nzi_console.portal_threads LIMIT 1`))[0]!.thread_id as string;
    const before = (await mails("portal.message.staff-notification")).length;
    await postPortalMessage(database.pool, { clientId: CLIENT, threadId, body: "A fresh question." }, portal(ALICE));
    await postPortalMessage(database.pool, { clientId: CLIENT, threadId, body: "And a follow-up." }, portal(BOB));
    assert.deepEqual((await pending("staff")).map((r) => r.message_count), [2]);
    await windowPasses();
    await scan();
    assert.equal((await mails("portal.message.staff-notification")).length, before + 1);
  });

  it("the staff email goes to the thread's owner once it has one; a client-wide conversation reaches every consenting user of the client, each to a job they hold", async () => {
    const wide = (await startClientThread(database.pool, { clientId: CLIENT, jobId: null, subjectCode: "general", title: "Welcome", body: "Welcome to the portal." }, staff(OWNER))).data.threadId as string;
    await db.query(`UPDATE nzi_console.portal_threads SET owner_id = $2 WHERE thread_id = $1`, [wide, OWNER]);
    await windowPasses();
    const before = (await mails("message.notification")).length;
    const result = await scan();
    assert.equal(result.emailed, 3, "Alice, Bob and Dan - all consenting, all able to see a client-wide conversation");
    const sent = (await mails("message.notification")).slice(before);
    const linkFor = (to: string) => /(https:\/\/\S+)/.exec(sent.find((m) => m.to_email === to)!.text_body)![1]!;
    assert.match(linkFor("alice@client.example"), new RegExp(`/portal/jobs/${JOB}/messages\\?thread=${wide}$`));
    assert.match(linkFor("dan@client.example"), new RegExp(`/portal/jobs/${JOB_B}/messages\\?thread=${wide}$`));
    // A client reply to an owned thread is mailed to its owner, not the manager.
    await postPortalMessage(database.pool, { clientId: CLIENT, threadId: wide, body: "Thanks." }, portal(ALICE));
    await windowPasses();
    await scan();
    assert.equal((await mails("portal.message.staff-notification")).at(-1)!.to_email, "olive@netzero.international");
  });

  it("a notification that cannot be rendered stays pending and is retried once the wording is right; nobody to tell is recorded, not dropped", async () => {
    const threadId = (await q(`SELECT thread_id FROM nzi_console.portal_threads LIMIT 1`))[0]!.thread_id as string;
    await postClientMessage(database.pool, { clientId: CLIENT, threadId, body: "Wording test." }, staff(OWNER));
    await db.query(`INSERT INTO nzi_console.message_templates (organisation_id, template_key, subject, body, created_by, updated_by) VALUES ($1, 'message.notification', 'Hi', 'No link here', 'tester', 'tester')`, [ORG]);
    await windowPasses();
    const before = (await mails()).length;
    assert.deepEqual(await scan(), { due: 1, emailed: 0, blockedNoConsent: 0, noRecipient: 0, refused: 1 });
    assert.equal((await pending("client")).length, 1, "left pending");
    assert.equal((await mails()).length, before, "a half-rendered email was queued");
    await db.query(`UPDATE nzi_console.message_templates SET active = false WHERE organisation_id = $1 AND template_key = 'message.notification'`, [ORG]);
    assert.equal((await scan()).emailed, 2, "Alice and Bob: consenting and able to see it");
    assert.equal((await pending("client")).length, 0);

    // No owner and no manager: the row is closed saying so.
    await db.query(`UPDATE nzi_console.clients SET client_manager_user_id = NULL, owner_user_id = NULL WHERE client_id = $1`, [CLIENT]);
    await db.query(`UPDATE nzi_console.portal_threads SET owner_id = NULL WHERE thread_id = $1`, [threadId]);
    await postPortalMessage(database.pool, { clientId: CLIENT, threadId, body: "Anyone there?" }, portal(ALICE));
    await windowPasses();
    assert.deepEqual(await scan(), { due: 1, emailed: 0, blockedNoConsent: 0, noRecipient: 1, refused: 0 });
    assert.equal((await q(`SELECT no_recipient FROM nzi_console.portal_message_notifications WHERE audience = 'staff' ORDER BY processed_at DESC LIMIT 1`))[0]!.no_recipient, true);
  });

  it("the worker part is dark unless the deployment turns it on, and needs the console's address; the ledger holds no address, name or text", async () => {
    const threadId = (await q(`SELECT thread_id FROM nzi_console.portal_threads LIMIT 1`))[0]!.thread_id as string;
    await postClientMessage(database.pool, { clientId: CLIENT, threadId, body: "Tick test." }, staff(OWNER));
    await windowPasses();
    const dispatch = emailDispatchFromEnv({});
    const tick = (messageNotifications: boolean, consoleOrigin: string | null = ORIGIN) => runWorkerTick(database.pool, { organisationId: ORG, today: "2026-11-03", mailer: suppressingMailer(), email: dispatch, consoleOrigin: consoleOrigin ?? undefined, messageNotifications, env: { mailMode: "suppress", appEnv: "staging", boundaryToken: "isolated-non-production" } });
    const off = await tick(false);
    assert.deepEqual(off.messageNotifications, { ok: true, summary: { off: true } });
    assert.equal((await pending("client")).length, 1, "off: it waits");
    const noOrigin = await tick(true, null);
    assert.equal(noOrigin.messageNotifications.ok, false, "no console address: nothing sent");
    assert.equal((await pending("client")).length, 1);
    const on = await tick(true);
    assert.ok(on.messageNotifications.ok && "due" in on.messageNotifications.summary && on.messageNotifications.summary.due === 1);
    assert.equal((await pending("client")).length, 0);
    // The next tick's existing email drain delivers it (stubbed on the isolated boundary) - the one pipe.
    const next = await tick(false);
    assert.ok(next.emails.ok);
    assert.ok((await mails("message.notification")).every((m) => m.status !== "queued"), "the existing drain left a notification queued");
    const ledger = JSON.stringify(await q(`SELECT * FROM nzi_console.portal_message_notifications`));
    assert.ok(!/@|client\.example|Tick test|Alice|Bob/.test(ledger), "personal data or message text in the ledger");
  });
});
