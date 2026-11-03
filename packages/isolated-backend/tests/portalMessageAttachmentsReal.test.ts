import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, PORTAL_MESSAGE_MAX_ATTACHMENTS, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  CommandValidationError, eicarTestSignature, getClientThread, getPortalFileHistory, getPortalThread, ingestFile, issueClientFileDownload, issuePortalFileDownload, listPortalFiles,
  LocalStorageAdapter, postClientMessage, postPortalMessage, rescanClientFile, startClientThread, startPortalThread, type PortalPrincipal, type ScanVerdict, type Scanner,
} from "../src/index";

/**
 * Message attachments, against a real database (RULING-portal-messages, M3). An attachment is a portal file through the exact files gate, linked to
 * its message in the one command:
 *  1. it arrives quarantined-until-clean, is downloadable only once released, and only by signed URL - no storage id, hash or URL in what a reader gets;
 *  2. a held (scanning) or infected (blocked) attachment is never served - to the client or to staff - and the message itself still posts;
 *  3. an attachment goes only to the thread's own job and is served only to whoever may see the thread (own client, held job; staff portal.admin);
 *  4. each file keeps its own audit trail (uploaded -> scanned -> released -> downloaded), and the thread's audit carries counts and ids, never text;
 *  5. a forged ingest, a file for another job, too many files or a repeated one is refused and nothing is recorded;
 *  6. the link is append-only; a message without attachments is exactly what it was.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-ma", OTHER_CLIENT = "client-ma-other";
const JOB = "job-ma", JOB_B = "job-ma-b", OTHER_JOB = "job-ma-other";
const ALICE = "portal-ma-alice", BOB = "portal-ma-bob", CARA = "portal-ma-cara", OTHER_USER = "portal-ma-other", STAFF = "staff-ma";
const principal = (userId: string, clientId: string) => ({ principal: "portal", organisationId: ORG, userId, clientId, sessionId: "p", issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid" }) as unknown as PortalPrincipal;
const holder = { organisationId: ORG, userId: STAFF, capabilities: commandGrantForRole("admin", ORG, STAFF).capabilities };
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF");

describe("message attachments: the files gate, linked to a message", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  let verdict: ScanVerdict = { state: "clean" };
  const adapter = new LocalStorageAdapter();
  const scanner: Scanner = { scan: async (data) => (new TextDecoder("latin1").decode(data).includes(eicarTestSignature()) ? { state: "infected", detail: "test signature" } : verdict) };
  const adapterFor = () => adapter;
  const portal = (userId = ALICE, clientId = CLIENT): CommandContext => { keys += 1; return { organisationId: ORG, actorId: userId, principal: "portal", portal: { portalUserId: userId, clientId }, idempotencyKey: `ma-${keys}`, correlationId: `corr-ma-${keys}` }; };
  const staff = (): CommandContext => { keys += 1; return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `ms-${keys}`, correlationId: `corr-ms-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) }; };
  const file = (jobId: string | null, data: Uint8Array = PDF, name = "evidence.pdf", clientId = CLIENT) => ingestFile({ adapter, scanner, organisationId: ORG, clientId, jobId, fileName: name, bytes: data });
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [];
  const start = async (attachments: Awaited<ReturnType<typeof file>>[] = [], over: Partial<{ jobId: string | null; user: string }> = {}) =>
    (await startPortalThread(database.pool, { clientId: CLIENT, jobId: over.jobId === undefined ? JOB : over.jobId, subjectCode: "data", title: "Gas bills", body: "Here are the gas bills.", ...(attachments.length ? { attachments } : {}) }, portal(over.user ?? ALICE))).data.threadId as string;

  before(async () => {
    database = (await createDisposableDatabase("portalmsgattach"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active'),($1,$3,'Other','active')`, [ORG, CLIENT, OTHER_CLIENT]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Sam Staff')`, [ORG, STAFF]);
    for (const [job, client] of [[JOB, CLIENT], [JOB_B, CLIENT], [OTHER_JOB, OTHER_CLIENT]] as const) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
         VALUES ($1,$2,$3,(SELECT coalesce(max(sequence),0)+1 FROM nzi_console.jobs),'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, job, client]);
    }
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,display_name,status) VALUES ($1,$2,$3,'Alice','active'),($1,$4,$3,'Bob','active'),($1,$5,$3,'Cara','active'),($1,$6,$7,'Olly','active')`,
      [ORG, ALICE, CLIENT, BOB, CARA, OTHER_USER, OTHER_CLIENT]);
    // Alice and Bob hold JOB; Cara holds only JOB_B; the other client's user holds its own job.
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at,revoked_at)
       VALUES ($1,'g1',$2,$3,$4,NULL,NULL,NULL),($1,'g2',$2,$5,$4,NULL,NULL,NULL),($1,'g3',$2,$6,$7,NULL,NULL,NULL),($1,'g4',$8,$9,$10,NULL,NULL,NULL)`,
      [ORG, CLIENT, ALICE, JOB, BOB, CARA, JOB_B, OTHER_CLIENT, OTHER_USER, OTHER_JOB]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("a clean attachment is recorded with the message, released, and downloadable only by signed URL; the reader gets no storage id, hash or URL", async () => {
    const ingest = await file(JOB);
    const threadId = await start([ingest]);
    const detail = await getPortalThread(database.pool, principal(ALICE, CLIENT), threadId);
    const [attachment] = detail.messages[0]!.attachments;
    assert.deepEqual(attachment, { fileId: ingest.fileId, fileName: "evidence.pdf", contentType: "application/pdf", sizeBytes: ingest.sizeBytes, state: "available" });
    const stored = (await q(`SELECT * FROM nzi_console.portal_files WHERE file_id=$1`, [ingest.fileId]))[0]!;
    assert.deepEqual([stored.status, stored.direction, stored.uploaded_by_principal, stored.job_id, stored.client_id], ["released", "client_upload", "portal", JOB, CLIENT]);
    const readerJson = JSON.stringify(detail) + JSON.stringify(await getClientThread(database.pool, holder, CLIENT, threadId));
    for (const secret of [stored.external_item_id, stored.sha256, "file:", "http"]) assert.ok(!readerJson.includes(secret), `a reader was shown ${secret}`);

    // A colleague on the same job is given a signed URL (per access, audited); the URL is not in the audit.
    const { download } = await issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: ingest.fileId }, portal(BOB), adapterFor);
    assert.ok(download?.url, "no signed URL");
    const trail = await q(`SELECT principal_type, action, after_json FROM nzi_console.audit_events WHERE entity_id=$1 ORDER BY occurred_at`, [ingest.fileId]);
    assert.deepEqual(trail.map((event) => event.action), ["portal_file_uploaded", "portal_file_downloaded"]);
    assert.equal(trail[0]!.after_json.messageId, detail.messages[0]!.messageId);
    assert.ok(!JSON.stringify(trail).includes(download!.url) && !JSON.stringify(trail).includes(stored.external_item_id));
    // The file's own History reads like any file's: uploaded, scanned, released, downloaded.
    const history = await getPortalFileHistory(database.pool, principal(ALICE, CLIENT), ingest.fileId);
    assert.deepEqual(history.map((entry) => entry.action), ["uploaded", "scanned", "released", "downloaded"]);
  });

  it("a held (scanning) attachment is never served, to the client or to staff; the message still posts; once released it is", async () => {
    verdict = { state: "unknown", detail: "Waiting for the scan." };
    let held;
    try { held = await file(JOB, PDF, "held.pdf"); } finally { verdict = { state: "clean" }; }
    assert.equal(held.status, "quarantined");
    const threadId = await start([held]);
    const read = async () => (await getPortalThread(database.pool, principal(ALICE, CLIENT), threadId)).messages[0]!.attachments[0]!;
    assert.equal((await read()).state, "scanning");
    for (const run of [
      () => issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: held.fileId }, portal(ALICE), adapterFor),
      () => issueClientFileDownload(database.pool, { clientId: CLIENT, fileId: held.fileId }, staff(), adapterFor),
    ]) await assert.rejects(run(), (e) => codes(e).includes("FILE_NOT_AVAILABLE"));
    await rescanClientFile(database.pool, { clientId: CLIENT, fileId: held.fileId }, staff(), adapterFor, scanner);
    assert.equal((await read()).state, "available");
    assert.ok((await issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: held.fileId }, portal(ALICE), adapterFor)).download?.url);
  });

  it("an infected attachment is blocked and never served; the message posts and says only that it was blocked", async () => {
    const bad = await file(JOB, new TextEncoder().encode(`%PDF-1.4 ${eicarTestSignature()}`), "bad.pdf");
    assert.deepEqual([bad.status, bad.flag], ["rejected", "infected"]);
    const threadId = await start([bad]);
    const detail = await getPortalThread(database.pool, principal(ALICE, CLIENT), threadId);
    assert.equal(detail.messages[0]!.body, "Here are the gas bills.", "the message itself posted");
    assert.equal(detail.messages[0]!.attachments[0]!.state, "blocked");
    assert.ok(!JSON.stringify(detail).toLowerCase().includes("virus") && !JSON.stringify(detail).includes("infected"), "the scanner's finding is not shown in the thread");
    for (const run of [
      () => issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: bad.fileId }, portal(ALICE), adapterFor),
      () => issueClientFileDownload(database.pool, { clientId: CLIENT, fileId: bad.fileId }, staff(), adapterFor),
    ]) await assert.rejects(run(), (e) => codes(e).includes("FILE_NOT_AVAILABLE"));
  });

  it("an attachment is the thread's: a user who cannot see the thread cannot be given the file, another client never can, and a client-wide one reaches the whole client", async () => {
    const mine = await file(JOB, PDF, "job.pdf");
    const jobThread = await start([mine]);
    const denied = [CARA, OTHER_USER];
    await assert.rejects(getPortalThread(database.pool, principal(CARA, CLIENT), jobThread), /not available/);
    for (const user of denied) {
      const clientId = user === OTHER_USER ? OTHER_CLIENT : CLIENT;
      await assert.rejects(issuePortalFileDownload(database.pool, { clientId, fileId: mine.fileId }, portal(user, clientId), adapterFor), (e) => codes(e).includes("NOT_FOUND"), user);
    }
    // Client-wide thread, client's own attachment: its upload row is job-less, so the Files rule alone would never have served a colleague - the thread does.
    const wide = await file(null, PDF, "wide.pdf");
    await start([wide], { jobId: null });
    assert.ok((await issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: wide.fileId }, portal(CARA), adapterFor)).download?.url, "a colleague on the same client could not read a client-wide attachment");
    await assert.rejects(issuePortalFileDownload(database.pool, { clientId: OTHER_CLIENT, fileId: wide.fileId }, portal(OTHER_USER, OTHER_CLIENT), adapterFor), (e) => codes(e).includes("NOT_FOUND"));
    // A file that is not an attachment keeps the Files rule: a colleague's job-less client upload is not served.
    const loose = await file(JOB, PDF, "loose.pdf");
    await q(`INSERT INTO nzi_console.portal_files (organisation_id,file_id,client_id,job_id,direction,status,file_name,content_type,size_bytes,sha256,storage_provider,external_item_id,uploaded_by,uploaded_by_principal,released_at,category)
             VALUES ($1,$2,$3,NULL,'client_upload','released','loose.pdf','application/pdf',$4,$5,'local',$6,$7,'portal',now(),'other')`, [ORG, loose.fileId, CLIENT, loose.sizeBytes, loose.sha256, loose.externalItemId, ALICE]);
    await assert.rejects(issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: loose.fileId }, portal(BOB), adapterFor), (e) => codes(e).includes("NOT_FOUND"));
  });

  it("staff attach from the Messages tab: a deliverable on the thread's job, served to the client's users who hold it, and in their Files list", async () => {
    const threadId = await start();
    const note = await file(JOB, PDF, "report-draft.pdf");
    const posted = await postClientMessage(database.pool, { clientId: CLIENT, threadId, body: "Draft attached.", attachments: [note] }, staff());
    assert.equal(posted.data.attachments, 1);
    const stored = (await q(`SELECT direction, uploaded_by_principal, job_id FROM nzi_console.portal_files WHERE file_id=$1`, [note.fileId]))[0]!;
    assert.deepEqual([stored.direction, stored.uploaded_by_principal, stored.job_id], ["deliverable", "staff", JOB]);
    const seen = await getPortalThread(database.pool, principal(BOB, CLIENT), threadId);
    assert.equal(seen.messages[1]!.attachments[0]!.state, "available");
    assert.equal(seen.messages[1]!.author, "adviser");
    assert.ok((await issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: note.fileId }, portal(BOB), adapterFor)).download?.url);
    assert.ok((await listPortalFiles(database.pool, principal(BOB, CLIENT))).some((f) => f.fileId === note.fileId), "the adviser's attachment is in the client's Files");
    assert.equal((await q(`SELECT action FROM nzi_console.audit_events WHERE entity_id=$1`, [note.fileId]))[0]!.action, "client_file_delivered");
    // Staff starting a conversation with a file works the same way.
    const opener = await file(null, PDF, "welcome.pdf");
    const started = await startClientThread(database.pool, { clientId: CLIENT, jobId: null, subjectCode: "general", title: "Welcome", body: "Welcome pack attached.", attachments: [opener] }, staff());
    assert.equal(started.data.attachments, 1);
    assert.ok((await issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: opener.fileId }, portal(CARA), adapterFor)).download?.url, "a client-wide adviser attachment reaches every user of the client");
  });

  it("refuses what the gate could not have produced, a file for another job, too many files and a repeat - and records nothing for the refused message", async () => {
    const threadId = await start();
    const before = (await q(`SELECT (SELECT count(*) FROM nzi_console.portal_files)::int AS f, (SELECT count(*) FROM nzi_console.portal_messages)::int AS m, (SELECT count(*) FROM nzi_console.portal_message_attachments)::int AS a`))[0]!;
    const good = await file(JOB);
    const post = (attachments: unknown[]) => postPortalMessage(database.pool, { clientId: CLIENT, threadId, body: "More.", attachments: attachments as never }, portal(ALICE));
    await assert.rejects(post([{ ...good, externalItemId: null }]), CommandValidationError, "released with no bytes");
    await assert.rejects(post([{ ...good, sha256: "nope" }]), CommandValidationError, "bad hash");
    await assert.rejects(post([await file(JOB_B)]), CommandValidationError, "another job's folder");
    await assert.rejects(post([await file(null)]), CommandValidationError, "a job thread takes job files only");
    await assert.rejects(post([good, good]), (e) => codes(e).includes("DUPLICATE"));
    await assert.rejects(post(await Promise.all(Array.from({ length: PORTAL_MESSAGE_MAX_ATTACHMENTS + 1 }, () => file(JOB)))), (e) => codes(e).includes("TOO_MANY"));
    const after = (await q(`SELECT (SELECT count(*) FROM nzi_console.portal_files)::int AS f, (SELECT count(*) FROM nzi_console.portal_messages)::int AS m, (SELECT count(*) FROM nzi_console.portal_message_attachments)::int AS a`))[0]!;
    assert.deepEqual(after, before, "a refused message left something behind");
    // Exactly the limit is fine.
    const five = await Promise.all(Array.from({ length: PORTAL_MESSAGE_MAX_ATTACHMENTS }, (_, n) => file(JOB, PDF, `f${n}.pdf`)));
    await post(five);
    const detail = await getPortalThread(database.pool, principal(ALICE, CLIENT), threadId);
    assert.deepEqual(detail.messages.at(-1)!.attachments.map((a) => a.fileName), five.map((f) => f.fileName), "in the order attached");
  });

  it("audits the thread with counts and ids, never the text or a file's bytes; replaying the same command records nothing twice", async () => {
    const ingest = await file(JOB);
    const threadId = await start();
    const context = portal(ALICE);
    const input = { clientId: CLIENT, threadId, body: "Secret wording.", attachments: [ingest] };
    const first = await postPortalMessage(database.pool, input, context);
    const replay = await postPortalMessage(database.pool, input, context);
    assert.equal(replay.replayed, true);
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.portal_message_attachments WHERE file_id=$1`, [ingest.fileId]))[0]!.n, 1);
    const events = await q(`SELECT entity_type, action, after_json FROM nzi_console.audit_events WHERE correlation_id=$1`, [context.correlationId]);
    assert.deepEqual(events.map((e) => e.entity_type).sort(), ["portal_file", "portal_thread"]);
    assert.ok(!JSON.stringify(events).includes("Secret wording"), "message text in the audit");
    assert.equal(events.find((e) => e.entity_type === "portal_thread")!.after_json.attachments, 1);
    assert.equal(first.data.attachments, 1);
  });

  it("the link is append-only; a message without attachments is exactly what it was", async () => {
    assert.deepEqual((await q(`SELECT has_table_privilege('nzi_console_app','nzi_console.portal_message_attachments','UPDATE') AS u, has_table_privilege('nzi_console_app','nzi_console.portal_message_attachments','DELETE') AS d`))[0], { u: false, d: false });
    const threadId = await start();
    await postPortalMessage(database.pool, { clientId: CLIENT, threadId, body: "No file." }, portal(ALICE));
    const detail = await getPortalThread(database.pool, principal(ALICE, CLIENT), threadId);
    assert.deepEqual(detail.messages.map((m) => m.attachments), [[], []]);
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.portal_message_attachments WHERE message_id=$1`, [detail.messages[1]!.messageId]))[0]!.n, 0);
  });
});
