/**
 * The mail port, and the gate in front of it.
 *
 * Two separable things live here on purpose:
 *
 *   * `Mailer` — an interface. Everything above it is testable without a mail server, and
 *     the SMTP implementation is a thin edge rather than something woven through the logic.
 *   * `mailDelivery` — the decision about whether real mail may leave this process at all.
 *
 * The gate **fails closed, twice over**. Sending requires an explicit opt-in *and* an
 * environment that is not the isolated one. Either alone is not enough: an opt-in set by
 * mistake on staging must not reach a real client, and a production-looking environment
 * without a deliberate switch should still stay quiet until someone turns it on.
 *
 * This repository's services are configured with `NZI_DATABASE_BOUNDARY=isolated-non-production`
 * (see `validateDatabaseBoundary`), so as deployed here the answer is always "suppress".
 * That is the intended state, not a limitation to work around.
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
  /** `NEXT_PUBLIC_APP_ENV` — the environment's own account of itself. */
  appEnv?: string;
  /** `NZI_DATABASE_BOUNDARY` — the isolation token this repo's services carry. */
  boundaryToken?: string;
};

export function mailDelivery(env: MailEnvironment): MailDelivery {
  // Checked first and reported first: it is the isolation rule, and it is the reason this
  // service can never mail a real client however the other two are set.
  if (env.boundaryToken === "isolated-non-production") {
    return { mode: "suppress", reason: "This service runs against the isolated non-production boundary." };
  }
  if (env.appEnv !== "production") {
    return { mode: "suppress", reason: `NEXT_PUBLIC_APP_ENV is ${env.appEnv ?? "unset"}, not production.` };
  }
  if (env.mailMode !== "send") {
    return { mode: "suppress", reason: "NZI_MAIL_MODE is not set to send." };
  }
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
 * which, in this repository's deployments, is everywhere.
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
