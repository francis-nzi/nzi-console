import { dateOnly, londonDayOf, utcDay } from "./dayValues";
import { greetingName } from "./firstName";
import type { PortalMessage, PortalThreadSummary } from "./portalConversations";

/**
 * The SRS review loop, Phase A (BRIEF-srs-iterative-review-and-messaging): when a completed readiness assessment is next due
 * for review, and the once-per-date reminder that tells the CRM so.
 *
 * Pure: the scan, the command and the staff surface ask these same questions, so they cannot disagree about a date.
 *
 * - **Cadence.** `annual` (the default, set on completion: assessed date + 12 months) · `biannual` (every 6 months) · `custom`
 *   (a date the CRM chose) · `off` (no date, nothing sends).
 * - **The reminder goes to the CRM, never the client.** The client's manager, else its owner — as a client's portal message is
 *   routed. It is staff mail: internal, not consent-gated. It links into the client's SRS area, where the CRM reopens or
 *   reassesses through the existing commands; nothing here edits an assessment.
 * - **Once per assessment per review date.** Owed from `review date − lead` (the Admin default lead, A3) and stays owed until
 *   sent — an overdue review is still worth the prompt, unlike an action's reminder, which is moot after its date.
 */

export const SRS_REVIEW_CADENCES = ["annual", "biannual", "custom", "off"] as const;
export type SrsReviewCadence = (typeof SRS_REVIEW_CADENCES)[number];
export const SRS_REVIEW_DEFAULT_CADENCE: SrsReviewCadence = "annual";
export const isSrsReviewCadence = (value: unknown): value is SrsReviewCadence => (SRS_REVIEW_CADENCES as readonly unknown[]).includes(value);

export const srsReviewCadenceLabels: Record<SrsReviewCadence, string> = {
  annual: "Every 12 months",
  biannual: "Every 6 months",
  custom: "On a date I choose",
  off: "Off — no review reminder",
};

/** The Admin message template the reminder is worded by. */
export const SRS_REVIEW_TEMPLATE_KEY = "srs.review.due";

const DAY_MS = 86_400_000;
const shiftDays = (day: string, days: number) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));

/**
 * Calendar months after a day, as Postgres adds `interval 'n months'` (the 0220 backfill): the same day of the month, or the
 * month's last day when it has fewer — 29 Feb + 12 months is 28 Feb.
 */
export function addCalendarMonths(day: string, months: number): string {
  const [year, month, date] = dateOnly(day).split("-").map(Number) as [number, number, number];
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12), targetMonth = index % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return utcDay(new Date(Date.UTC(targetYear, targetMonth, Math.min(date, lastDay))));
}

/** The review date a cadence resolves to from the assessed date. `custom` takes the CRM's date; `off` has none. */
export function srsNextReviewDate(assessedOn: string, cadence: SrsReviewCadence, customDate: string | null = null): string | null {
  switch (cadence) {
    case "annual": return addCalendarMonths(assessedOn, 12);
    case "biannual": return addCalendarMonths(assessedOn, 6);
    case "custom": return customDate === null ? null : dateOnly(customDate);
    case "off": return null;
  }
}

/** Where a completed assessment stands against its review reminder, before who would receive it is known. */
export type SrsReviewTiming =
  /** On or after `remindOn` (review date − lead): owed now, unless already sent for this date. */
  | { kind: "owed"; reviewDate: string; leadDays: number; remindOn: string }
  /** Before its window: owed on `remindOn`. */
  | { kind: "scheduled"; reviewDate: string; leadDays: number; remindOn: string }
  /** Never reminded: still a draft, the cadence is off, or a later assessment has superseded it. */
  | { kind: "none"; why: "not-complete" | "off" | "superseded" };

export function srsReviewTiming(
  assessment: { status: "draft" | "complete"; reviewCadence: SrsReviewCadence | null; nextReviewDate: string | null; latest: boolean },
  today: string,
  leadDays: number,
): SrsReviewTiming {
  if (assessment.status !== "complete") return { kind: "none", why: "not-complete" };
  if (!assessment.latest) return { kind: "none", why: "superseded" };
  if (assessment.reviewCadence === "off" || assessment.reviewCadence === null || assessment.nextReviewDate === null) return { kind: "none", why: "off" };
  const reviewDate = dateOnly(assessment.nextReviewDate);
  const remindOn = shiftDays(reviewDate, -leadDays);
  return dateOnly(today) >= remindOn ? { kind: "owed", reviewDate, leadDays, remindOn } : { kind: "scheduled", reviewDate, leadDays, remindOn };
}

/** The CRM as the scan reads them: the client's manager, else its owner, joined to the membership. Null: the client has neither. */
export type SrsReviewCrm = { userId: string; email: string | null; status: string; firstName: string | null; displayName: string | null } | null;
export type SrsReviewBlock = "no-crm" | "crm-inactive" | "no-email";

/** Who an owed review reminder goes to — the CRM, and only the CRM. A blocked reminder is not marked, so it goes once fixed. */
export function srsReviewRecipient(crm: SrsReviewCrm): { ok: true; userId: string; email: string; firstName: string } | { ok: false; why: SrsReviewBlock } {
  if (crm === null) return { ok: false, why: "no-crm" };
  if (crm.status !== "active") return { ok: false, why: "crm-inactive" };
  const email = (crm.email ?? "").trim().toLowerCase();
  if (email === "" || !email.includes("@")) return { ok: false, why: "no-email" };
  return { ok: true, userId: crm.userId, email, firstName: greetingName({ firstName: crm.firstName, fullName: crm.displayName ?? "" }) };
}

export const srsReviewBlockLabels: Record<SrsReviewBlock, string> = {
  "no-crm": "the client has no client manager or owner",
  "crm-inactive": "the client manager is no longer an active member",
  "no-email": "the client manager has no email address",
};

/** The review schedule and its reminder, for the CRM's SRS area. */
export type SrsReviewStatus = {
  assessmentId: string;
  assessedOn: string;
  cadence: SrsReviewCadence;
  nextReviewDate: string | null;
  version: number;
  reminder:
    | { state: "off" }
    | { state: "reminders-off" }
    | { state: "sent"; reviewDate: string; enqueuedAt: string }
    | { state: "scheduled"; reviewDate: string; remindOn: string; leadDays: number; blocked: SrsReviewBlock | null }
    | { state: "due"; reviewDate: string; leadDays: number; blocked: SrsReviewBlock | null };
};

/** Compose the reminder's state: the timing, the marker for the current date, the CRM check and the Admin master switch. */
export function srsReviewReminderState(input: {
  enabled: boolean; timing: SrsReviewTiming; sentForReviewDate: { enqueuedAt: string } | null; crm: SrsReviewCrm;
}): SrsReviewStatus["reminder"] {
  const { timing } = input;
  if (timing.kind === "none") return { state: "off" };
  // Sent stays true whatever the switch now says: it is a fact about what the CRM received.
  if (input.sentForReviewDate) return { state: "sent", reviewDate: timing.reviewDate, enqueuedAt: input.sentForReviewDate.enqueuedAt };
  if (!input.enabled) return { state: "reminders-off" };
  const recipient = srsReviewRecipient(input.crm);
  const blocked = recipient.ok ? null : recipient.why;
  return timing.kind === "owed"
    ? { state: "due", reviewDate: timing.reviewDate, leadDays: timing.leadDays, blocked }
    : { state: "scheduled", reviewDate: timing.reviewDate, remindOn: timing.remindOn, leadDays: timing.leadDays, blocked };
}

/** dd/mm/yyyy (NZC-040). */
export function formatUkDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

/** One line for the SRS area: what happens to the review reminder, in words. */
export function srsReviewReminderLabel(reminder: SrsReviewStatus["reminder"]): string {
  switch (reminder.state) {
    case "off": return "No review reminder";
    case "reminders-off": return "Reminders are off for this organisation";
    case "sent": return `Review reminder sent to the client manager on ${formatUkDay(londonDayOf(reminder.enqueuedAt))}`;
    case "scheduled": return reminder.blocked
      ? `Review reminder due ${formatUkDay(reminder.remindOn)} will not send: ${srsReviewBlockLabels[reminder.blocked]}`
      : `Review reminder to the client manager on ${formatUkDay(reminder.remindOn)} (${reminder.leadDays} day${reminder.leadDays === 1 ? "" : "s"} before)`;
    case "due": return reminder.blocked ? `Review reminder due now, not sent: ${srsReviewBlockLabels[reminder.blocked]}` : "Review reminder goes to the client manager on the next run";
  }
}

/** The values the reminder fills — every token the template declares. No score, no answer: a date and a link. */
export function srsReviewValues(input: { firstName: string; clientName: string; assessedOn: string; reviewDate: string; srsLink: string }): Record<string, string> {
  return { firstName: input.firstName, clientName: input.clientName, assessedOn: formatUkDay(input.assessedOn), reviewDate: formatUkDay(input.reviewDate), srsLink: input.srsLink };
}

/* ── Phase B: the client's SRS readiness conversation ───────────────────────────────────────────────────────────────── */

/** The client's SRS readiness conversation as either side reads it. `thread` null: nobody has written yet. */
export type SrsThreadReadModel = {
  thread: PortalThreadSummary | null;
  messages: PortalMessage[];
  /** The client's latest review request still awaiting the CRM — no adviser message after it. Null: none open. */
  openReviewRequest: { messageId: string; createdAt: string } | null;
};

/**
 * A review request is open until the CRM answers it in the thread. Surfaced, never acted on: the CRM reopens or reassesses
 * through the existing commands (NZC-022), and nothing from the portal reaches the assessment.
 */
export function openSrsReviewRequest(messages: readonly Pick<PortalMessage, "messageId" | "seq" | "createdAt" | "authorPrincipal" | "reviewRequest">[]): SrsThreadReadModel["openReviewRequest"] {
  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  const lastStaff = ordered.reduce((seq, message) => message.authorPrincipal === "staff" ? message.seq : seq, 0);
  const request = ordered.filter((message) => message.reviewRequest === true && message.authorPrincipal === "portal" && message.seq > lastStaff).at(-1);
  return request ? { messageId: request.messageId, createdAt: request.createdAt } : null;
}
