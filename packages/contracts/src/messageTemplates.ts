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
 * - **No transport here (F-Q7).** Who it is from and the footer belong to the organisation profile, not to a template.
 *
 * ## HTML and text together (email programme phase 2, R2)
 *
 * A key with `htmlPart` carries an **HTML body beside the text**; the text stays the plain-text part, and a templated send
 * is always multipart, so every mail degrades to text. Without a saved HTML body the HTML part is made from the text
 * (`textToHtml`), so the two never say different things. `renderEmailTemplate` is the one render: the board's preview and
 * `sendTemplatedEmail` both call it, and it **refuses** — a missing or undeclared token, an empty required one, a link
 * that is not https — rather than send a half-rendered mail. Values are HTML-escaped into the HTML part, never the text.
 *
 * **No link is stored in a template (R5).** Links are tokens filled at send time; a template whose wording holds an
 * enrolment, reset or other single-use link is refused (`messageTemplateLinkIssues`).
 */

import type { OrganisationProfileFields } from "./adminOrganisation";
import type { EmailPerson } from "./staffSignature";

export const MESSAGE_TEMPLATE_CHANNELS = ["email"] as const;
export type MessageTemplateChannel = (typeof MESSAGE_TEMPLATE_CHANNELS)[number];
export const MESSAGE_TEMPLATE_SUBJECT_MAX = 200;
export const MESSAGE_TEMPLATE_BODY_MAX = 10_000;
export const MESSAGE_TEMPLATE_HTML_MAX = 50_000;
export const MESSAGE_TEMPLATE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;

/**
 * `required`: the body (and the HTML body) must use it — a message without it would fail at its one job (an invitation
 * with no link). `kind: "url"`: its value is a link, which a send refuses unless it is https.
 */
export type MessageToken = { name: string; description: string; sample: string; required?: boolean; kind?: "url" };
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
  builtIn: { subject: string; body: string; html?: string };
  /**
   * Whether the message is sent as HTML and text through `sendTemplatedEmail` (phase 2), so its HTML body can be edited.
   * Absent: its send-site sends plain text through the mailer, and an HTML body would never be sent — so it has none.
   */
  htmlPart?: true;
  /**
   * v7's template this one takes its content from on import (load:v7-message-templates), and how v7's token names map
   * onto this key's. A v7 token with no mapping here refuses that template — never guessed.
   */
  v7?: { key: string; tokens: Readonly<Record<string, string>> };
};

// Inline styles, because mail clients drop stylesheets. Buttons are the frame's (`<a class="cta">`, phase 5-1), not inline here.
const SMALL = "color:#5b6875;font-size:13px";

const REMINDER_TOKENS: readonly MessageToken[] = [
  { name: "firstName", description: "The recipient's first name — or \"there\" when the contact has no name", sample: "Grace" },
  { name: "clientName", description: "The client whose reduction plan the action is in", sample: "Example Manufacturing Ltd" },
  { name: "strategyTitle", description: "The reduction action", sample: "Switch to LED lighting" },
  { name: "ownerLine", description: "A line \"Owner: …\" beneath the action — or nothing when the action has no owner", sample: "\nOwner: Sam Example" },
  { name: "targetDate", description: "The action's target date, dd/mm/yyyy", sample: "30/11/2026" },
];

export const MESSAGE_TEMPLATE_REGISTRY: readonly MessageTemplateDefinition[] = [
  {
    // Actions A3: re-pointed from the consenting-contacts reminder to the action's owner, on the reminder lead, through
    // sendTemplatedEmail — so it is sent in the house frame, and signed by the client's adviser. Its tokens are the old
    // ones plus the portal link, so wording an organisation saved before A3 still renders.
    key: "strategy.reminder.approaching",
    label: "Reduction action — reminder to its owner before the target date",
    purpose: "To the action's owner (a client contact who has consented to email), the reminder lead before its target date — 7 days unless Admin or the action sets another. Agreed and In progress actions only; once per target date.",
    channel: "email",
    sendSite: "The due-date reminder scan in the worker tick (Actions A3): dueReminders.ts → sendTemplatedEmail, attributed to the client's adviser",
    tokens: [
      ...REMINDER_TOKENS,
      { name: "actionsLink", description: "A link to the plan in the client portal, where the owner updates the action (sign-in still required)", sample: "https://console.example.test/portal", kind: "url" },
    ],
    builtIn: {
      subject: "{{strategyTitle}} — due {{targetDate}}",
      body: [
        "Hello {{firstName}},",
        "",
        "You are the owner of this action in {{clientName}}'s reduction plan, and its target date is coming up.",
        "",
        "Action: {{strategyTitle}}",
        "Target date: {{targetDate}}",
        "",
        "You can update its progress — or its date, if it needs to move — in your client portal:",
        "{{actionsLink}}",
        "",
        "If it is already done, mark it complete there, or let your adviser know.",
      ].join("\n"),
      html: [
        "<p>Hello {{firstName}},</p>",
        "<p>You are the owner of this action in <b>{{clientName}}</b>'s reduction plan, and its target date is coming up.</p>",
        "<p><b>{{strategyTitle}}</b><br>Target date: {{targetDate}}</p>",
        "<p>You can update its progress — or its date, if it needs to move — in your client portal.</p>",
        `<a class="cta" href="{{actionsLink}}">Open your plan</a>`,
        `<p style="${SMALL}">If it is already done, mark it complete there, or let your adviser know.</p>`,
      ].join("\n"),
    },
    htmlPart: true,
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
    purpose: "To a member of staff an admin invites, or reinvites, from Admin → Team & access.",
    channel: "email",
    sendSite: "Staff invitations from Admin → Team & access: staffInvitations.ts → inviteStaffMember(), through sendTemplatedEmail (phase 3)",
    tokens: [
      // `inviteLink`, as every invite's is (phase 3, R4). It was `link` until 0180, which rewrote saved wording to match.
      { name: "inviteLink", description: "The single-use enrolment link", sample: "https://console.example.test/enrol#token=sample-token", required: true, kind: "url" },
      { name: "expiresAt", description: "When the link expires", sample: "Friday 30 October 2026, 17:00" },
    ],
    builtIn: {
      subject: "Set up your NZ Insights Pro sign-in",
      body: [
        "You have been invited to the NZ Insights Pro staff console.",
        "",
        "Set your own password and connect your authenticator here:",
        "{{inviteLink}}",
        "",
        "This link works once and expires at {{expiresAt}}. Nobody at NZI sees your password or your authenticator.",
        "If you were not expecting this, ignore it — nothing happens unless the link is used.",
      ].join("\n"),
      html: [
        "<p>You have been invited to the NZ Insights Pro staff console.</p>",
        `<a class="cta" href="{{inviteLink}}">Set up your sign-in</a>`,
        `<p style="${SMALL}">Or copy this link into your browser: {{inviteLink}}</p>`,
        "<p>This link works once and expires at {{expiresAt}}. Nobody at NZI sees your password or your authenticator.</p>",
        `<p style="${SMALL}">If you were not expecting this, ignore it — nothing happens unless the link is used.</p>`,
      ].join("\n"),
    },
    htmlPart: true,
    // v7's staff invite carries a temporary password, which the console never issues: it maps only if v7's wording
    // uses none of it (load:v7-message-templates refuses it otherwise, and says which token).
    v7: { key: "team_member_invite", tokens: { invite_expires_at: "expiresAt" } },
  },
  {
    key: "portal.access.invite",
    label: "Client portal access invitation",
    purpose: "To a client contact given access to their organisation's client portal, with a single-use link to set their own password and authenticator.",
    channel: "email",
    sendSite: "Portal access invitations: portalAccess.ts, through sendTemplatedEmail (phase 4)",
    tokens: [
      { name: "displayName", description: "The invitee's name, as the portal user record holds it", sample: "Grace Example" },
      { name: "clientName", description: "The client organisation the access is for", sample: "Example Manufacturing Ltd" },
      { name: "senderName", description: "The NZI adviser who granted the access", sample: "Sam Adviser" },
      { name: "inviteLink", description: "The single-use link to set a password and connect an authenticator", sample: "https://console.example.test/portal/accept#token=sample-token", required: true, kind: "url" },
      { name: "expiresAt", description: "When the link expires", sample: "Friday 30 October 2026, 17:00" },
    ],
    builtIn: {
      subject: "Your NZ Insights Pro client portal access for {{clientName}}",
      body: [
        "Hello {{displayName}},",
        "",
        "{{senderName}} at Net Zero International has given you access to {{clientName}}'s client portal in NZ Insights Pro.",
        "",
        "Set your own password and connect your authenticator here:",
        "{{inviteLink}}",
        "",
        "This link works once and expires at {{expiresAt}}. Nobody at NZI sees your password or your authenticator.",
        "If you were not expecting this, ignore it — nothing happens unless the link is used.",
      ].join("\n"),
      html: [
        "<p>Hello {{displayName}},</p>",
        "<p>{{senderName}} at Net Zero International has given you access to <b>{{clientName}}</b>'s client portal in NZ Insights Pro.</p>",
        `<a class="cta" href="{{inviteLink}}">Set up your portal access</a>`,
        `<p style="${SMALL}">Or copy this link into your browser: {{inviteLink}}</p>`,
        "<p>This link works once and expires at {{expiresAt}}. Nobody at NZI sees your password or your authenticator.</p>",
        `<p style="${SMALL}">If you were not expecting this, ignore it — nothing happens unless the link is used.</p>`,
      ].join("\n"),
    },
    htmlPart: true,
  },
  {
    key: "password.reset.staff",
    label: "Staff password reset",
    purpose: "To a member of staff who asked to reset their password, with a single-use reset link.",
    channel: "email",
    sendSite: "Staff password reset: the staff sign-in's Forgot password, through sendTemplatedEmail (phase 4)",
    tokens: [
      { name: "displayName", description: "The member of staff's name", sample: "Sam Adviser" },
      { name: "resetLink", description: "The single-use link to choose a new password", sample: "https://console.example.test/reset#token=sample-token", required: true, kind: "url" },
      { name: "expiresAt", description: "When the link expires", sample: "Friday 30 October 2026, 17:00" },
    ],
    builtIn: {
      subject: "Reset your NZ Insights Pro password",
      body: [
        "Hello {{displayName}},",
        "",
        "Someone asked to reset the password for your NZ Insights Pro staff account. If it was you, choose a new password here:",
        "{{resetLink}}",
        "",
        "This link works once and expires at {{expiresAt}}. Your authenticator is unchanged — you will still need it to sign in.",
        "If you did not ask for this, ignore this email: your password stays as it is.",
      ].join("\n"),
      html: [
        "<p>Hello {{displayName}},</p>",
        "<p>Someone asked to reset the password for your NZ Insights Pro staff account. If it was you, choose a new password:</p>",
        `<a class="cta" href="{{resetLink}}">Choose a new password</a>`,
        `<p style="${SMALL}">Or copy this link into your browser: {{resetLink}}</p>`,
        "<p>This link works once and expires at {{expiresAt}}. Your authenticator is unchanged — you will still need it to sign in.</p>",
        `<p style="${SMALL}">If you did not ask for this, ignore this email: your password stays as it is.</p>`,
      ].join("\n"),
    },
    htmlPart: true,
  },
  {
    key: "password.reset.portal",
    label: "Client portal password reset",
    purpose: "To a client portal user who asked to reset their password, with a single-use reset link.",
    channel: "email",
    sendSite: "Portal password reset: the client portal sign-in's Forgot password, through sendTemplatedEmail (phase 4)",
    tokens: [
      { name: "displayName", description: "The portal user's name", sample: "Grace Example" },
      { name: "resetLink", description: "The single-use link to choose a new password", sample: "https://console.example.test/portal/reset#token=sample-token", required: true, kind: "url" },
      { name: "expiresAt", description: "When the link expires", sample: "Friday 30 October 2026, 17:00" },
    ],
    builtIn: {
      subject: "Reset your NZ Insights Pro client portal password",
      body: [
        "Hello {{displayName}},",
        "",
        "Someone asked to reset the password for your NZ Insights Pro client portal account. If it was you, choose a new password here:",
        "{{resetLink}}",
        "",
        "This link works once and expires at {{expiresAt}}. Your authenticator is unchanged — you will still need it to sign in.",
        "If you did not ask for this, ignore this email: your password stays as it is. If it keeps happening, tell your adviser at NZI.",
      ].join("\n"),
      html: [
        "<p>Hello {{displayName}},</p>",
        "<p>Someone asked to reset the password for your NZ Insights Pro client portal account. If it was you, choose a new password:</p>",
        `<a class="cta" href="{{resetLink}}">Choose a new password</a>`,
        `<p style="${SMALL}">Or copy this link into your browser: {{resetLink}}</p>`,
        "<p>This link works once and expires at {{expiresAt}}. Your authenticator is unchanged — you will still need it to sign in.</p>",
        `<p style="${SMALL}">If you did not ask for this, ignore this email: your password stays as it is. If it keeps happening, tell your adviser at NZI.</p>`,
      ].join("\n"),
    },
    htmlPart: true,
  },
  {
    key: "message.notification",
    label: "New portal message notification",
    purpose: "To a client portal user when there is a new message for them in the portal. The message itself is never in the email — it stays in the portal.",
    channel: "email",
    sendSite: "Portal messages: a new message on the portal thread, through sendTemplatedEmail (phase 4)",
    // Deliberately no token for the message, its author or its subject (design R10): the content stays in the portal.
    tokens: [
      { name: "displayName", description: "The portal user's name", sample: "Grace Example" },
      { name: "clientName", description: "The client organisation the thread belongs to", sample: "Example Manufacturing Ltd" },
      { name: "threadLink", description: "A link to the thread in the portal (sign-in still required)", sample: "https://console.example.test/portal/messages", required: true, kind: "url" },
    ],
    builtIn: {
      subject: "New message in your {{clientName}} client portal",
      body: [
        "Hello {{displayName}},",
        "",
        "There is a new message for {{clientName}} in your NZ Insights Pro client portal.",
        "",
        "Read and reply in the portal:",
        "{{threadLink}}",
        "",
        "For your security the message itself is not in this email — it stays in the portal, behind your sign-in.",
      ].join("\n"),
      html: [
        "<p>Hello {{displayName}},</p>",
        "<p>There is a new message for <b>{{clientName}}</b> in your NZ Insights Pro client portal.</p>",
        `<a class="cta" href="{{threadLink}}">Read it in the portal</a>`,
        `<p style="${SMALL}">For your security the message itself is not in this email — it stays in the portal, behind your sign-in.</p>`,
      ].join("\n"),
    },
    htmlPart: true,
  },
  {
    // Data entry D3 (R6): reopen after submit is a request to the CRM, never a self-serve recall.
    key: "portal.data.reopen-request",
    label: "Client portal — a client asks to reopen a reviewed entry",
    purpose: "To the CRM (the job's owner, else the client's adviser) when a client asks, from the portal, to reopen an entry that has been reviewed. The client's reason stays on the job, not in the email; the CRM reopens the entry by editing it.",
    channel: "email",
    sendSite: "The portal's Ask to reopen on a reviewed entry: portalReopenRequests.ts → requestScopeRowReopen(), through sendTemplatedEmail",
    // No token for the reason (as the portal's own messages, design R10): it is the client's words about their data, read on the job.
    tokens: [
      { name: "firstName", description: "The CRM's first name — or \"there\" when their record has no name", sample: "Sam" },
      { name: "clientName", description: "The client whose entry it is", sample: "Example Manufacturing Ltd" },
      { name: "jobNumber", description: "The job the entry is on", sample: "J000612" },
      { name: "entryLabel", description: "The entry, as its row is labelled", sample: "Office supplies" },
      { name: "requestedBy", description: "The portal user who asked", sample: "Grace Example" },
      { name: "jobLink", description: "A link to the job in the console, where the request and its reason are (sign-in still required)", sample: "https://console.example.test/jobs/job-1", required: true, kind: "url" },
    ],
    builtIn: {
      subject: "{{clientName}} asks to reopen an entry on {{jobNumber}}",
      body: [
        "Hello {{firstName}},",
        "",
        "{{requestedBy}} at {{clientName}} has asked to reopen an entry on {{jobNumber}} that has already been reviewed:",
        "",
        "{{entryLabel}}",
        "",
        "Their reason is on the job. To reopen it, edit the entry — it returns to pending for review:",
        "{{jobLink}}",
      ].join("\n"),
      html: [
        "<p>Hello {{firstName}},</p>",
        "<p>{{requestedBy}} at <b>{{clientName}}</b> has asked to reopen an entry on {{jobNumber}} that has already been reviewed:</p>",
        "<p><b>{{entryLabel}}</b></p>",
        "<p>Their reason is on the job. To reopen it, edit the entry — it returns to pending for review.</p>",
        `<a class="cta" href="{{jobLink}}">Open the job</a>`,
      ].join("\n"),
    },
    htmlPart: true,
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

/** `html`: the HTML body, for a key with `htmlPart`; absent or null, the HTML part is made from the text. */
export type MessageContent = { subject: string; body: string; html?: string | null };

/** Subject and body, rendered. */
export const renderMessage = (content: MessageContent, values: Readonly<Record<string, string>>): MessageContent =>
  ({ subject: renderMessageText(content.subject, values), body: renderMessageText(content.body, values) });

/** The preview: the content rendered against the key's **sample** values — never a real record's (F-Q2). */
export const previewMessage = (content: MessageContent, definition: MessageTemplateDefinition): MessageContent =>
  renderMessage(content, Object.fromEntries(definition.tokens.map((token) => [token.name, token.sample])));

/** What is sent: the organisation's active template when it has one, else the built-in wording. */
export const messageContentFor = (definition: MessageTemplateDefinition, saved: MessageContent | null): MessageContent => saved ?? definition.builtIn;

// ── HTML, and the strict render (email programme phase 2) ──────────────────────────────────────────────────────────

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The text as HTML: paragraphs on blank lines, line breaks kept, everything escaped. The HTML part of a text-only template. */
export function textToHtml(text: string): string {
  return text.split(/\n{2,}/).map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join("\n");
}

/**
 * Markup an HTML body may not hold: anything that runs, embeds or submits. Mail clients strip most of it, but the board's
 * preview shows the body to other admins, and a template is not a place for active content.
 */
export function messageTemplateHtmlIssues(html: string): string[] {
  const issues: string[] = [];
  if (/<\s*(script|iframe|object|embed|form|base|meta|link)\b/i.test(html)) issues.push("An HTML body may not contain script, iframe, object, embed, form, base, meta or link elements.");
  if (/\son[a-z]+\s*=/i.test(html)) issues.push("An HTML body may not contain event handlers (onclick=, onload= and the like).");
  if (/\b(?:href|src)\s*=\s*["']?\s*(?:javascript|vbscript|data)\s*:/i.test(html)) issues.push("An HTML body may not contain javascript:, vbscript: or data: links.");
  return issues;
}

/**
 * R5: a template holds copy and tokens, never a live link. A single-use link pasted into the wording would be stored at
 * rest and sent to everyone who receives the message — so wording with an enrolment, reset or other token-bearing link is
 * refused; the link is a token, filled at send time.
 */
export function messageTemplateLinkIssues(text: string): string[] {
  return /https?:\/\/[^\s"'<>]*(?:token=|\/enrol\b|\/accept\b|\/reset\b)/i.test(text)
    ? ["A single-use link cannot be written into a template — use the message's link token, which is filled when it is sent."]
    : [];
}

/** A link a send may put in a mail: https, or http to this machine for local development. */
const isSendableLink = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch { return false; }
};

export type RenderedEmail = { subject: string; text: string; html: string };

// ── The house signature chrome (email programme phase 5-1) ─────────────────────────────────────────────────────────

/** A logo in the signature: an absolute URL a mail client can fetch with no session. `width` when it is known, so Outlook sizes it. */
export type EmailLogo = { url: string; alt: string; width: number | null };

/**
 * The fixed house signature that closes every templated email (R1): from Organisation settings (0184) through
 * {@link emailBrandFor}, with the house standard as built-in defaults so it is right before anyone fills anything in.
 * It is the organisation's chrome only — no sign-off, no person (R5): the personal lines are 5-2.
 */
export type EmailBrand = {
  /** The company, bold — "Net Zero International". Null: no signature at all (a frame with no organisation behind it). */
  company: string | null;
  /** Side by side beneath the company — the NZI logo, then the CPD Member badge. Empty: no logo row. */
  logos: EmailLogo[];
  /** "Website: netzero.international", linked. */
  website: { href: string; label: string } | null;
  /** The confidentiality (GDPR) block that closes the email. */
  notice: string | null;
  /**
   * The personal lines (phase 5-2) — sign-off, name, title above the company; Email and Mobile UK beside the website — for
   * an email attributed to a member. Absent or null: the organisation's chrome only, as every system email is (R3).
   */
  person?: EmailPerson | null;
};

/** The button: NZI Deep Pine, which white text reads on at 5.4 : 1. Code-owned, like the rest of the frame. */
export const EMAIL_BUTTON_COLOUR = "#0B7A4B";
export const DEFAULT_EMAIL_WEBSITE = "https://netzero.international";
/** The house GDPR confidentiality block, verbatim (Francis, 26 Oct 2026). */
export const DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE = "Under the General Data Protection Regulation (GDPR) (EU) 2016/679, we have a legal duty to protect "
  + "any information we collect from you. Information contained in this email and any attachments may be privileged or confidential and intended "
  + "for the exclusive use of the original recipient. If you have received this email by mistake, please advise the sender immediately and delete "
  + "the email, including emptying your deleted items.";
/** The NZI logo, as a PNG (Outlook cannot show WebP), served publicly from the console's own origin. 1428 × 600. */
export const EMAIL_LOGO_PATH = "/brand/netzero-logo.png";
const DEFAULT_ORGANISATION_NAME = "Net Zero International";
/** Every logo is drawn at this height, side by side; the built-in one's width follows from its 1428 × 600. */
const LOGO_HEIGHT = 48;
const BUILT_IN_LOGO_WIDTH = Math.round((LOGO_HEIGHT * 1428) / 600);

type BrandProfile = Pick<OrganisationProfileFields, "legalName" | "displayName" | "websiteUrl" | "emailLogoUrl" | "emailBadgeUrl" | "emailConfidentialityNotice">;

/**
 * The house signature from the organisation profile and the console's origin (R3). Every value falls back rather than
 * failing (R4): no profile, no origin, no badge — the signature still closes the mail, and the send still goes. A logo
 * that cannot be had is left out, never drawn as a broken image; the company name above it carries the identity.
 */
export function emailBrandFor(profile: BrandProfile | null, origin: string | null): EmailBrand {
  const company = profile?.displayName ?? profile?.legalName ?? DEFAULT_ORGANISATION_NAME;
  const nzi: EmailLogo | null = profile?.emailLogoUrl ? { url: profile.emailLogoUrl, alt: company, width: null } : builtInLogo(origin, company);
  const badge: EmailLogo | null = profile?.emailBadgeUrl ? { url: profile.emailBadgeUrl, alt: "CPD Member", width: null } : null;
  return {
    company,
    logos: [nzi, badge].filter((logo): logo is EmailLogo => logo !== null),
    website: websiteLink(profile?.websiteUrl ?? DEFAULT_EMAIL_WEBSITE),
    notice: profile?.emailConfidentialityNotice ?? DEFAULT_EMAIL_CONFIDENTIALITY_NOTICE,
  };
}

/** The built-in logo at the console's origin — https only, since a mail client will not load anything else (localhost aside, for previews). */
const builtInLogo = (origin: string | null, alt: string): EmailLogo | null => {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" || url.hostname === "localhost" ? { url: `${url.origin}${EMAIL_LOGO_PATH}`, alt, width: BUILT_IN_LOGO_WIDTH } : null;
  } catch { return null; }
};

/** The website as the signature shows it — `netzero.international`, linked to the address itself. */
const websiteLink = (address: string) => {
  try {
    const url = new URL(address);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return { href: url.href, label: `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}` };
  } catch { return null; }
};

/** The frame with no organisation behind it: the one footer line given (if any) as the signature, nothing else. */
const plainBrand = (footer: string | null | undefined): EmailBrand => ({ company: footer?.trim() || null, logos: [], website: null, notice: null });

/**
 * The signature as plain text — the person's sign-off and lines when there is one, then the company, the website and their
 * contact lines, then the confidentiality block — so the text part is complete alone.
 */
const signatureText = (brand: EmailBrand) => {
  const person = brand.person ?? null;
  const lines = (values: Array<string | null | undefined>) => values.filter((line): line is string => Boolean(line)).join("\n");
  const parts = [
    person ? person.signOff : "",
    lines([person?.name, person?.title, brand.company, brand.website ? `Website: ${brand.website.label}` : null,
      person?.email ? `Email: ${person.email}` : null, person?.mobile ? `Mobile UK: ${person.mobile}` : null]),
    brand.notice ?? "",
  ].filter(Boolean);
  return parts.length ? `\n\n--\n${parts.join("\n\n")}` : "";
};
export type EmailRenderResult = { ok: true; email: RenderedEmail } | { ok: false; issues: string[] };

/**
 * The one render of a templated email (R2, R4): subject, text and HTML from a key's content and the values a send supplies.
 *
 * **It refuses rather than guesses.** A value for a token the key does not declare; a token the content uses with no value;
 * a required token that is empty or absent from a part; a link that is not https; content that has drifted outside its
 * declared tokens — each is an issue, and nothing is rendered. Values are escaped into the HTML part and left as they are
 * in the text. The organisation's footer, when it has one, closes both parts.
 *
 * Both parts close with the house signature (phase 5-1) when a `brand` is given — `emailBrandFor`, from Organisation
 * settings — and otherwise with only the `footer` line. Branding never refuses: the strict part is the wording and the
 * values, as before.
 */
export function renderEmailTemplate(
  definition: MessageTemplateDefinition, content: MessageContent, values: Readonly<Record<string, string>>,
  options: { brand?: EmailBrand; footer?: string | null } = {},
): EmailRenderResult {
  const issues: string[] = [];
  const declared = new Map(definition.tokens.map((token) => [token.name, token]));
  const html = content.html ?? null;
  const parts = [content.subject, content.body, ...(html === null ? [] : [html])];

  const unknown = Object.keys(values).filter((name) => !declared.has(name));
  if (unknown.length) issues.push(`${unknown.map((name) => `{{${name}}}`).join(", ")} ${unknown.length === 1 ? "is not a token" : "are not tokens"} this message supplies.`);
  for (const part of parts) issues.push(...messageTemplateTokenIssues(part, definition));
  issues.push(...messageTemplateRequiredIssues(content.body, definition));
  if (html !== null) issues.push(...messageTemplateRequiredIssues(html, definition).map((issue) => issue.replace("The body", "The HTML body")));
  const used = new Set(parts.flatMap(tokensIn));
  for (const token of definition.tokens) {
    const value = values[token.name];
    const has = Object.prototype.hasOwnProperty.call(values, token.name) && typeof value === "string";
    if (used.has(token.name) && !has) issues.push(`No value for {{${token.name}}} — ${token.description.toLowerCase()}.`);
    else if (has && token.required && value!.trim() === "") issues.push(`{{${token.name}}} is required and is empty.`);
    else if (has && token.kind === "url" && value!.trim() !== "" && !isSendableLink(value!)) issues.push(`{{${token.name}}} must be an https link.`);
  }
  if (issues.length) return { ok: false, issues: [...new Set(issues)] };

  const escaped = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, escapeHtml(value)]));
  const brand = options.brand ?? plainBrand(options.footer);
  const fragment = html === null ? linkedTextToHtml(content.body, values, definition) : renderMessageText(html, escaped);
  const subject = renderMessageText(content.subject, values);
  return {
    ok: true,
    email: {
      subject,
      // The plain-text part is the message as written, then the signature — the graceful fallback, and complete on its own.
      text: renderMessageText(content.body, values) + signatureText(brand),
      html: brandedEmailDocument(fragment, brand, subject),
    },
  };
}

/** The board's preview: the strict render against the key's **sample** values (F-Q2), so it shows exactly what a send would. */
export const previewEmailTemplate = (definition: MessageTemplateDefinition, content: MessageContent, branding?: EmailBrand | string | null): EmailRenderResult =>
  renderEmailTemplate(definition, content, Object.fromEntries(definition.tokens.map((token) => [token.name, token.sample])),
    typeof branding === "object" && branding !== null ? { brand: branding } : { footer: branding ?? null });

/**
 * The HTML part of a template with none of its own: the text, escaped, with each link token's value made a link — a reset
 * mail whose link cannot be clicked would be the text part with extra steps. The link stands in as a marker no escaping
 * touches, then is put back as an anchor whose href and text are both escaped.
 */
function linkedTextToHtml(body: string, values: Readonly<Record<string, string>>, definition: MessageTemplateDefinition): string {
  const links: string[] = [];
  const marked = Object.fromEntries(Object.entries(values).map(([name, value]) => {
    // A value cannot forge a marker: the marker character is not something a name or a date carries.
    if (definition.tokens.find((token) => token.name === name)?.kind !== "url" || value.trim() === "") return [name, value.replace(/\u0000/g, "")];
    links.push(value);
    return [name, `\u0000${links.length - 1}\u0000`];
  }));
  return textToHtml(renderMessageText(body, marked))
    .replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => { const link = escapeHtml(links[Number(index)]!); return `<a href="${link}">${link}</a>`; });
}

const FONT = "Arial,Helvetica,sans-serif";
// LINK: the house signature's website link, the blue its mail client draws.
const INK = "#1C2B26", MUTED = "#6B7A75", LINK = "#2F6F9E";

/**
 * A link the author marked `<a class="cta" href="…">Label</a>` becomes a bulletproof button: a VML rounded rectangle for
 * Outlook's Word renderer, and an inline-styled link in a table cell for everything else — so it is a button in every
 * client, not only those that honour CSS on links. A surrounding `<p>` is dropped (a table cannot sit inside one).
 */
function ctaButtons(fragment: string, colour: string): string {
  return fragment.replace(/(?:<p>\s*)?<a\s+([^>]*\bclass="cta"[^>]*)>([\s\S]*?)<\/a>(?:\s*<\/p>)?/g, (whole, attributes: string, label: string) => {
    const href = /\bhref="([^"]*)"/.exec(attributes)?.[1];
    if (!href) return whole;
    const text = label.replace(/<[^>]*>/g, "").trim();
    const width = Math.max(200, Math.min(420, text.length * 9 + 56));
    return [
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 18px"><tr><td align="center" bgcolor="${colour}" style="border-radius:6px;background:${colour}">`,
      `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:44px;v-text-anchor:middle;width:${width}px" arcsize="14%" stroke="f" fillcolor="${colour}"><w:anchorlock/><center style="color:#ffffff;font-family:${FONT};font-size:15px;font-weight:bold">${text}</center></v:roundrect><![endif]-->`,
      `<!--[if !mso]><!--><a href="${href}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:bold;line-height:20px;color:#ffffff;text-decoration:none;border-radius:6px;background:${colour}">${label}</a><!--<![endif]-->`,
      "</td></tr></table>",
    ].join("");
  });
}

/**
 * Body typography, inline — Outlook does not inherit a table cell's font into a paragraph. A paragraph gets the body style
 * ahead of any of its own; a plain link takes the brand colour. Nothing else in the author's markup is touched.
 */
function bodyTypography(fragment: string, colour: string): string {
  const base = `margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.55;color:${INK}`;
  return fragment
    .replace(/<p(\s+style="([^"]*)")?>/g, (_whole, _attr: string | undefined, own: string | undefined) => `<p style="${base}${own ? `;${own}` : ""}">`)
    .replace(/<a\s+href="([^"]*)">/g, (_whole, href: string) => `<a href="${href}" style="color:${colour};word-break:break-all">`);
}

/**
 * The house signature chrome (R1), in the same inline, table-based markup as the rest: the company in bold; the logos side by
 * side, each at the same height (a table row, since Outlook ignores flex and floats); the website, linked; and the GDPR
 * confidentiality block, set small beneath a rule. Every value escaped. Empty when there is nothing to sign with.
 */
function signatureHtml(brand: EmailBrand): string {
  const text = `font-family:${FONT};color:${INK}`;
  const logos = brand.logos.map((logo, index) => {
    const size = logo.width === null ? `height="${LOGO_HEIGHT}"` : `width="${logo.width}" height="${LOGO_HEIGHT}"`;
    const style = `display:block;height:${LOGO_HEIGHT}px;${logo.width === null ? "width:auto" : `width:${logo.width}px`};border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:12px;color:${MUTED}`;
    return `<td valign="middle" style="padding:0 ${index === brand.logos.length - 1 ? 0 : 16}px 0 0"><img src="${escapeHtml(logo.url)}" ${size} alt="${escapeHtml(logo.alt)}" style="${style}"></td>`;
  }).join("");
  const person = brand.person ?? null;
  const link = (href: string, label: string) => `<a href="${escapeHtml(href)}" style="color:${LINK};text-decoration:underline">${escapeHtml(label)}</a>`;
  // The contact lines: the organisation's website, then — on a member's email — their address and mobile (5-2).
  const contact = [
    brand.website ? `Website: ${link(brand.website.href, brand.website.label)}` : null,
    person?.email ? `Email: ${link(`mailto:${person.email}`, person.email)}` : null,
    person?.mobile ? `Mobile UK: ${escapeHtml(person.mobile)}` : null,
  ].filter((line): line is string => line !== null);
  const rows = [
    person
      ? `<p style="margin:0 0 14px;${text};font-size:14px;line-height:1.5">${escapeHtml(person.signOff)}</p>`
        + `<p style="margin:0;${text};font-size:14px;line-height:1.5">${escapeHtml(person.name)}</p>`
        + (person.title ? `<p style="margin:0;${text};font-size:14px;line-height:1.5">${escapeHtml(person.title)}</p>` : "")
      : "",
    brand.company ? `<p style="margin:${person ? "2px 0 0" : 0};${text};font-size:14px;line-height:1.5;font-weight:bold">${escapeHtml(brand.company)}</p>` : "",
    logos ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:12px 0 10px"><tr>${logos}</tr></table>` : "",
    contact.length ? `<p style="margin:${logos ? 0 : "6px 0 0"};${text};font-size:12px;line-height:1.7">${contact.join("<br>")}</p>` : "",
    brand.notice
      ? `<p style="margin:16px 0 0;padding-top:12px;border-top:1px solid #E6ECE9;font-family:${FONT};font-size:11px;line-height:1.5;color:${MUTED}">${escapeHtml(brand.notice)}</p>`
      : "",
  ].join("");
  return rows ? `<tr><td style="padding:8px 32px 28px;font-family:${FONT};font-size:13px;color:${INK}">${rows}</td></tr>` : "";
}

/** The signature alone in the same frame — the account page's preview of a member's lines in the house chrome (5-2). */
export const emailSignatureDocument = (brand: EmailBrand): string => brandedEmailDocument("", brand, "Your email signature");

/**
 * The code-owned frame every HTML part is sent in (phase 5-1): real HTML email, not web HTML — a table layout, every style
 * inline, no stylesheet and no web font, the logos at absolute URLs — so it holds in Outlook (MSO), Gmail and Apple Mail. A
 * clean body with the link drawn as a bulletproof button, then the house signature chrome. No banner header (the house
 * standard is signature-led). No tokens, nothing an admin edits.
 */
function brandedEmailDocument(fragment: string, brand: EmailBrand, subject: string): string {
  const colour = EMAIL_BUTTON_COLOUR;
  return [
    "<!doctype html>",
    '<html lang="en-GB" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">',
    `<title>${escapeHtml(subject)}</title>`,
    "<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]--></head>",
    // overflow-wrap: a single-use link is one long unbroken word, and on a phone it would run off the edge.
    `<body style="margin:0;padding:0;background:#EEF2F0;word-break:break-word;overflow-wrap:anywhere">`,
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#EEF2F0" style="background:#EEF2F0"><tr><td align="center" style="padding:24px 12px">`,
    `<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" bgcolor="#FFFFFF" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid #E3E8E6;border-radius:10px">`,
    `<tr><td style="padding:28px 32px 4px;font-family:${FONT};font-size:15px;line-height:1.55;color:${INK}">${bodyTypography(ctaButtons(fragment, colour), colour)}</td></tr>`,
    signatureHtml(brand),
    "</table>",
    "</td></tr></table></body></html>",
  ].join("\n");
}
