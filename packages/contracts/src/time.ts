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

/** A job's time, by person (Job → Time). Hours only; "budget used" compares logged with the job's budgeted hours. */
export type JobTimeSummary = {
  jobId: string;
  budgetedMinutes: number | null;
  totals: { minutes: number; billableMinutes: number };
  people: Array<{ userId: string; name: string; minutes: number; billableMinutes: number; entries: number }>;
  /** False when the reader holds no time.view for this job: only their own time is shown. */
  othersVisible: boolean;
};
