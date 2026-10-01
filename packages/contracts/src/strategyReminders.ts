import { messageContentFor, messageTemplateDefinition, renderMessage, type MessageContent } from "./messageTemplates";
import { strategyDeadline, type ClientStrategy, type StrategyDeadline } from "./reductionStrategies";

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
    if (kind === null) continue;
    // Narrowed by `reminderKindFor`, but read from the branch so the date is the one the
    // deadline is about rather than one assumed to match.
    if (!("targetDate" in deadline)) continue;
    claims.push({ clientStrategyId: strategy.id, kind, targetDate: deadline.targetDate.slice(0, 10) });
  }
  return claims;
}
