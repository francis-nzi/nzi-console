/**
 * Prove the email pipe end to end (email programme phase 1): enqueue one plain test email, or read back how one resolved.
 *
 *   npm run email:test-send -w @nzi/isolated-backend -- --to <you>@netzero.international --actor <your name>
 *   npm run email:test-send -w @nzi/isolated-backend -- --status <email_message_id>
 *
 * Run in the Render Shell of the **reminder worker** service: that is where the database URL, the organisation the drain
 * reads, and the Resend key live, and only staff with Render access can reach it — there is no route to this. It only
 * enqueues, exactly as any caller of `sendEmail` does; the worker sends it on its next tick (NZI_REMINDER_TICK_SECONDS).
 * `--status` then says whether it was sent (with Resend's message id), stubbed (and why), or failed.
 *
 * On this repository's services the isolated boundary sends only to @netzero.international; any other recipient is
 * recorded as stubbed, never sent. Fail-closed on the boundary like every other script here.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { emailDispatchFromEnv, sendEmail, stubReasonFor } from "../src/email";
import { withTenantWorker } from "../src/postgres";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const USAGE = "Usage: email:test-send (--to <address> --actor <your name> | --status <email_message_id>) [--organisation <id>]";

async function main(): Promise<void> {
  const to = argument("--to")?.trim();
  const actor = argument("--actor")?.trim();
  const status = argument("--status")?.trim();
  const organisationId = argument("--organisation")?.trim() || process.env.NZI_DEMO_ORGANISATION_ID?.trim();
  if (!organisationId) throw new Error("NZI_DEMO_ORGANISATION_ID is not set; pass --organisation <id>.");
  if (!status && (!to || !actor)) throw new Error(USAGE);

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const pool = new Pool({ connectionString: url.toString(), max: 1, application_name: "nzi-email-test-send" });
  try {
    if (status) {
      const row = await withTenantWorker(pool, organisationId, async (db) => (await db.query<{
        to_email: string; status: string; provider_message_id: string | null; attempts: number; last_error: string | null;
        created_at: Date; resolved_at: Date | null;
      }>(
        `SELECT to_email, status, provider_message_id, attempts, last_error, created_at, resolved_at
         FROM nzi_console.email_messages WHERE organisation_id=$1 AND email_message_id=$2`, [organisationId, status])).rows[0]);
      if (!row) { log(`No email ${status} in ${organisationId}.`); return; }
      log(`\n${status} → ${row.to_email}: ${row.status.toUpperCase()}`);
      if (row.provider_message_id) log(`  Resend message id: ${row.provider_message_id}`);
      if (row.last_error) log(`  ${row.status === "stubbed" ? "Why" : "Last error"}: ${row.last_error}`);
      log(`  Attempts: ${row.attempts} · queued ${row.created_at.toISOString()}${row.resolved_at ? ` · resolved ${row.resolved_at.toISOString()}` : " · not yet drained"}\n`);
      return;
    }

    const at = new Date().toISOString();
    const environment = process.env.NEXT_PUBLIC_APP_ENV ?? "unset";
    const queued = await withTenantWorker(pool, organisationId, (db) => sendEmail(db, organisationId, {
      to: to!,
      subject: `NZI Console — test send (${environment})`,
      text: `This is a test email from NZI Console, queued by ${actor} at ${at} on ${environment}.\n\nIf you can read this, outbound email over Resend works. No reply is needed.`,
      html: `<p>This is a test email from NZI Console, queued by ${escape(actor!)} at ${at} on ${escape(environment)}.</p><p>If you can read this, outbound email over Resend works. No reply is needed.</p>`,
      correlationId: `operator-test:${actor}`,
    }));
    const gate = emailDispatchFromEnv(process.env).gate;
    const stub = stubReasonFor(gate, to!.toLowerCase());
    log(`\nQueued ${queued.emailMessageId} to ${to} in ${organisationId}.`);
    log(stub === null
      ? "The worker will send it over Resend on its next tick."
      : `The worker will record it as STUBBED, not send it: ${stub}`);
    log(`Check how it resolved: npm run email:test-send -w @nzi/isolated-backend -- --status ${queued.emailMessageId}\n`);
  } finally {
    await pool.end();
  }
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

main().catch((error) => {
  process.stderr.write(`\nemail:test-send failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
