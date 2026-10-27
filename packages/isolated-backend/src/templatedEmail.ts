import { emailBrandFor, messageContentFor, messageTemplateDefinition, renderEmailTemplate } from "@nzi/contracts";
import { sendEmail, type EmailRequest } from "./email";
import { readActiveMessageTemplate } from "./messageTemplates";
import { readEmailBrandProfile } from "./organisationSettings";
import { emailPersonForMember } from "./staffSignature";
import type { Queryable } from "./postgres";

/**
 * Render a message template and queue it (email programme phase 2, R4). The invite and reset flows (phases 3–4) call this
 * with the link they have just minted; nothing else about the send is theirs to compose.
 *
 * - **The wording** is the organisation's active template for the key, else the registry's built-in (`messageContentFor`).
 * - **The render refuses** (`renderEmailTemplate`): an undeclared token, a token with no value, an empty required one, a
 *   link that is not https. A refusal writes nothing — a half-rendered invite is never queued.
 * - **Multipart, always** (R2): the text part, and the HTML part (the template's own, or made from the text).
 * - **The house signature** (phase 5-1): company, logos, website and GDPR block from Organisation settings (`emailBrandFor`), with built-in
 *   defaults for anything unset — so branding never stops a send. The logo is the console's public NZI asset at
 *   `consoleOrigin` unless settings name another. The sender stays the deployment's `EMAIL_FROM`.
 * - **The member's lines** (phase 5-2): when the send is `attributedTo` a member, their sign-off, name, title, email and
 *   mobile go above the chrome, from their own record; a system email carries the chrome only. From and reply-to are
 *   unchanged by it — the signature is body content.
 * - **Then it is `sendEmail`**, with `templateCode` set: the same validation, queue, idempotency and isolation gate as
 *   phase 1 — on the isolated boundary a templated send to anyone outside the NZI domain is still stubbed.
 *
 * Run it in the caller's transaction. It reads only the profile's brand columns, the member's signature fields and the
 * message templates — what the console's role reads, and since 0190 what the reminder worker's role may read too, so the
 * worker's due-date reminders (A3) are rendered by this same code.
 */

export class TemplatedEmailError extends Error {
  constructor(message: string, readonly issues: readonly string[]) { super(message); }
}

export type TemplatedEmailRequest = Pick<EmailRequest, "to" | "from" | "replyTo" | "correlationId" | "idempotencyKey"> & {
  templateCode: string;
  /** The console's own origin, for the signature's built-in logo URL. Absent: the logo is left out. */
  consoleOrigin?: string;
  /**
   * The member the email is from (phase 5-2, R5): their personal lines go above the house chrome. Explicit — the sending
   * code names the member; nothing is guessed from the From header. Absent: a system email, the chrome only.
   */
  attributedTo?: string;
  /** One value per token the message uses — every one, and no others. Links are passed here, never stored (R5). */
  vars: Readonly<Record<string, string>>;
};

export async function sendTemplatedEmail(db: Queryable, organisationId: string, input: TemplatedEmailRequest): Promise<{ emailMessageId: string; enqueued: boolean }> {
  const definition = messageTemplateDefinition(input.templateCode);
  if (!definition) throw new TemplatedEmailError(`${input.templateCode} is not a message the console sends.`, ["UNKNOWN_TEMPLATE"]);
  const content = messageContentFor(definition, await readActiveMessageTemplate(db, definition.key));
  const profile = await readEmailBrandProfile(db, organisationId);
  const person = input.attributedTo ? await emailPersonForMember(db, input.attributedTo) : null;
  const brand = { ...emailBrandFor(profile, input.consoleOrigin ?? null), person };
  const rendered = renderEmailTemplate(definition, content, input.vars, { brand });
  // Names the template and the issue — never a value, since values are links and names.
  if (!rendered.ok) throw new TemplatedEmailError(`${definition.key} was not sent: ${rendered.issues.join(" ")}`, rendered.issues);
  return sendEmail(db, organisationId, {
    to: input.to, subject: rendered.email.subject, text: rendered.email.text, html: rendered.email.html,
    from: input.from, replyTo: input.replyTo, correlationId: input.correlationId, idempotencyKey: input.idempotencyKey,
    templateCode: definition.key,
  });
}
