/**
 * Message templates (admin Phase F1; ruled `phaseF-comms-crm-plan.md`, F-Q2/F-Q3/F-Q7): the wording behind the messages
 * the console sends, editable per organisation, over a **catalogue of keys governed here in code**.
 *
 * - **A key exists because a send-site uses it (F-Q3).** This registry is that list: each entry names the code that sends
 *   it, the tokens that code supplies, a sample of each for preview, and the built-in wording used when the organisation
 *   has saved none (or has deactivated its own). An admin edits a key's subject and body — never the key set.
 * - **Tokens are declared (F-Q2).** `{{token}}`, the name a declared one; anything else in a subject or body is refused,
 *   on the screen and by the command. A send fills every declared token, so nothing renders blank by accident.
 * - **Preview is samples only (F-Q2).** It renders the registry's sample values — never a real client's data.
 * - **No transport here (F-Q7).** Plain text, as the mailer sends it; who it is from and the footer belong to the
 *   organisation profile, not to a template.
 */

export const MESSAGE_TEMPLATE_CHANNELS = ["email"] as const;
export type MessageTemplateChannel = (typeof MESSAGE_TEMPLATE_CHANNELS)[number];
export const MESSAGE_TEMPLATE_SUBJECT_MAX = 200;
export const MESSAGE_TEMPLATE_BODY_MAX = 10_000;
export const MESSAGE_TEMPLATE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;

/** `required`: the body must use it — a message without it would fail at its one job (an invitation with no link). */
export type MessageToken = { name: string; description: string; sample: string; required?: boolean };
export type MessageTemplateDefinition = {
  key: string;
  label: string;
  /** Who receives it, and when. */
  purpose: string;
  channel: MessageTemplateChannel;
  /** The code that sends it — why the key exists. */
  sendSite: string;
  tokens: readonly MessageToken[];
  /** The built-in wording: what is sent when the organisation has no active template of its own. */
  builtIn: { subject: string; body: string };
  /**
   * v7's template this one takes its content from on import (load:v7-message-templates), and how v7's token names map
   * onto this key's. A v7 token with no mapping here refuses that template — never guessed.
   */
  v7?: { key: string; tokens: Readonly<Record<string, string>> };
};

const REMINDER_TOKENS: readonly MessageToken[] = [
  { name: "firstName", description: "The recipient's first name — or \"there\" when the contact has no name", sample: "Grace" },
  { name: "clientName", description: "The client whose reduction plan the action is in", sample: "Example Manufacturing Ltd" },
  { name: "strategyTitle", description: "The reduction action", sample: "Switch to LED lighting" },
  { name: "ownerLine", description: "A line \"Owner: …\" beneath the action — or nothing when the action has no owner", sample: "\nOwner: Sam Example" },
  { name: "targetDate", description: "The action's target date, dd/mm/yyyy", sample: "30/11/2026" },
];

export const MESSAGE_TEMPLATE_REGISTRY: readonly MessageTemplateDefinition[] = [
  {
    key: "strategy.reminder.approaching",
    label: "Reduction action — target date approaching",
    purpose: "To a client's consenting contacts, as a reduction action's target date comes within the reminder window.",
    channel: "email",
    sendSite: "The strategy reminder worker (nzi-console-reminders): strategyReminderWorker.ts → reminderMessage()",
    tokens: REMINDER_TOKENS,
    builtIn: {
      subject: "{{strategyTitle}} — target date approaching ({{targetDate}})",
      body: [
        "Hello {{firstName}},",
        "",
        "The target date for this action in {{clientName}}'s reduction plan is {{targetDate}}.",
        "",
        "Action: {{strategyTitle}}{{ownerLine}}",
        "Target date: {{targetDate}}",
        "",
        "If the date needs to move, or it is already done, let your consultant know.",
        "",
        "You can see your full plan in your client portal.",
        "",
        "— NZ Insights Pro",
      ].join("\n"),
    },
  },
  {
    key: "strategy.reminder.overdue",
    label: "Reduction action — target date passed",
    purpose: "To a client's consenting contacts, once a reduction action's target date has passed and it is not complete.",
    channel: "email",
    sendSite: "The strategy reminder worker (nzi-console-reminders): strategyReminderWorker.ts → reminderMessage()",
    tokens: REMINDER_TOKENS,
    builtIn: {
      subject: "{{strategyTitle}} — target date passed ({{targetDate}})",
      body: [
        "Hello {{firstName}},",
        "",
        "The target date for this action in {{clientName}}'s reduction plan was {{targetDate}}, and it is not yet marked complete.",
        "",
        "Action: {{strategyTitle}}{{ownerLine}}",
        "Target date: {{targetDate}}",
        "",
        "If it is done, your consultant can mark it complete. If the date needs to move, tell them — a date that has moved is more useful than a date that has passed.",
        "",
        "You can see your full plan in your client portal.",
        "",
        "— NZ Insights Pro",
      ].join("\n"),
    },
  },
  {
    key: "staff.invitation",
    label: "Staff sign-in invitation",
    purpose: "To a member of staff an admin invites from Platform & audit → Access, when the service may send mail.",
    channel: "email",
    sendSite: "Staff enrolment invitations: staffInvitations.ts → inviteStaffMember()",
    tokens: [
      { name: "link", description: "The single-use enrolment link", sample: "https://console.example.test/enrol#token=sample-token", required: true },
      { name: "expiresAt", description: "When the link expires", sample: "2026-10-04T09:00:00.000Z" },
    ],
    builtIn: {
      subject: "Set up your NZ Insights Pro sign-in",
      body: [
        "You have been invited to the NZ Insights Pro staff console.",
        "",
        "Set your own password and connect your authenticator here:",
        "{{link}}",
        "",
        "This link works once and expires at {{expiresAt}}. Nobody at NZI sees your password or your authenticator.",
        "If you were not expecting this, ignore it — nothing happens unless the link is used.",
      ].join("\n"),
    },
    // v7's staff invite carries a temporary password, which the console never issues: it maps only if v7's wording
    // uses none of it (load:v7-message-templates refuses it otherwise, and says which token).
    v7: { key: "team_member_invite", tokens: { invite_expires_at: "expiresAt" } },
  },
];

export const messageTemplateDefinition = (key: string): MessageTemplateDefinition | undefined =>
  MESSAGE_TEMPLATE_REGISTRY.find((definition) => definition.key === key);

// ── Tokens ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const TOKEN = /\{\{([^{}]*)\}\}/g;

/** The tokens a subject or body uses, in order, each once. */
export function tokensIn(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((match) => match[1]!))];
}

/**
 * What is wrong with a subject or body for this key: tokens it does not declare, and braces that are not a token. Empty
 * when it is sound. Never repeats the text itself — only token names.
 */
export function messageTemplateTokenIssues(text: string, definition: MessageTemplateDefinition): string[] {
  const declared = new Set(definition.tokens.map((token) => token.name));
  const issues: string[] = [];
  const unknown = tokensIn(text).filter((name) => !declared.has(name));
  if (unknown.length) issues.push(`${unknown.map((name) => `{{${name}}}`).join(", ")} ${unknown.length === 1 ? "is not a token" : "are not tokens"} this message supplies.`);
  if (/\{\{|\}\}/.test(text.replace(TOKEN, ""))) issues.push("A {{ or }} that is not part of a token — tokens are written {{name}}.");
  return issues;
}

/** The declared tokens a body must use and does not. */
export function messageTemplateRequiredIssues(body: string, definition: MessageTemplateDefinition): string[] {
  const used = new Set(tokensIn(body));
  return definition.tokens.filter((token) => token.required && !used.has(token.name)).map((token) => `The body must include {{${token.name}}} — ${token.description.toLowerCase()}.`);
}

/** The text with each declared token replaced by its value. A send supplies every declared token. */
export function renderMessageText(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(TOKEN, (whole, name: string) => Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : whole);
}

export type MessageContent = { subject: string; body: string };

/** Subject and body, rendered. */
export const renderMessage = (content: MessageContent, values: Readonly<Record<string, string>>): MessageContent =>
  ({ subject: renderMessageText(content.subject, values), body: renderMessageText(content.body, values) });

/** The preview: the content rendered against the key's **sample** values — never a real record's (F-Q2). */
export const previewMessage = (content: MessageContent, definition: MessageTemplateDefinition): MessageContent =>
  renderMessage(content, Object.fromEntries(definition.tokens.map((token) => [token.name, token.sample])));

/** What is sent: the organisation's active template when it has one, else the built-in wording. */
export const messageContentFor = (definition: MessageTemplateDefinition, saved: MessageContent | null): MessageContent => saved ?? definition.builtIn;
