import { messageContentFor, messageTemplateDefinition, renderMessage, type MessageContent } from "./messageTemplates";
import { strategyDeadline, type ClientStrategy, type StrategyDeadline, type StrategyStatus } from "./reductionStrategies";
import { dateOnly, londonDayOf, utcDay } from "./dayValues";

/**
 * What a deadline reminder says, and who is allowed to receive it.
 *
 * Pure: this decides the message and the recipients, and nothing here touches a database or
 * a mail server. The worker does the claiming and the sending; what is actually *said* to a
 * client is the part most worth being able to read and test in one place.
 */

/** Who may be written to, and why that decision is safe to act on. */
export type ReminderRecipient = { email: string; name: string };

export type ClientContactLike = {
  email: string | null;
  fullName: string;
  status: "active" | "inactive";
  emailConsent: "unknown" | "granted" | "declined";
};

/**
 * Consent holds rather than assumes, following `training_bookings.consent_status`: only
 * `granted` is written to. `unknown` is an absent decision, and an absent decision is not
 * permission — so a client nobody has asked receives nothing, which is the correct and
 * quiet default.
 *
 * Addresses are lowercased and de-duplicated: two contact records sharing an address are
 * one inbox, and sending twice because the database holds two rows would be the platform's
 * bookkeeping leaking into someone's morning.
 */
export function reminderRecipients(contacts: readonly ClientContactLike[]): ReminderRecipient[] {
  const byEmail = new Map<string, ReminderRecipient>();
  for (const contact of contacts) {
    if (contact.status !== "active") continue;
    if (contact.emailConsent !== "granted") continue;
    const email = (contact.email ?? "").trim().toLowerCase();
    if (email === "" || !email.includes("@")) continue;
    if (!byEmail.has(email)) byEmail.set(email, { email, name: contact.fullName });
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

export type ReminderKind = "approaching" | "overdue";

/** Only these two states are worth a message; everything else is a plan going to plan. */
export function reminderKindFor(deadline: StrategyDeadline): ReminderKind | null {
  if (deadline.state === "overdue") return "overdue";
  if (deadline.state === "approaching") return "approaching";
  return null;
}

export type ReminderMessage = { subject: string; body: string };

/**
 * The message itself.
 *
 * Deliberately plain, and deliberately not alarming: a date that has passed is a normal
 * event in a multi-year plan, and a reminder that reads like a demand makes a client
 * defensive about telling their consultant the truth. It carries no figures — a reduction
 * strategy has no modelled tCO₂e (A2-lite), and inventing one in an email would be the
 * easiest place in the platform to do it unnoticed.
 */
export function reminderMessage(input: {
  clientName: string;
  strategyTitle: string;
  owner: string;
  targetDate: string;
  kind: ReminderKind;
  deadline: StrategyDeadline;
  recipient: ReminderRecipient;
}, template: MessageContent | null = null): ReminderMessage {
  // The wording is a message template (admin F1): the organisation's own when it has an active one, else the built-in
  // wording, which is what this function composed before F1, word for word. D3b still holds for the built-in: no
  // organisation name — the worker runs as nzi_console_worker, which cannot read the organisation profile.
  const definition = messageTemplateDefinition(reminderTemplateKey(input.kind))!;
  return renderMessage(messageContentFor(definition, template), {
    firstName: firstName(input.recipient.name),
    clientName: input.clientName,
    strategyTitle: input.strategyTitle,
    ownerLine: input.owner.trim() === "" ? "" : `\nOwner: ${input.owner.trim()}`,
    targetDate: formatUkDate(input.targetDate),
  });
}

/** The message template a reminder of this kind is worded by. */
export const reminderTemplateKey = (kind: ReminderKind): string => kind === "overdue" ? "strategy.reminder.overdue" : "strategy.reminder.approaching";

/** dd/mm/yyyy (NZC-040). An ISO date in a client-facing email is a platform talking to itself. */
function formatUkDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

const firstName = (name: string): string => name.trim().split(/\s+/)[0] || "there";

/**
 * Everything the worker needs to claim one reminder, derived in one place so the scan and
 * the send cannot disagree about what is owed.
 *
 * `targetDate` is read from the deadline branch rather than the strategy, because it is the
 * date the reminder is *about* — and it is part of the idempotency key, so taking it from
 * anywhere else would let a moved date reuse a spent claim.
 */
export type ReminderClaim = {
  clientStrategyId: string;
  kind: ReminderKind;
  targetDate: string;
};

export function remindersDue(
  plan: readonly ClientStrategy[],
  today: string,
  windowDays?: number,
): ReminderClaim[] {
  const claims: ReminderClaim[] = [];
  for (const strategy of plan) {
    const deadline = strategyDeadline(strategy, today, windowDays);
    const kind = reminderKindFor(deadline);
    // A3: the reminder before a date is the owner's, sent by the due-date scan on its own lead. This scan raises only the
    // reminder after a date has passed.
    if (kind === null || kind === "approaching") continue;
    // Narrowed by `reminderKindFor`, but read from the branch so the date is the one the
    // deadline is about rather than one assumed to match.
    if (!("targetDate" in deadline)) continue;
    claims.push({ clientStrategyId: strategy.id, kind, targetDate: deadline.targetDate.slice(0, 10) });
  }
  return claims;
}

/* ── A3: the owner's reminder before the due date ──────────────────────────────────────────────────────────────────── */

/** The house standard lead (26 Oct): seven days before the target date. */
export const STRATEGY_REMINDER_DEFAULT_LEAD_DAYS = 7;
/** The longest lead an admin or consultant may set — the same bound the database holds. */
export const STRATEGY_REMINDER_MAX_LEAD_DAYS = 90;
/**
 * The Admin message template a due-date reminder is worded by. The existing "approaching" entry, re-pointed to the owner
 * (A3): an organisation that has already worded it keeps its wording, and there is one reminder in Admin, not two.
 */
export const DUE_REMINDER_TEMPLATE_KEY = "strategy.reminder.approaching";
/** R5: only a live action reminds. Complete and Declined are finished; On hold suppresses until it resumes. */
export const REMINDING_STATUSES: readonly StrategyStatus[] = ["agreed", "in_progress"];

/** The Admin settings (R6). Absent from the database: off, seven days. */
export type ReminderSettings = { enabled: boolean; defaultLeadDays: number; version: number | null; updatedAt: string | null; updatedBy: string | null };
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = { enabled: false, defaultLeadDays: STRATEGY_REMINDER_DEFAULT_LEAD_DAYS, version: null, updatedAt: null, updatedBy: null };

export const isReminderLead = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= STRATEGY_REMINDER_MAX_LEAD_DAYS;

/** Where an action stands against its reminder, from the action alone — before who would receive it is known. */
export type DueReminderTiming =
  /** Inside its window (due − lead ≤ today ≤ due): owed now, unless already sent for this date. */
  | { kind: "owed"; dueDate: string; leadDays: number; remindOn: string }
  /** Before its window: it will be owed on `remindOn`. */
  | { kind: "scheduled"; dueDate: string; leadDays: number; remindOn: string }
  /** Never reminded: no date, not a live state, removed, or the date has passed (a reminder before it is moot). */
  | { kind: "none"; why: "no-date" | "not-live" | "removed" | "passed" };

const DAY_MS = 86_400_000;
// Calendar arithmetic on a day, anchored at UTC midnight so no offset or clock change can move it.
const shiftDays = (day: string, days: number) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));

/**
 * R1 and R5: when an action's reminder is owed. Due when today ≥ due − lead; never after the date itself (that would be
 * the overdue nudge, which A3 does not add); never without a date; only Agreed or In progress. The lead is the action's own
 * override, else the organisation's default. Pure: the scan and the staff surface ask the same question.
 */
export function dueReminderTiming(
  action: Pick<ClientStrategy, "active" | "status" | "targetDate"> & { reminderLeadDays: number | null },
  today: string,
  defaultLeadDays: number,
): DueReminderTiming {
  if (!action.active) return { kind: "none", why: "removed" };
  if (!REMINDING_STATUSES.includes(action.status)) return { kind: "none", why: "not-live" };
  if (action.targetDate === null || action.targetDate.trim() === "") return { kind: "none", why: "no-date" };
  const dueDate = dateOnly(action.targetDate);
  const leadDays = action.reminderLeadDays ?? defaultLeadDays;
  const remindOn = shiftDays(dueDate, -leadDays);
  const day = dateOnly(today);
  if (day > dueDate) return { kind: "none", why: "passed" };
  return day >= remindOn ? { kind: "owed", dueDate, leadDays, remindOn } : { kind: "scheduled", dueDate, leadDays, remindOn };
}

/** The owner as the scan reads them: the action's `owner_contact_id`, joined to the contact. Null: no owner chosen. */
export type ReminderOwner = { contactId: string; fullName: string; email: string | null; status: string; emailConsent: string } | null;

/** Why an owed reminder cannot go (R3) — surfaced to staff, never a send to nobody. */
export type ReminderBlock = "no-owner" | "owner-inactive" | "no-email" | "no-consent";

/**
 * R3: who an owed reminder goes to — the owner, and only the owner. Consent holds as it does for every automation here
 * (0083): only `granted` is written to. A blocked reminder is not marked sent, so it goes once the owner is fixed.
 */
export function dueReminderRecipient(owner: ReminderOwner): { ok: true; contactId: string; email: string; firstName: string } | { ok: false; why: ReminderBlock } {
  if (owner === null) return { ok: false, why: "no-owner" };
  if (owner.status !== "active") return { ok: false, why: "owner-inactive" };
  const email = (owner.email ?? "").trim().toLowerCase();
  if (email === "" || !email.includes("@")) return { ok: false, why: "no-email" };
  if (owner.emailConsent !== "granted") return { ok: false, why: "no-consent" };
  return { ok: true, contactId: owner.contactId, email, firstName: firstName(owner.fullName) };
}

export const reminderBlockLabels: Record<ReminderBlock, string> = {
  "no-owner": "no owner is chosen",
  "owner-inactive": "the owner is no longer an active contact",
  "no-email": "the owner has no email address",
  "no-consent": "the owner has not consented to email",
};

/** What one action's reminder stands at, for the consultant (R3: a skipped reminder is surfaced, not dropped). */
export type StrategyReminderStatus =
  | { state: "off" }
  | { state: "none"; why: "no-date" | "not-live" | "removed" | "passed" }
  | { state: "sent"; dueDate: string; enqueuedAt: string }
  | { state: "scheduled"; dueDate: string; remindOn: string; leadDays: number; blocked: ReminderBlock | null }
  | { state: "due"; dueDate: string; leadDays: number; blocked: ReminderBlock | null };

/** Compose the status from the timing, the marker for the current date (if any), the recipient check and the master switch. */
export function strategyReminderStatus(input: {
  enabled: boolean; timing: DueReminderTiming; sentForDueDate: { enqueuedAt: string } | null; owner: ReminderOwner;
}): StrategyReminderStatus {
  const { timing } = input;
  // Sent stays true whatever the switch now says: it is a fact about what the owner received.
  if (timing.kind !== "none" && input.sentForDueDate) return { state: "sent", dueDate: timing.dueDate, enqueuedAt: input.sentForDueDate.enqueuedAt };
  if (!input.enabled) return { state: "off" };
  if (timing.kind === "none") return { state: "none", why: timing.why };
  const recipient = dueReminderRecipient(input.owner);
  const blocked = recipient.ok ? null : recipient.why;
  return timing.kind === "owed"
    ? { state: "due", dueDate: timing.dueDate, leadDays: timing.leadDays, blocked }
    : { state: "scheduled", dueDate: timing.dueDate, remindOn: timing.remindOn, leadDays: timing.leadDays, blocked };
}

/** One line for the plan: what happens to this action's reminder, in words. */
export function strategyReminderStatusLabel(status: StrategyReminderStatus): string {
  switch (status.state) {
    case "off": return "Reminders are off for this organisation";
    case "none": return status.why === "no-date" ? "No reminder: no target date" : status.why === "not-live" ? "No reminder: only Agreed and In progress actions remind" : status.why === "passed" ? "No reminder: the target date has passed" : "No reminder";
    // The enqueue is an instant: the day it fell on in London, as every operating day here is.
    case "sent": return `Reminder sent to the owner on ${formatUkDate(londonDayOf(status.enqueuedAt))} for ${formatUkDate(status.dueDate)}`;
    case "scheduled": return status.blocked ? `Reminder due ${formatUkDate(status.remindOn)} will not send: ${reminderBlockLabels[status.blocked]}` : `Reminder to the owner on ${formatUkDate(status.remindOn)} (${status.leadDays} day${status.leadDays === 1 ? "" : "s"} before)`;
    case "due": return status.blocked ? `Reminder due now, not sent: ${reminderBlockLabels[status.blocked]}` : "Reminder goes to the owner on the next run";
  }
}

/**
 * The values a due-date reminder fills (R3) — every token the template declares. `ownerLine` is empty: the reminder is to
 * the owner, so naming them beneath the action would only tell them who they are.
 */
export function dueReminderValues(input: { firstName: string; clientName: string; actionTitle: string; dueDate: string; actionsLink: string }): Record<string, string> {
  return {
    firstName: input.firstName, clientName: input.clientName, strategyTitle: input.actionTitle,
    ownerLine: "", targetDate: formatUkDate(input.dueDate), actionsLink: input.actionsLink,
  };
}
