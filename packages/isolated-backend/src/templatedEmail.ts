import { emailBrandFor, messageContentFor, messageTemplateDefinition, renderEmailTemplate } from "@nzi/contracts";
import { sendEmail, type EmailRequest } from "./email";
import { readActiveMessageTemplate } from "./messageTemplates";
import { readOrganisationProfile } from "./organisationSettings";
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
 * - **Then it is `sendEmail`**, with `templateCode` set: the same validation, queue, idempotency and isolation gate as
 *   phase 1 — on the isolated boundary a templated send to anyone outside the NZI domain is still stubbed.
 *
 * Run it in the caller's transaction, as the console's role: it reads the organisation profile, which the worker cannot.
 */

export class TemplatedEmailError extends Error {
  constructor(message: string, readonly issues: readonly string[]) { super(message); }
}

export type TemplatedEmailRequest = Pick<EmailRequest, "to" | "from" | "replyTo" | "correlationId" | "idempotencyKey"> & {
  templateCode: string;
  /** The console's own origin, for the frame's default logo URL. Absent: the header shows the name as a wordmark. */
  consoleOrigin?: string;
  /** One value per token the message uses — every one, and no others. Links are passed here, never stored (R5). */
  vars: Readonly<Record<string, string>>;
};

export async function sendTemplatedEmail(db: Queryable, organisationId: string, input: TemplatedEmailRequest): Promise<{ emailMessageId: string; enqueued: boolean }> {
  const definition = messageTemplateDefinition(input.templateCode);
  if (!definition) throw new TemplatedEmailError(`${input.templateCode} is not a message the console sends.`, ["UNKNOWN_TEMPLATE"]);
  const content = messageContentFor(definition, await readActiveMessageTemplate(db, definition.key));
  const profile = await readOrganisationProfile(db, organisationId);
  const brand = emailBrandFor(profile?.fields ?? null, input.consoleOrigin ?? null);
  const rendered = renderEmailTemplate(definition, content, input.vars, { brand });
  // Names the template and the issue — never a value, since values are links and names.
  if (!rendered.ok) throw new TemplatedEmailError(`${definition.key} was not sent: ${rendered.issues.join(" ")}`, rendered.issues);
  return sendEmail(db, organisationId, {
    to: input.to, subject: rendered.email.subject, text: rendered.email.text, html: rendered.email.html,
    from: input.from, replyTo: input.replyTo, correlationId: input.correlationId, idempotencyKey: input.idempotencyKey,
    templateCode: definition.key,
  });
}
