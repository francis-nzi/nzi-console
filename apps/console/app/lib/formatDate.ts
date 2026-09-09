// The one shared UK date formatter (NZC-040): dd/mm/yyyy everywhere in the UI, the
// client portal and generated documents. ISO stays the storage and transport shape
// (SQL `date`, command inputs, `<input type="date">` values) — formatting happens
// here, at the render edge, and nowhere else.
//
// Reporting-period month labelling (NZC-032) is separate: see formatMonth.

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A date-only string is reformatted from its parts, never parsed into a Date:
 * `new Date("2026-04-01")` is UTC midnight, and reading local components off it
 * shifts the day backwards west of UTC (the same trap `dateOnly()` fixes server-side).
 *
 * A value that is not a date at all — `next_report_due_label` carries free text
 * like "Baseline in progress" — is passed through unchanged rather than blanked.
 */
export function formatDate(value: string | Date | null | undefined, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string") {
    const parts = DATE_ONLY.exec(value.trim());
    if (parts) return `${parts[3]}/${parts[2]}/${parts[1]}`;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return typeof value === "string" ? value : fallback;
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** dd/mm/yyyy HH:mm for timestamps (audit trails, approvals, review threads). */
export function formatDateTime(value: string | Date | null | undefined, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return typeof value === "string" ? value : fallback;
  const time = parsed.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${formatDate(parsed)} ${time}`;
}

/** "Jan 2026" — month pickers and monthly-activity slots, which are months, not dates. */
export function formatMonth(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}
