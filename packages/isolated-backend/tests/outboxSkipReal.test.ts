import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { EMAIL_SEND_TOPIC } from "../src/email";
import {
  clearUnconsumedOutbox, countUnconsumedOutbox, OUTBOX_CONSUMED_TOPICS, OUTBOX_EMAIL_TOPIC, OUTBOX_REMINDER_TOPIC, OUTBOX_SKIP_AUDIT_ACTION,
} from "../src/outboxSkip";
import { REMINDER_TOPIC } from "../src/strategyReminderWorker";

/**
 * The skip-only outbox clean-up, on a real database. The properties that matter: it moves `state` and nothing else, it leaves the
 * two consumed topics and every non-`pending` row alone, it never crosses an organisation, a dry run writes nothing, a re-run is a
 * no-op, and the audit event carries counts and never a payload.
 */

const ORG = "skip-org";
const OTHER = "skip-other";
const SECRET = "PAYLOAD-SENTINEL-do-not-log";

describe("outbox skip-only clean-up", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const put = (org: string, id: string, topic: string, state = "pending") => q(
    `INSERT INTO nzi_console.transactional_outbox (organisation_id, outbox_id, topic, payload_json, correlation_id, state) VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
    [org, id, topic, JSON.stringify({ note: SECRET }), `corr-${id}`, state]);
  const states = async (org: string) => Object.fromEntries((await q<{ outbox_id: string; state: string }>(
    `SELECT outbox_id, state FROM nzi_console.transactional_outbox WHERE organisation_id = $1`, [org])).map((r) => [r.outbox_id, r.state]));
  const audits = () => q<{ after_json: any; actor_id: string; action: string }>(
    `SELECT after_json, actor_id, action FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = $2`, [ORG, OUTBOX_SKIP_AUDIT_ACTION]);

  before(async () => {
    database = (await createDisposableDatabase("outboxskip"))!;
    admin = await database.admin();
    for (const org of [ORG, OTHER]) await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
  });
  after(async () => { await admin?.end(); await database?.end(); });

  beforeEach(async () => {
    await q(`DELETE FROM nzi_console.audit_events WHERE organisation_id = ANY($1)`, [[ORG, OTHER]]);
    await q(`DELETE FROM nzi_console.transactional_outbox WHERE organisation_id = ANY($1)`, [[ORG, OTHER]]);
    await put(ORG, "a1", "job.created");
    await put(ORG, "a2", "job.created");
    await put(ORG, "a3", "scope.row.updated");
    await put(ORG, "a4", "client.updated");
    await put(ORG, "a5", "portal.strategy.added");
    await put(ORG, "mail", EMAIL_SEND_TOPIC);
    await put(ORG, "remind", REMINDER_TOPIC);
    await put(ORG, "busy", "job.created", "processing");
    await put(ORG, "bad", "job.created", "failed");
    await put(ORG, "done", "job.created", "sent");
    await put(ORG, "old", "job.created", "skipped");
    await put(OTHER, "o1", "job.created");
  });

  it("names the two consumed topics exactly as their handlers do", () => {
    assert.equal(OUTBOX_EMAIL_TOPIC, EMAIL_SEND_TOPIC);
    assert.equal(OUTBOX_REMINDER_TOPIC, REMINDER_TOPIC);
    assert.deepEqual([...OUTBOX_CONSUMED_TOPICS], [EMAIL_SEND_TOPIC, REMINDER_TOPIC]);
  });

  it("imports no mailer, sender or reminder scan", () => {
    const source = readFileSync(new URL("../src/outboxSkip.ts", import.meta.url), "utf8");
    const imports = source.split("\n").filter((line) => /^import /.test(line)).join("\n");
    assert.doesNotMatch(imports, /mailer|email|strategyReminderWorker|dueReminders|resend/i);
    assert.doesNotMatch(source, /payload_json/); // the sweep never names the payload column
  });

  it("dry run counts per topic and writes nothing", async () => {
    const before = await states(ORG);
    const run = await clearUnconsumedOutbox(database.pool, ORG, { commit: false });
    assert.equal(run.committed, false);
    assert.deepEqual(run.byTopic, { "client.updated": 1, "job.created": 2, "portal.strategy.added": 1, "scope.row.updated": 1 });
    assert.equal(run.total, 5);
    assert.deepEqual(await states(ORG), before);
    assert.equal((await audits()).length, 0);
  });

  it("commit skips only pending, unconsumed rows of this organisation, in batches", async () => {
    const batches: number[] = [];
    const run = await clearUnconsumedOutbox(database.pool, ORG, { commit: true, actorId: "francis", batchSize: 2, onBatch: (b) => batches.push(b.total) });
    assert.equal(run.total, 5);
    assert.deepEqual(batches, [2, 2, 1]);
    assert.equal(run.batches, 3);
    assert.deepEqual(await states(ORG), {
      a1: "skipped", a2: "skipped", a3: "skipped", a4: "skipped", a5: "skipped",
      mail: "pending", remind: "pending", busy: "processing", bad: "failed", done: "sent", old: "skipped",
    });
    assert.deepEqual(await states(OTHER), { o1: "pending" });
  });

  it("changes state and nothing else, and sends nothing", async () => {
    const snapshot = () => q(`SELECT outbox_id, topic, payload_json, correlation_id, attempts, available_at, created_at FROM nzi_console.transactional_outbox WHERE organisation_id = $1 ORDER BY outbox_id`, [ORG]);
    const before = await snapshot();
    const mail = (await q(`SELECT count(*)::int AS n FROM nzi_console.email_messages`))[0]!.n;
    await clearUnconsumedOutbox(database.pool, ORG, { commit: true, actorId: "francis" });
    assert.deepEqual(await snapshot(), before);
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.email_messages`))[0]!.n, mail);
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.strategy_automation_log`))[0]!.n, 0);
  });

  it("writes one counts-only audit event under the actor", async () => {
    await clearUnconsumedOutbox(database.pool, ORG, { commit: true, actorId: "francis", batchSize: 2 });
    const events = await audits();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.actor_id, "francis");
    assert.equal(events[0]!.after_json.skipped, 5);
    assert.deepEqual(events[0]!.after_json.byTopic, { "client.updated": 1, "job.created": 2, "portal.strategy.added": 1, "scope.row.updated": 1 });
    assert.doesNotMatch(JSON.stringify(events[0]), new RegExp(SECRET));
  });

  it("is idempotent: a second run marks nothing and records nothing", async () => {
    await clearUnconsumedOutbox(database.pool, ORG, { commit: true, actorId: "francis" });
    const again = await clearUnconsumedOutbox(database.pool, ORG, { commit: true, actorId: "francis" });
    assert.equal(again.total, 0);
    assert.equal(again.batches, 0);
    assert.equal((await audits()).length, 1);
    assert.equal((await countUnconsumedOutbox(admin, ORG)).total, 0);
  });

  it("refuses a commit with no actor, and writes nothing", async () => {
    await assert.rejects(clearUnconsumedOutbox(database.pool, ORG, { commit: true, actorId: " " }), /actor/);
    assert.equal((await states(ORG)).a1, "pending");
  });

  it("--keep-topic only narrows the run, and cannot release a consumed topic", async () => {
    const run = await clearUnconsumedOutbox(database.pool, ORG, { commit: true, actorId: "francis", extraKept: ["portal.strategy.added"] });
    assert.equal(run.total, 4);
    assert.deepEqual(run.kept, [EMAIL_SEND_TOPIC, REMINDER_TOPIC, "portal.strategy.added"]);
    const after = await states(ORG);
    assert.equal(after.a5, "pending");
    assert.equal(after.mail, "pending");
    assert.equal(after.remind, "pending");
  });
});
