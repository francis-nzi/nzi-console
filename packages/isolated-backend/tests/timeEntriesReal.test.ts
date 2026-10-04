import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { figuresIn } from "./support/payloadScan";
import { createJob, CommandValidationError } from "../src/postgresCommands";
import { withTenantRead, withTenantWrite } from "../src/postgres";
import { createReferenceValue, listReferenceValuesPage, updateReferenceValue } from "../src/referenceEngine";
import { setStaffRate } from "../src/staffAdmin";
import {
  billTimeEntry, editTimeEntry, logTimeEntry, readJobTimeSummary, readLoggableJobs, readMyTimeEntries, readTimeActivities, voidTimeEntry,
} from "../src/timeEntries";
import { defaultListQuery, referenceValueListSpec } from "@nzi/contracts";

/**
 * Time, PR A (0155 + matrix v9) against a real database: the activity seed and its billable defaults (Addendum), the
 * time_entries shapes, own-time-only logging against reachable jobs (T-Q3/T-Q7), the rate snapshot as of the work date
 * (T-Q1) — and that no rate or fee ever reaches an audit, idempotency or outbox payload (NZC-120) — the billed lock
 * (T-Q6), the activity default through the Lookups commands, and the job budget/fee defaulting from its template (⚑5).
 */
type Issue = { field: string; code: string; message: string };
const issue = (field: string, code?: string) => (error: unknown) =>
  error instanceof CommandValidationError && error.issues.some((item: Issue) => item.field === field && (code === undefined || item.code === code));

// Rates chosen so no minutes figure in a payload can equal one by chance.
const JAN = { cost: 41.5, sell: 97.25 };
const JUL = { cost: 46.75, sell: 103.5 };
const FEE = 1234.5;
const MONEY = [JAN.cost, JAN.sell, JUL.cost, JUL.sell, FEE, 2469];

describe("Time entries, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "tm-org-a";
  const OTHER = "tm-org-b";
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actor = "ada", role: StaffRole = "admin", org = ORG): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: `tm-${keys}`, correlationId: `corr-tm-${keys}`, grant: commandGrantForRole(role, org, actor) };
  };
  const holder = (actor: string, role: StaffRole, org = ORG) => ({ organisationId: org, userId: actor, capabilities: commandGrantForRole(role, org, actor).capabilities });
  const admin = async <T>(work: (db: import("pg").Client) => Promise<T>) => { const db = await database.admin(); try { return await work(db); } finally { await db.end(); } };
  const q = (sql: string, params: unknown[] = []) => admin(async (db) => (await db.query(sql, params)).rows);
  const entry = async (entryId: string) => (await q(`SELECT * FROM nzi_console.time_entries WHERE organisation_id = $1 AND entry_id = $2`, [ORG, entryId]))[0];
  /** The three places a command's `data` is written: the audit's after_json, the idempotency outcome and the outbox event. */
  const payloadsOf = async (auditEventId: string) => {
    const [audit] = await q(`SELECT after_json, before_json, correlation_id FROM nzi_console.audit_events WHERE audit_event_id = $1`, [auditEventId]);
    const idempotency = await q(`SELECT outcome_json FROM nzi_console.command_idempotency WHERE organisation_id = $1 AND outcome_json->>'auditEventId' = $2`, [ORG, auditEventId]);
    const outbox = await q(`SELECT payload_json FROM nzi_console.transactional_outbox WHERE organisation_id = $1 AND correlation_id = $2`, [ORG, audit.correlation_id]);
    assert.deepEqual([idempotency.length, outbox.length], [1, 1], "the idempotency record and the outbox event were both found");
    return { audit: audit.after_json, before: audit.before_json, idempotency: idempotency[0].outcome_json.data, outbox: outbox[0].payload_json };
  };
  const assertNoMoney = async (auditEventId: string) => {
    const payloads = await payloadsOf(auditEventId);
    for (const [where, value] of Object.entries(payloads)) assert.deepEqual(figuresIn(value, MONEY), [], `money reached the ${where}`);
    return payloads;
  };
  const activity = (slug: string) => `activity_types:${slug}`;

  before(async () => {
    database = (await createDisposableDatabase("timeentries"))!;
    for (const org of [ORG, OTHER]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await q(`SELECT nzi_console.provision_organisation($1)`, [org]);
    }
    for (const [user, role] of [["ada", "admin"], ["cal", "consultant"], ["dee", "consultant"], ["fin", "finance"], ["vic", "viewer"], ["rev", "reviewer"]] as const) {
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $4)`, [ORG, user, role, `${user} name`]);
    }
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ($1, 'oz', 'admin', 'active')`, [OTHER]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, owner_user_id) VALUES
      ($1, 'c-cal', 'Cal''s client', 'active', 'cal'), ($1, 'c-dee', 'Dee''s client', 'active', 'dee')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, owner_user_id) VALUES ($1, 'c-oz', 'Other', 'active', 'oz')`, [OTHER]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage) VALUES
      ($1, 'j-cal', 'c-cal', 9101, 'consultancy', 'Cal job', 'open', 'Scope'),
      ($1, 'j-dee', 'c-dee', 9102, 'consultancy', 'Dee job', 'open', 'Scope'),
      ($1, 'j-gone', 'c-cal', 9103, 'consultancy', 'Cancelled job', 'cancelled', 'Scope')`, [ORG]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage) VALUES ($1, 'j-oz', 'c-oz', 9104, 'crp', 'Oz job', 'open', 'Setup')`, [OTHER]);
    // Cal's rates: January, then July. Dee has none.
    await setStaffRate(database.pool, { userId: "cal", effectiveFrom: "2026-01-01", costPerHour: JAN.cost, sellPerHour: JAN.sell }, context("fin", "finance"));
    await setStaffRate(database.pool, { userId: "cal", effectiveFrom: "2026-07-01", costPerHour: JUL.cost, sellPerHour: JUL.sell }, context("fin", "finance"));
  });
  after(async () => { await database?.end(); });

  describe("0155", () => {
    it("seeds the six activities for every organisation, Travel and Admin non-billable (⚑3) — and a new organisation gets them too", async () => {
      const seeded = async (org: string) => (await q(
        `SELECT v.label, d.billable_default FROM nzi_console.reference_values v
           JOIN nzi_console.time_activity_defaults d ON (d.organisation_id, d.value_id) = (v.organisation_id, v.value_id)
          WHERE v.organisation_id = $1 AND v.category_key = 'activity_types' ORDER BY v.sort_order`, [org])).map((row) => [row.label, row.billable_default]);
      const expected = [["Fieldwork", true], ["Analysis", true], ["Reporting", true], ["Meeting", true], ["Travel", false], ["Admin", false]];
      assert.deepEqual(await seeded(ORG), expected);
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ('tm-org-new', 'new')`);
      assert.deepEqual(await seeded("tm-org-new"), expected);
    });

    it("holds the entry shapes: whole minutes 1–1440, a known activity, and no DELETE for the application", async () => {
      const raw = (minutes: number) => q(`INSERT INTO nzi_console.time_entries (organisation_id, entry_id, user_id, job_id, work_date, minutes, activity_value_id, billable, created_by, updated_by)
        VALUES ($1, gen_random_uuid()::text, 'cal', 'j-cal', '2026-03-02', $2, $3, true, 'x', 'x')`, [ORG, minutes, activity("fieldwork")]);
      await assert.rejects(raw(0), /time_entries_minutes_check/);
      await assert.rejects(raw(1441), /time_entries_minutes_check/);
      await assert.rejects(q(`INSERT INTO nzi_console.time_entries (organisation_id, entry_id, user_id, job_id, work_date, minutes, activity_value_id, billable, created_by, updated_by)
        VALUES ($1, 'bad', 'cal', 'j-cal', '2026-03-02', 60, 'industries:nope', true, 'x', 'x')`, [ORG]), /foreign key/);
      await assert.rejects(q(`INSERT INTO nzi_console.time_entries (organisation_id, entry_id, user_id, job_id, work_date, minutes, activity_value_id, billable, rate_id, created_by, updated_by)
        VALUES ($1, 'bad2', 'cal', 'j-cal', '2026-03-02', 60, $2, true, 'r', 'x', 'x')`, [ORG, activity("fieldwork")]), /time_entries_rate_source/);
      await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`DELETE FROM nzi_console.time_entries`)), /permission denied/);
      await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`DELETE FROM nzi_console.time_activity_defaults`)), /permission denied/);
    });

    it("gives every membership 37.5 hours of weekly capacity (T-Q4)", async () => {
      const rows = await q(`SELECT DISTINCT weekly_capacity_hours::float8 AS hours FROM nzi_console.memberships WHERE organisation_id = $1`, [ORG]);
      assert.deepEqual(rows.map((row) => row.hours), [37.5]);
    });
  });

  describe("logging", () => {
    let calEntry = "";

    it("logs one's own time with the activity's billable default, and the rate in force on the work date — no rate in any payload", async () => {
      const logged = await logTimeEntry(database.pool, { jobId: "j-cal", workDate: "2026-03-10", minutes: 90, activityValueId: activity("fieldwork"), note: " Site visit " }, context("cal", "consultant"));
      calEntry = logged.data.entryId;
      const row = await entry(calEntry);
      assert.deepEqual([row.user_id, row.minutes, row.billable, row.note, Number(row.cost_rate), Number(row.charge_rate), row.rate_currency],
        ["cal", 90, true, "Site visit", JAN.cost, JAN.sell, "GBP"]);
      const payloads = await assertNoMoney(logged.auditEventId);
      assert.deepEqual(payloads.audit, { entryId: calEntry, version: 1, userId: "cal", jobId: "j-cal", workDate: "2026-03-10", minutes: 90, billable: true, rateRecorded: true });
    });

    it("takes Travel as non-billable by default, and an explicit choice over the default", async () => {
      const travel = await logTimeEntry(database.pool, { jobId: "j-cal", workDate: "2026-03-10", minutes: 45, activityValueId: activity("travel") }, context("cal", "consultant"));
      assert.equal((await entry(travel.data.entryId)).billable, false);
      const overridden = await logTimeEntry(database.pool, { jobId: "j-cal", workDate: "2026-03-10", minutes: 30, activityValueId: activity("travel"), billable: true }, context("cal", "consultant"));
      assert.equal((await entry(overridden.data.entryId)).billable, true);
      // ⚑2: three entries on one day for one person and job.
      assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.time_entries WHERE organisation_id = $1 AND user_id = 'cal' AND work_date = '2026-03-10'`, [ORG]))[0].n, 3);
    });

    it("records 'rate not recorded' as null when no rate was in force — never zero", async () => {
      const early = await logTimeEntry(database.pool, { jobId: "j-cal", workDate: "2025-12-31", minutes: 60, activityValueId: activity("analysis") }, context("cal", "consultant"));
      const row = await entry(early.data.entryId);
      assert.deepEqual([row.rate_id, row.cost_rate, row.charge_rate, row.rate_currency, early.data.rateRecorded], [null, null, null, null, false]);
    });

    it("refuses bad input: no minutes, over 24 hours, an unknown activity, a cancelled job", async () => {
      await assert.rejects(logTimeEntry(database.pool, { jobId: "j-cal", workDate: "2026-03-10", minutes: 0, activityValueId: activity("fieldwork") }, context("cal", "consultant")), issue("minutes"));
      await assert.rejects(logTimeEntry(database.pool, { jobId: "j-cal", workDate: "2026-03-10", minutes: 1441, activityValueId: activity("fieldwork") }, context("cal", "consultant")), issue("minutes"));
      await assert.rejects(logTimeEntry(database.pool, { jobId: "j-cal", workDate: "2026-02-30", minutes: 60, activityValueId: activity("fieldwork") }, context("cal", "consultant")), issue("workDate"));
      await assert.rejects(logTimeEntry(database.pool, { jobId: "j-cal", workDate: "2026-03-10", minutes: 60, activityValueId: "industries:x" }, context("cal", "consultant")), issue("activityValueId", "NOT_FOUND"));
      await assert.rejects(logTimeEntry(database.pool, { jobId: "j-gone", workDate: "2026-03-10", minutes: 60, activityValueId: activity("fieldwork") }, context("cal", "consultant")), issue("jobId", "CANCELLED"));
    });

    it("keeps a consultant to their own clients' jobs (T-Q7); a viewer logs on any job (T-Q3); another organisation's job is refused", async () => {
      await assert.rejects(logTimeEntry(database.pool, { jobId: "j-dee", workDate: "2026-03-11", minutes: 60, activityValueId: activity("meeting") }, context("cal", "consultant")), /own clients/);
      const viewer = await logTimeEntry(database.pool, { jobId: "j-dee", workDate: "2026-03-11", minutes: 60, activityValueId: activity("meeting") }, context("vic", "viewer"));
      assert.equal((await entry(viewer.data.entryId)).user_id, "vic");
      await assert.rejects(logTimeEntry(database.pool, { jobId: "j-oz", workDate: "2026-03-11", minutes: 60, activityValueId: activity("meeting") }, context("ada")), /not in your organisation/);
    });

    it("edits only one's own entry; a changed day re-snapshots the rate as of the new day, an unchanged day keeps its snapshot", async () => {
      const current = await entry(calEntry);
      await assert.rejects(editTimeEntry(database.pool, { entryId: calEntry, expectedVersion: current.version, jobId: "j-cal", workDate: "2026-03-10", minutes: 60, activityValueId: activity("fieldwork"), billable: true }, context("ada")), /only your own time/);
      const same = await editTimeEntry(database.pool, { entryId: calEntry, expectedVersion: current.version, jobId: "j-cal", workDate: "2026-03-10", minutes: 120, activityValueId: activity("reporting"), billable: false, note: null }, context("cal", "consultant"));
      assert.equal(same.data.rateResnapshotted, false);
      assert.equal(Number((await entry(calEntry)).cost_rate), JAN.cost);
      const moved = await editTimeEntry(database.pool, { entryId: calEntry, expectedVersion: same.data.version, jobId: "j-cal", workDate: "2026-08-03", minutes: 120, activityValueId: activity("reporting"), billable: false }, context("cal", "consultant"));
      assert.equal(moved.data.rateResnapshotted, true);
      const row = await entry(calEntry);
      assert.deepEqual([row.minutes, row.billable, row.note, Number(row.cost_rate), Number(row.charge_rate)], [120, false, null, JUL.cost, JUL.sell]);
      const payloads = await assertNoMoney(moved.auditEventId);
      assert.deepEqual(payloads.before, { jobId: "j-cal", workDate: "2026-03-10", minutes: 120, activityValueId: activity("reporting"), billable: false });
      // Moving it to a job the consultant cannot reach is refused.
      await assert.rejects(editTimeEntry(database.pool, { entryId: calEntry, expectedVersion: moved.data.version, jobId: "j-dee", workDate: "2026-08-03", minutes: 120, activityValueId: activity("reporting"), billable: false }, context("cal", "consultant")), /own clients/);
      await assert.rejects(editTimeEntry(database.pool, { entryId: calEntry, expectedVersion: 1, jobId: "j-cal", workDate: "2026-08-03", minutes: 30, activityValueId: activity("reporting"), billable: false }, context("cal", "consultant")), /version/i);
    });

    it("locks a billed entry (T-Q6): no edit or void until finance unbills; billing is finance.manage", async () => {
      let row = await entry(calEntry);
      await assert.rejects(billTimeEntry(database.pool, { entryId: calEntry, expectedVersion: row.version, billedRef: "INV-1" }, context("cal", "consultant")), /finance\.manage|permission/i);
      const billed = await billTimeEntry(database.pool, { entryId: calEntry, expectedVersion: row.version, billedRef: " INV-1001 " }, context("fin", "finance"));
      row = await entry(calEntry);
      assert.deepEqual([row.billed_ref, row.billed_by], ["INV-1001", "fin"]);
      await assertNoMoney(billed.auditEventId);
      await assert.rejects(editTimeEntry(database.pool, { entryId: calEntry, expectedVersion: row.version, jobId: "j-cal", workDate: "2026-08-03", minutes: 30, activityValueId: activity("reporting"), billable: false }, context("cal", "consultant")), issue("entryId", "LOCKED"));
      await assert.rejects(voidTimeEntry(database.pool, { entryId: calEntry, expectedVersion: row.version }, context("cal", "consultant")), issue("entryId", "LOCKED"));
      await assert.rejects(billTimeEntry(database.pool, { entryId: calEntry, expectedVersion: row.version, billedRef: "INV-2" }, context("fin", "finance")), issue("billedRef", "ALREADY_BILLED"));
      const unbilled = await billTimeEntry(database.pool, { entryId: calEntry, expectedVersion: row.version, billedRef: null }, context("fin", "finance"));
      assert.equal(unbilled.data.billed, false);
      const voided = await voidTimeEntry(database.pool, { entryId: calEntry, expectedVersion: unbilled.data.version }, context("cal", "consultant"));
      row = await entry(calEntry);
      assert.deepEqual([row.active, row.voided_by], [false, "cal"]);
      await assertNoMoney(voided.auditEventId);
      await assert.rejects(voidTimeEntry(database.pool, { entryId: calEntry, expectedVersion: row.version }, context("cal", "consultant")), issue("entryId", "VOIDED"));
    });
  });

  describe("reads", () => {
    it("My time lists one's own active entries in a range, newest first — hours and labels, no rate", async () => {
      const mine = await withTenantRead(database.pool, ORG, (db) => readMyTimeEntries(db, holder("cal", "consultant"), { from: "2026-03-01", to: "2026-03-31" }));
      // The 90-minute entry moved to August and was voided; the two Travel entries remain.
      assert.deepEqual(mine.map((e) => [e.workDate, e.minutes, e.activityLabel, e.billable]).sort(), [["2026-03-10", 30, "Travel", true], ["2026-03-10", 45, "Travel", false]]);
      assert.ok(mine.every((e) => e.userId === "cal" && e.active));
      for (const e of mine) assert.deepEqual(figuresIn(e, MONEY), []);
      const withVoided = await withTenantRead(database.pool, ORG, (db) => readMyTimeEntries(db, holder("cal", "consultant"), { from: "2026-01-01", to: "2026-12-31", includeVoided: true }));
      assert.ok(withVoided.some((e) => !e.active));
    });

    it("offers a consultant only their own clients' open jobs, and the activities with their defaults", async () => {
      const jobs = await withTenantRead(database.pool, ORG, (db) => readLoggableJobs(db, holder("cal", "consultant")));
      assert.deepEqual(jobs.map((j) => j.jobId), ["j-cal"]);
      const all = await withTenantRead(database.pool, ORG, (db) => readLoggableJobs(db, holder("ada", "admin")));
      assert.deepEqual(new Set(all.map((j) => j.jobId)), new Set(["j-cal", "j-dee"]));
      const activities = await withTenantRead(database.pool, ORG, (db) => readTimeActivities(db, holder("vic", "viewer")));
      assert.deepEqual(activities.find((a) => a.label === "Admin")?.billableDefault, false);
    });

    it("Job → Time: everyone's hours with time.view; only one's own without it", async () => {
      await logTimeEntry(database.pool, { jobId: "j-dee", workDate: "2026-03-12", minutes: 75, activityValueId: activity("analysis") }, context("dee", "consultant"));
      const full = await withTenantRead(database.pool, ORG, (db) => readJobTimeSummary(db, holder("ada", "admin"), "j-dee"));
      assert.equal(full.othersVisible, true);
      assert.deepEqual(new Set(full.people.map((p) => p.userId)), new Set(["vic", "dee"]));
      assert.deepEqual(full.totals, { minutes: 135, billableMinutes: 135 });
      const own = await withTenantRead(database.pool, ORG, (db) => readJobTimeSummary(db, holder("vic", "viewer"), "j-dee"));
      assert.deepEqual([own.othersVisible, own.people.map((p) => p.userId)], [false, ["vic"]]);
      await assert.rejects(withTenantRead(database.pool, ORG, (db) => readJobTimeSummary(db, holder("cal", "consultant"), "j-dee")), /own clients/);
    });
  });

  describe("the activity default through Admin → Lookups", () => {
    it("requires a default when an activity is added, writes it with the value, and audits it", async () => {
      await assert.rejects(createReferenceValue(database.pool, { categoryKey: "activity_types", label: "Training" }, context()), issue("billableDefault", "REQUIRED"));
      await assert.rejects(createReferenceValue(database.pool, { categoryKey: "industries", label: "Mining", billableDefault: true }, context()), issue("billableDefault", "NOT_APPLICABLE"));
      const added = await createReferenceValue(database.pool, { categoryKey: "activity_types", label: "Training", billableDefault: false }, context());
      const [stored] = await q(`SELECT billable_default FROM nzi_console.time_activity_defaults WHERE organisation_id = $1 AND value_id = $2`, [ORG, added.data.valueId]);
      assert.equal(stored.billable_default, false);
      assert.equal((await payloadsOf(added.auditEventId)).audit.billableDefault, false);
      const page = await withTenantRead(database.pool, ORG, (db) => listReferenceValuesPage(db, { ...defaultListQuery(referenceValueListSpec), filters: { category: ["activity_types"] } }));
      assert.equal(page.rows.find((row) => row.valueId === added.data.valueId)?.billableDefault, false);
      // "In use" counts the time entries logged as each activity, voided ones included (they still resolve it).
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM nzi_console.time_entries WHERE organisation_id = $1 AND activity_value_id = $2`, [ORG, activity("travel")]);
      assert.ok(n > 0);
      assert.equal(page.rows.find((row) => row.valueId === activity("travel"))?.inUse, n);
      // The toggle: changed with an edit, before and after in the audit; omitted, the held default stays.
      const flipped = await updateReferenceValue(database.pool, { categoryKey: "activity_types", valueId: added.data.valueId, label: "Training", sortOrder: 70, expectedVersion: 1, billableDefault: true }, context());
      const payloads = await payloadsOf(flipped.auditEventId);
      assert.deepEqual([payloads.before.billableDefault, payloads.audit.billableDefault], [false, true]);
      await updateReferenceValue(database.pool, { categoryKey: "activity_types", valueId: added.data.valueId, label: "Training course", sortOrder: 70, expectedVersion: 2 }, context());
      assert.equal((await q(`SELECT billable_default FROM nzi_console.time_activity_defaults WHERE organisation_id = $1 AND value_id = $2`, [ORG, added.data.valueId]))[0].billable_default, true);
      // Time logged as it takes the new default.
      const logged = await logTimeEntry(database.pool, { jobId: "j-cal", workDate: "2026-04-01", minutes: 60, activityValueId: added.data.valueId }, context("cal", "consultant"));
      assert.equal(logged.data.billable, true);
    });
  });

  describe("the job's budget and fee (⚑5)", () => {
    it("defaults from the job type's included template items on creation — the fee never in the payload", async () => {
      await q(`INSERT INTO nzi_console.job_types (organisation_id, job_type_id, name, family, created_by, updated_by) VALUES ($1, 'jt-t', 'Timed', 'consultancy', 's', 's')`, [ORG]);
      await q(`INSERT INTO nzi_console.job_items (organisation_id, item_id, item_code, name, currency_code, default_hours, default_sell_amount, created_by, updated_by) VALUES
        ($1, 'ji-a', 'A', 'Assess', 'GBP', 6, $2, 's', 's'), ($1, 'ji-b', 'B', 'Extra', 'GBP', 4, 500, 's', 's')`, [ORG, FEE]);
      await q(`INSERT INTO nzi_console.job_type_items (organisation_id, job_type_id, item_id, quantity, included, created_by, updated_by) VALUES
        ($1, 'jt-t', 'ji-a', 2, true, 's', 's'), ($1, 'jt-t', 'ji-b', 1, false, 's', 's')`, [ORG]);
      const created = await createJob(database.pool, { clientId: "c-cal", family: "consultancy", title: "Budgeted", workflowStage: "Scope", owner: "Ada", startDate: "2026-04-01", dueDate: "2026-06-30", jobTypeId: "jt-t" }, context());
      const [job] = await q(`SELECT budgeted_hours::float8 AS hours, fee_amount::float8 AS fee FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [ORG, created.data.jobId]);
      assert.deepEqual([job.hours, job.fee], [12, FEE * 2]);
      await assertNoMoney(created.auditEventId);
      const summary = await withTenantRead(database.pool, ORG, (db) => readJobTimeSummary(db, holder("ada", "admin"), created.data.jobId));
      assert.deepEqual([summary.budgetedMinutes, summary.totals.minutes], [720, 0]);
    });
  });
});
