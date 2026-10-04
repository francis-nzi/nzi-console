import { randomUUID } from "node:crypto";
import {
  grantsAllow, TIME_ACTIVITY_CATEGORY, type CommandContext, type CommandInputMap, type JobTimeSummary, type LoggableJob,
  type TimeActivityOption, type TimeEntryReadModel,
} from "@nzi/contracts";
import { assertCapabilityOnClient, capabilityScope, type CapabilityHolder } from "./access";
import { AuthorizationError } from "./auth";
import { VersionConflictError } from "./errors";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";
import { moneyFrom } from "./timeReads";

type MoneyRow = Parameters<typeof moneyFrom>[0];

/**
 * Time (TIME module, PR A; rulings T-Q1…T-Q7, ⚑1…⚑9 + Addendum). Each person logs **their own** time (T-Q3) against a
 * job they can reach (T-Q7): many entries a day (⚑2), whole minutes up to 24 hours (⚑1, ⚑9), an activity whose
 * billable default the entry takes unless it says otherwise.
 *
 * **Money stays out of every payload (NZC-120).** An entry snapshots the cost and charge rate in force on its work date
 * (T-Q1), but a command's `data` — its audit after_json, idempotency outcome and outbox payload — says only *whether* a
 * rate was recorded, never the figures; and no read here returns them (payroll and cost reads are PR B, finance-gated).
 *
 * Billed (T-Q5/T-Q6): an entry with a `billed_ref` is locked — no edit, no void — until finance unbills it.
 */

// ── Shared ─────────────────────────────────────────────────────────────────────────────────────────────────────

type StoredEntry = {
  user_id: string; job_id: string; work_date: string; minutes: number; activity_value_id: string; billable: boolean; note: string | null;
  rate_id: string | null; billed_ref: string | null; active: boolean; version: number;
};

const cleanNote = (note: string | null | undefined) => note?.trim() ? note.trim() : null;

async function lockEntry(db: Queryable, context: CommandContext, entryId: string, expectedVersion: number): Promise<StoredEntry> {
  const { rows: [entry] } = await db.query<StoredEntry>(
    `SELECT user_id, job_id, work_date::text AS work_date, minutes, activity_value_id, billable, note, rate_id, billed_ref, active, version
       FROM nzi_console.time_entries WHERE organisation_id = $1 AND entry_id = $2 FOR UPDATE`, [context.organisationId, entryId]);
  if (!entry) throw new CommandValidationError([{ field: "entryId", code: "NOT_FOUND", message: "That time entry is not in this organisation." }]);
  if (entry.version !== expectedVersion) throw new VersionConflictError(expectedVersion, entry.version);
  return entry;
}

/** T-Q3: time is one's own. Nobody — admin included — logs, edits or voids another person's entry. */
function assertOwnEntry(entry: StoredEntry, context: CommandContext) {
  if (entry.user_id !== context.actorId) throw new AuthorizationError("time.log", "You can change only your own time.");
}

/** T-Q6: a billed entry is locked until finance unbills it. */
function assertUnbilled(entry: StoredEntry) {
  if (entry.billed_ref !== null) throw new CommandValidationError([{ field: "entryId", code: "LOCKED", message: "This time has been billed; finance must unbill it before it can change." }]);
}

/** The job can take time: in this organisation (the access check resolved that) and not cancelled. */
async function assertLoggableJob(db: Queryable, context: CommandContext, jobId: string) {
  const { rows: [job] } = await db.query<{ status: string }>(
    `SELECT status::text AS status FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [context.organisationId, jobId]);
  if (!job) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "That job is not in this organisation." }]);
  if (job.status === "cancelled") throw new CommandValidationError([{ field: "jobId", code: "CANCELLED", message: "Time can't be logged against a cancelled job." }]);
}

/** An active activity value, and its billable default (the Addendum: every activity has one). */
async function activityDefault(db: Queryable, context: CommandContext, valueId: string, allowInactive = false): Promise<boolean> {
  const { rows: [activity] } = await db.query<{ active: boolean; billable_default: boolean | null }>(
    `SELECT v.active, d.billable_default FROM nzi_console.reference_values v
       LEFT JOIN nzi_console.time_activity_defaults d ON (d.organisation_id, d.value_id) = (v.organisation_id, v.value_id)
      WHERE v.organisation_id = $1 AND v.category_key = $2 AND v.value_id = $3`, [context.organisationId, TIME_ACTIVITY_CATEGORY, valueId]);
  if (!activity || (!activity.active && !allowInactive)) throw new CommandValidationError([{ field: "activityValueId", code: "NOT_FOUND", message: "Choose an activity from the list." }]);
  if (activity.billable_default === null) throw new CommandValidationError([{ field: "activityValueId", code: "NO_DEFAULT", message: "That activity has no billable default; an admin must set one in Lookups." }]);
  return activity.billable_default;
}

/**
 * T-Q1: the person's rate in force on the work date — the latest `effective_from` on or before it among rows no
 * correction supersedes (the staffAdmin rule). None, or a row with neither rate, is "rate not recorded": null, never 0.
 */
async function rateOn(db: Queryable, context: CommandContext, userId: string, workDate: string) {
  const { rows: [rate] } = await db.query<{ rate_id: string; cost_per_hour: string | null; sell_per_hour: string | null; currency: string }>(
    `SELECT r.rate_id, r.cost_per_hour, r.sell_per_hour, r.currency FROM nzi_console.staff_rates r
      WHERE r.organisation_id = $1 AND r.user_id = $2 AND r.effective_from <= $3::date
        AND NOT EXISTS (SELECT 1 FROM nzi_console.staff_rates s WHERE s.organisation_id = r.organisation_id AND s.supersedes_rate_id = r.rate_id)
      ORDER BY r.effective_from DESC, r.recorded_at DESC LIMIT 1`, [context.organisationId, userId, workDate]);
  if (!rate || (rate.cost_per_hour === null && rate.sell_per_hour === null)) return { rateId: null, cost: null, charge: null, currency: null };
  return { rateId: rate.rate_id, cost: rate.cost_per_hour, charge: rate.sell_per_hour, currency: rate.currency };
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What a time command returns — and so its audit, idempotency and outbox payload. Hours and flags; never a rate. */
export type TimeEntryResult = {
  entryId: string; version: number; userId: string; jobId: string; workDate: string; minutes: number; billable: boolean;
  /** Whether a rate was in force and snapshotted — the fact, not the figure. */
  rateRecorded: boolean;
};

export function logTimeEntry(pool: PoolLike, input: CommandInputMap["time.entry.log"], context: CommandContext): Promise<StoredOutcome<TimeEntryResult>> {
  return runPostgresCommand(pool, "time.entry.log", input, context, async (db) => {
    await assertLoggableJob(db, context, input.jobId);
    const billableDefault = await activityDefault(db, context, input.activityValueId);
    const billable = input.billable ?? billableDefault;
    const rate = await rateOn(db, context, context.actorId, input.workDate);
    const entryId = randomUUID();
    await db.query(
      `INSERT INTO nzi_console.time_entries (organisation_id, entry_id, user_id, job_id, work_date, minutes, activity_value_id, billable, note,
         rate_id, cost_rate, charge_rate, rate_currency, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13, $3, $3)`,
      [context.organisationId, entryId, context.actorId, input.jobId, input.workDate, input.minutes, input.activityValueId, billable,
        cleanNote(input.note), rate.rateId, rate.cost, rate.charge, rate.currency]);
    return {
      data: { entryId, version: 1, userId: context.actorId, jobId: input.jobId, workDate: input.workDate, minutes: input.minutes, billable, rateRecorded: rate.rateId !== null },
      entityType: "time_entry", entityId: entryId, topic: "time.entry.logged",
    };
  });
}

export function editTimeEntry(pool: PoolLike, input: CommandInputMap["time.entry.edit"], context: CommandContext): Promise<StoredOutcome<TimeEntryResult & { rateResnapshotted: boolean }>> {
  return runPostgresCommand(pool, "time.entry.edit", input, context, async (db) => {
    const entry = await lockEntry(db, context, input.entryId, input.expectedVersion);
    assertOwnEntry(entry, context);
    assertUnbilled(entry);
    if (!entry.active) throw new CommandValidationError([{ field: "entryId", code: "VOIDED", message: "This time entry was voided." }]);
    if (input.jobId !== entry.job_id) {
      // Moving the time to another job: that job must be one the person can log against too (T-Q7).
      await assertCapabilityOnClient(db, context.grant, "time.log", { jobId: input.jobId });
      await assertLoggableJob(db, context, input.jobId);
    }
    // An activity retired since the entry was logged may stay on it; a newly chosen one must be active.
    await activityDefault(db, context, input.activityValueId, input.activityValueId === entry.activity_value_id);
    // T-Q1: the rate belongs to the day worked. A changed day takes that day's rate; an unchanged day keeps its snapshot.
    const resnapshot = input.workDate !== entry.work_date;
    const rate = resnapshot ? await rateOn(db, context, entry.user_id, input.workDate) : null;
    const { rows: [saved] } = await db.query<{ version: number; rate_id: string | null }>(
      `UPDATE nzi_console.time_entries
          SET job_id = $3, work_date = $4::date, minutes = $5, activity_value_id = $6, billable = $7, note = $8,
              rate_id = CASE WHEN $9 THEN $10 ELSE rate_id END, cost_rate = CASE WHEN $9 THEN $11::numeric ELSE cost_rate END,
              charge_rate = CASE WHEN $9 THEN $12::numeric ELSE charge_rate END, rate_currency = CASE WHEN $9 THEN $13 ELSE rate_currency END,
              version = version + 1, updated_at = now(), updated_by = $14
        WHERE organisation_id = $1 AND entry_id = $2 RETURNING version, rate_id`,
      [context.organisationId, input.entryId, input.jobId, input.workDate, input.minutes, input.activityValueId, input.billable, cleanNote(input.note),
        resnapshot, rate?.rateId ?? null, rate?.cost ?? null, rate?.charge ?? null, rate?.currency ?? null, context.actorId]);
    return {
      data: { entryId: input.entryId, version: saved!.version, userId: entry.user_id, jobId: input.jobId, workDate: input.workDate, minutes: input.minutes,
        billable: input.billable, rateRecorded: saved!.rate_id !== null, rateResnapshotted: resnapshot },
      entityType: "time_entry", entityId: input.entryId, topic: "time.entry.edited",
      before: { jobId: entry.job_id, workDate: entry.work_date, minutes: entry.minutes, activityValueId: entry.activity_value_id, billable: entry.billable },
    };
  });
}

export function voidTimeEntry(pool: PoolLike, input: CommandInputMap["time.entry.void"], context: CommandContext): Promise<StoredOutcome<{ entryId: string; version: number; active: false }>> {
  return runPostgresCommand(pool, "time.entry.void", input, context, async (db) => {
    const entry = await lockEntry(db, context, input.entryId, input.expectedVersion);
    assertOwnEntry(entry, context);
    assertUnbilled(entry);
    if (!entry.active) throw new CommandValidationError([{ field: "entryId", code: "VOIDED", message: "This time entry is already voided." }]);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.time_entries SET active = false, voided_at = now(), voided_by = $3, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND entry_id = $2 RETURNING version`, [context.organisationId, input.entryId, context.actorId]);
    return {
      data: { entryId: input.entryId, version: saved!.version, active: false as const },
      entityType: "time_entry", entityId: input.entryId, topic: "time.entry.voided",
      before: { active: true },
    };
  });
}

/** T-Q5: finance records the invoice an entry was billed on, or clears it (unbill) so its owner can correct it. */
export function billTimeEntry(pool: PoolLike, input: CommandInputMap["time.entry.bill"], context: CommandContext): Promise<StoredOutcome<{ entryId: string; version: number; billed: boolean; billedRef: string | null }>> {
  return runPostgresCommand(pool, "time.entry.bill", input, context, async (db) => {
    const entry = await lockEntry(db, context, input.entryId, input.expectedVersion);
    if (!entry.active) throw new CommandValidationError([{ field: "entryId", code: "VOIDED", message: "A voided entry isn't billed." }]);
    const billedRef = input.billedRef === null ? null : input.billedRef.trim();
    if (billedRef === null && entry.billed_ref === null) throw new CommandValidationError([{ field: "billedRef", code: "NOT_BILLED", message: "This time isn't billed." }]);
    if (billedRef !== null && entry.billed_ref !== null) throw new CommandValidationError([{ field: "billedRef", code: "ALREADY_BILLED", message: "This time is already billed; unbill it first." }]);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.time_entries
          SET billed_ref = $3, billed_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, billed_by = CASE WHEN $3::text IS NULL THEN NULL ELSE $4 END,
              version = version + 1, updated_at = now(), updated_by = $4
        WHERE organisation_id = $1 AND entry_id = $2 RETURNING version`, [context.organisationId, input.entryId, billedRef, context.actorId]);
    return {
      data: { entryId: input.entryId, version: saved!.version, billed: billedRef !== null, billedRef },
      entityType: "time_entry", entityId: input.entryId, topic: billedRef === null ? "time.entry.unbilled" : "time.entry.billed",
      before: { billedRef: entry.billed_ref },
    };
  });
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────────

type Holder = CapabilityHolder;

function requireTimeLog(holder: Holder) {
  if (capabilityScope(holder, "time.log") === null) throw new AuthorizationError("time.log");
}

/** The activities time can be logged as, in Lookups order, each with its billable default. */
export async function readTimeActivities(db: Queryable, holder: Holder): Promise<TimeActivityOption[]> {
  requireTimeLog(holder);
  const { rows } = await db.query<{ value_id: string; label: string; billable_default: boolean | null }>(
    `SELECT v.value_id, v.label, d.billable_default FROM nzi_console.reference_values v
       LEFT JOIN nzi_console.time_activity_defaults d ON (d.organisation_id, d.value_id) = (v.organisation_id, v.value_id)
      WHERE v.organisation_id = $1 AND v.category_key = $2 AND v.active ORDER BY v.sort_order, v.label`, [holder.organisationId, TIME_ACTIVITY_CATEGORY]);
  // A value without a default can't be logged as (the command refuses it), so it isn't offered.
  return rows.filter((row) => row.billable_default !== null).map((row) => ({ valueId: row.value_id, label: row.label, billableDefault: row.billable_default! }));
}

/** The jobs this person can log time against (T-Q7): their own clients' under own_clients, any under all; never cancelled. */
export async function readLoggableJobs(db: Queryable, holder: Holder): Promise<LoggableJob[]> {
  const scope = capabilityScope(holder, "time.log");
  if (scope === null) throw new AuthorizationError("time.log");
  const { rows } = await db.query<{ job_id: string; job_number: string; title: string; client: string; family: string }>(
    `SELECT j.job_id, j.job_number, j.title, c.name AS client, j.job_family::text AS family
       FROM nzi_console.jobs j JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
      WHERE j.organisation_id = $1 AND j.status::text <> 'cancelled' AND ($2::text IS NULL OR c.owner_user_id = $2)
      ORDER BY j.sequence DESC`, [holder.organisationId, scope === "own_clients" ? holder.userId : null]);
  return rows.map((row) => ({ jobId: row.job_id, jobNumber: row.job_number, title: row.title, clientName: row.client, family: row.family }));
}

/** One's own entries between two days (inclusive), newest first. Voided ones only when asked. No rate, no money. */
export async function readMyTimeEntries(db: Queryable, holder: Holder, range: { from: string; to: string; includeVoided?: boolean }): Promise<TimeEntryReadModel[]> {
  requireTimeLog(holder);
  const { rows } = await db.query<{ entry_id: string; version: number; user_id: string; job_id: string; job_number: string; title: string; client: string;
    work_date: string; minutes: number; activity_value_id: string; activity: string; billable: boolean; note: string | null; billed_ref: string | null; active: boolean }>(
    `SELECT t.entry_id, t.version, t.user_id, t.job_id, j.job_number, j.title, c.name AS client, t.work_date::text AS work_date, t.minutes,
            t.activity_value_id, v.label AS activity, t.billable, t.note, t.billed_ref, t.active
       FROM nzi_console.time_entries t
       JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (t.organisation_id, t.job_id)
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
       JOIN nzi_console.reference_values v ON (v.organisation_id, v.value_id) = (t.organisation_id, t.activity_value_id)
      WHERE t.organisation_id = $1 AND t.user_id = $2 AND t.work_date BETWEEN $3::date AND $4::date AND ($5 OR t.active)
      ORDER BY t.work_date DESC, t.created_at DESC`, [holder.organisationId, holder.userId, range.from, range.to, range.includeVoided === true]);
  return rows.map((row) => ({
    entryId: row.entry_id, version: row.version, userId: row.user_id, jobId: row.job_id, jobNumber: row.job_number, jobTitle: row.title, clientName: row.client,
    workDate: row.work_date, minutes: row.minutes, activityValueId: row.activity_value_id, activityLabel: row.activity, billable: row.billable, note: row.note,
    billed: row.billed_ref !== null, active: row.active,
  }));
}

/**
 * Job → Time: hours by person, billable or not, against the job's budgeted hours. With time.view on the job, everyone's;
 * with only time.log on it, the reader's own (`othersVisible: false`). Hours only — never rates or the fee.
 */
export async function readJobTimeSummary(db: Queryable, holder: Holder, jobId: string): Promise<JobTimeSummary> {
  let othersVisible = false;
  if (capabilityScope(holder, "time.view") !== null) {
    try { await assertCapabilityOnClient(db, holder, "time.view", { jobId }); othersVisible = true; }
    catch (error) { if (!(error instanceof AuthorizationError) || error.permission === "tenant") throw error; }
  }
  if (!othersVisible) await assertCapabilityOnClient(db, holder, "time.log", { jobId });
  const { rows: [job] } = await db.query<MoneyRow & { budgeted_hours: string | null; fee_amount: string | null; version: number; client_owner: string | null }>(
    `SELECT j.budgeted_hours::text AS budgeted_hours, j.fee_amount::text AS fee_amount, j.version, c.owner_user_id AS client_owner,
            ${jobMoneySql}
       FROM nzi_console.jobs j
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
       LEFT JOIN nzi_console.time_entries t ON (t.organisation_id, t.job_id) = (j.organisation_id, j.job_id) AND t.active
      WHERE j.organisation_id = $1 AND j.job_id = $2
      GROUP BY j.budgeted_hours, j.fee_amount, j.version, c.owner_user_id`, [holder.organisationId, jobId]);
  const owned = job?.client_owner === holder.userId;
  // Time PR B: the job's money, for finance.view on it — and only when everyone's time is visible, so the cost is the
  // job's labour cost and not the reader's share of it. Never in a payload; a read under finance.view alone.
  let money: JobTimeSummary["money"] = null;
  if (job && othersVisible && grantsAllow(holder.capabilities, "finance.view", owned)) {
    const base = moneyFrom(job);
    const fee = job.fee_amount === null ? null : Number(job.fee_amount);
    money = { ...base, fee, margin: fee !== null && base.cost !== null ? Math.round((fee - base.cost) * 100) / 100 : null };
  }
  const { rows } = await db.query<{ user_id: string; name: string; minutes: string; billable_minutes: string; entries: string }>(
    `SELECT t.user_id, coalesce(nullif(btrim(m.display_name), ''), t.user_id) AS name, sum(t.minutes)::text AS minutes,
            coalesce(sum(t.minutes) FILTER (WHERE t.billable), 0)::text AS billable_minutes, count(*)::text AS entries
       FROM nzi_console.time_entries t
       LEFT JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (t.organisation_id, t.user_id)
      WHERE t.organisation_id = $1 AND t.job_id = $2 AND t.active AND ($3 OR t.user_id = $4)
      GROUP BY t.user_id, m.display_name ORDER BY sum(t.minutes) DESC, t.user_id`, [holder.organisationId, jobId, othersVisible, holder.userId]);
  const people = rows.map((row) => ({ userId: row.user_id, name: row.name, minutes: Number(row.minutes), billableMinutes: Number(row.billable_minutes), entries: Number(row.entries) }));
  return {
    jobId,
    jobVersion: job?.version ?? 0,
    budgetedMinutes: job?.budgeted_hours === null || job?.budgeted_hours === undefined ? null : Math.round(Number(job.budgeted_hours) * 60),
    totals: { minutes: people.reduce((sum, p) => sum + p.minutes, 0), billableMinutes: people.reduce((sum, p) => sum + p.billableMinutes, 0) },
    people,
    othersVisible,
    money,
    editable: { budget: grantsAllow(holder.capabilities, "job.manage", owned), fee: grantsAllow(holder.capabilities, "finance.manage", owned) },
  };
}

const jobMoneySql = `
  count(DISTINCT t.rate_currency) FILTER (WHERE t.rate_id IS NOT NULL)::text AS currencies,
  min(t.rate_currency) FILTER (WHERE t.rate_id IS NOT NULL) AS currency,
  round(coalesce(sum(t.minutes * t.cost_rate), 0) / 60.0, 2)::text AS cost,
  round(coalesce(sum(t.minutes * t.charge_rate), 0) / 60.0, 2)::text AS charge,
  coalesce(sum(t.minutes) FILTER (WHERE t.entry_id IS NOT NULL AND t.rate_id IS NULL), 0)::text AS unrated`;

// ── Time PR B: the figures the reads compare against ───────────────────────────────────────────────────────────

/** T-Q4: a person's weekly capacity, which utilisation is read against. admin.users; capacity is hours, not money. */
export function setStaffCapacity(pool: PoolLike, input: CommandInputMap["staff.capacity.set"], context: CommandContext): Promise<StoredOutcome<{ userId: string; version: number; weeklyCapacityHours: number }>> {
  return runPostgresCommand(pool, "staff.capacity.set", input, context, async (db) => {
    const { rows: [held] } = await db.query<{ version: number; weekly_capacity_hours: string }>(
      `SELECT version, weekly_capacity_hours::text AS weekly_capacity_hours FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2 FOR UPDATE`,
      [context.organisationId, input.userId]);
    if (!held) throw new CommandValidationError([{ field: "userId", code: "NOT_FOUND", message: "That person is not in this organisation." }]);
    if (held.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, held.version);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.memberships SET weekly_capacity_hours = $3, version = version + 1, updated_at = now(), updated_by = $4
        WHERE organisation_id = $1 AND user_id = $2 RETURNING version`, [context.organisationId, input.userId, input.weeklyCapacityHours, context.actorId]);
    return {
      data: { userId: input.userId, version: saved!.version, weeklyCapacityHours: input.weeklyCapacityHours },
      entityType: "membership", entityId: input.userId, topic: "staff.capacity.set",
      before: { weeklyCapacityHours: Number(held.weekly_capacity_hours) },
    };
  });
}

async function lockJob(db: Queryable, context: CommandContext, jobId: string, expectedVersion: number) {
  const { rows: [job] } = await db.query<{ version: number; budgeted_hours: string | null; fee_amount: string | null }>(
    `SELECT version, budgeted_hours::text AS budgeted_hours, fee_amount::text AS fee_amount FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 FOR UPDATE`,
    [context.organisationId, jobId]);
  if (!job) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "That job is not in this organisation." }]);
  if (job.version !== expectedVersion) throw new VersionConflictError(expectedVersion, job.version);
  return job;
}

/** ⚑5: the job's budgeted hours (job.manage). Hours, not money, so the figure is in the payload. */
export function setJobBudget(pool: PoolLike, input: CommandInputMap["job.budget.set"], context: CommandContext): Promise<StoredOutcome<{ jobId: string; version: number; budgetedHours: number | null }>> {
  return runPostgresCommand(pool, "job.budget.set", input, context, async (db) => {
    const held = await lockJob(db, context, input.jobId, input.expectedVersion);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.jobs SET budgeted_hours = $3, version = version + 1, updated_at = now() WHERE organisation_id = $1 AND job_id = $2 RETURNING version`,
      [context.organisationId, input.jobId, input.budgetedHours]);
    return {
      data: { jobId: input.jobId, version: saved!.version, budgetedHours: input.budgetedHours },
      entityType: "job", entityId: input.jobId, topic: "job.budget.set",
      before: { budgetedHours: held.budgeted_hours === null ? null : Number(held.budgeted_hours) },
    };
  });
}

/**
 * ⚑5/⚑6: the job's fee, ex VAT (finance.manage). **Money — never in a payload (NZC-120)**: the audit, idempotency
 * record and outbox say only whether a fee is recorded, before and after; the figure lives in the column alone.
 */
export function setJobFee(pool: PoolLike, input: CommandInputMap["job.fee.set"], context: CommandContext): Promise<StoredOutcome<{ jobId: string; version: number; feeRecorded: boolean }>> {
  return runPostgresCommand(pool, "job.fee.set", input, context, async (db) => {
    const held = await lockJob(db, context, input.jobId, input.expectedVersion);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.jobs SET fee_amount = $3, version = version + 1, updated_at = now() WHERE organisation_id = $1 AND job_id = $2 RETURNING version`,
      [context.organisationId, input.jobId, input.feeAmount]);
    return {
      data: { jobId: input.jobId, version: saved!.version, feeRecorded: input.feeAmount !== null },
      entityType: "job", entityId: input.jobId, topic: "job.fee.set",
      before: { feeRecorded: held.fee_amount !== null },
    };
  });
}
