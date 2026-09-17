import type { CommandIssue } from "./commands";

/**
 * The four dates a job carries, and what counts as a plausible one (Part 1, Task E).
 *
 * **The server is the guard, and the browser is a courtesy.** A native `<input type="date">`
 * accepts any year its user can type — that is how a job on live ended up starting in the year
 * 98655 — and a client-side check is one devtools panel away from irrelevant. Everything here is
 * exported once and called from both sides, so the two cannot disagree: the form spares the
 * consultant a round trip, and the command decides.
 *
 * **Plausible, not correct.** A window cannot know whether a period is right; it can only refuse
 * one nobody meant. 2000 is the floor because carbon accounting at this firm does not predate it,
 * and the ceiling floats five years ahead of today so a job planned for a future reporting cycle
 * is accepted while a typo three digits wide is not. The ceiling is computed, never written down —
 * a hardcoded year is a bug with a delayed fuse, correct until the day it silently starts
 * rejecting next year's work.
 */

/** Carbon accounting at this firm does not predate 2000; anything earlier is a typo. */
export const PLAUSIBLE_YEAR_FLOOR = 2000;
/** Far enough ahead for a planned reporting cycle, near enough to catch a mistyped year. */
export const PLAUSIBLE_YEARS_AHEAD = 5;

export function plausibleYearRange(today: Date = new Date()): { min: number; max: number } {
  return { min: PLAUSIBLE_YEAR_FLOOR, max: today.getUTCFullYear() + PLAUSIBLE_YEARS_AHEAD };
}

export type JobDateFields = {
  startDate: string;
  dueDate: string;
  reportingPeriodStart: string;
  reportingPeriodEnd: string;
};

/** What each field is called on screen, so a message names the field the consultant sees. */
export const JOB_DATE_LABELS: Record<keyof JobDateFields, string> = {
  startDate: "Job start",
  dueDate: "Job end",
  reportingPeriodStart: "Reporting period start",
  reportingPeriodEnd: "Reporting period end",
};

/**
 * A real calendar date written `yyyy-mm-dd` — the wire format. Consultants read and type
 * dd/mm/yyyy (NZC-040); that conversion happens at the edge, and every message below speaks
 * dd/mm/yyyy because that is the format the person is looking at.
 *
 * The four-digit check is load-bearing rather than cosmetic: a date input hands back a five-digit
 * year as `98655-11-22`, which parses perfectly well as a date and is not one anybody meant.
 */
const isRealIsoDate = (value: unknown): value is string =>
  typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const ORDERED_PAIRS = [
  { earlier: "startDate", later: "dueDate" },
  { earlier: "reportingPeriodStart", later: "reportingPeriodEnd" },
] as const;

/**
 * Every issue with a job's four dates, as command issues, for the create path and any edit path
 * that ever exists. Returns an empty array when all four are present, real, plausible and ordered.
 */
export function jobDateIssues(input: Partial<JobDateFields>, today: Date = new Date()): CommandIssue[] {
  const issues: CommandIssue[] = [];
  const { min, max } = plausibleYearRange(today);
  const valid = new Set<keyof JobDateFields>();

  for (const field of Object.keys(JOB_DATE_LABELS) as (keyof JobDateFields)[]) {
    const label = JOB_DATE_LABELS[field];
    const value = input[field];
    if (value === undefined || value === null || value === "") {
      issues.push({ field, code: "REQUIRED", message: `${label} is required.` });
      continue;
    }
    if (!isRealIsoDate(value)) {
      issues.push({ field, code: "INVALID", message: `Enter ${label.toLowerCase()} as dd/mm/yyyy.` });
      continue;
    }
    const year = Number(value.slice(0, 4));
    if (year < min || year > max) {
      issues.push({ field, code: "IMPLAUSIBLE_YEAR",
        message: `${label} must be between ${min} and ${max}. Check the year.` });
      continue;
    }
    valid.add(field);
  }

  // Ordering is only meaningful once both ends are real dates; otherwise the consultant gets two
  // complaints about one mistake.
  for (const { earlier, later } of ORDERED_PAIRS) {
    if (!valid.has(earlier) || !valid.has(later)) continue;
    if (input[earlier]! < input[later]!) continue;
    issues.push({ field: later, code: "INVALID_RANGE",
      message: `${JOB_DATE_LABELS[later]} must be after ${JOB_DATE_LABELS[earlier].toLowerCase()}.` });
  }

  return issues;
}
