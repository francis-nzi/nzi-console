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

// Inline styles, because mail clients drop stylesheets. Deep Pine on white — the brand's own, and AA for button text.
const BUTTON = "display:inline-block;background:#0B7A4B;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:6px";
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
        `<p><a href="{{inviteLink}}" style="${BUTTON}">Set up your sign-in</a></p>`,
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
        `<p><a href="{{inviteLink}}" style="${BUTTON}">Set up your portal access</a></p>`,
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
        `<p><a href="{{resetLink}}" style="${BUTTON}">Choose a new password</a></p>`,
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
        `<p><a href="{{resetLink}}" style="${BUTTON}">Choose a new password</a></p>`,
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
        `<p><a href="{{threadLink}}" style="${BUTTON}">Read it in the portal</a></p>`,
        `<p style="${SMALL}">For your security the message itself is not in this email — it stays in the portal, behind your sign-in.</p>`,
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
export type EmailRenderResult = { ok: true; email: RenderedEmail } | { ok: false; issues: string[] };

/**
 * The one render of a templated email (R2, R4): subject, text and HTML from a key's content and the values a send supplies.
 *
 * **It refuses rather than guesses.** A value for a token the key does not declare; a token the content uses with no value;
 * a required token that is empty or absent from a part; a link that is not https; content that has drifted outside its
 * declared tokens — each is an issue, and nothing is rendered. Values are escaped into the HTML part and left as they are
 * in the text. The organisation's footer, when it has one, closes both parts.
 */
export function renderEmailTemplate(
  definition: MessageTemplateDefinition, content: MessageContent, values: Readonly<Record<string, string>>, options: { footer?: string | null } = {},
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
  const footer = options.footer?.trim() || null;
  const fragment = html === null ? linkedTextToHtml(content.body, values, definition) : renderMessageText(html, escaped);
  return {
    ok: true,
    email: {
      subject: renderMessageText(content.subject, values),
      text: renderMessageText(content.body, values) + (footer ? `\n\n--\n${footer}` : ""),
      html: emailHtmlDocument(fragment, footer),
    },
  };
}

/** The board's preview: the strict render against the key's **sample** values (F-Q2), so it shows exactly what a send would. */
export const previewEmailTemplate = (definition: MessageTemplateDefinition, content: MessageContent, footer?: string | null): EmailRenderResult =>
  renderEmailTemplate(definition, content, Object.fromEntries(definition.tokens.map((token) => [token.name, token.sample])), { footer });

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

/** The code-owned frame every HTML part is sent in: no tokens, nothing editable, the footer escaped. */
function emailHtmlDocument(fragment: string, footer: string | null): string {
  return [
    "<!doctype html>",
    '<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    // overflow-wrap: a single-use link is one long unbroken word, and on a phone it would run off the edge.
    '<body style="margin:0;padding:24px 16px;background:#ffffff;color:#0B1B2B;font-family:Inter,Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;overflow-wrap:anywhere;word-break:break-word">',
    '<div style="max-width:560px;margin:0 auto">',
    fragment,
    footer ? `<hr style="border:0;border-top:1px solid #e3e8ec;margin:24px 0 12px"><p style="color:#5b6875;font-size:12px">${escapeHtml(footer).replace(/\n/g, "<br>")}</p>` : "",
    "</div></body></html>",
  ].join("\n");
}
