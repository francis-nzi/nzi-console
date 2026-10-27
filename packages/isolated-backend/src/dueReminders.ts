import { randomUUID } from "node:crypto";
import {
  DEFAULT_REMINDER_SETTINGS, DUE_REMINDER_TEMPLATE_KEY, dueReminderRecipient, dueReminderTiming, dueReminderValues,
  strategyReminderStatus,
  type ClientStrategy, type CommandContext, type CommandInputMap, type ReminderBlock, type ReminderOwner, type ReminderSettings,
  type StrategyReminderStatus, type StrategyStatus,
} from "@nzi/contracts";
import { dateOnlyOrNull } from "./dates";
import { EmailValidationError } from "./email";
import { VersionConflictError } from "./errors";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { Queryable } from "./postgres";
import type { PoolLike } from "./postgres";
import { listClientStrategies } from "./reductionStrategies";
import { sendTemplatedEmail, TemplatedEmailError } from "./templatedEmail";

/**
 * Actions A3: a reminder to an action's owner before its target date (BUILD-actions-A3-due-date-reminders).
 *
 * ## One pipe (R2, R8)
 *
 * The scan **enqueues**; it never sends. Each owed reminder is rendered by `sendTemplatedEmail` — the house frame, signed by
 * the client's adviser — and queued as an `email.send` row on `transactional_outbox`, which the worker's existing email
 * drain delivers in its own transaction, through the isolation gate, exactly as an invite or a reset is. The scan runs in
 * a transaction of its own in the tick (`runWorkerTick`), apart from that drain: a failing scan cannot stop an email, and a
 * failing drain cannot roll back what the scan enqueued.
 *
 * ## Once per action per due date (R4)
 *
 * The marker (`strategy_due_reminders`, unique on action + due date) is written in the same transaction as the email and
 * its outbox row: the three are one fact. A re-tick finds the marker and sends nothing; a moved date is a new key, so it
 * re-arms. The email's idempotency key is the same pair, so even two ticks racing enqueue one email.
 *
 * ## Who, and who not (R3, R5)
 *
 * Only Agreed or In progress actions with a date, inside their window (`dueReminderTiming`). Only to the owner, an active
 * contact with an email who has consented (`dueReminderRecipient`). A blocked reminder is counted and surfaced to staff —
 * and is **not** marked, so it goes once the owner is put right, if the date has not passed.
 *
 * ## Audit (R7)
 *
 * Each enqueue is an audit event by reference — the template, the owner's contact id, the email's id — never the address.
 */

/** Who the audit trail names for the scan's enqueues: the worker, as a system principal. */
export const DUE_REMINDER_ACTOR = "worker:due-reminders";

type SettingsRow = { enabled: boolean; default_lead_days: number; version: number; updated_at: Date | string; updated_by: string };
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : String(value);

/** The Admin settings (R6). No row: off, seven days. No organisation given: the transaction's own tenant. */
export async function readReminderSettings(db: Queryable, organisationId?: string): Promise<ReminderSettings> {
  const { rows: [row] } = await db.query<SettingsRow>(
    `SELECT enabled, default_lead_days, version, updated_at, updated_by FROM nzi_console.organisation_reminder_settings
      WHERE organisation_id = coalesce($1, current_setting('app.organisation_id', true))`,
    [organisationId ?? null]);
  return row
    ? { enabled: row.enabled, defaultLeadDays: row.default_lead_days, version: row.version, updatedAt: iso(row.updated_at), updatedBy: row.updated_by }
    : DEFAULT_REMINDER_SETTINGS;
}

export type ReminderSettingsResult = { enabled: boolean; defaultLeadDays: number; version: number };

/** R6: the master switch and default lead, under admin.templates. Versioned; the first save creates the row. */
export function updateReminderSettings(pool: PoolLike, input: CommandInputMap["admin.reminders.update"], context: CommandContext): Promise<StoredOutcome<ReminderSettingsResult>> {
  return runPostgresCommand(pool, "admin.reminders.update", input, context, async (db) => {
    const { rows: [current] } = await db.query<SettingsRow>(
      `SELECT enabled, default_lead_days, version, updated_at, updated_by FROM nzi_console.organisation_reminder_settings WHERE organisation_id = $1 FOR UPDATE`,
      [context.organisationId]);
    const expected = input.expectedVersion ?? null;
    if (current ? expected !== current.version : expected !== null) throw new VersionConflictError(expected ?? 0, current?.version ?? 0);
    if (current && current.enabled === input.enabled && current.default_lead_days === input.defaultLeadDays) {
      throw new CommandValidationError([{ field: "enabled", code: "UNCHANGED", message: "Those are the settings already in force." }]);
    }
    const { rows: [saved] } = await db.query<{ version: number }>(
      `INSERT INTO nzi_console.organisation_reminder_settings (organisation_id, enabled, default_lead_days, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organisation_id) DO UPDATE SET enabled = EXCLUDED.enabled, default_lead_days = EXCLUDED.default_lead_days,
         version = organisation_reminder_settings.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING version`,
      [context.organisationId, input.enabled, input.defaultLeadDays, context.actorId]);
    return {
      data: { enabled: input.enabled, defaultLeadDays: input.defaultLeadDays, version: saved!.version },
      entityType: "organisation_reminder_settings", entityId: context.organisationId, topic: "reminder_settings.updated",
      before: current ? { enabled: current.enabled, defaultLeadDays: current.default_lead_days } : DEFAULT_REMINDER_SETTINGS_SNAPSHOT,
    };
  });
}
const DEFAULT_REMINDER_SETTINGS_SNAPSHOT = { enabled: DEFAULT_REMINDER_SETTINGS.enabled, defaultLeadDays: DEFAULT_REMINDER_SETTINGS.defaultLeadDays };

/* ── The scan ────────────────────────────────────────────────────────────────────────────────────────────────────── */

export type DueReminderScan = {
  /** The master switch as read this tick. Off: nothing was considered. */
  enabled: boolean;
  /** Actions owed a reminder now and not yet sent one for their date. */
  owed: number;
  enqueued: number;
  /** Owed but not sendable (R3), by reason — surfaced to staff on the plan. */
  blocked: Record<ReminderBlock, number>;
  /** Owed, sendable, but the render or the address was refused — logged by reason, never sent half-made. */
  refused: number;
};

type CandidateRow = {
  client_strategy_id: string; client_id: string; status: StrategyStatus; active: boolean; target_date: Date | string;
  reminder_lead_days: number | null; title: string; client_name: string; adviser_user_id: string | null;
  contact_id: string | null; full_name: string | null; email: string | null; contact_status: string | null; email_consent: string | null;
};

const ownerOf = (row: Pick<CandidateRow, "contact_id" | "full_name" | "email" | "contact_status" | "email_consent">): ReminderOwner =>
  row.contact_id === null ? null
    : { contactId: row.contact_id, fullName: row.full_name ?? "", email: row.email, status: row.contact_status ?? "inactive", emailConsent: row.email_consent ?? "unknown" };

/**
 * One scan: every live, dated action not yet reminded for its date, checked against its window and its owner; each one
 * owed and sendable enqueued, marked and audited. Run it in a transaction of its own, as `nzi_console_worker`.
 *
 * `consoleOrigin` is the console's own address, for the link into the portal. Without it the scan refuses outright: a
 * reminder that cannot say where to update the action is not sent.
 */
export async function scanDueReminders(db: Queryable, input: { organisationId: string; today: string; consoleOrigin: string | undefined }): Promise<DueReminderScan> {
  const settings = await readReminderSettings(db, input.organisationId);
  const summary: DueReminderScan = { enabled: settings.enabled, owed: 0, enqueued: 0, blocked: { "no-owner": 0, "owner-inactive": 0, "no-email": 0, "no-consent": 0 }, refused: 0 };
  if (!settings.enabled) return summary;
  let origin: string;
  try { origin = new URL(input.consoleOrigin ?? "").origin; }
  catch { throw new Error("The console's own address (NZI_ISOLATED_API_URL) is not set, so a reminder could not link to the portal; none was sent."); }

  // Narrowed in SQL to what could be owed — live, dated, not past, not already marked for this date — then decided by the
  // same pure rule the staff surface uses.
  const { rows } = await db.query<CandidateRow>(
    `SELECT a.client_strategy_id, a.client_id, a.status, a.active, a.target_date, a.reminder_lead_days,
            coalesce(l.title, a.bespoke_title, '') AS title, c.name AS client_name, c.owner_user_id AS adviser_user_id,
            oc.contact_id, oc.full_name, oc.email, oc.status AS contact_status, oc.email_consent
       FROM nzi_console.client_strategies a
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (a.organisation_id, a.client_id)
       LEFT JOIN nzi_console.reduction_strategies l ON (l.organisation_id, l.strategy_id) = (a.organisation_id, a.strategy_id)
       LEFT JOIN nzi_console.client_contacts oc ON (oc.organisation_id, oc.contact_id) = (a.organisation_id, a.owner_contact_id)
      WHERE a.organisation_id = $1 AND a.active AND c.status = 'active'
        AND a.status IN ('agreed', 'in_progress') AND a.target_date IS NOT NULL AND a.target_date >= $2::date
        AND NOT EXISTS (SELECT 1 FROM nzi_console.strategy_due_reminders r
                         WHERE (r.organisation_id, r.client_strategy_id, r.due_date) = (a.organisation_id, a.client_strategy_id, a.target_date))
      ORDER BY a.target_date, a.client_strategy_id`,
    [input.organisationId, input.today]);

  for (const row of rows) {
    const dueDay = dateOnlyOrNull(row.target_date)!;
    const timing = dueReminderTiming({ active: row.active, status: row.status, targetDate: dueDay, reminderLeadDays: row.reminder_lead_days }, input.today, settings.defaultLeadDays);
    if (timing.kind !== "owed") continue;
    summary.owed += 1;
    const recipient = dueReminderRecipient(ownerOf(row));
    if (!recipient.ok) { summary.blocked[recipient.why] += 1; continue; }

    const reminderId = randomUUID();
    let emailMessageId: string;
    try {
      ({ emailMessageId } = await sendTemplatedEmail(db, input.organisationId, {
        templateCode: DUE_REMINDER_TEMPLATE_KEY, to: recipient.email, consoleOrigin: origin,
        // The client's adviser signs it where they are an active member (5-2); otherwise the organisation's chrome only.
        ...(row.adviser_user_id ? { attributedTo: row.adviser_user_id } : {}),
        vars: dueReminderValues({ firstName: recipient.firstName, clientName: row.client_name, actionTitle: row.title, dueDate: timing.dueDate, actionsLink: `${origin}/portal` }),
        correlationId: reminderId,
        idempotencyKey: `${DUE_REMINDER_TEMPLATE_KEY}:${row.client_strategy_id}:${timing.dueDate}`,
      }));
    } catch (error) {
      // Refused before anything was written (the render, or the address): nothing half-made is queued, and the next tick
      // tries again — after someone fixes the wording or the contact.
      if (error instanceof TemplatedEmailError || error instanceof EmailValidationError) { summary.refused += 1; continue; }
      throw error;
    }
    const marked = await db.query<{ reminder_id: string }>(
      `INSERT INTO nzi_console.strategy_due_reminders
         (organisation_id, reminder_id, client_strategy_id, client_id, due_date, lead_days, owner_contact_id, template_code, email_message_id)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9)
       ON CONFLICT (organisation_id, client_strategy_id, due_date) DO NOTHING
       RETURNING reminder_id`,
      [input.organisationId, reminderId, row.client_strategy_id, row.client_id, timing.dueDate, timing.leadDays, recipient.contactId, DUE_REMINDER_TEMPLATE_KEY, emailMessageId]);
    if (marked.rows.length === 0) continue;
    await db.query(
      `INSERT INTO nzi_console.audit_events
         (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, after_json, client_id)
       VALUES ($1, $2, $3, 'system', 'strategy_reminder_enqueued', 'client_strategy', $4, $5, $6::jsonb, $7)`,
      [input.organisationId, randomUUID(), DUE_REMINDER_ACTOR, row.client_strategy_id, reminderId,
        JSON.stringify({ templateCode: DUE_REMINDER_TEMPLATE_KEY, recipientContactId: recipient.contactId, emailMessageId, dueDate: timing.dueDate, leadDays: timing.leadDays, attributedTo: row.adviser_user_id }),
        row.client_id]);
    summary.enqueued += 1;
  }
  return summary;
}

/* ── What staff see (R3) ─────────────────────────────────────────────────────────────────────────────────────────── */

export type StrategyReminders = { settings: ReminderSettings; statuses: Record<string, StrategyReminderStatus> };

/**
 * Each action's reminder, for the plan: sent (and when), when it will go, or why it cannot — a skipped reminder is
 * surfaced here rather than silently dropped. Read in the console's tenant transaction, after the client's access is checked;
 * `plan` is the client's plan as the caller already read it.
 */
export async function strategyReminderStatuses(db: Queryable, input: { clientId: string; today: string; plan: readonly ClientStrategy[] }): Promise<StrategyReminders> {
  const settings = await readReminderSettings(db);
  const markers = await db.query<{ client_strategy_id: string; due_date: Date | string; enqueued_at: Date | string }>(
    `SELECT client_strategy_id, due_date, enqueued_at FROM nzi_console.strategy_due_reminders WHERE client_id = $1`, [input.clientId]);
  const owners = await db.query<{ contact_id: string; full_name: string; email: string | null; status: string; email_consent: string }>(
    `SELECT contact_id, full_name, email, status, email_consent FROM nzi_console.client_contacts WHERE client_id = $1`, [input.clientId]);
  const plan = input.plan;
  const sent = new Map(markers.rows.map((row) => [`${row.client_strategy_id}|${dateOnlyOrNull(row.due_date)}`, iso(row.enqueued_at)]));
  const contacts = new Map(owners.rows.map((row) => [row.contact_id, row]));
  const statuses: Record<string, StrategyReminderStatus> = {};
  for (const action of plan) {
    const timing = dueReminderTiming(action, input.today, settings.defaultLeadDays);
    const enqueuedAt = timing.kind === "none" ? undefined : sent.get(`${action.id}|${timing.dueDate}`);
    const contact = action.ownerContactId ? contacts.get(action.ownerContactId) : undefined;
    statuses[action.id] = strategyReminderStatus({
      enabled: settings.enabled, timing, sentForDueDate: enqueuedAt ? { enqueuedAt } : null,
      owner: contact ? { contactId: contact.contact_id, fullName: contact.full_name, email: contact.email, status: contact.status, emailConsent: contact.email_consent } : null,
    });
  }
  return { settings, statuses };
}

/** The same, reading the plan itself — for a caller that has not. */
export async function listStrategyReminderStatuses(db: Queryable, input: { clientId: string; today: string }): Promise<StrategyReminders> {
  return strategyReminderStatuses(db, { ...input, plan: await listClientStrategies(db, input.clientId) });
}
