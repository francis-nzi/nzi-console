import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { figuresIn } from "./support/payloadScan";
import { CommandValidationError } from "../src/postgresCommands";
import { withTenantRead } from "../src/postgres";
import { setStaffRate } from "../src/staffAdmin";
import { logTimeEntry, readJobTimeSummary, setJobBudget, setJobFee, setStaffCapacity, voidTimeEntry } from "../src/timeEntries";
import { readTimeOversight, readTimePayroll, readTimeUtilisation } from "../src/timeReads";

/**
 * Time PR B (0157, matrix v10) against a real database: Oversight (budget used, cost vs fee), Payroll and Utilisation
 * over a period; money only for finance.view, null (never zero) otherwise; the team-wide reads refused to an own-clients
 * holder; voided time never counted; the capacity, budget and fee editors — and no money in any of their payloads.
 */
type Issue = { field: string; code: string; message: string };
const issue = (field: string, code?: string) => (error: unknown) =>
  error instanceof CommandValidationError && error.issues.some((item: Issue) => item.field === field && (code === undefined || item.code === code));

// Rates and fees chosen so no minutes figure in a payload can equal one by chance.
const CAL = { cost: 41.5, sell: 97.25 };
const DEE = { cost: 52.25, sell: 110.75 };
const FEE = { cal: 1111.11, dee: 101.25, edited: 1234.56 };
const MONEY = [CAL.cost, CAL.sell, DEE.cost, DEE.sell, FEE.cal, FEE.dee, FEE.edited];
const SEPT = { from: "2026-09-01", to: "2026-09-30" };

describe("Time reads (PR B), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "tr-org-a";
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actor = "ada", role: StaffRole = "admin"): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `tr-${keys}`, correlationId: `corr-tr-${keys}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const holder = (actor: string, role: StaffRole) => ({ organisationId: ORG, userId: actor, capabilities: commandGrantForRole(role, ORG, actor).capabilities });
  const admin = async <T>(work: (db: import("pg").Client) => Promise<T>) => { const db = await database.admin(); try { return await work(db); } finally { await db.end(); } };
  const q = (sql: string, params: unknown[] = []) => admin(async (db) => (await db.query(sql, params)).rows);
  const read = <T>(work: (db: import("../src/postgres").Queryable) => Promise<T>) => withTenantRead(database.pool, ORG, work);
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
  const version = async (table: "jobs" | "memberships", column: string, id: string) =>
    (await q(`SELECT version FROM nzi_console.${table} WHERE organisation_id = $1 AND ${column} = $2`, [ORG, id]))[0].version as number;
  const log = (actor: string, role: StaffRole, jobId: string, workDate: string, minutes: number, activity = "fieldwork") =>
    logTimeEntry(database.pool, { jobId, workDate, minutes, activityValueId: `activity_types:${activity}` }, context(actor, role));

  before(async () => {
    database = (await createDisposableDatabase("timereads"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    for (const [user, role] of [["ada", "admin"], ["cal", "consultant"], ["dee", "consultant"], ["fin", "finance"], ["rev", "reviewer"], ["vic", "viewer"]] as const) {
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $4)`, [ORG, user, role, `${user} name`]);
    }
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, owner_user_id) VALUES
      ($1, 'c-cal', 'Cal''s client', 'active', 'cal'), ($1, 'c-dee', 'Dee''s client', 'active', 'dee')`, [ORG]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, owner_name, budgeted_hours, fee_amount) VALUES
      ($1, 'j-cal', 'c-cal', 9201, 'consultancy', 'Cal job', 'open', 'Scope', 'Cal', 10, $2),
      ($1, 'j-dee', 'c-dee', 9202, 'consultancy', 'Dee job', 'open', 'Scope', 'Dee', 2, $3),
      ($1, 'j-free', 'c-dee', 9203, 'consultancy', 'Unbudgeted', 'open', 'Scope', 'Dee', NULL, NULL)`, [ORG, FEE.cal, FEE.dee]);
    await setStaffRate(database.pool, { userId: "cal", effectiveFrom: "2026-01-01", costPerHour: CAL.cost, sellPerHour: CAL.sell }, context("fin", "finance"));
    await setStaffRate(database.pool, { userId: "dee", effectiveFrom: "2026-01-01", costPerHour: DEE.cost, sellPerHour: DEE.sell }, context("fin", "finance"));
    // September: cal 6 h on j-cal (3 h more in August, before the period); dee 3 h on j-dee (budget 2 h) and 1 h on j-free;
    // vic 30 min on j-cal with no rate; vic's voided hour never counts.
    await log("cal", "consultant", "j-cal", "2026-08-14", 180);
    await log("cal", "consultant", "j-cal", "2026-09-01", 360);
    await log("dee", "consultant", "j-dee", "2026-09-02", 180);
    await log("dee", "consultant", "j-free", "2026-09-03", 60, "travel");
    await log("vic", "viewer", "j-cal", "2026-09-03", 30, "meeting");
    const voided = await log("vic", "viewer", "j-cal", "2026-09-04", 60);
    await voidTimeEntry(database.pool, { entryId: voided.data.entryId, expectedVersion: 1 }, context("vic", "viewer"));
  });
  after(async () => { await database?.end(); });

  describe("Oversight", () => {
    it("lists the period's jobs, over budget first — budget used is to date as at the period's end; voided time never counts", async () => {
      const view = await read((db) => readTimeOversight(db, holder("ada", "admin"), SEPT));
      assert.deepEqual(view.jobs.map((job) => [job.jobId, job.loggedMinutes, job.periodMinutes, job.budgetUsedPct, job.budgetStatus]), [
        ["j-dee", 180, 180, 150, "over"],
        ["j-cal", 570, 390, 95, "approaching"],
        ["j-free", 60, 60, null, "no-budget"],
      ]);
      assert.deepEqual(view.totals, { periodMinutes: 630, billableMinutes: 570, overBudget: 1, approaching: 1, overCost: 1 });
      assert.equal(view.allClients, true);
    });

    it("costs each job from its snapshotted rates, against its fee — and says how much time had no rate", async () => {
      const view = await read((db) => readTimeOversight(db, holder("fin", "finance"), SEPT));
      const byId = new Map(view.jobs.map((job) => [job.jobId, job.money]));
      assert.deepEqual(byId.get("j-cal"), { currency: "GBP", mixedCurrency: false, cost: 9 * CAL.cost, charge: 9 * CAL.sell, unratedMinutes: 30, fee: FEE.cal, margin: Math.round((FEE.cal - 9 * CAL.cost) * 100) / 100, overCost: false });
      assert.deepEqual(byId.get("j-dee"), { currency: "GBP", mixedCurrency: false, cost: 3 * DEE.cost, charge: 3 * DEE.sell, unratedMinutes: 0, fee: FEE.dee, margin: Math.round((FEE.dee - 3 * DEE.cost) * 100) / 100, overCost: true });
      assert.equal(byId.get("j-free")!.fee, null);
      assert.equal(byId.get("j-free")!.overCost, null, "no fee, so neither over nor under");
    });

    it("shows hours without money to a reader without finance.view, and only their own clients' jobs to an own-clients one", async () => {
      const reviewer = await read((db) => readTimeOversight(db, holder("rev", "reviewer"), SEPT));
      assert.ok(reviewer.jobs.every((job) => job.money === null), "hours only");
      assert.equal(reviewer.totals.overCost, null, "no cost figure, not zero");
      const consultant = await read((db) => readTimeOversight(db, holder("cal", "consultant"), SEPT));
      assert.deepEqual([consultant.allClients, consultant.jobs.map((job) => job.jobId)], [false, ["j-cal"]]);
      assert.ok(consultant.jobs[0]!.money, "a consultant holds finance.view, so sees their own job's cost");
      await assert.rejects(read((db) => readTimeOversight(db, holder("vic", "viewer"), SEPT)), /time\.view/);
    });
  });

  describe("Payroll", () => {
    it("gives every active person's hours over the period — split billable or not — and their cost to finance", async () => {
      const payroll = await read((db) => readTimePayroll(db, holder("fin", "finance"), SEPT));
      assert.equal(payroll.moneyVisible, true);
      const byId = new Map(payroll.people.map((person) => [person.userId, person]));
      assert.deepEqual(new Set(byId.keys()), new Set(["ada", "cal", "dee", "fin", "rev", "vic"]), "everyone active, worked or not");
      assert.deepEqual([byId.get("cal")!.totalMinutes, byId.get("cal")!.billableMinutes, byId.get("cal")!.money!.cost], [360, 360, 6 * CAL.cost], "August's hours are outside the period");
      assert.deepEqual([byId.get("dee")!.totalMinutes, byId.get("dee")!.nonBillableMinutes, byId.get("dee")!.money!.cost], [240, 60, 4 * DEE.cost]);
      assert.deepEqual([byId.get("vic")!.totalMinutes, byId.get("vic")!.entries, byId.get("vic")!.money!.cost, byId.get("vic")!.money!.unratedMinutes], [30, 1, 0, 30], "the voided hour is gone; the unrated half-hour is said");
      assert.equal(byId.get("ada")!.totalMinutes, 0);
    });

    it("gives hours without cost to a reviewer, and refuses an own-clients holder and a viewer", async () => {
      const payroll = await read((db) => readTimePayroll(db, holder("rev", "reviewer"), SEPT));
      assert.equal(payroll.moneyVisible, false);
      assert.ok(payroll.people.every((person) => person.money === null));
      await assert.rejects(read((db) => readTimePayroll(db, holder("cal", "consultant"), SEPT)), /across all clients/);
      await assert.rejects(read((db) => readTimePayroll(db, holder("vic", "viewer"), SEPT)), /time\.view/);
    });
  });

  describe("Utilisation and capacity", () => {
    it("reads logged hours against weekly capacity over the period's weekdays (⚑8: capacity, never budget)", async () => {
      const view = await read((db) => readTimeUtilisation(db, holder("ada", "admin"), SEPT));
      assert.equal(view.weekdays, 22, "September 2026 has 22 weekdays");
      const cal = view.people.find((person) => person.userId === "cal")!;
      assert.deepEqual([cal.weeklyCapacityHours, cal.capacityMinutes, cal.loggedMinutes, cal.utilisationPct], [37.5, 37.5 / 5 * 22 * 60, 360, Math.round(360 / 9900 * 100)]);
      assert.equal(view.capacityEditable, true);
      assert.equal((await read((db) => readTimeUtilisation(db, holder("rev", "reviewer"), SEPT))).capacityEditable, false);
      await assert.rejects(read((db) => readTimeUtilisation(db, holder("cal", "consultant"), SEPT)), /across all clients/);
    });

    it("sets a person's capacity under admin.users, versioned and audited; the read follows", async () => {
      await assert.rejects(setStaffCapacity(database.pool, { userId: "cal", expectedVersion: await version("memberships", "user_id", "cal"), weeklyCapacityHours: 30 }, context("rev", "reviewer")), /admin\.users|permission/i);
      for (const bad of [0, 169, 37.555]) {
        await assert.rejects(setStaffCapacity(database.pool, { userId: "cal", expectedVersion: 1, weeklyCapacityHours: bad }, context()), issue("weeklyCapacityHours"), String(bad));
      }
      const set = await setStaffCapacity(database.pool, { userId: "cal", expectedVersion: await version("memberships", "user_id", "cal"), weeklyCapacityHours: 30 }, context());
      const payloads = await payloadsOf(set.auditEventId);
      assert.deepEqual([payloads.before, payloads.audit.weeklyCapacityHours], [{ weeklyCapacityHours: 37.5 }, 30]);
      const cal = (await read((db) => readTimeUtilisation(db, holder("ada", "admin"), SEPT))).people.find((person) => person.userId === "cal")!;
      assert.deepEqual([cal.capacityMinutes, cal.utilisationPct], [30 / 5 * 22 * 60, Math.round(360 / 7920 * 100)]);
      await assert.rejects(setStaffCapacity(database.pool, { userId: "cal", expectedVersion: set.data.version - 1, weeklyCapacityHours: 20 }, context()), /version/i);
    });
  });

  describe("the job's budget and fee", () => {
    it("sets budgeted hours under job.manage, and clears them with null", async () => {
      // job.manage is Admin and Consultant (all clients, per the matrix); a Reviewer, Finance or Viewer holds none.
      await assert.rejects(setJobBudget(database.pool, { jobId: "j-dee", expectedVersion: await version("jobs", "job_id", "j-dee"), budgetedHours: 5 }, context("rev", "reviewer")), /job\.manage|permission/i);
      await assert.rejects(setJobBudget(database.pool, { jobId: "j-cal", expectedVersion: 1, budgetedHours: -1 }, context("cal", "consultant")), issue("budgetedHours"));
      const set = await setJobBudget(database.pool, { jobId: "j-cal", expectedVersion: await version("jobs", "job_id", "j-cal"), budgetedHours: 20 }, context("cal", "consultant"));
      assert.deepEqual((await payloadsOf(set.auditEventId)).before, { budgetedHours: 10 });
      let job = (await read((db) => readTimeOversight(db, holder("ada", "admin"), SEPT))).jobs.find((row) => row.jobId === "j-cal")!;
      assert.deepEqual([job.budgetUsedPct, job.budgetStatus], [Math.round(570 / 1200 * 100), "on-track"]);
      await setJobBudget(database.pool, { jobId: "j-cal", expectedVersion: set.data.version, budgetedHours: null }, context("cal", "consultant"));
      job = (await read((db) => readTimeOversight(db, holder("ada", "admin"), SEPT))).jobs.find((row) => row.jobId === "j-cal")!;
      assert.deepEqual([job.budgetUsedPct, job.budgetStatus], [null, "no-budget"]);
    });

    it("sets the fee under finance.manage only — and no fee figure reaches the audit, idempotency record or outbox (NZC-120)", async () => {
      await assert.rejects(setJobFee(database.pool, { jobId: "j-cal", expectedVersion: await version("jobs", "job_id", "j-cal"), feeAmount: FEE.edited }, context("cal", "consultant")), /finance\.manage|permission/i);
      await assert.rejects(setJobFee(database.pool, { jobId: "j-cal", expectedVersion: 1, feeAmount: 1.005 }, context("fin", "finance")), issue("feeAmount"));
      const set = await setJobFee(database.pool, { jobId: "j-cal", expectedVersion: await version("jobs", "job_id", "j-cal"), feeAmount: FEE.edited }, context("fin", "finance"));
      assert.equal(Number((await q(`SELECT fee_amount FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = 'j-cal'`, [ORG]))[0].fee_amount), FEE.edited);
      const payloads = await assertNoMoney(set.auditEventId);
      assert.deepEqual([payloads.audit, payloads.before], [{ jobId: "j-cal", version: set.data.version, feeRecorded: true }, { feeRecorded: true }]);
      const cleared = await setJobFee(database.pool, { jobId: "j-cal", expectedVersion: set.data.version, feeAmount: null }, context("fin", "finance"));
      assert.deepEqual((await assertNoMoney(cleared.auditEventId)).audit, { jobId: "j-cal", version: cleared.data.version, feeRecorded: false });
      await setJobFee(database.pool, { jobId: "j-cal", expectedVersion: cleared.data.version, feeAmount: FEE.cal }, context("fin", "finance"));
    });

    it("Job → Time carries the job's money for finance.view, with everyone's time — and says what the reader may edit", async () => {
      const finance = await read((db) => readJobTimeSummary(db, holder("fin", "finance"), "j-cal"));
      assert.deepEqual([finance.money?.cost, finance.money?.fee, finance.money?.unratedMinutes, finance.editable], [9 * CAL.cost, FEE.cal, 30, { budget: false, fee: true }]);
      assert.equal(finance.jobVersion, await version("jobs", "job_id", "j-cal"));
      const consultant = await read((db) => readJobTimeSummary(db, holder("cal", "consultant"), "j-cal"));
      assert.deepEqual([consultant.money !== null, consultant.editable], [true, { budget: true, fee: false }]);
      const reviewer = await read((db) => readJobTimeSummary(db, holder("rev", "reviewer"), "j-cal"));
      assert.deepEqual([reviewer.money, reviewer.editable], [null, { budget: false, fee: false }]);
      // A viewer sees only their own time, so no job cost is shown — their half-hour is not the job's cost.
      const viewer = await read((db) => readJobTimeSummary(db, holder("vic", "viewer"), "j-cal"));
      assert.deepEqual([viewer.othersVisible, viewer.money], [false, null]);
    });

    it("refuses to sum two currencies into one figure", async () => {
      await setStaffRate(database.pool, { userId: "rev", effectiveFrom: "2026-01-01", costPerHour: 60, sellPerHour: 120, currency: "EUR" }, context("fin", "finance"));
      await log("rev", "reviewer", "j-dee", "2026-09-10", 60);
      const job = (await read((db) => readTimeOversight(db, holder("fin", "finance"), SEPT))).jobs.find((row) => row.jobId === "j-dee")!;
      assert.deepEqual([job.money!.mixedCurrency, job.money!.currency, job.money!.cost, job.money!.margin, job.money!.overCost], [true, null, null, null, null]);
    });
  });
});
