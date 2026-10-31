/**
 * The mail port, and the gate in front of it.
 *
 * Two separable things live here on purpose:
 *
 *   * `Mailer` — an interface. Everything above it is testable without a mail server, and
 *     the SMTP implementation is a thin edge rather than something woven through the logic.
 *   * `mailDelivery` — the decision about whether real mail may leave this process at all.
 *
 * The gate **fails closed, twice over**, and both conditions are about mail itself:
 *
 *   1. `NZI_MAIL_MODE` is exactly `send` — the deliberate switch. Anything else suppresses.
 *   2. The SMTP configuration is complete. With the switch on and a variable missing,
 *      `mailDelivery` **throws** (`SmtpConfigurationError`, naming the variable, never a value)
 *      rather than suppressing: a switch someone turned on that quietly does nothing is the
 *      failure mode this is here to prevent, and it must never fall through to "send" half-configured.
 *
 * Mail does not read the database-isolation token (`NZI_DATABASE_BOUNDARY`) or `NEXT_PUBLIC_APP_ENV`.
 * Those describe which database a service may touch (`validateDatabaseBoundary`), not whether it may
 * send an email; coupling them meant the staging console, whose database is the live organisation's,
 * could never mail anyone. Turning `NZI_MAIL_MODE` on is therefore the whole decision, made per service
 * in the host's environment — and it applies to everything that sends through the SMTP `Mailer`.
 */

export type MailMessage = {
  to: string;
  subject: string;
  body: string;
};

export type Mailer = {
  /** Resolves on acceptance by the server. Throws on failure — the caller decides about retries. */
  send(message: MailMessage): Promise<void>;
};

export type MailDelivery =
  | { mode: "send" }
  | { mode: "suppress"; reason: string };

export type MailEnvironment = {
  /** `NZI_MAIL_MODE` — the deliberate switch. Only the exact string "send" opts in. */
  mailMode?: string;
  /** The SMTP variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_TLS`), normally `process.env`. */
  smtp?: Record<string, string | undefined>;
};

/** Suppress unless the switch is on; with it on, throw unless the SMTP configuration is complete. */
export function mailDelivery(env: MailEnvironment): MailDelivery {
  if (env.mailMode !== "send") {
    return { mode: "suppress", reason: "NZI_MAIL_MODE is not set to send." };
  }
  // Throws when incomplete. Deliberately not a suppress: see the module comment.
  smtpSettingsFrom(env.smtp ?? {});
  return { mode: "send" };
}

/** The transport's own settings, read from the environment and never written down here. */
export type SmtpSettings = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  /** STARTTLS on 587 is the Office 365 default; `false` only for a local test server. */
  requireTls: boolean;
};

export class SmtpConfigurationError extends Error {}

/**
 * Reads the SMTP contract from the environment. Values are never logged, never defaulted to
 * anything real, and never returned in an error message — a misconfiguration should say
 * *which* variable is missing, never what any of them contain.
 */
export function smtpSettingsFrom(env: Record<string, string | undefined>): SmtpSettings {
  const missing = (["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const)
    .filter((key) => (env[key] ?? "").trim() === "");
  if (missing.length > 0) {
    throw new SmtpConfigurationError(`Missing SMTP configuration: ${missing.join(", ")}.`);
  }
  const port = Number(env.SMTP_PORT ?? "587");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new SmtpConfigurationError("SMTP_PORT must be a valid port number.");
  }
  return {
    host: env.SMTP_HOST!.trim(),
    port,
    user: env.SMTP_USER!.trim(),
    pass: env.SMTP_PASS!,
    from: env.SMTP_FROM!.trim(),
    // Opt *out* rather than in: the insecure setting has to be asked for by name.
    requireTls: (env.SMTP_TLS ?? "").trim().toLowerCase() !== "false",
  };
}

/**
 * A mailer that records instead of sending. Used wherever `mailDelivery` says suppress —
 * that is, wherever `NZI_MAIL_MODE` is not `send`.
 *
 * It is a real implementation rather than a no-op: the message is composed in full and
 * handed back, so a suppressed run produces the same audit trail as a real one minus the
 * delivery. "We would have sent this" is a claim worth being able to inspect.
 */
export function suppressingMailer(onSuppressed?: (message: MailMessage) => void): Mailer {
  return {
    async send(message: MailMessage) {
      onSuppressed?.(message);
    },
  };
}
