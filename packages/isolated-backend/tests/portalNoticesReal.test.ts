import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { CommandValidationError, getPortalNotices, markPortalNoticesSeen, setClientCategoryVisibility, type PortalPrincipal } from "../src/index";

/**
 * Portal Updates, against a real database (RULING-portal-messages, M2): the feed is derived from events that already exist and stores nothing
 * of its own; what a user sees is exactly their client's and their held jobs'; a reviewer's note is never read; the seen watermark is per user
 * and only moves forward; and an unread count is only ever about the last fortnight.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-nt", OTHER_CLIENT = "client-nt-other";
const JOB = "job-nt", JOB_B = "job-nt-b", OTHER_JOB = "job-nt-other";
const ALICE = "portal-nt-alice", BOB = "portal-nt-bob", CARA = "portal-nt-cara", OTHER_USER = "portal-nt-other";
const STAFF = "staff-nt";
const NOW = new Date("2026-10-20T12:00:00.000Z");
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();
const ahead = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();
// A broadcast is live by the database's clock, so its times are set against the real one.
const realAgo = (days: number, hours = 0) => new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString();
const realAhead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const principal = (userId: string, clientId: string) => ({ principal: "portal", organisationId: ORG, userId, clientId, sessionId: "p", issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid" }) as unknown as PortalPrincipal;

describe("portal updates: derived notices, scope, seen state", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const portal = (userId = ALICE, clientId = CLIENT): CommandContext => { keys += 1; return { organisationId: ORG, actorId: userId, principal: "portal", portal: { portalUserId: userId, clientId }, idempotencyKey: `nt-${keys}`, correlationId: `corr-nt-${keys}` }; };
  const staff = (): CommandContext => { keys += 1; return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `ns-${keys}`, correlationId: `corr-ns-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) }; };
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const feed = (user = ALICE, client = CLIENT) => getPortalNotices(database.pool, principal(user, client), NOW);
  const keysOf = async (user = ALICE, client = CLIENT) => (await feed(user, client)).notices.map((notice) => notice.noticeKey);
  const row = (id: string, job: string, category: string, scope: string, captured: "client-portal" | "staff") => db.query(
    `INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,category_code,source_label,report_label,level_1,level_2,unit,enabled,version,provenance_json)
     VALUES ($1,$2,$3,$4,$5,'Entry','Entry','L1','L2','kWh',true,1,$6::jsonb)`, [ORG, id, job, scope, category, JSON.stringify({ capturedAs: captured })]);
  const review = (event: string, rowId: string, job: string, decision: "approved" | "rejected", at: string, note = "Reviewer note: SECRET-WORDING") => db.query(
    `INSERT INTO nzi_console.scope_row_review_history (organisation_id,review_event_id,job_id,scope_row_id,row_version,decision,reviewer_id,reviewer_note,occurred_at) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)`,
    [ORG, event, job, rowId, decision, STAFF, note, at]);
  const report = (id: string, job: string, publishedAt: string, status = "published") => db.query(
    `INSERT INTO nzi_console.report_versions (organisation_id,report_version_id,job_id,status,manifest_version,reviewed_snapshot_id,data_hash,published_at) VALUES ($1,$2,$3,$7,${status === "superseded" ? 2 : 1},$4,$5,$6)`,
    [ORG, id, job, `snap-${job}`, `sha256:${"a".repeat(64)}`, publishedAt, status]);

  before(async () => {
    database = (await createDisposableDatabase("portalnotices"))!;
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
      await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id,snapshot_id,job_id,snapshot_version,job_version,data_hash,payload_json,created_by) VALUES ($1,$2,$3,1,1,$4,'{}'::jsonb,'seed')`, [ORG, `snap-${job}`, job, `sha256:${"a".repeat(64)}`]);
    }
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,display_name,status) VALUES ($1,$2,$3,'Alice','active'),($1,$4,$3,'Bob','active'),($1,$5,$3,'Cara','active'),($1,$6,$7,'Olly','active')`, [ORG, ALICE, CLIENT, BOB, CARA, OTHER_USER, OTHER_CLIENT]);
    // Alice and Bob hold JOB (Alice's data-entry window closes in five days; Bob's in 40); Cara holds JOB_B; the other client's user its own job.
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at,revoked_at)
       VALUES ($1,'g1',$2,$3,$4,$8,$9,NULL),($1,'g2',$2,$5,$4,$8,$10,NULL),($1,'g3',$2,$6,$7,NULL,NULL,NULL),($1,'g4',$11,$12,$13,NULL,NULL,NULL)`,
      [ORG, CLIENT, ALICE, JOB, BOB, CARA, JOB_B, ago(30), ahead(5), ahead(40), OTHER_CLIENT, OTHER_USER, OTHER_JOB]);
    await report("rv-job", JOB, ago(2)); await report("rv-jobb", JOB_B, ago(3)); await report("rv-other", OTHER_JOB, ago(1)); await report("rv-old", JOB, ago(200), "superseded");
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("derives a report notice from a published report of a job the user holds - not another job's, not another client's, not a superseded or old one", async () => {
    const alice = await keysOf(ALICE);
    assert.ok(alice.includes("report:rv-job"));
    assert.ok(!alice.includes("report:rv-jobb") && !alice.includes("report:rv-other") && !alice.includes("report:rv-old"));
    const cara = await keysOf(CARA);
    assert.ok(cara.includes("report:rv-jobb") && !cara.includes("report:rv-job"));
    assert.deepEqual((await keysOf(OTHER_USER, OTHER_CLIENT)).filter((key) => key.startsWith("report:")), ["report:rv-other"], "another client sees only its own");
    const notice = (await feed(ALICE)).notices.find((n) => n.noticeKey === "report:rv-job")!;
    assert.deepEqual([notice.kind, notice.subjectLabel, notice.jobNumber !== null, notice.action?.view, notice.action?.path], ["report", "Reports", true, "reports", "/portal/reports"]);
    assert.equal(notice.at, ago(2));
  });

  it("derives data notices from a reviewer's decision on the client's OWN entries, grouped per job, decision and day, and never reads the reviewer's note", async () => {
    await row("nt-r1", JOB, "1.natural-gas", "1", "client-portal"); await row("nt-r2", JOB, "1.natural-gas", "1", "client-portal"); await row("nt-r3", JOB, "1.natural-gas", "1", "client-portal");
    await row("nt-staffrow", JOB, "1.natural-gas", "1", "staff");
    await review("e1", "nt-r1", JOB, "approved", ago(1, 3)); await review("e2", "nt-r2", JOB, "approved", ago(1, 2)); await review("e3", "nt-r3", JOB, "rejected", ago(1, 1));
    await review("e4", "nt-staffrow", JOB, "approved", ago(1));
    const f = await feed(ALICE);
    const data = f.notices.filter((n) => n.kind === "data");
    assert.equal(data.length, 2, "approved and queried are separate notices; the staff-entered row's approval is not news to the client");
    const approved = data.find((n) => n.detail.kind === "data" && n.detail.decision === "approved")!, queried = data.find((n) => n.detail.kind === "data" && n.detail.decision === "rejected")!;
    assert.deepEqual([approved.detail.kind === "data" && approved.detail.count, queried.detail.kind === "data" && queried.detail.count], [2, 1]);
    assert.equal(approved.action?.path, `/portal/jobs/${JOB}/data`);
    assert.equal(approved.subjectLabel, "Data");
    assert.doesNotMatch(JSON.stringify(f), /SECRET-WORDING|Reviewer note|staff-nt|Sam Staff/, "no reviewer note, id or name reaches the client");
    // Another job's decisions are not visible to someone who does not hold it.
    assert.deepEqual((await feed(CARA)).notices.filter((n) => n.kind === "data"), []);
    assert.deepEqual((await feed(OTHER_USER, OTHER_CLIENT)).notices.filter((n) => n.kind === "data"), []);
  });

  it("shows data notices only for rows the client's portal profile shows", async () => {
    await setClientCategoryVisibility(database.pool, { clientId: CLIENT, categoryCode: "1.natural-gas", visible: false }, staff());
    assert.deepEqual((await feed(ALICE)).notices.filter((n) => n.kind === "data"), [], "the category is hidden from this client, so nothing about it is announced");
    await setClientCategoryVisibility(database.pool, { clientId: CLIENT, categoryCode: "1.natural-gas", visible: null }, staff());
    assert.equal((await feed(ALICE)).notices.filter((n) => n.kind === "data").length, 2);
  });

  it("derives a deadline from the user's own data-entry window closing within a fortnight - theirs, not a colleague's, and not one far off", async () => {
    const alice = (await feed(ALICE)).notices.filter((n) => n.kind === "deadline");
    assert.equal(alice.length, 1);
    assert.deepEqual([alice[0]!.detail.kind === "deadline" && alice[0]!.detail.closesOn, alice[0]!.jobId], [ahead(5).slice(0, 10), JOB]);
    assert.deepEqual((await feed(BOB)).notices.filter((n) => n.kind === "deadline"), [], "Bob's window closes in 40 days");
    assert.deepEqual((await feed(CARA)).notices.filter((n) => n.kind === "deadline"), [], "no window at all");
  });

  it("derives broadcasts from the broadcasts' own table: live ones, to everyone or to this client, never another client's or an expired or switched-off one", async () => {
    const add = (id: string, over: { target?: string | null; starts?: string; ends?: string | null; active?: boolean; link?: [string, string] | null }) => db.query(
      `INSERT INTO nzi_console.portal_broadcasts (organisation_id,broadcast_id,title,body,style,link_url,link_label,starts_at,ends_at,target_client_id,active,created_by,updated_by)
       VALUES ($1,$2,$3,'The body','info',$4,$5,$6,$7,$8,$9,'seed','seed')`,
      [ORG, id, `Title ${id}`, over.link?.[0] ?? null, over.link?.[1] ?? null, over.starts ?? realAgo(1), over.ends ?? null, over.target ?? null, over.active ?? true]);
    await add("b-all", {}); await add("b-mine", { target: CLIENT, link: ["/portal/files", "Open Files"] }); await add("b-theirs", { target: OTHER_CLIENT });
    await add("b-ended", { ends: realAgo(0, 1) }); await add("b-off", { active: false }); await add("b-future", { starts: realAhead(1) }); await add("b-ext", { link: ["https://example.com/news", "Read more"] });
    const alice = await feed(ALICE);
    const keys = alice.notices.filter((n) => n.kind === "broadcast").map((n) => n.noticeKey).sort();
    assert.deepEqual(keys, ["broadcast:b-all", "broadcast:b-ext", "broadcast:b-mine"]);
    const mine = alice.notices.find((n) => n.noticeKey === "broadcast:b-mine")!;
    assert.deepEqual([mine.action?.path, mine.action?.externalUrl, mine.action?.label, mine.subjectLabel], ["/portal/files", null, "Open Files", "General"], "its one action is the link it carries");
    assert.deepEqual([alice.notices.find((n) => n.noticeKey === "broadcast:b-ext")!.action?.externalUrl], ["https://example.com/news"]);
    assert.equal(alice.notices.find((n) => n.noticeKey === "broadcast:b-all")!.action, null, "no link, no action");
    assert.ok((await keysOf(OTHER_USER, OTHER_CLIENT)).includes("broadcast:b-theirs") && !(await keysOf(OTHER_USER, OTHER_CLIENT)).includes("broadcast:b-mine"));
  });

  it("stores nothing for a notice: the only table the feature adds is the seen watermark", async () => {
    const tables = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema='nzi_console' AND (table_name ILIKE '%notice%' OR table_name ILIKE '%update%feed%')`)).map((r) => r.table_name);
    assert.deepEqual(tables, ["portal_notice_seen"]);
    const before = (await q(`SELECT (SELECT count(*) FROM nzi_console.audit_events) AS a, (SELECT count(*) FROM nzi_console.transactional_outbox) AS o`))[0]!;
    await feed(ALICE); await feed(BOB); await feed(CARA);
    const after = (await q(`SELECT (SELECT count(*) FROM nzi_console.audit_events) AS a, (SELECT count(*) FROM nzi_console.transactional_outbox) AS o`))[0]!;
    assert.deepEqual([after.a, after.o], [before.a, before.o], "reading the feed emits no event and writes no audit row");
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.portal_notice_seen`))[0]!.n, 0, "nor does it write a watermark");
  });

  it("counts unread per user from a watermark that only moves forward, within the last fortnight, and clears it when marked seen", async () => {
    const before = await feed(ALICE);
    assert.ok(before.unread > 0 && before.seenThrough === null);
    assert.ok(before.notices.every((n) => n.unread === (new Date(n.at).getTime() > NOW.getTime() - 14 * 86_400_000)), "only the last fortnight can be unread");
    const newest = before.notices[0]!.at;
    const seen = await markPortalNoticesSeen(database.pool, { clientId: CLIENT, seenThrough: newest }, portal(ALICE));
    assert.equal(seen.data.seenThrough, newest);
    // `getPortalNotices` is read at NOW in the test; the marker was written with the real clock, so use a feed at a fixed later time.
    const after = await getPortalNotices(database.pool, principal(ALICE, CLIENT), NOW);
    assert.equal(after.unread, 0);
    assert.equal(after.seenThrough, newest);
    assert.ok((await feed(BOB)).unread > 0, "Bob's seen state is his own: Alice marking hers changes nothing for him");
    // A later, smaller mark does not move it back; a mark in the future is held at now.
    await markPortalNoticesSeen(database.pool, { clientId: CLIENT, seenThrough: ago(30) }, portal(ALICE));
    assert.equal((await feed(ALICE)).seenThrough, newest, "the watermark never goes backwards");
    const future = await markPortalNoticesSeen(database.pool, { clientId: CLIENT, seenThrough: "2999-01-01T00:00:00Z" }, portal(ALICE));
    assert.ok(Date.parse(future.data.seenThrough as string) <= Date.now() + 1000, "an unseen future is not marked seen");
  });

  it("audits the mark-seen command by id and moment only, and keeps it to the user's own client and an active portal principal", async () => {
    const events = await q(`SELECT principal_type, action, after_json FROM nzi_console.audit_events WHERE action='portal_notices_seen' ORDER BY occurred_at`);
    assert.ok(events.length >= 3 && events.every((e) => e.principal_type === "portal"));
    await assert.rejects(markPortalNoticesSeen(database.pool, { clientId: OTHER_CLIENT, seenThrough: ago(1) }, portal(ALICE, CLIENT)), (e) => e instanceof CommandValidationError || (e as Error).name === "AuthorizationError");
    await assert.rejects(markPortalNoticesSeen(database.pool, { clientId: CLIENT, seenThrough: "not a date" }, portal(ALICE)), CommandValidationError);
    const staffTry = markPortalNoticesSeen(database.pool, { clientId: CLIENT, seenThrough: ago(1) }, staff());
    await assert.rejects(staffTry);
  });
});
