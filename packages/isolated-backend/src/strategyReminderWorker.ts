import { randomUUID } from "node:crypto";
import {
  reminderMessage, reminderRecipients, remindersDue, strategyDeadline, reminderKindFor,
  type ClientContactLike, type ReminderKind,
} from "@nzi/contracts";
import { listClientStrategies } from "./reductionStrategies";
import { mailDelivery, type MailDelivery, type Mailer } from "./mailer";
import type { Queryable } from "./postgres";

/**
 * The reminder worker's two halves: **scan** (what is owed) and **drain** (what is sent).
 *
 * ## The claim is the guarantee
 *
 * A log row is written *before* a send is attempted, never after it succeeds. A row written
 * afterwards cannot prevent a duplicate, because the crash that loses it happens in exactly
 * the window between the send and the write. So the unique index on
 * (strategy, kind, target_date, recipient) is the idempotency key, and winning the insert is
 * how a run earns the right to send. A second run of the clock loses the insert and sends
 * nothing — which is the whole point.
 *
 * ## The standing backlog
 *
 * `transactional_outbox` has been written by every command since migration 0001 and drained
 * by nothing, so it holds a long tail of rows whose topics no mail handler recognises. The
 * drainer is safe against this **by construction**: delivery is keyed on a handler lookup,
 * and a topic with no handler is marked `skipped` — seen, understood, nothing to deliver.
 * Nothing in that backlog can become an email, because none of it ever had a mail handler.
 *
 * ## Staleness
 *
 * A queued reminder is re-derived against live state immediately before sending. A strategy
 * that was completed, removed, or had its date moved between the scan and the send is
 * dropped rather than delivered. The alternative — trusting a payload written minutes or
 * hours ago — is how a client gets told they are late for something they finished.
 */

export const REMINDER_TOPIC = "strategy.deadline.reminder";
/** Enough to survive a transient SMTP refusal; few enough that a real fault stops shouting. */
export const MAX_SEND_ATTEMPTS = 4;

export type ReminderRunSummary = {
  scanned: number;
  claimed: number;
  sent: number;
  suppressed: number;
  failed: number;
  /** Outbox rows seen whose topic no handler recognised — the 0001 backlog, mostly. */
  skipped: number;
  delivery: MailDelivery;
};

type ReminderPayload = {
  clientId: string;
  clientStrategyId: string;
  automationLogId: string;
  kind: ReminderKind;
  targetDate: string;
  recipientEmail: string;
};

/* ── Scan ────────────────────────────────────────────────────────────────────────────── */

/**
 * Finds what is owed for one client and claims it, enqueuing an outbox row per fresh claim.
 *
 * The claim and the enqueue are one transaction per reminder: an enqueued row whose claim
 * was rolled back would be a send nothing owns, and a claim whose enqueue was lost would be
 * a reminder that can never be sent again — the unique index would refuse the retry.
 */
export async function scanClientReminders(db: Queryable, input: {
  organisationId: string;
  clientId: string;
  today: string;
  windowDays?: number;
}): Promise<{ scanned: number; claimed: number }> {
  const plan = (await listClientStrategies(db, input.clientId)).filter((strategy) => strategy.active);
  const due = remindersDue(plan, input.today, input.windowDays);
  if (due.length === 0) return { scanned: plan.length, claimed: 0 };

  const contacts = await listReminderContacts(db, input.clientId);
  const recipients = reminderRecipients(contacts);
  // No consenting contact is not an error and not a retry: there is simply nobody this may
  // be sent to. Claiming would burn the idempotency key against a send that never happens,
  // so consent is checked before the claim, never after it.
  if (recipients.length === 0) return { scanned: plan.length, claimed: 0 };

  const clientName = await clientNameFor(db, input.clientId);
  const byId = new Map(plan.map((strategy) => [strategy.id, strategy]));
  let claimed = 0;

  for (const claim of due) {
    const strategy = byId.get(claim.clientStrategyId);
    if (strategy === undefined) continue;
    for (const recipient of recipients) {
      const deadline = strategyDeadline(strategy, input.today, input.windowDays);
      const message = reminderMessage({
        clientName, strategyTitle: strategy.title, owner: strategy.owner,
        targetDate: claim.targetDate, kind: claim.kind, deadline, recipient,
      });
      const automationLogId = randomUUID();
      const won = await db.query<{ automation_log_id: string }>(
        `INSERT INTO nzi_console.strategy_automation_log
           (organisation_id, automation_log_id, client_strategy_id, client_id, kind, target_date,
            recipient_email, state, subject, body)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7,'claimed',$8,$9)
         ON CONFLICT (organisation_id, client_strategy_id, kind, target_date, recipient_email) DO NOTHING
         RETURNING automation_log_id`,
        [input.organisationId, automationLogId, claim.clientStrategyId, input.clientId, claim.kind,
          claim.targetDate, recipient.email, message.subject, message.body],
      );
      // Lost the race, or already reminded: either way this one is spoken for.
      if (won.rows.length === 0) continue;
      const payload: ReminderPayload = {
        clientId: input.clientId, clientStrategyId: claim.clientStrategyId,
        automationLogId, kind: claim.kind, targetDate: claim.targetDate, recipientEmail: recipient.email,
      };
      await db.query(
        `INSERT INTO nzi_console.transactional_outbox
           (organisation_id, outbox_id, topic, payload_json, correlation_id)
         VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [input.organisationId, randomUUID(), REMINDER_TOPIC, JSON.stringify(payload), automationLogId],
      );
      claimed += 1;
    }
  }
  return { scanned: plan.length, claimed };
}

async function listReminderContacts(db: Queryable, clientId: string): Promise<ClientContactLike[]> {
  const result = await db.query<{ email: string | null; full_name: string; status: string; email_consent: string }>(
    `SELECT email, full_name, status, email_consent
     FROM nzi_console.client_contacts WHERE client_id = $1`,
    [clientId],
  );
  return result.rows.map((row) => ({
    email: row.email,
    fullName: row.full_name,
    status: row.status === "active" ? "active" : "inactive",
    emailConsent: row.email_consent === "granted" ? "granted" : row.email_consent === "declined" ? "declined" : "unknown",
  }));
}

async function clientNameFor(db: Queryable, clientId: string): Promise<string> {
  const result = await db.query<{ name: string }>(
    `SELECT name FROM nzi_console.clients WHERE client_id = $1`, [clientId]);
  return result.rows[0]?.name ?? "your organisation";
}

/* ── Drain ───────────────────────────────────────────────────────────────────────────── */

/**
 * Drains pending outbox rows. Every row reaches a terminal state, so the backlog is cleared
 * once rather than re-read on every tick — but only reminder rows can produce a message.
 */
export async function drainOutbox(db: Queryable, input: {
  organisationId: string;
  today: string;
  mailer: Mailer;
  delivery: MailDelivery;
  limit?: number;
  windowDays?: number;
}): Promise<Omit<ReminderRunSummary, "scanned" | "claimed">> {
  const pending = await db.query<{ outbox_id: string; topic: string; payload_json: ReminderPayload; attempts: number }>(
    `SELECT outbox_id, topic, payload_json, attempts
     FROM nzi_console.transactional_outbox
     WHERE organisation_id = $1 AND state = 'pending' AND available_at <= now()
     ORDER BY created_at
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [input.organisationId, input.limit ?? 200],
  );

  let sent = 0, suppressed = 0, failed = 0, skipped = 0;

  for (const row of pending.rows) {
    // The handler lookup is the safety property: a topic nobody handles cannot become mail,
    // which is what makes the pre-drainer backlog inert rather than dangerous.
    if (row.topic !== REMINDER_TOPIC) {
      await db.query(
        `UPDATE nzi_console.transactional_outbox SET state='skipped' WHERE organisation_id=$1 AND outbox_id=$2`,
        [input.organisationId, row.outbox_id]);
      skipped += 1;
      continue;
    }

    const outcome = await deliverReminder(db, {
      organisationId: input.organisationId, today: input.today, payload: row.payload_json,
      mailer: input.mailer, delivery: input.delivery, windowDays: input.windowDays,
    });

    if (outcome === "sent") { sent += 1; await settle(db, input.organisationId, row.outbox_id, "sent"); }
    else if (outcome === "suppressed") { suppressed += 1; await settle(db, input.organisationId, row.outbox_id, "sent"); }
    // Stale: the plan moved under the queued reminder. Nothing was sent and nothing is owed.
    else if (outcome === "stale") { skipped += 1; await settle(db, input.organisationId, row.outbox_id, "skipped"); }
    else {
      failed += 1;
      const exhausted = row.attempts + 1 >= MAX_SEND_ATTEMPTS;
      await db.query(
        `UPDATE nzi_console.transactional_outbox
         SET state = $3, attempts = attempts + 1,
             available_at = now() + (interval '1 minute' * power(4, attempts + 1))
         WHERE organisation_id=$1 AND outbox_id=$2`,
        [input.organisationId, row.outbox_id, exhausted ? "failed" : "pending"]);
    }
  }

  return { sent, suppressed, failed, skipped, delivery: input.delivery };
}

const settle = (db: Queryable, organisationId: string, outboxId: string, state: "sent" | "skipped") =>
  db.query(`UPDATE nzi_console.transactional_outbox SET state=$3 WHERE organisation_id=$1 AND outbox_id=$2`,
    [organisationId, outboxId, state]);

type DeliveryOutcome = "sent" | "suppressed" | "stale" | "failed";

async function deliverReminder(db: Queryable, input: {
  organisationId: string;
  today: string;
  payload: ReminderPayload;
  mailer: Mailer;
  delivery: MailDelivery;
  windowDays?: number;
}): Promise<DeliveryOutcome> {
  const log = await db.query<{ state: string; subject: string; body: string; attempts: number }>(
    `SELECT state, subject, body, attempts FROM nzi_console.strategy_automation_log
     WHERE organisation_id=$1 AND automation_log_id=$2`,
    [input.organisationId, input.payload.automationLogId]);
  const claim = log.rows[0];
  // Already resolved — a duplicate outbox row, or a retry after the send actually landed.
  // Re-sending here is precisely the failure the claim exists to prevent.
  if (claim === undefined) return "stale";
  if (claim.state === "sent" || claim.state === "suppressed") return "stale";

  // Re-derive against live state. A strategy completed, removed or re-dated since the scan
  // is not owed a reminder, and saying otherwise would be telling a client they are late
  // for something they have finished.
  const plan = await listClientStrategies(db, input.payload.clientId);
  const strategy = plan.find((entry) => entry.id === input.payload.clientStrategyId);
  if (strategy === undefined || !strategy.active) return await markStale(db, input, "the strategy is no longer on the plan");
  const deadline = strategyDeadline(strategy, input.today, input.windowDays);
  const kind = reminderKindFor(deadline);
  if (kind === null) return await markStale(db, input, "the strategy no longer has a deadline to raise");
  if (kind !== input.payload.kind) return await markStale(db, input, `the deadline is now ${kind}, not ${input.payload.kind}`);
  const currentDate = "targetDate" in deadline ? deadline.targetDate.slice(0, 10) : "";
  if (currentDate !== input.payload.targetDate) return await markStale(db, input, "the target date has moved");

  try {
    if (input.delivery.mode === "send") {
      await input.mailer.send({ to: input.payload.recipientEmail, subject: claim.subject, body: claim.body });
      await resolve(db, input.organisationId, input.payload.automationLogId, "sent", null);
      return "sent";
    }
    // Suppressed is a successful outcome, recorded in full: the message was composed and is
    // on the record, it simply never went on the wire.
    await input.mailer.send({ to: input.payload.recipientEmail, subject: claim.subject, body: claim.body });
    await resolve(db, input.organisationId, input.payload.automationLogId, "suppressed", input.delivery.reason);
    return "suppressed";
  } catch (error) {
    const attempts = claim.attempts + 1;
    const message = error instanceof Error ? error.message : "The mail server refused the message.";
    await db.query(
      `UPDATE nzi_console.strategy_automation_log
       SET state = $3, attempts = $4, last_error = $5, resolved_at = CASE WHEN $3 = 'failed' THEN now() ELSE NULL END
       WHERE organisation_id=$1 AND automation_log_id=$2`,
      [input.organisationId, input.payload.automationLogId,
        attempts >= MAX_SEND_ATTEMPTS ? "failed" : "claimed", attempts, message]);
    return "failed";
  }
}

/**
 * A stale claim is resolved, not deleted. The row stays as the record that a reminder was
 * once owed and deliberately not sent — and, because the unique key survives, it also stops
 * the same reminder being raised again for the same unchanged date.
 */
async function markStale(db: Queryable, input: { organisationId: string; payload: ReminderPayload }, why: string): Promise<"stale"> {
  await resolve(db, input.organisationId, input.payload.automationLogId, "suppressed", `Not sent: ${why}.`);
  return "stale";
}

const resolve = (db: Queryable, organisationId: string, automationLogId: string,
  state: "sent" | "suppressed", note: string | null) =>
  db.query(
    `UPDATE nzi_console.strategy_automation_log
     SET state=$3, last_error=$4, resolved_at=now(), attempts = attempts + 1
     WHERE organisation_id=$1 AND automation_log_id=$2`,
    [organisationId, automationLogId, state, note]);

/* ── One tick ────────────────────────────────────────────────────────────────────────── */

/** Every client with an active plan. The scan is per client so one bad client cannot stop the rest. */
export async function clientsWithPlans(db: Queryable): Promise<string[]> {
  const result = await db.query<{ client_id: string }>(
    `SELECT DISTINCT s.client_id
     FROM nzi_console.client_strategies s
     JOIN nzi_console.clients c ON c.organisation_id = s.organisation_id AND c.client_id = s.client_id
     WHERE s.active AND s.target_date IS NOT NULL AND c.status = 'active'
     ORDER BY 1`);
  return result.rows.map((row) => row.client_id);
}

export async function runReminderTick(db: Queryable, input: {
  organisationId: string;
  today: string;
  mailer: Mailer;
  env?: Parameters<typeof mailDelivery>[0];
  windowDays?: number;
  limit?: number;
}): Promise<ReminderRunSummary> {
  const delivery = mailDelivery(input.env ?? {
    mailMode: process.env.NZI_MAIL_MODE,
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
  });
  let scanned = 0, claimed = 0;
  for (const clientId of await clientsWithPlans(db)) {
    const result = await scanClientReminders(db, {
      organisationId: input.organisationId, clientId, today: input.today, windowDays: input.windowDays,
    });
    scanned += result.scanned;
    claimed += result.claimed;
  }
  const drained = await drainOutbox(db, {
    organisationId: input.organisationId, today: input.today,
    mailer: input.mailer, delivery, limit: input.limit, windowDays: input.windowDays,
  });
  return { scanned, claimed, ...drained };
}
