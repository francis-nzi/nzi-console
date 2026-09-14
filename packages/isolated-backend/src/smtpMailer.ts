import nodemailer from "nodemailer";
import type { MailMessage, Mailer, SmtpSettings } from "./mailer";

/**
 * The SMTP edge — Office 365, matching the live platform.
 *
 * Deliberately thin. Everything worth testing (who may be written to, what the message
 * says, whether a send is owed, whether it may leave the building) lives above this behind
 * the `Mailer` interface; this only puts an already-decided message on the wire.
 *
 * Nothing here logs or returns a credential. A failure says the server refused the message,
 * and the settings that produced it stay in the environment where they came from.
 */
export function smtpMailer(settings: SmtpSettings): Mailer {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    // Port 465 is implicit TLS; 587 (the Office 365 default) upgrades via STARTTLS.
    secure: settings.port === 465,
    requireTLS: settings.requireTls,
    auth: { user: settings.user, pass: settings.pass },
  });

  return {
    async send(message: MailMessage) {
      try {
        await transport.sendMail({
          from: settings.from,
          to: message.to,
          subject: message.subject,
          text: message.body,
        });
      } catch (cause) {
        // Re-thrown without the cause's own fields: nodemailer attaches the connection
        // configuration to some errors, and that includes the password.
        const reason = cause instanceof Error ? cause.message : "unknown error";
        throw new Error(`SMTP delivery failed: ${reason}`);
      }
    },
  };
}
