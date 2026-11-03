import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  AuthorizationError, CommandValidationError, getClientThread, getPortalThread, listClientThreads, listPortalThreads, markPortalThreadRead, postClientMessage, postPortalMessage,
  setThreadSubject, startClientThread, startPortalThread, updateClientThread, VersionConflictError, type PortalPrincipal,
} from "../src/index";

/**
 * Portal conversations, against a real database (RULING-portal-messages, M1):
 *  1. who sees a thread - the client's own, client-wide or on a job they hold; never another client's, never a job they do not hold;
 *  2. state follows who spoke last; the response target is set while the client waits and cleared otherwise; Resolved reopens on a post;
 *  3. staff assign and set state (version-guarded); the first adviser to reply owns an unowned thread;
 *  4. read markers and unread counts; messages are append-only; no name is stored with a message and the client is never shown a staff name;
 *  5. every command is audited without the text of the message;
 *  6. the report page's comments and their thread are one conversation, both ways, with nothing duplicated;
 *  7. the subject tags are the organisation's: seeded, configurable, never deleted, a thread keeps its tag.
 */
const ORG = "demo-nzi-console", OTHER_ORG = "conv-other-org";
const CLIENT = "client-cv", OTHER_CLIENT = "client-cv-other";
const JOB = "job-cv", JOB_B = "job-cv-b", OTHER_JOB = "job-cv-other";
const ALICE = "portal-cv-alice", BOB = "portal-cv-bob", CARA = "portal-cv-cara", OTHER_USER = "portal-cv-other";
const STAFF = "staff-cv", STAFF_B = "staff-cv-b";
const principal = (userId: string, clientId: string) => ({ principal: "portal", organisationId: ORG, userId, clientId, sessionId: "p", issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid" }) as unknown as PortalPrincipal;
const holder = { organisationId: ORG, userId: STAFF, capabilities: commandGrantForRole("admin", ORG, STAFF).capabilities };

describe("portal conversations: visibility, state, ownership, read markers and the report bridge", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const portal = (userId = ALICE, clientId = CLIENT): CommandContext => { keys += 1; return { organisationId: ORG, actorId: userId, principal: "portal", portal: { portalUserId: userId, clientId }, idempotencyKey: `cv-${keys}`, correlationId: `corr-cv-${keys}` }; };
  const staff = (actor = STAFF): CommandContext => { keys += 1; return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `cs-${keys}`, correlationId: `corr-cs-${keys}`, grant: commandGrantForRole("admin", ORG, actor) }; };
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [];
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const start = async (user = ALICE, over: Partial<{ jobId: string | null; subjectCode: string; title: string; body: string }> = {}) =>
    (await startPortalThread(database.pool, { clientId: CLIENT, jobId: JOB, subjectCode: "data", title: "Gas bills", body: "Where do I upload the gas bills?", ...over }, portal(user))).data.threadId as string;
  const row = async (threadId: string) => (await q(`SELECT * FROM nzi_console.portal_threads WHERE thread_id=$1`, [threadId]))[0]!;

  before(async () => {
    database = (await createDisposableDatabase("portalconv"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active'),($1,$3,'Other','active')`, [ORG, CLIENT, OTHER_CLIENT]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Sam Staff'),($1,$3,'admin','active','Bea Staff')`, [ORG, STAFF, STAFF_B]);
    for (const [job, client] of [[JOB, CLIENT], [JOB_B, CLIENT], [OTHER_JOB, OTHER_CLIENT]] as const) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
         VALUES ($1,$2,$3,(SELECT coalesce(max(sequence),0)+1 FROM nzi_console.jobs),'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, job, client]);
    }
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,display_name,status) VALUES ($1,$2,$3,'Alice Client','active'),($1,$4,$3,'Bob Client','active'),($1,$5,$3,'Cara Client','active'),($1,$6,$7,'Olly Other','active')`, [ORG, ALICE, CLIENT, BOB, CARA, OTHER_USER, OTHER_CLIENT]);
    // Alice and Bob hold JOB; Cara holds only JOB_B; the other client's user holds its own job.
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at,revoked_at)
       VALUES ($1,'g1',$2,$3,$4,NULL,NULL,NULL),($1,'g2',$2,$5,$4,NULL,NULL,NULL),($1,'g3',$2,$6,$7,NULL,NULL,NULL),($1,'g4',$8,$9,$10,NULL,NULL,NULL)`,
      [ORG, CLIENT, ALICE, JOB, BOB, CARA, JOB_B, OTHER_CLIENT, OTHER_USER, OTHER_JOB]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("seeds the five subject tags for every organisation, including one inserted later (the trigger)", async () => {
    const tags = async (org: string) => (await q(`SELECT subject_code FROM nzi_console.portal_thread_subjects WHERE organisation_id=$1 ORDER BY sort_order`, [org])).map((r) => r.subject_code);
    assert.deepEqual(await tags(ORG), ["data", "reports", "srs", "actions", "general"]);
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [OTHER_ORG]);
    assert.deepEqual(await tags(OTHER_ORG), ["data", "reports", "srs", "actions", "general"], "a new organisation starts with the same five");
  });

  it("a client user starts a conversation on a job they hold or for the whole organisation: Awaiting adviser, a response target of two working days, the first message in", async () => {
    const jobThread = await start(ALICE);
    const wide = await start(CARA, { jobId: null, subjectCode: "general", title: "Billing contact" });
    const job = await row(jobThread), whole = await row(wide);
    assert.deepEqual([job.scope, job.job_id, job.state, job.message_count, job.started_by_principal, job.owner_id], ["job", JOB, "awaiting_nzi", 1, "portal", null]);
    assert.deepEqual([whole.scope, whole.job_id], ["client", null]);
    const target = new Date(job.response_target_at), made = new Date(job.created_at);
    assert.ok(target > made && target.getTime() - made.getTime() <= 4 * 86_400_000 && ![0, 6].includes(target.getUTCDay()), "a working day, at most two working days (four calendar days over a weekend) on");
    await assert.rejects(start(CARA, { jobId: JOB }), (e) => codes(e).includes("NOT_FOUND"), "a job the user does not hold");
    await assert.rejects(start(ALICE, { jobId: OTHER_JOB }), (e) => codes(e).includes("NOT_FOUND"), "another client's job");
    await assert.rejects(start(ALICE, { subjectCode: "nonsense" }), (e) => codes(e).includes("NOT_FOUND"), "an unknown subject");
    await assert.rejects(startPortalThread(database.pool, { clientId: CLIENT, jobId: JOB, subjectCode: "data", title: "x", body: "   " }, portal()), (e) => codes(e).includes("REQUIRED"));
  });

  it("shows a user exactly their client's client-wide threads and the threads of jobs they hold - never another client's, never a job they do not hold", async () => {
    const titles = async (user: string, client = CLIENT) => (await listPortalThreads(database.pool, principal(user, client))).threads.map((t) => t.title).sort();
    const forJobB = await start(CARA, { jobId: JOB_B, title: "Job B only" });
    const alice = await titles(ALICE), cara = await titles(CARA);
    assert.ok(alice.includes("Gas bills") && alice.includes("Billing contact") && !alice.includes("Job B only"));
    assert.ok(cara.includes("Billing contact") && cara.includes("Job B only") && !cara.includes("Gas bills"));
    assert.deepEqual(await titles(OTHER_USER, OTHER_CLIENT), [], "another client sees none of it");
    const gas = (await listPortalThreads(database.pool, principal(ALICE, CLIENT))).threads.find((t) => t.title === "Gas bills")!;
    await assert.rejects(getPortalThread(database.pool, principal(CARA, CLIENT), gas.threadId), AuthorizationError, "a job thread of a job she does not hold");
    await assert.rejects(getPortalThread(database.pool, principal(OTHER_USER, OTHER_CLIENT), gas.threadId), AuthorizationError);
    await assert.rejects(postPortalMessage(database.pool, { clientId: CLIENT, threadId: gas.threadId, body: "hi" }, portal(CARA)), (e) => codes(e).includes("NOT_FOUND"));
    await assert.rejects(postPortalMessage(database.pool, { clientId: CLIENT, threadId: gas.threadId, body: "hi" }, portal(OTHER_USER, OTHER_CLIENT)), AuthorizationError);
    assert.deepEqual((await listPortalThreads(database.pool, principal(ALICE, CLIENT), { jobId: JOB })).threads.map((t) => t.title).sort(), ["Billing contact", "Gas bills"], "the job's page: its threads and the client-wide ones");
    assert.ok(forJobB);
  });

  it("state follows who spoke last: a staff reply is Awaiting client (target cleared, owner claimed), a client reply is Awaiting adviser again, and a post to a Resolved thread reopens it", async () => {
    const id = await start(ALICE, { title: "State machine" });
    await postClientMessage(database.pool, { clientId: CLIENT, threadId: id, body: "Upload them on the Data page." }, staff());
    let t = await row(id);
    assert.deepEqual([t.state, t.response_target_at, t.owner_id, t.message_count], ["awaiting_client", null, STAFF, 2]);
    await postPortalMessage(database.pool, { clientId: CLIENT, threadId: id, body: "Done, thanks." }, portal(BOB));
    t = await row(id);
    assert.equal(t.state, "awaiting_nzi"); assert.ok(t.response_target_at);
    const resolved = await updateClientThread(database.pool, { clientId: CLIENT, threadId: id, expectedVersion: t.version, state: "resolved" }, staff());
    assert.equal(resolved.data.state, "resolved");
    t = await row(id);
    assert.ok(t.resolved_at && t.response_target_at === null);
    await postPortalMessage(database.pool, { clientId: CLIENT, threadId: id, body: "One more thing." }, portal(ALICE));
    t = await row(id);
    assert.deepEqual([t.state, t.resolved_at], ["awaiting_nzi", null]);
    // A second adviser replying does not take the thread over.
    await postClientMessage(database.pool, { clientId: CLIENT, threadId: id, body: "Go on." }, staff(STAFF_B));
    assert.equal((await row(id)).owner_id, STAFF);
  });

  it("lets staff assign and set the state, guarded by the version, to an active member of staff only", async () => {
    const id = await start(ALICE, { title: "Assign me" });
    const v = (await row(id)).version;
    await updateClientThread(database.pool, { clientId: CLIENT, threadId: id, expectedVersion: v, ownerId: STAFF_B, state: "open" }, staff());
    let t = await row(id);
    assert.deepEqual([t.owner_id, t.state, t.response_target_at], [STAFF_B, "open", null], "Open is neutral: no one is awaited, no target");
    await assert.rejects(updateClientThread(database.pool, { clientId: CLIENT, threadId: id, expectedVersion: v, ownerId: STAFF }, staff()), VersionConflictError, "the stale version");
    await assert.rejects(updateClientThread(database.pool, { clientId: CLIENT, threadId: id, expectedVersion: t.version, ownerId: "nobody" }, staff()), (e) => codes(e).includes("NOT_FOUND"));
    await db.query(`UPDATE nzi_console.memberships SET status='inactive' WHERE user_id=$1`, [STAFF_B]).catch(() => undefined);
    await updateClientThread(database.pool, { clientId: CLIENT, threadId: id, expectedVersion: t.version, ownerId: null, state: "awaiting_nzi" }, staff());
    t = await row(id);
    assert.deepEqual([t.owner_id, t.state], [null, "awaiting_nzi"]);
    assert.ok(t.response_target_at, "set to Awaiting adviser by hand, the target is set too");
    await assert.rejects(updateClientThread(database.pool, { clientId: CLIENT, threadId: id, expectedVersion: t.version }, staff()), (e) => codes(e).includes("REQUIRED"), "nothing to change");
    await db.query(`UPDATE nzi_console.memberships SET status='active' WHERE user_id=$1`, [STAFF_B]);
  });

  it("starts a conversation from the adviser's side: Awaiting client, owned by whoever started it", async () => {
    const out = await startClientThread(database.pool, { clientId: CLIENT, jobId: JOB, subjectCode: "reports", title: "Draft report", body: "The draft is ready for you." }, staff(STAFF_B));
    const t = await row(out.data.threadId as string);
    assert.deepEqual([t.state, t.owner_id, t.started_by_principal, t.response_target_at], ["awaiting_client", STAFF_B, "staff", null]);
    await assert.rejects(startClientThread(database.pool, { clientId: "no-such-client", jobId: null, subjectCode: "general", title: "x", body: "y" }, staff()), (e) => e instanceof AuthorizationError || codes(e).includes("NOT_FOUND"));
  });

  it("counts what a user has not read, clears it when they mark it read, and counts for staff what the client has said since the last reply", async () => {
    const id = await start(ALICE, { title: "Unread" });
    await postClientMessage(database.pool, { clientId: CLIENT, threadId: id, body: "r1" }, staff());
    await postClientMessage(database.pool, { clientId: CLIENT, threadId: id, body: "r2" }, staff());
    const unread = async (user: string) => (await listPortalThreads(database.pool, principal(user, CLIENT))).threads.find((t) => t.threadId === id)!.unread;
    assert.deepEqual([await unread(ALICE), await unread(BOB)], [2, 3], "Alice wrote the first message herself; Bob wrote none");
    await markPortalThreadRead(database.pool, { clientId: CLIENT, threadId: id }, portal(BOB));
    assert.deepEqual([await unread(ALICE), await unread(BOB)], [2, 0], "Bob's marker is his own");
    await postPortalMessage(database.pool, { clientId: CLIENT, threadId: id, body: "c2" }, portal(ALICE));
    await postPortalMessage(database.pool, { clientId: CLIENT, threadId: id, body: "c3" }, portal(BOB));
    assert.equal((await listClientThreads(database.pool, holder, CLIENT)).threads.find((t) => t.threadId === id)!.unread, 2, "staff: two client messages since the last adviser reply");
    await assert.rejects(markPortalThreadRead(database.pool, { clientId: CLIENT, threadId: id }, portal(CARA)), (e) => codes(e).includes("NOT_FOUND"), "not a thread she may be in");
  });

  it("keeps messages append-only and stores no name with them: the client reads You / A colleague / the adviser, staff read names joined from the person's own record", async () => {
    const id = await start(ALICE, { title: "Names" });
    await postClientMessage(database.pool, { clientId: CLIENT, threadId: id, body: "From staff." }, staff());
    await postPortalMessage(database.pool, { clientId: CLIENT, threadId: id, body: "From Bob." }, portal(BOB));
    assert.equal((await q(`SELECT has_table_privilege('nzi_console_app','nzi_console.portal_messages','UPDATE') AS u, has_table_privilege('nzi_console_app','nzi_console.portal_messages','DELETE') AS d`))[0]!.u, false);
    assert.equal((await q(`SELECT has_table_privilege('nzi_console_app','nzi_console.portal_messages','DELETE') AS d`))[0]!.d, false);
    assert.deepEqual((await q(`SELECT column_name FROM information_schema.columns WHERE table_name='portal_messages' AND column_name ILIKE '%name%'`)), [], "no name column");
    const asAlice = await getPortalThread(database.pool, principal(ALICE, CLIENT), id);
    assert.deepEqual(asAlice.messages.map((m) => m.author), ["you", "adviser", "colleague"]);
    assert.doesNotMatch(JSON.stringify(asAlice), /Sam Staff|Bob Client|Alice Client|staff-cv|portal-cv/);
    const asStaff = await getClientThread(database.pool, holder, CLIENT, id);
    assert.deepEqual(asStaff.messages.map((m) => m.authorName), ["Alice Client", "Sam Staff", "Bob Client"]);
    assert.equal(asStaff.thread.ownerName, "Sam Staff");
  });

  it("audits every command by id and state, never by the text of the message", async () => {
    const id = await start(ALICE, { title: "Audited", body: "Secret figures: 12345 kWh" });
    await postClientMessage(database.pool, { clientId: CLIENT, threadId: id, body: "Confidential reply text" }, staff());
    const events = await q(`SELECT principal_type, action, after_json FROM nzi_console.audit_events WHERE entity_id=$1 ORDER BY occurred_at`, [id]);
    assert.deepEqual(events.map((e) => [e.principal_type, e.action]), [["portal", "portal_thread_started"], ["staff", "client_message_posted"]]);
    assert.doesNotMatch(JSON.stringify(events), /Secret figures|Confidential reply|12345/);
  });

  it("is one conversation with the report page's comments: existing comments become a Reports-tagged job thread, a comment is mirrored in, a message is mirrored out, and nothing is duplicated", async () => {
    await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id,snapshot_id,job_id,snapshot_version,job_version,data_hash,payload_json,created_by) VALUES ($1,'snap-cv',$2,1,1,$3,'{}'::jsonb,'seed')`, [ORG, JOB, `sha256:${"a".repeat(64)}`]);
    await db.query(`INSERT INTO nzi_console.report_versions (organisation_id,report_version_id,job_id,status,manifest_version,reviewed_snapshot_id,data_hash) VALUES ($1,'rv-cv',$2,'validated',1,'snap-cv',$3)`, [ORG, JOB, `sha256:${"a".repeat(64)}`]);
    const comment = (id: string, principalType: "portal" | "staff", author: string, name: string, body: string, at: string) => db.query(
      `INSERT INTO nzi_console.portal_report_comments (organisation_id,comment_id,report_version_id,job_id,client_id,author_principal,author_id,author_display_name,body,created_at) VALUES ($1,$2,'rv-cv',$3,$4,$5,$6,$7,$8,$9)`, [ORG, id, JOB, CLIENT, principalType, author, name, body, at]);
    await comment("c1", "portal", ALICE, "Alice Client", "Is table 3 right?", "2026-10-01T09:00:00Z");
    await comment("c2", "staff", STAFF, "Sam Staff", "Yes - see the note.", "2026-10-01T10:00:00Z");
    await db.query(`SELECT nzi_console.mirror_report_comment_to_thread($1,'c1')`, [ORG]);
    await db.query(`SELECT nzi_console.mirror_report_comment_to_thread($1,'c2')`, [ORG]);
    await db.query(`SELECT nzi_console.mirror_report_comment_to_thread($1,'c2')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.portal_report_thread_reads (organisation_id,report_version_id,portal_user_id,last_read_at) VALUES ($1,'rv-cv',$2,'2026-10-01T11:00:00Z')`, [ORG, ALICE]);
    await db.query(`SELECT nzi_console.mirror_report_thread_read($1,'rv-cv',$2,'2026-10-01T11:00:00Z')`, [ORG, ALICE]);
    const thread = (await q(`SELECT * FROM nzi_console.portal_threads WHERE report_version_id='rv-cv'`))[0]!;
    assert.deepEqual([thread.subject_code, thread.scope, thread.job_id, thread.message_count, thread.state], ["reports", "job", JOB, 2, "awaiting_client"], "idempotent: the second mirror of c2 added nothing");
    assert.deepEqual((await q(`SELECT seq, author_principal, body, legacy_comment_id FROM nzi_console.portal_messages WHERE thread_id=$1 ORDER BY seq`, [thread.thread_id])).map((m) => [m.seq, m.author_principal, m.body, m.legacy_comment_id]),
      [[1, "portal", "Is table 3 right?", "c1"], [2, "staff", "Yes - see the note.", "c2"]]);
    assert.equal((await listPortalThreads(database.pool, principal(ALICE, CLIENT))).threads.find((t) => t.threadId === thread.thread_id)!.unread, 0, "the report page's read marker carried over");
    // A reply written in the conversation appears on the report page, with the person's name, and is not mirrored twice.
    await postPortalMessage(database.pool, { clientId: CLIENT, threadId: thread.thread_id, body: "Thanks - approving." }, portal(ALICE));
    const comments = await q(`SELECT comment_id, author_principal, author_id, author_display_name, body FROM nzi_console.portal_report_comments WHERE report_version_id='rv-cv' ORDER BY created_at, comment_id`);
    assert.deepEqual(comments.map((c) => c.body), ["Is table 3 right?", "Yes - see the note.", "Thanks - approving."]);
    assert.deepEqual([comments[2]!.author_principal, comments[2]!.author_id, comments[2]!.author_display_name], ["portal", ALICE, "Alice Client"]);
    await db.query(`SELECT nzi_console.mirror_report_comment_to_thread($1,$2)`, [ORG, comments[2]!.comment_id]);
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.portal_messages WHERE thread_id=$1`, [thread.thread_id]))[0]!.n, 3, "the comment written from the thread is not mirrored back in a second time");
    await postClientMessage(database.pool, { clientId: CLIENT, threadId: thread.thread_id, body: "Great." }, staff());
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.portal_report_comments WHERE report_version_id='rv-cv'`))[0]!.n, 4);
    assert.equal((await q(`SELECT author_display_name AS n FROM nzi_console.portal_report_comments WHERE body='Great.'`))[0]!.n, "Sam Staff");
  });

  it("makes the subject tags the organisation's own: add, rename, switch off - never deleted, and a thread keeps the tag it was started under", async () => {
    const id = await start(ALICE, { subjectCode: "srs", title: "SRS question" });
    await setThreadSubject(database.pool, { code: "esg", label: "ESG", sortOrder: 45 }, staff());
    await setThreadSubject(database.pool, { code: "srs", label: "Supplier scoring", active: false }, staff());
    const tags = (await listPortalThreads(database.pool, principal(ALICE, CLIENT))).subjects;
    assert.ok(tags.some((s) => s.code === "esg" && s.label === "ESG") && !tags.some((s) => s.code === "srs"), "an inactive tag is not offered to the client");
    assert.ok((await listClientThreads(database.pool, holder, CLIENT)).subjects.some((s) => s.code === "srs" && !s.active), "but staff still see it, switched off");
    await assert.rejects(start(ALICE, { subjectCode: "srs" }), (e) => codes(e).includes("NOT_FOUND"), "nothing new is started under it");
    assert.equal((await getPortalThread(database.pool, principal(ALICE, CLIENT), id)).thread.subjectLabel, "Supplier scoring", "the existing thread keeps its tag (renamed)");
    assert.equal((await q(`SELECT has_table_privilege('nzi_console_app','nzi_console.portal_thread_subjects','DELETE') AS d`))[0]!.d, false);
    await assert.rejects(setThreadSubject(database.pool, { code: "Bad Code", label: "x" }, staff()), CommandValidationError);
  });

  it("keeps tenants apart: another organisation's tags and threads are not reachable, and a portal user cannot run a staff command nor staff a portal one", async () => {
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.portal_thread_subjects WHERE organisation_id=$1 AND subject_code='esg'`, [OTHER_ORG]))[0]!.n, 0);
    await assert.rejects(startClientThread(database.pool, { clientId: CLIENT, jobId: null, subjectCode: "general", title: "x", body: "y" }, portal()), AuthorizationError);
    await assert.rejects(startPortalThread(database.pool, { clientId: CLIENT, jobId: null, subjectCode: "general", title: "x", body: "y" }, staff()), AuthorizationError);
    await assert.rejects(listClientThreads(database.pool, { organisationId: ORG, userId: "nobody", capabilities: [] }, CLIENT), AuthorizationError);
  });
});
