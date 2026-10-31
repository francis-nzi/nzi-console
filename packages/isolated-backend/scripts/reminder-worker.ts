import pg from "pg";
import {
  emailDispatchFromEnv, mailDelivery, runWorkerTick, smtpSettingsFrom, suppressingMailer, validateDatabaseBoundary,
  type Mailer,
} from "../src/index";
import { smtpMailer } from "../src/smtpMailer";

/**
 * The reminder worker — one clock, one tick, no web surface.
 *
 * Runs as its own Render service. The console is a web service and cannot host this: a tick
 * driven by request traffic fires whenever someone happens to be looking, which is neither a
 * schedule nor idempotent in any useful sense.
 *
 * **Isolation.** The boundary is validated before a connection is opened, and mail delivery
 * is decided once, up front, and reported in the log line. On this repository's services the
 * answer is always "suppress" — `NZI_DATABASE_BOUNDARY=isolated-non-production` — so the
 * worker composes and records reminders and sends nothing. That is the intended state.
 *
 * **Email (`email.send`).** The same drain also delivers queued email over Resend (`email.ts`). Its gate is decided once,
 * here: no `RESEND_API_KEY` stubs every send; with one, the isolated boundary sends only to the NZI domain and stubs the rest.
 *
 * **Secrets.** SMTP settings and the Resend key are read from the environment and never logged. The startup
 * line says whether a transport was configured, never what it was configured with.
 */

const TICK_MS = Number(process.env.NZI_REMINDER_TICK_SECONDS ?? "900") * 1000;
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

function buildMailer(delivery: ReturnType<typeof mailDelivery>): { mailer: Mailer; transport: string } {
  if (delivery.mode === "suppress") {
    // Still a real mailer: the message is composed and handed back so a suppressed run
    // produces the same record as a live one, minus the delivery.
    return {
      mailer: suppressingMailer((message) =>
        log("mail.suppressed", { to: message.to, subject: message.subject, reason: delivery.reason })),
      transport: "suppressed",
    };
  }
  return { mailer: smtpMailer(smtpSettingsFrom(process.env)), transport: "smtp" };
}

async function main() {
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const organisationId = process.env.NZI_DEMO_ORGANISATION_ID?.trim();
  if (!organisationId) throw new Error("NZI_DEMO_ORGANISATION_ID is required.");

  const delivery = mailDelivery({ mailMode: process.env.NZI_MAIL_MODE, smtp: process.env });
  const { mailer, transport } = buildMailer(delivery);
  const email = emailDispatchFromEnv(process.env);
  log("worker.started", {
    tickSeconds: TICK_MS / 1000, organisationId, transport,
    delivery: delivery.mode, reason: delivery.mode === "suppress" ? delivery.reason : undefined,
    email: email.gate.mode,
    emailReason: email.gate.mode === "stub" ? email.gate.reason : undefined,
    emailDomains: email.gate.mode === "isolated" ? email.gate.domains : undefined,
  });

  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (!stopping) {
    try {
      // Email and reminders in their own transactions, email first: a reminder-side failure is reported, never fatal to email.
      // A3's due-date reminders link to the portal at the console's own address — the same variable the console uses.
      const { emails, dueReminders, reminders } = await runWorkerTick(pool, { organisationId, today: londonToday(), mailer, email,
        consoleOrigin: process.env.NZI_ISOLATED_API_URL, env: { mailMode: process.env.NZI_MAIL_MODE, smtp: process.env } });
      // Counts only: no address, name or action title reaches the log.
      log("tick.complete", {
        emails: emails.ok ? emails.summary : { failed: emails.error },
        dueReminders: dueReminders.ok ? dueReminders.summary : { failed: dueReminders.error },
        reminders: reminders.ok
          ? reminders.summary.off ? { off: true }
            : { scanned: reminders.summary.scanned, claimed: reminders.summary.claimed, sent: reminders.summary.sent,
              suppressed: reminders.summary.suppressed, failed: reminders.summary.failed, skipped: reminders.summary.skipped }
          : { failed: reminders.error },
      });
    } catch (error) {
      // A tick that throws must not kill the clock: the next one re-reads the same state,
      // and every claim it already took is still owned by its log row.
      log("tick.failed", { message: error instanceof Error ? error.message : String(error) });
    }
    if (stopping) break;
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }

  await pool.end();
  log("worker.stopped");
}

main().catch((error) => {
  log("worker.failed", { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
