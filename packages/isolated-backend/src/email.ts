import { randomUUID } from "node:crypto";
import { mailDelivery } from "./mailer";
import type { Queryable } from "./postgres";

/**
 * Outbound email: one pipe, queued, logged, and sent over Resend (email programme phase 1).
 *
 * ## Queue, never inline (R1)
 *
 * `sendEmail` validates, writes an `email_messages` row (`queued`) and an `email.send` row on `transactional_outbox`, and
 * returns. It never calls the provider. The outbox drainer — the reminder worker, which already drains the outbox on a clock —
 * reads the row and hands it to the transport. A request handler that sent inline would make a slow or failing provider the
 * user's problem, and a retry the user's double-send.
 *
 * ## No double delivery
 *
 * The drainer sends only from `queued`, and gives Resend the `email_message_id` as its `Idempotency-Key`. The send happens
 * inside the tick's transaction, so a tick that fails after the provider accepted rolls this row back to `queued`; the
 * redelivered send carries the same key, and Resend returns the first message rather than sending a second.
 *
 * ## Who it may reach (R3, and the isolation rule)
 *
 * With no `RESEND_API_KEY` every send is `stubbed`: recorded in full, never on the wire, like the DVLA lookup's stub. With a
 * key, the existing mail gate (`mailDelivery`) still decides. On the isolated non-production boundary — which every service
 * in this repository runs on, against a database holding the live organisation's real contacts — it does not open the gate:
 * it narrows it to {@link ISOLATED_RECIPIENT_DOMAINS}, so the test send can be proved without staging ever being able to
 * write to a client. Any other recipient there is `stubbed`, with the reason recorded.
 */

export const EMAIL_SEND_TOPIC = "email.send";
/** Enough to ride out a provider blip; few enough that a real fault stops retrying within a couple of hours. */
export const MAX_EMAIL_ATTEMPTS = 4;
/**
 * The only recipients the isolated boundary will send to, with a key set. A constant rather than an environment value on
 * purpose: widening who staging can write to is a reviewed code change, never a dashboard edit.
 */
export const ISOLATED_RECIPIENT_DOMAINS: readonly string[] = ["netzero.international"];
export const RESEND_ENDPOINT = "https://api.resend.com/emails";

const SUBJECT_MAX = 300;
const BODY_MAX = 200_000;
const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
/** `Name <address>` or a bare address — the two shapes a From or Reply-To may take. */
const MAILBOX = /^(?:[^<>\r\n]{1,100}\s<([^<>\s]+)>|([^<>\s]+))$/;

export class EmailValidationError extends Error {}

export type EmailRequest = {
  to: string;
  subject: string;
  html?: string | null;
  text?: string | null;
  /** Defaults to the deployment's `EMAIL_FROM` at send time. */
  from?: string | null;
  replyTo?: string | null;
  /** The message-template registry key; null for plain system mail (phase 1). */
  templateCode?: string | null;
  correlationId?: string | null;
  /** The same key enqueues once. Defaults to a fresh one, so an unkeyed call is always a new send. */
  idempotencyKey?: string | null;
};

type ValidEmail = {
  to: string; subject: string; html: string | null; text: string | null; from: string | null; replyTo: string | null;
  templateCode: string | null;
};

const blank = (value: string | null | undefined) => value === undefined || value === null || value.trim() === "";

function mailbox(value: string, field: string): string {
  const trimmed = value.trim();
  const match = MAILBOX.exec(trimmed);
  const address = match?.[1] ?? match?.[2];
  if (!address || !ADDRESS.test(address)) throw new EmailValidationError(`${field} is not a valid email address.`);
  return trimmed;
}

/** Everything a send needs, checked before anything is written. Header fields refuse line breaks, which is header injection. */
export function validateEmailRequest(input: EmailRequest): ValidEmail {
  if (blank(input.to)) throw new EmailValidationError("A recipient is required.");
  const to = input.to.trim().toLowerCase();
  if (!ADDRESS.test(to)) throw new EmailValidationError("The recipient is not a valid email address.");
  if (blank(input.subject)) throw new EmailValidationError("A subject is required.");
  if (/[\r\n]/.test(input.subject)) throw new EmailValidationError("The subject must be a single line.");
  const subject = input.subject.trim();
  if (subject.length > SUBJECT_MAX) throw new EmailValidationError(`The subject is longer than ${SUBJECT_MAX} characters.`);
  const html = blank(input.html) ? null : input.html!;
  const text = blank(input.text) ? null : input.text!;
  if (html === null && text === null) throw new EmailValidationError("A body is required: html, text, or both.");
  if ((html?.length ?? 0) > BODY_MAX || (text?.length ?? 0) > BODY_MAX) {
    throw new EmailValidationError(`A body is longer than ${BODY_MAX} characters.`);
  }
  return {
    to, subject, html, text,
    from: blank(input.from) ? null : mailbox(input.from!, "From"),
    replyTo: blank(input.replyTo) ? null : mailbox(input.replyTo!, "Reply-To"),
    templateCode: blank(input.templateCode) ? null : input.templateCode!.trim(),
  };
}

/**
 * Enqueues one email. Pure enqueue: the log row and the outbox row, and nothing on the wire.
 *
 * Run it inside the caller's transaction — the two inserts are one fact, and an outbox row without its log row is a send
 * nothing owns. A repeated `idempotencyKey` returns the first row's id with `enqueued: false` and writes nothing.
 */
export async function sendEmail(db: Queryable, organisationId: string, input: EmailRequest): Promise<{ emailMessageId: string; enqueued: boolean }> {
  const email = validateEmailRequest(input);
  const emailMessageId = randomUUID();
  const idempotencyKey = blank(input.idempotencyKey) ? emailMessageId : input.idempotencyKey!.trim();
  const correlationId = blank(input.correlationId) ? emailMessageId : input.correlationId!.trim();
  const won = await db.query<{ email_message_id: string }>(
    `INSERT INTO nzi_console.email_messages
       (organisation_id, email_message_id, idempotency_key, correlation_id, template_code, to_email, from_address, reply_to,
        subject, html_body, text_body)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (organisation_id, idempotency_key) DO NOTHING
     RETURNING email_message_id`,
    [organisationId, emailMessageId, idempotencyKey, correlationId, email.templateCode, email.to, email.from, email.replyTo,
      email.subject, email.html, email.text]);
  if (won.rows.length === 0) {
    const existing = await db.query<{ email_message_id: string }>(
      `SELECT email_message_id FROM nzi_console.email_messages WHERE organisation_id=$1 AND idempotency_key=$2`,
      [organisationId, idempotencyKey]);
    return { emailMessageId: existing.rows[0]!.email_message_id, enqueued: false };
  }
  await db.query(
    `INSERT INTO nzi_console.transactional_outbox (organisation_id, outbox_id, topic, payload_json, correlation_id)
     VALUES ($1,$2,$3,$4::jsonb,$5)`,
    [organisationId, randomUUID(), EMAIL_SEND_TOPIC, JSON.stringify({ emailMessageId }), correlationId]);
  return { emailMessageId, enqueued: true };
}

/* ── The transport ───────────────────────────────────────────────────────────────────── */

export type OutboundEmail = {
  from: string; to: string; subject: string; html: string | null; text: string | null; replyTo: string | null;
  /** Resend's `Idempotency-Key`: the email_message_id, so a redelivery returns the first send. */
  idempotencyKey: string;
};

/** A refusal or a fault. `retryable` is the transport's judgement: a rate limit or an outage is; a bad request is not. */
export class EmailTransportError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

export type EmailTransport = {
  /** Resolves with the provider's message id on acceptance; throws {@link EmailTransportError} otherwise. */
  send(message: OutboundEmail): Promise<{ id: string }>;
};

/**
 * Resend's REST API (R2): stateless HTTP rather than SMTP, which suits a Render worker. The key is sent as a bearer token and
 * appears in no error, log line or return value.
 */
export function resendTransport(config: { apiKey: string; fetchImpl?: typeof fetch; endpoint?: string }): EmailTransport {
  const doFetch = config.fetchImpl ?? fetch;
  return {
    async send(message) {
      let response: Response;
      try {
        response = await doFetch(config.endpoint ?? RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", Accept: "application/json",
            "Idempotency-Key": message.idempotencyKey,
          },
          body: JSON.stringify({
            from: message.from, to: [message.to], subject: message.subject,
            ...(message.html === null ? {} : { html: message.html }),
            ...(message.text === null ? {} : { text: message.text }),
            ...(message.replyTo === null ? {} : { reply_to: message.replyTo }),
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new EmailTransportError("Resend could not be reached.", true);
      }
      const payload = (await response.json().catch(() => ({}))) as { id?: unknown; message?: unknown; name?: unknown };
      if (response.ok) {
        if (typeof payload.id !== "string" || payload.id === "") {
          throw new EmailTransportError("Resend accepted the request but returned no message id.", false);
        }
        return { id: payload.id };
      }
      const detail = typeof payload.message === "string" ? `: ${payload.message.slice(0, 300)}` : "";
      // 409 is Resend's "a request with this idempotency key is still in progress" — try again later, never resend fresh.
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      throw new EmailTransportError(`Resend refused the message (HTTP ${response.status})${detail}`, retryable);
    },
  };
}

/* ── The gate ────────────────────────────────────────────────────────────────────────── */

export type EmailGate =
  | { mode: "live" }
  | { mode: "isolated"; domains: readonly string[] }
  | { mode: "stub"; reason: string };

export type EmailDispatch = { gate: EmailGate; transport: EmailTransport | null; defaultFrom: string | null };

/**
 * Decides, once per process, whether email can leave it, and to whom. Fails closed: no key, or no From, is a stub; a key on
 * a gate that would not otherwise send is a stub too, except on the isolated boundary, which narrows rather than opens.
 */
export function emailDispatchFromEnv(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): EmailDispatch {
  const apiKey = env.RESEND_API_KEY?.trim();
  const defaultFrom = env.EMAIL_FROM?.trim() || null;
  if (!apiKey) return { gate: { mode: "stub", reason: "RESEND_API_KEY is not set." }, transport: null, defaultFrom };
  if (defaultFrom === null) return { gate: { mode: "stub", reason: "EMAIL_FROM is not set." }, transport: null, defaultFrom };
  try { mailbox(defaultFrom, "EMAIL_FROM"); } catch {
    return { gate: { mode: "stub", reason: "EMAIL_FROM is not a valid sender." }, transport: null, defaultFrom: null };
  }
  const transport = resendTransport({ apiKey, fetchImpl });
  if (env.NZI_DATABASE_BOUNDARY === "isolated-non-production") {
    return { gate: { mode: "isolated", domains: ISOLATED_RECIPIENT_DOMAINS }, transport, defaultFrom };
  }
  const delivery = mailDelivery({ mailMode: env.NZI_MAIL_MODE, appEnv: env.NEXT_PUBLIC_APP_ENV, boundaryToken: env.NZI_DATABASE_BOUNDARY });
  return delivery.mode === "send"
    ? { gate: { mode: "live" }, transport, defaultFrom }
    : { gate: { mode: "stub", reason: delivery.reason }, transport: null, defaultFrom };
}

/** Why this recipient is not sent to, or null when it is. */
export function stubReasonFor(gate: EmailGate, to: string): string | null {
  if (gate.mode === "live") return null;
  if (gate.mode === "stub") return gate.reason;
  const domain = to.slice(to.lastIndexOf("@") + 1).toLowerCase();
  return gate.domains.includes(domain)
    ? null
    : `The isolated boundary sends only to ${gate.domains.map((entry) => `@${entry}`).join(", ")}; recorded, not sent.`;
}

/* ── The handler ─────────────────────────────────────────────────────────────────────── */

/**
 * - `sent` / `stubbed`: resolved; the outbox row is done.
 * - `retry`: still queued after a retryable failure; the outbox row backs off.
 * - `failed`: resolved as failed; the outbox row is done.
 * - `stale`: the row was already resolved (a redelivery) or is missing; nothing was sent.
 */
export type EmailOutcome = "sent" | "stubbed" | "retry" | "failed" | "stale";

/** The `email.send` handler. Sends only from `queued`, so a redelivered outbox row cannot send twice. */
export async function deliverEmail(db: Queryable, input: { organisationId: string; emailMessageId: string; dispatch: EmailDispatch }): Promise<EmailOutcome> {
  const found = await db.query<{
    to_email: string; from_address: string | null; reply_to: string | null; subject: string; html_body: string | null;
    text_body: string | null; status: string; attempts: number;
  }>(
    `SELECT to_email, from_address, reply_to, subject, html_body, text_body, status, attempts
     FROM nzi_console.email_messages WHERE organisation_id=$1 AND email_message_id=$2 FOR UPDATE`,
    [input.organisationId, input.emailMessageId]);
  const row = found.rows[0];
  if (row === undefined || row.status !== "queued") return "stale";

  const stub = stubReasonFor(input.dispatch.gate, row.to_email);
  if (stub !== null || input.dispatch.transport === null) {
    await resolveEmail(db, input, "stubbed", { note: stub ?? "No transport is configured." });
    return "stubbed";
  }
  try {
    const accepted = await input.dispatch.transport.send({
      from: row.from_address ?? input.dispatch.defaultFrom!, to: row.to_email, subject: row.subject,
      html: row.html_body, text: row.text_body, replyTo: row.reply_to, idempotencyKey: input.emailMessageId,
    });
    await resolveEmail(db, input, "sent", { providerId: accepted.id, attempt: true });
    return "sent";
  } catch (error) {
    const message = error instanceof Error ? error.message : "The provider refused the message.";
    const retryable = error instanceof EmailTransportError ? error.retryable : true;
    if (retryable && row.attempts + 1 < MAX_EMAIL_ATTEMPTS) {
      await db.query(
        `UPDATE nzi_console.email_messages SET attempts = attempts + 1, last_error = $3, updated_at = now()
         WHERE organisation_id=$1 AND email_message_id=$2`,
        [input.organisationId, input.emailMessageId, message]);
      return "retry";
    }
    await resolveEmail(db, input, "failed", { note: message, attempt: true });
    return "failed";
  }
}

const resolveEmail = (db: Queryable, input: { organisationId: string; emailMessageId: string },
  status: "sent" | "stubbed" | "failed", detail: { providerId?: string; note?: string; attempt?: boolean }) =>
  db.query(
    `UPDATE nzi_console.email_messages
     SET status = $3, provider_message_id = $4, last_error = $5, attempts = attempts + $6,
         html_body = NULL, text_body = NULL, resolved_at = now(), updated_at = now()
     WHERE organisation_id=$1 AND email_message_id=$2`,
    [input.organisationId, input.emailMessageId, status, detail.providerId ?? null, detail.note ?? null, detail.attempt ? 1 : 0]);
