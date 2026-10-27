import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { listStrategyReminderStatuses, updateReminderSettings } from "../src/dueReminders";
import { emailDispatchFromEnv } from "../src/email";
import { VersionConflictError } from "../src/errors";
import { suppressingMailer } from "../src/mailer";
import { withTenantRead } from "../src/postgres";
import { listClientStrategies, updateClientStrategy } from "../src/reductionStrategies";
import { runWorkerTick } from "../src/strategyReminderWorker";

/**
 * Actions A3 against a real database (0190), with the tick run as the role it really runs as (`nzi_console_worker`):
 *
 * - a reminder is owed at due − lead (the default 7, an action's own lead honoured); no date, or a state other than Agreed /
 *   In progress, never reminds;
 * - the scan **enqueues** into the existing outbox (an `email.send` row, an `email_messages` row, the marker and an audit
 *   event) and sends nothing; the existing email drain sends it on the next tick, in the house frame, signed by the
 *   client's adviser — and the isolation gate still stubs an owner outside the NZI domain;
 * - once per action per due date: a re-tick sends nothing; a changed date re-arms;
 * - no owner, no address or no consent: skipped and counted, never sent, and not burned — fixed, it goes;
 * - Admin's switch off: nothing scanned, nothing sent, for either kind of reminder;
 * - audited by template and contact id, never the address; no money;
 * - the scan and the send are separate transactions: a failing scan sends nothing and leaves the drain unharmed.
 */

const ORG = "a3-org";
const CLIENT = "client-a3";
const TODAY = "2026-11-02";
const ORIGIN = "https://console.example.test";
const KEYED = { NZI_DATABASE_BOUNDARY: "isolated-non-production", NEXT_PUBLIC_APP_ENV: "staging", RESEND_API_KEY: "re_test_0123456789abcdef", EMAIL_FROM: "Net Zero International <no-reply@netzero.international>" };
const ENV = { appEnv: "staging", boundaryToken: "isolated-non-production" };
let keys = 0;
const context = (): CommandContext => {
  keys += 1;
  return { organisationId: ORG, actorId: "ada", principal: "staff", idempotencyKey: `a3-${keys}`, correlationId: `corr-a3-${keys}`, grant: commandGrantForRole("admin", ORG, "ada") };
};

type Posted = { to: string; subject: string; html: string; text: string };
function resend(): typeof fetch & { posted: Posted[] } {
  const posted: Posted[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    posted.push({ to: body.to[0], subject: body.subject, html: body.html, text: body.text });
    return new Response(JSON.stringify({ id: `re-${posted.length}` }), { status: 200 });
  }) as unknown as typeof fetch & { posted: Posted[] };
  impl.posted = posted;
  return impl;
}

describe("Actions A3 — due-date reminders through the email pipe (0190), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  let requirement: { framework_id: string; requirement_id: string };
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const tick = (fetchImpl = resend(), options: { origin: string | undefined } = { origin: ORIGIN }) =>
    runWorkerTick(database.pool, { organisationId: ORG, today: TODAY, mailer: suppressingMailer(), email: emailDispatchFromEnv(KEYED, fetchImpl), env: ENV, consoleOrigin: options.origin });
  const markers = (id: string) => q<{ due_date: string }>(`SELECT to_char(due_date, 'YYYY-MM-DD') AS due_date FROM nzi_console.strategy_due_reminders WHERE client_strategy_id = $1 ORDER BY due_date`, [id]);
  const settings = async (enabled: boolean, defaultLeadDays = 7) => {
    const [row] = await q<{ version: number }>(`SELECT version FROM nzi_console.organisation_reminder_settings WHERE organisation_id = $1`, [ORG]);
    return updateReminderSettings(database.pool, { enabled, defaultLeadDays, expectedVersion: row?.version ?? null }, context());
  };
  const addAction = async (id: string, input: { status?: string; target?: string | null; owner?: string | null; lead?: number | null }) => {
    const status = input.status ?? "agreed";
    await q("BEGIN");
    await q(`INSERT INTO nzi_console.client_strategies (organisation_id, client_strategy_id, client_id, bespoke_title, bespoke_scope, bespoke_control_level,
               status, progress_pct, target_date, owner_contact_id, reminder_lead_days, created_by)
             VALUES ($1, $2, $3, $4, '2', 'direct_control', $5, $6, $7::date, $8, $9, 'seed')`,
      [ORG, id, CLIENT, `Action ${id}`, status, status === "complete" ? 100 : 0, input.target === undefined ? "2026-11-06" : input.target, input.owner ?? null, input.lead ?? null]);
    await q(`INSERT INTO nzi_console.client_strategy_srs_requirements (organisation_id, client_strategy_id, framework_id, requirement_id) VALUES ($1, $2, $3, $4)`,
      [ORG, id, requirement.framework_id, requirement.requirement_id]);
    await q("COMMIT");
  };

  before(async () => {
    database = (await createDisposableDatabase("duereminders"))!;
    admin = await database.admin();
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'A3 House')`, [ORG]);
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    // The house brand the worker may read — and a VAT number it may not.
    await q(`UPDATE nzi_console.organisation_profiles SET display_name = 'A3 House Ltd', vat_number = 'GB123456789' WHERE organisation_id = $1`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email) VALUES
      ($1, 'ada', 'admin', 'active', 'Ada Admin', 'ada@netzero.international'),
      ($1, 'sam', 'consultant', 'active', 'Sam Adviser', 'sam@netzero.international')`, [ORG]);
    // Sam is the client's adviser: the reminder is signed by them.
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, owner_user_id) VALUES ($1, $2, 'Northwind Ltd', 'active', 'sam')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_contacts (organisation_id, contact_id, client_id, full_name, email, status, email_consent, created_by, updated_by) VALUES
      ($1, 'c-nzi', $2, 'Grace Owner', 'grace.owner@netzero.international', 'active', 'granted', 'seed', 'seed'),
      ($1, 'c-client', $2, 'Dana Reid', 'dana@northwind.example', 'active', 'granted', 'seed', 'seed'),
      ($1, 'c-unasked', $2, 'Uma Unasked', 'uma@northwind.example', 'active', 'unknown', 'seed', 'seed'),
      ($1, 'c-noemail', $2, 'Noel Noemail', NULL, 'active', 'granted', 'seed', 'seed')`, [ORG, CLIENT]);
    requirement = (await q<{ framework_id: string; requirement_id: string }>(`SELECT framework_id, requirement_id FROM nzi_console.srs_requirements WHERE organisation_id = $1 ORDER BY requirement_id LIMIT 1`, [ORG]))[0]!;

    // Due 06/11 with the default 7: owed today (02/11).
    await addAction("due-nzi", { owner: "c-nzi" });
    await addAction("due-client", { status: "in_progress", owner: "c-client", target: "2026-11-04" });
    // Due 25/11: not yet on 7 days — but this one's own lead is 30.
    await addAction("far", { owner: "c-nzi", target: "2026-11-25" });
    await addAction("far-own-lead", { owner: "c-nzi", target: "2026-11-25", lead: 30 });
    await addAction("no-date", { owner: "c-nzi", target: null });
    for (const status of ["proposed", "complete", "declined", "on_hold"]) await addAction(`state-${status}`, { status, owner: "c-nzi" });
    await addAction("no-owner", {});
    await addAction("no-consent", { owner: "c-unasked" });
    await addAction("no-email", { owner: "c-noemail" });
  });
  after(async () => { await admin?.end(); await database?.end(); });

  it("the worker may read the brand columns and the signature fields, and nothing else of the profile or the member", async () => {
    const [grants] = await q<Record<string, boolean>>(`SELECT
      has_column_privilege('nzi_console_worker', 'nzi_console.organisation_profiles', 'display_name', 'SELECT') AS brand,
      has_column_privilege('nzi_console_worker', 'nzi_console.organisation_profiles', 'vat_number', 'SELECT') AS vat,
      has_column_privilege('nzi_console_worker', 'nzi_console.memberships', 'signature_mobile', 'SELECT') AS signature,
      has_column_privilege('nzi_console_worker', 'nzi_console.memberships', 'role_id', 'SELECT') AS role,
      has_table_privilege('nzi_console_worker', 'nzi_console.strategy_due_reminders', 'INSERT') AS mark,
      has_table_privilege('nzi_console_worker', 'nzi_console.strategy_due_reminders', 'DELETE') AS unmark,
      has_table_privilege('nzi_console_app', 'nzi_console.strategy_due_reminders', 'INSERT') AS app_mark`);
    assert.deepEqual(grants, { brand: true, vat: false, signature: true, role: false, mark: true, unmark: false, app_mark: false });
  });

  it("off by default: a tick considers nothing and sends nothing, for either kind of reminder", async () => {
    const result = await tick();
    assert.ok(result.dueReminders.ok && result.reminders.ok);
    assert.deepEqual(result.dueReminders.ok && result.dueReminders.summary, { enabled: false, owed: 0, enqueued: 0, blocked: { "no-owner": 0, "owner-inactive": 0, "no-email": 0, "no-consent": 0 }, refused: 0, sent: { sent: 0, stubbed: 0 } });
    assert.equal(result.reminders.ok && result.reminders.summary.off, true);
    assert.equal((await q(`SELECT 1 FROM nzi_console.email_messages`)).length, 0);
  });

  it("Admin turns them on (admin.templates, versioned, audited in full)", async () => {
    const saved = await settings(true);
    assert.equal(saved.state, "success");
    await assert.rejects(updateReminderSettings(database.pool, { enabled: false, defaultLeadDays: 7, expectedVersion: 9 }, context()), VersionConflictError);
    const [audit] = await q(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE action = 'reminder_settings_updated'`);
    assert.deepEqual([audit!.before_json, audit!.after_json], [{ enabled: false, defaultLeadDays: 7 }, { enabled: true, defaultLeadDays: 7, version: 1 }]);
  });

  it("the scan enqueues what is owed — and sends nothing", async () => {
    const fetchImpl = resend();
    const result = await tick(fetchImpl);
    assert.ok(result.dueReminders.ok, result.dueReminders.ok ? "" : result.dueReminders.error);
    // due-nzi, due-client and far-own-lead are owed and sendable; three are owed and blocked; the rest are not owed.
    assert.deepEqual(result.dueReminders.summary, { enabled: true, owed: 6, enqueued: 3, blocked: { "no-owner": 1, "owner-inactive": 0, "no-email": 1, "no-consent": 1 }, refused: 0, sent: { sent: 0, stubbed: 0 } });
    assert.equal(fetchImpl.posted.length, 0, "enqueued only: the email drain ran before the scan, in its own transaction");
    const queued = await q<{ to_email: string; template_code: string; status: string }>(`SELECT to_email, template_code, status FROM nzi_console.email_messages ORDER BY to_email`);
    assert.deepEqual(queued.map((row) => [row.to_email, row.template_code, row.status]), [
      ["dana@northwind.example", "strategy.reminder.approaching", "queued"],
      ["grace.owner@netzero.international", "strategy.reminder.approaching", "queued"],
      ["grace.owner@netzero.international", "strategy.reminder.approaching", "queued"],
    ]);
    assert.equal((await q(`SELECT 1 FROM nzi_console.transactional_outbox WHERE topic = 'email.send' AND state = 'pending'`)).length, 3, "into the existing outbox");
    assert.deepEqual(await markers("far-own-lead"), [{ due_date: "2026-11-25" }], "an action's own lead honoured");
    for (const id of ["far", "no-date", "state-proposed", "state-complete", "state-declined", "state-on_hold", "no-owner", "no-consent", "no-email"]) {
      assert.deepEqual(await markers(id), [], `${id}: no reminder`);
    }
  });

  it("is audited by template and contact id — never the address — with no money", async () => {
    const audits = await q<{ actor_id: string; principal_type: string; entity_id: string; after_json: Record<string, unknown>; client_id: string }>(
      `SELECT actor_id, principal_type, entity_id, after_json, client_id FROM nzi_console.audit_events WHERE action = 'strategy_reminder_enqueued' ORDER BY entity_id`);
    assert.deepEqual(audits.map((row) => row.entity_id), ["due-client", "due-nzi", "far-own-lead"]);
    for (const row of audits) {
      assert.deepEqual([row.actor_id, row.principal_type, row.client_id], ["worker:due-reminders", "system", CLIENT]);
      assert.equal(row.after_json.templateCode, "strategy.reminder.approaching");
      assert.match(String(row.after_json.recipientContactId), /^c-/);
      assert.ok(!JSON.stringify(row.after_json).includes("@"), "no address in the audit trail");
      assert.ok(!/amount|£|price|fee/i.test(JSON.stringify(row.after_json)), "no money");
    }
  });

  it("the existing drain sends them on the next tick, in the house frame signed by the adviser; the isolation gate stubs the client's owner", async () => {
    const fetchImpl = resend();
    const result = await tick(fetchImpl);
    assert.ok(result.emails.ok);
    assert.deepEqual(result.emails.ok && result.emails.summary, { sent: 2, stubbed: 1, retried: 0, failed: 0 });
    assert.deepEqual(result.dueReminders.ok && result.dueReminders.summary.sent, { sent: 2, stubbed: 1 }, "the tick reports the reminders sent (R8)");
    assert.deepEqual(fetchImpl.posted.map((mail) => mail.to), ["grace.owner@netzero.international", "grace.owner@netzero.international"], "only the NZI address leaves the isolated boundary");
    const [stubbed] = await q<{ status: string; last_error: string }>(`SELECT status, last_error FROM nzi_console.email_messages WHERE to_email = 'dana@northwind.example'`);
    assert.equal(stubbed!.status, "stubbed");
    assert.match(stubbed!.last_error, /isolated boundary sends only to @netzero\.international/);

    const mail = fetchImpl.posted.find((posted) => posted.subject.startsWith("Action due-nzi"))!;
    assert.equal(mail.subject, "Action due-nzi — due 06/11/2026");
    assert.match(mail.text, /^Hello Grace,/);
    assert.match(mail.text, /Northwind Ltd's reduction plan/);
    assert.match(mail.html, /href="https:\/\/console\.example\.test\/portal"/, "the link into the portal");
    assert.match(mail.html, />Sam Adviser<\/p>/, "signed by the client's adviser (5-2)");
    assert.match(mail.html, /font-weight:bold">A3 House Ltd<\/p>/, "the house chrome from the organisation's own brand (5-1), read by the worker");
    assert.ok(!mail.html.includes("GB123456789"), "nothing of the profile beyond the brand");
    // Nothing more is owed: this tick's scan found every one already marked.
    assert.ok(result.dueReminders.ok && result.dueReminders.summary.enqueued === 0);
  });

  it("fires once per action per due date: a further tick sends nothing", async () => {
    const fetchImpl = resend();
    const result = await tick(fetchImpl);
    assert.ok(result.dueReminders.ok && result.dueReminders.summary.enqueued === 0);
    assert.equal(fetchImpl.posted.length, 0);
    assert.equal((await q(`SELECT 1 FROM nzi_console.email_messages`)).length, 3);
  });

  it("re-arms when the date changes — set through the plan's own command, the lead with it", async () => {
    const [current] = await withTenantRead(database.pool, ORG, async (db) => (await listClientStrategies(db, CLIENT)).filter((entry) => entry.id === "due-nzi"));
    const moved = await updateClientStrategy(database.pool, {
      clientStrategyId: "due-nzi", expectedVersion: current!.version, status: current!.status, progressPct: current!.progressPct, targetDate: "2026-11-08",
      notes: current!.notes, srsRequirementIds: current!.srsRequirementIds, includeInReport: current!.includeInReport, reminderLeadDays: 10,
    }, context());
    assert.equal(moved.state, "success");
    const [audit] = await q(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE action = 'client_strategy_updated' AND entity_id = 'due-nzi'`);
    assert.deepEqual([audit!.before_json.reminderLeadDays, audit!.after_json.reminderLeadDays, audit!.after_json.targetDate], [null, 10, "2026-11-08"]);

    const result = await tick();
    assert.ok(result.dueReminders.ok && result.dueReminders.summary.enqueued === 1);
    assert.deepEqual(await markers("due-nzi"), [{ due_date: "2026-11-06" }, { due_date: "2026-11-08" }], "one reminder per date — the first kept as the record");
  });

  it("a blocked reminder is surfaced to staff, not burned: once the owner is put right, it goes", async () => {
    const before = await withTenantRead(database.pool, ORG, (db) => listStrategyReminderStatuses(db, { clientId: CLIENT, today: TODAY }));
    assert.deepEqual(before.statuses["no-owner"], { state: "due", dueDate: "2026-11-06", leadDays: 7, blocked: "no-owner" });
    assert.deepEqual(before.statuses["no-consent"], { state: "due", dueDate: "2026-11-06", leadDays: 7, blocked: "no-consent" });
    assert.equal(before.statuses["due-client"]!.state, "sent");
    assert.deepEqual(before.statuses["far"], { state: "scheduled", dueDate: "2026-11-25", remindOn: "2026-11-18", leadDays: 7, blocked: null });
    assert.deepEqual(before.statuses["state-on_hold"], { state: "none", why: "not-live" });

    await q(`UPDATE nzi_console.client_strategies SET owner_contact_id = 'c-nzi' WHERE client_strategy_id = 'no-owner'`);
    const result = await tick();
    assert.ok(result.dueReminders.ok && result.dueReminders.summary.enqueued === 1 && result.dueReminders.summary.blocked["no-owner"] === 0);
    assert.deepEqual(await markers("no-owner"), [{ due_date: "2026-11-06" }]);
  });

  it("the scan and the send are separate transactions: a failing scan writes nothing and the drain still sends", async () => {
    await addAction("late-add", { owner: "c-nzi" });
    await q(`REVOKE INSERT ON nzi_console.strategy_due_reminders FROM nzi_console_worker`);
    try {
      const fetchImpl = resend();
      const result = await tick(fetchImpl);
      assert.equal(result.dueReminders.ok, false);
      assert.match(!result.dueReminders.ok ? result.dueReminders.error : "", /permission denied for table strategy_due_reminders/);
      assert.ok(result.emails.ok, "the email drain is not touched by the scan");
      assert.equal(fetchImpl.posted.length, 1, "the reminder the last tick queued still went");
      assert.equal((await q(`SELECT 1 FROM nzi_console.email_messages WHERE status = 'queued'`)).length, 0, "the failed scan's email rolled back with it — no send owned by nothing");
      assert.deepEqual(await markers("late-add"), []);
    } finally {
      await q(`GRANT INSERT ON nzi_console.strategy_due_reminders TO nzi_console_worker`);
    }
  });

  it("refuses outright without the console's address — a reminder that cannot link to the portal is not sent", async () => {
    const result = await tick(resend(), { origin: undefined });
    assert.equal(result.dueReminders.ok, false);
    assert.match(!result.dueReminders.ok ? result.dueReminders.error : "", /NZI_ISOLATED_API_URL/);
    assert.deepEqual(await markers("late-add"), []);
  });

  it("off means off: with the switch off, a newly owed reminder is not sent", async () => {
    await settings(false);
    const result = await tick();
    assert.ok(result.dueReminders.ok && result.dueReminders.summary.enabled === false && result.dueReminders.summary.enqueued === 0);
    assert.deepEqual(await markers("late-add"), []);
    const statuses = await withTenantRead(database.pool, ORG, (db) => listStrategyReminderStatuses(db, { clientId: CLIENT, today: TODAY }));
    assert.deepEqual(statuses.statuses["late-add"], { state: "off" });
    assert.equal(statuses.statuses["due-client"]!.state, "sent", "what was sent stays on the record");
  });
});
