/**
 * Time (TIME-module kickoff; rulings T-Q1…T-Q7, ⚑1…⚑9): staff log their own time against jobs.
 *
 * - Stored as **integer minutes** (⚑1), > 0 and ≤ 1440 an entry (⚑9); entered and shown as hours in quarter steps.
 * - **Many entries a day** (⚑2): each its own activity, billable state and note; totals are reads.
 * - `billable` defaults from the activity (Addendum), overridable per entry.
 * - Rates are snapshotted on the entry as of its work date (T-Q1) and are **money**: behind finance.view in every read,
 *   never in an audit, idempotency or outbox payload (NZC-120).
 */
export const TIME_ENTRY_MAX_MINUTES = 1440;
export const TIME_ENTRY_NOTE_MAX = 2000;
/** The screen's hours step: a quarter-hour. */
export const TIME_HOURS_STEP = 0.25;
/** The Lookups category whose values time is logged as. */
export const TIME_ACTIVITY_CATEGORY = "activity_types";

/** Hours (as typed) to whole minutes — quarter-hours land exactly; anything else rounds to the minute. */
export const minutesFromHours = (hours: number): number => Math.round(hours * 60);
/** Minutes to hours for display: 90 → "1.5", 15 → "0.25". */
export const hoursFromMinutes = (minutes: number): string => {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 100) / 100);
};
export const isTimeEntryMinutes = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= TIME_ENTRY_MAX_MINUTES;

/** One of one's own entries, as My time lists it. Hours only — no rate or money (T-Q3). */
export type TimeEntryReadModel = {
  entryId: string; version: number; userId: string;
  jobId: string; jobNumber: string; jobTitle: string; clientName: string;
  workDate: string; minutes: number; activityValueId: string; activityLabel: string;
  billable: boolean; note: string | null;
  billed: boolean; active: boolean;
};

/** An activity a person can log time as, with its billable default. */
export type TimeActivityOption = { valueId: string; label: string; billableDefault: boolean };

/** A job a person can log time against. */
export type LoggableJob = { jobId: string; jobNumber: string; title: string; clientName: string; family: string };

/** A job's time, by person (Job → Time). "Budget used" compares logged with the job's budgeted hours. */
export type JobTimeSummary = {
  jobId: string;
  /** The job's version, for the budget and fee editors' `expectedVersion`. */
  jobVersion: number;
  budgetedMinutes: number | null;
  totals: { minutes: number; billableMinutes: number };
  people: Array<{ userId: string; name: string; minutes: number; billableMinutes: number; entries: number }>;
  /** False when the reader holds no time.view for this job: only their own time is shown. */
  othersVisible: boolean;
  /**
   * The job's labour cost, charge-out value, fee and margin (Time PR B) — present only for a finance.view holder on this
   * job, and only when everyone's time is visible (a cost of one's own hours alone would be a misleading job cost).
   */
  money: TimeMoney | null;
  /** What the reader may change here: the budget (job.manage), the fee (finance.manage). */
  editable: { budget: boolean; fee: boolean };
};

// ── Time PR B: the reads over the entries ──────────────────────────────────────────────────────────────────────

/** A person's weekly capacity is more than 0 and at most a week of hours (0155's CHECK). */
export const TIME_CAPACITY_MAX_HOURS = 168;
/** 0155's column bounds: `budgeted_hours numeric(9,2)`, `fee_amount numeric(12,2)`. */
export const JOB_BUDGET_MAX_HOURS = 9_999_999.99;
export const JOB_FEE_MAX = 9_999_999_999.99;
/** "Approaching" its budget from this share used; over 100 is over (the mockup's RAG). */
export const BUDGET_APPROACHING_PCT = 90;

/** A finite, non-negative quantity to two decimal places, within `max` — hours or money as the columns store them. */
export const isTimeQuantity = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max && Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

/** Logged against budgeted: the share of the budget used, or null when no budget is recorded (never 0 or ∞). */
export function budgetUsedPct(loggedMinutes: number, budgetedMinutes: number | null): number | null {
  if (budgetedMinutes === null || budgetedMinutes <= 0) return null;
  return Math.round((loggedMinutes / budgetedMinutes) * 100);
}
export type BudgetStatus = "over" | "approaching" | "on-track" | "no-budget";
export function budgetStatus(pct: number | null): BudgetStatus {
  return pct === null ? "no-budget" : pct > 100 ? "over" : pct >= BUDGET_APPROACHING_PCT ? "approaching" : "on-track";
}

/** Monday–Friday days in a period of London days, inclusive. Bank holidays are not removed (no calendar is held). */
export function weekdaysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  let days = 0;
  for (let at = start; at <= end; at += 86_400_000) { const day = new Date(at).getUTCDay(); if (day !== 0 && day !== 6) days++; }
  return days;
}
/** A person's capacity over a period: their weekly hours, spread over five weekdays, times the weekdays in it. */
export const capacityMinutes = (weeklyCapacityHours: number, weekdays: number) => Math.round((weeklyCapacityHours / 5) * weekdays * 60);
/** Utilisation (⚑8: capacity only) — logged against capacity; null when there is no capacity in the period. */
export const utilisationPct = (loggedMinutes: number, capacity: number) => capacity > 0 ? Math.round((loggedMinutes / capacity) * 100) : null;

/**
 * Money over a set of entries (finance.view only): hours × each entry's snapshotted rate. An entry with no rate recorded
 * adds nothing and is counted in `unratedMinutes`, so a cost is never quietly short. Entries in more than one currency are
 * not summed: `currency` is null and the figures are null (`mixedCurrency`).
 */
export type TimeMoney = {
  currency: string | null; mixedCurrency: boolean;
  cost: number | null; charge: number | null;
  /** The job's fee (ex VAT) — on a job's read only. */
  fee?: number | null;
  /** fee − cost, when both are known. */
  margin?: number | null;
  unratedMinutes: number;
};

export type TimePeriod = { from: string; to: string };

/** Oversight: one job. Logged hours and cost are the job's to date, as at the period's end; `periodMinutes` is the period's. */
export type OversightJob = {
  jobId: string; jobNumber: string; title: string; clientName: string; family: string; ownerName: string | null;
  loggedMinutes: number; periodMinutes: number; billableMinutes: number;
  budgetedMinutes: number | null; budgetUsedPct: number | null; budgetStatus: BudgetStatus;
  /** finance.view on this job only. `overCost` is cost > fee, when both are known. */
  money: (TimeMoney & { overCost: boolean | null }) | null;
};
export type TimeOversight = {
  period: TimePeriod; jobs: OversightJob[];
  totals: { periodMinutes: number; billableMinutes: number; overBudget: number; approaching: number; overCost: number | null };
  /** False for an own-clients time.view holder: the jobs are their own clients' only. */
  allClients: boolean;
};

/** Payroll: one person's hours over the period (and cost, for finance.view at all). */
export type PayrollPerson = {
  userId: string; name: string; billableMinutes: number; nonBillableMinutes: number; totalMinutes: number; entries: number;
  money: TimeMoney | null;
};
export type TimePayroll = { period: TimePeriod; people: PayrollPerson[]; moneyVisible: boolean };

/** Utilisation (⚑8): logged hours against capacity over the period. */
export type UtilisationPerson = {
  userId: string; name: string; weeklyCapacityHours: number; capacityMinutes: number;
  loggedMinutes: number; billableMinutes: number; utilisationPct: number | null;
  /** The membership version, for the capacity editor. */
  version: number;
};
export type TimeUtilisation = { period: TimePeriod; weekdays: number; people: UtilisationPerson[]; capacityEditable: boolean };
